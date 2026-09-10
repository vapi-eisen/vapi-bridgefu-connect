// Stage 3 (assistant): persona for the stack-created assistant, plus the advanced path
// that wires an engineer's existing assistant to the Bridgefu stack.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, log, vapiRequest } from "./common.mjs";

const PROMPT_PATH = join(common.REPO_ROOT, "vapi", "prompts", "lab-support.md");
const TRANSFER_TOOL_PATH = join(common.REPO_ROOT, "vapi", "transfer-tool.json");
export const FIRST_MESSAGE = "Thanks for calling Brightline Mobile, this is Riley. How can I help you today?";
export const RULES_MARKER = "Required Bridgefu rules";

export function labPrompt() {
  return readFileSync(PROMPT_PATH, "utf8").trim();
}

export function rulesBlock() {
  const prompt = labPrompt();
  const index = prompt.indexOf(RULES_MARKER);
  if (index < 0) throw new LabError(`${PROMPT_PATH} lost its '${RULES_MARKER}' section`);
  return prompt.slice(index);
}

function systemMessages(model, content) {
  const messages = (model.messages ?? []).filter((m) => m && typeof m === "object").map((m) => ({ ...m }));
  const system = messages.find((m) => m.role === "system");
  if (system) {
    system.content = content;
    return messages;
  }
  return [{ role: "system", content }, ...messages];
}

export async function applyPersona(state, assistantId, firstMessage = FIRST_MESSAGE) {
  const assistant = await vapiRequest(state, "GET", `/assistant/${assistantId}`);
  if (!assistant?.model || typeof assistant.model !== "object") throw new LabError("the Vapi assistant could not be read");
  const model = { ...assistant.model, messages: systemMessages(assistant.model, labPrompt()) };
  await vapiRequest(state, "PATCH", `/assistant/${assistantId}`, { model, firstMessage });
  const check = await vapiRequest(state, "GET", `/assistant/${assistantId}`);
  const applied = (check?.model?.messages ?? []).find((m) => m.role === "system")?.content ?? "";
  if (common.sha256(String(applied)) !== common.sha256(labPrompt())) throw new LabError("the persona PATCH did not apply; inspect the assistant in the Vapi dashboard");
  log(`persona applied; assistant keeps toolIds=${JSON.stringify(model.toolIds ?? [])} and inline tools=${JSON.stringify((model.tools ?? []).map((t) => t.type))}`);
}

