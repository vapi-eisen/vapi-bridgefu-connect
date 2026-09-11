// Stage 5: the Vapi objects the browser path needs: the bridgefu_direct_handoff tool
// (static handoff_token parameter filled by Vapi from the SIP header Bridgefu sends),
// a dedicated assistant that owns only that tool, a SIP endpoint with digest
// credentials Bridgefu dials (credentials live in Secrets Manager), and the identity
// binding that tells the released handoff Lambda which assistant to trust.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import * as sipProbe from "./sip_probe.mjs";
import { LabError, log, vapiRequest } from "./common.mjs";

export const TOOL_NAME = "bridgefu_direct_handoff";

/** The user part of a `sip:user@host` URI, or null. */
export function usernameFromSipUri(sipUri) {
  const match = /^sips?:([^@]+)@/.exec(String(sipUri ?? ""));
  return match ? match[1] : null;
}
export const ASSISTANT_NAME_PREFIX = "BridgeFu Lab Web Assistant";
const PROMPT_PATH = join(common.REPO_ROOT, "vapi", "prompts", "lab-web-direct.md");
export const FIRST_MESSAGE = "Hi, this is Riley from Brightline Mobile support. How can I help you today?";

/** Port of the released screen_pop.vapi_parameters for the tool's JSON Schema. */
export function vapiParametersFromFieldsJson(fieldsJson) {
  const fields = JSON.parse(fieldsJson);
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 8) throw new LabError("ScreenPopFieldsJson is not a list of 1-8 fields");
  const properties = {};
  const required = [];
  for (const field of fields) {
    if (field.key === "handoff_token") throw new LabError("screen-pop fields may not use the reserved key handoff_token");
    const entry = { type: "string", description: field.description ?? "" };
    if ((field.type ?? "text") === "choice") entry.enum = [...field.choices];
    else entry.maxLength = Number(field.max_length ?? 256);
    properties[field.key] = entry;
    if (field.required ?? true) required.push(field.key);
  }
  return { type: "object", additionalProperties: false, required, properties };
}

export function toolPayload(endpointUrl, credentialId, fieldsJson) {
  if (!endpointUrl.startsWith("https://")) throw new LabError("the direct handoff URL must be https");
  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description: "Store the configured screen-pop context and securely replace this Bridgefu assistant leg with Amazon Connect.",
      parameters: vapiParametersFromFieldsJson(fieldsJson),
    },
    server: { url: endpointUrl, credentialId, timeoutSeconds: 10 },
    parameters: [{ key: "handoff_token", value: "{{ bridgefu_handoff_token }}" }],
  };
}

export function assistantPayload(name, toolId, modelName, voiceId, deploymentId) {
  return {
    name,
    firstMessageMode: "assistant-speaks-first",
    firstMessage: FIRST_MESSAGE,
    model: { provider: "openai", model: modelName, temperature: 0.3, messages: [{ role: "system", content: readFileSync(PROMPT_PATH, "utf8").trim() }], toolIds: [toolId] },
    voice: { provider: "vapi", voiceId },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    artifactPlan: { recordingEnabled: false },
    maxDurationSeconds: 600,
    metadata: { vapi_bridgefu_connect_lab: deploymentId, purpose: "direct-browser-handoff" },
  };
}

async function orgId(state) {
  const outputs = state.bridgefu.outputs;
  let org;
  try {
    const binding = JSON.parse(await common.secretValue(outputs.VapiIdentityBindingArn, common.regionOf(state)));
    org = binding?.organization_id;
  } catch {
    org = undefined;
  }
  if (!org) org = (await vapiRequest(state, "GET", `/assistant/${outputs.VapiAssistantId}`))?.orgId;
  if (typeof org !== "string" || !common.RESOURCE_ID.test(org)) throw new LabError("could not determine the Vapi organization id");
  return org;
}

