// Stage 3 (number): give the lab assistant a way to be called.
//
// Modes: free (a free Vapi US number: provider "vapi" + numberDesiredAreaCode; up to
// five per account, a payment method may be required, the number is not charged),
// sip (a sip:<user>@sip.vapi.ai endpoint for softphones), byo (reuse a number you
// own; its previous assistant is recorded so teardown can restore it).
import { randomBytes } from "node:crypto";
import * as common from "./common.mjs";
import { LabError, log, sleep, vapiRequest } from "./common.mjs";

export const options = {
  "number-mode": { type: "string", default: "free" },
  "area-code": { type: "string", default: "415" },
  "phone-number-id": { type: "string" },
};

function phoneName(state) {
  return `bridgefu-lab-${common.deploymentIdOf(state)}`;
}

async function findByName(state, name) {
  const matches = (await common.vapiList(state, "phone-number")).filter((p) => p.name === name);
  if (matches.length > 1) throw new LabError(`more than one Vapi phone number is named ${name}; clean up before continuing`);
  return matches[0] ?? null;
}

/** Three-digit area codes from a Vapi "not available" error's "Try one of ..." hint. Pure. */
export function areaCodeHints(message) {
  const hint = /try one of ([\d,\s]+)/i.exec(String(message ?? ""));
  return hint ? [...new Set(hint[1].match(/\d{3}/g) ?? [])] : [];
}

/** POST a phone number, resolving the VapiAmbiguousWrite race by finding it by name. */
async function postPhoneNumber(state, payload, name) {
  let phone;
  try {
    phone = await vapiRequest(state, "POST", "/phone-number", payload);
  } catch (error) {
    if (!(error instanceof common.VapiAmbiguousWrite)) throw error;
    await sleep(3000);
    phone = await findByName(state, name);
    if (!phone) throw error;
  }
  if (!phone?.id) throw new LabError("Vapi did not return a phone number object");
  return phone;
}

/**
 * Get a free Vapi number in `desired`, falling back to the area codes Vapi suggests when it is
 * unavailable rather than failing the whole run. Vapi returns HTTP 400 "This area code is currently
 * not available. Hint: Try one of 575, 804, 571." when a code is exhausted.
 */
async function createFreeNumber(state, name, assistantId, desired) {
  const tried = new Set();
  const queue = [desired];
  let lastError;
  while (queue.length && tried.size < 6) {
    const code = queue.shift();
    if (tried.has(code)) continue;
    tried.add(code);
    try {
      const phone = await postPhoneNumber(state, { provider: "vapi", name, assistantId, numberDesiredAreaCode: code }, name);
      if (code !== desired) log(`area code ${desired} was unavailable; used ${code} instead`);
      return phone;
    } catch (error) {
      const message = String(error?.message ?? "");
      if (!/area code.{0,40}not available/i.test(message)) throw error;
      lastError = error;
      const hints = areaCodeHints(message).filter((hint) => !tried.has(hint));
      queue.push(...hints);
      log(`area code ${code} is not available at Vapi${hints.length ? `; trying ${hints[0]}` : ""}`);
    }
  }
  throw lastError ?? new LabError("could not obtain a free Vapi number in any area code");
}

async function waitActive(state, phoneId) {
  const deadline = Date.now() + 90_000;
  let phone = {};
  while (Date.now() < deadline) {
    phone = (await vapiRequest(state, "GET", `/phone-number/${phoneId}`)) ?? {};
    const status = String(phone.status ?? "");
    if (status === "" || status === "active") return phone;
    if (status === "blocked") throw new LabError("Vapi reports the phone number as blocked");
    await sleep(3000);
  }
  return phone;
}

export async function wire(values, state, assistantId) {
  const existing = state.vapi?.phone;
  if (existing) {
    if (existing.assistant_id !== assistantId) {
      await vapiRequest(state, "PATCH", `/phone-number/${existing.id}`, { assistantId });
      existing.assistant_id = assistantId;
      common.saveState(state);
    }
    log(`reusing the lab number recorded in state (${existing.mode})`);
    return existing;
  }
  const mode = values["number-mode"];
  if (!["free", "sip", "byo"].includes(mode)) throw new LabError("--number-mode must be free, sip, or byo");
  const name = phoneName(state);
  let record;
  if (mode === "byo") {
    const id = values["phone-number-id"];
    if (!id) throw new LabError("--phone-number-id is required with --number-mode byo");
    const phone = await vapiRequest(state, "GET", `/phone-number/${id}`);
    if (!phone || typeof phone !== "object") throw new LabError("that Vapi phone number was not found");
    await vapiRequest(state, "PATCH", `/phone-number/${phone.id}`, { assistantId });
    record = { id: phone.id, mode, number: phone.number ?? null, sipUri: phone.sipUri ?? null, previous_assistant_id: phone.assistantId ?? null, created_by_lab: false };
  } else {
    let phone = await findByName(state, name);
    if (phone) {
      log("a lab number with the expected name already exists in Vapi; adopting it");
      if (phone.assistantId !== assistantId) await vapiRequest(state, "PATCH", `/phone-number/${phone.id}`, { assistantId });
    } else {
      if (mode === "free") {
        if (!/^\d{3}$/.test(values["area-code"])) throw new LabError("--area-code must be three digits");
        phone = await createFreeNumber(state, name, assistantId, values["area-code"]);
      } else {
        phone = await postPhoneNumber(state, { provider: "vapi", name, assistantId, sipUri: `sip:lab_${randomBytes(8).toString("hex")}@sip.vapi.ai` }, name);
      }
      phone = (await waitActive(state, phone.id)) ?? phone;
    }
    record = { id: phone.id, mode, number: phone.number ?? null, sipUri: phone.sipUri ?? null, previous_assistant_id: null, created_by_lab: true };
  }
  record.assistant_id = assistantId;
  state.vapi = state.vapi ?? {};
  state.vapi.phone = record;
  common.saveState(state);
  return record;
}

export async function release(state) {
  const phone = state.vapi?.phone;
  if (!phone) {
    log("no lab phone number recorded; nothing to release");
    return;
  }
  if (phone.created_by_lab) {
    await vapiRequest(state, "DELETE", `/phone-number/${phone.id}`, undefined, { allowMissing: true });
    log("deleted the lab-created Vapi phone number");
  } else if (phone.previous_assistant_id) {
    await vapiRequest(state, "PATCH", `/phone-number/${phone.id}`, { assistantId: phone.previous_assistant_id });
    log("restored the number's previous assistant assignment");
  } else {
    log("the bring-your-own number had no previous assistant; leaving its assignment for you to change in Vapi");
  }
  delete state.vapi.phone;
  common.saveState(state);
}

export function describe(record) {
  const rows = [["mode", String(record.mode)]];
  if (record.number) rows.push(["dial-in number", String(record.number)]);
  if (record.sipUri) rows.push(["SIP URI", String(record.sipUri)]);
  return rows;
}