/** Point an existing assistant at this stack and rebind the identity secret to it. */
export async function attachExisting(state, assistantId, assumeYes) {
  common.requireKeys(state, "bridgefu");
  const outputs = state.bridgefu.outputs;
  for (const key of ["VapiPrepareToolId", "VapiWebhookCredentialId", "VapiTransferUrl", "VapiIdentityBindingArn", "VapiAssistantId"]) {
    if (!outputs[key]) throw new LabError(`Bridgefu stack output ${key} is missing`);
  }
  const assistant = await vapiRequest(state, "GET", `/assistant/${assistantId}`);
  if (!assistant?.model || typeof assistant.model !== "object") throw new LabError("the existing assistant could not be read");
  const server = assistant.server ?? {};
  if (server.url && server.url !== outputs.VapiTransferUrl) {
    throw new LabError("that assistant already sends server messages to another URL; the Bridgefu stack must own server.url to answer transfer-destination-request. Use a copy of the assistant instead.");
  }
  await common.confirm(`Attach Bridgefu tools to assistant ${assistantId} and rebind the stack's identity secret to it? The stack-created template assistant stops transferring until you --detach.`, assumeYes);
  const previous = {
    server: assistant.server ?? null,
    serverMessages: assistant.serverMessages ?? null,
    credentialIds: assistant.credentialIds ?? null,
    toolIds: assistant.model.toolIds ?? null,
    tools: assistant.model.tools ?? null,
    messages: assistant.model.messages ?? null,
  };
  const model = { ...assistant.model };
  const toolIds = [...(model.toolIds ?? [])];
  if (!toolIds.includes(outputs.VapiPrepareToolId)) toolIds.push(outputs.VapiPrepareToolId);
  model.toolIds = toolIds;
  const tools = (model.tools ?? []).filter((t) => t && typeof t === "object").map((t) => ({ ...t }));
  if (!tools.some((t) => t.type === "transferCall")) tools.push(JSON.parse(readFileSync(TRANSFER_TOOL_PATH, "utf8")));
  model.tools = tools;
  const messages = (model.messages ?? []).filter((m) => m && typeof m === "object").map((m) => ({ ...m }));
  const system = messages.find((m) => m.role === "system");
  if (!system) messages.unshift({ role: "system", content: rulesBlock() });
  else if (!String(system.content ?? "").includes(RULES_MARKER)) system.content = `${String(system.content ?? "").trimEnd()}\n\n${rulesBlock()}`;
  model.messages = messages;
  const serverMessages = [...new Set([...(assistant.serverMessages ?? []), "transfer-destination-request"])].sort();
  const credentialIds = [...new Set([...(assistant.credentialIds ?? []), outputs.VapiWebhookCredentialId])].sort();
  await vapiRequest(state, "PATCH", `/assistant/${assistantId}`, {
    model,
    server: { url: outputs.VapiTransferUrl, credentialId: outputs.VapiWebhookCredentialId },
    serverMessages,
    credentialIds,
  });
  const orgId = String(assistant.orgId ?? "");
  if (!orgId) throw new LabError("the assistant has no orgId; cannot bind the identity secret");
  await bindIdentity(state, outputs.VapiIdentityBindingArn, orgId, assistantId);
  state.vapi = state.vapi ?? {};
  state.vapi.attached_assistant = { id: assistantId, previous };
  common.saveState(state);
  console.log(`Assistant ${assistantId} now uses the Bridgefu prepare tool, transfer tool, and server URL, and the stack trusts it.`);
  console.log("Caveats: only one assistant is trusted at a time; a Bridgefu stack update rebinds to the template assistant");
  console.log("(re-run this command afterwards); Lambdas cache secrets for 300 s, so allow up to five minutes.");
}

export async function detach(state) {
  const attached = state.vapi?.attached_assistant;
  if (!attached) {
    log("no attached assistant recorded; nothing to detach");
    return;
  }
  common.requireKeys(state, "bridgefu");
  const outputs = state.bridgefu.outputs;
  const previous = attached.previous ?? {};
  const assistant = await vapiRequest(state, "GET", `/assistant/${attached.id}`, undefined, { allowMissing: true });
  if (assistant && typeof assistant === "object") {
    const model = { ...(assistant.model ?? {}) };
    for (const key of ["toolIds", "tools", "messages"]) {
      if (previous[key] !== null && previous[key] !== undefined) model[key] = previous[key];
      else delete model[key];
    }
    const patch = { model };
    for (const key of ["server", "serverMessages", "credentialIds"]) {
      patch[key] = previous[key] !== null && previous[key] !== undefined ? previous[key] : key === "server" ? null : [];
    }
    await vapiRequest(state, "PATCH", `/assistant/${attached.id}`, patch);
  }
  const template = await vapiRequest(state, "GET", `/assistant/${outputs.VapiAssistantId}`);
  if (!template || typeof template !== "object") throw new LabError("the template assistant could not be read for rebinding");
  await bindIdentity(state, outputs.VapiIdentityBindingArn, String(template.orgId), outputs.VapiAssistantId);
  delete state.vapi.attached_assistant;
  common.saveState(state);
  console.log("Detached: the existing assistant's previous configuration is restored and the template assistant is trusted again.");
}

export async function bindIdentity(state, secretArn, orgId, assistantId) {
  if (!orgId || !common.RESOURCE_ID.test(orgId) || !common.RESOURCE_ID.test(assistantId)) throw new LabError("organization or assistant id is not a valid identifier");
  await common.putSecretValue(secretArn, JSON.stringify({ status: "bound", organization_id: orgId, assistant_id: assistantId }), common.regionOf(state));
  log(`identity binding ${common.fingerprint(secretArn)} now trusts assistant ${assistantId}`);
}