export async function create(state) {
  common.requireKeys(state, "bridgefu", "lab_web");
  const region = common.regionOf(state);
  const deployment = common.deploymentIdOf(state);
  const outputs = state.bridgefu.outputs;
  const labWeb = state.lab_web.outputs;
  const record = { ...(state.web?.vapi ?? {}) };

  const desiredTool = toolPayload(labWeb.DirectHandoffUrl, outputs.VapiWebhookCredentialId, outputs.ScreenPopFieldsJson);
  if (!record.tool_id) {
    const existing = (await common.vapiList(state, "tool")).filter((t) => t.function?.name === TOOL_NAME && t.server?.url === labWeb.DirectHandoffUrl);
    if (existing.length) {
      record.tool_id = existing[0].id;
      log("adopting the existing direct handoff tool");
    } else {
      const created = await vapiRequest(state, "POST", "/tool", desiredTool);
      if (!created?.id) throw new LabError("Vapi did not return a tool id");
      record.tool_id = created.id;
      log("created the direct handoff tool");
    }
  }

  const assistantName = `${ASSISTANT_NAME_PREFIX} (${deployment})`;
  if (!record.assistant_id) {
    const existing = (await common.vapiList(state, "assistant")).filter((a) => a.name === assistantName);
    if (existing.length) {
      record.assistant_id = existing[0].id;
      log("adopting the existing direct web assistant");
    } else {
      const created = await vapiRequest(state, "POST", "/assistant", assistantPayload(assistantName, record.tool_id, outputs.VapiModel ?? "gpt-4.1-mini", outputs.VapiVoiceId ?? "Elliot", deployment));
      if (!created?.id) throw new LabError("Vapi did not return an assistant id");
      record.assistant_id = created.id;
      log("created the direct web assistant");
    }
  }

  const phoneName = `bridgefu-lab-${deployment}-direct`;
  // Digest credentials on the direct Vapi SIP endpoint are set ONCE, at creation, and the identical
  // password is written to the host secret in the same step so the two never drift. We never PATCH
  // or rotate `authentication` afterward: repeated rotation can wedge the username at Vapi's SIP
  // gateway so every INVITE gets 403 "Invalid credentials", and that state survives deleting and
  // recreating the phone-number object (only a brand-new username recovers). For the same reason a
  // new endpoint always mints a fresh username rather than reusing a recorded one. See
  // docs/05-web-sdk-handoff.md and references/troubleshooting.md.
  //
  // A recorded endpoint that has since been deleted out from under us (404) is treated as absent so
  // we mint a fresh identity instead of PATCHing a dead id.
  if (record.phone_id) {
    const still = await vapiRequest(state, "GET", `/phone-number/${record.phone_id}`, undefined, { allowMissing: true });
    if (!still) {
      log("the recorded direct SIP endpoint no longer exists; minting a fresh one");
      delete record.phone_id;
      delete record.sip_username;
      delete record.sip_uri;
    }
  }
  let username = record.sip_username;
  let mintedCredentials = null;
  if (!record.phone_id) {
    const existing = (await common.vapiList(state, "phone-number")).filter((p) => p.name === phoneName);
    if (existing.length) {
      record.phone_id = existing[0].id;
      username = usernameFromSipUri(existing[0].sipUri) ?? username ?? `lab_${randomBytes(8).toString("hex")}`;
      await vapiRequest(state, "PATCH", `/phone-number/${record.phone_id}`, { assistantId: record.assistant_id });
      log("adopting the existing direct SIP endpoint (leaving its registered credentials untouched)");
    } else {
      // Create the endpoint, then confirm it actually authenticates over SIP before trusting it. A
      // username Vapi has wedged answers every digest with 403; if that happens, discard it and mint
      // another (up to three tries). A timeout/socket result is inconclusive, so keep the endpoint.
      const sipHostname = state.sip_hostname ?? "lab.invalid";
      for (let attempt = 1; ; attempt++) {
        username = `lab_${randomBytes(8).toString("hex")}`;
        mintedCredentials = { realm: "sip.vapi.ai", username, password: randomBytes(24).toString("base64url") };
        const created = await vapiRequest(state, "POST", "/phone-number", { provider: "vapi", name: phoneName, sipUri: `sip:${username}@sip.vapi.ai`, assistantId: record.assistant_id, authentication: mintedCredentials });
        if (!created?.id) throw new LabError("Vapi did not return a phone number id");
        record.phone_id = created.id;
        const health = await sipProbe.probeDigest({ username, password: mintedCredentials.password, target: `sip:${username}@sip.vapi.ai:5061;transport=tls`, fromUri: `sips:bridgefu@${sipHostname}` });
        if (health.ok) {
          log("created the direct SIP endpoint with digest credentials (verified it authenticates)");
          break;
        }
        if (health.status !== 403) {
          log(`created the direct SIP endpoint; could not verify it over SIP (${health.reason}) - continuing`);
          break;
        }
        log(`the new SIP username 403s auth at Vapi's gateway (attempt ${attempt}); discarding it and minting another`);
        await vapiRequest(state, "DELETE", `/phone-number/${created.id}`, undefined, { allowMissing: true });
        record.phone_id = undefined;
        if (attempt >= 3) throw new LabError("the direct Vapi SIP endpoint answers auth with 403 after three fresh usernames; Vapi's SIP gateway may be rejecting new endpoints - see references/troubleshooting.md");
      }
    }
  } else {
    username = username ?? `lab_${randomBytes(8).toString("hex")}`;
    await vapiRequest(state, "PATCH", `/phone-number/${record.phone_id}`, { assistantId: record.assistant_id });
  }
  // Write the host secret only when we just minted the credentials (i.e. created the endpoint). On
  // adopt, the endpoint already holds a password we cannot read back, so the existing secret is
  // left in place, matching what Vapi has.
  if (mintedCredentials) await common.putSecretValue(labWeb.DirectVapiSipAuthSecretArn, JSON.stringify(mintedCredentials), region);
  record.sip_username = username;
  record.sip_uri = `sip:${username}@sip.vapi.ai`;

  await common.putSecretValue(labWeb.DirectVapiIdentityBindingArn, JSON.stringify({ status: "bound", organization_id: await orgId(state), assistant_id: record.assistant_id }), region);
  state.web = state.web ?? {};
  state.web.vapi = record;
  common.saveState(state);
  log(`direct web assistant ${record.assistant_id} is bound; Bridgefu will dial ${record.sip_uri}`);
  return record;
}

export async function remove(state) {
  const errors = [];
  const record = state.web?.vapi;
  if (!record) return errors;
  const labWeb = state.lab_web?.outputs ?? {};
  const region = state.region;
  if (labWeb.DirectVapiIdentityBindingArn && region) {
    try {
      await common.putSecretValue(labWeb.DirectVapiIdentityBindingArn, '{"status":"unbound"}', region);
    } catch (error) {
      errors.push(`unbind: ${error.message}`);
    }
  }
  for (const [kind, key] of [["phone-number", "phone_id"], ["assistant", "assistant_id"], ["tool", "tool_id"]]) {
    if (!record[key]) continue;
    try {
      await vapiRequest(state, "DELETE", `/${kind}/${record[key]}`, undefined, { allowMissing: true });
    } catch (error) {
      errors.push(`delete ${kind}: ${error.message}`);
    }
  }
  if (labWeb.DirectVapiSipAuthSecretArn && region) {
    try {
      await common.putSecretValue(labWeb.DirectVapiSipAuthSecretArn, "{}", region);
    } catch (error) {
      errors.push(`reset sip auth: ${error.message}`);
    }
  }
  if (!errors.length) {
    delete state.web.vapi;
    common.saveState(state);
  }
  return errors;
}
