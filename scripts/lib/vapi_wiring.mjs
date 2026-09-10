// Stage 3 orchestration: persona + dial-in number, or the advanced existing-assistant path.
import * as common from "./common.mjs";
import { LabError } from "./common.mjs";
import * as vapiAssistant from "./vapi_assistant.mjs";
import * as vapiPhone from "./vapi_phone.mjs";

export const options = {
  ...vapiPhone.options,
  "skip-persona": { type: "boolean", default: false },
  "skip-number": { type: "boolean", default: false },
  "first-message": { type: "string", default: vapiAssistant.FIRST_MESSAGE },
  "attach-existing": { type: "string" },
  detach: { type: "boolean", default: false },
  "release-number": { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
};
export const help = `--number-mode free|sip|byo  --area-code 415  --phone-number-id <id>  --skip-persona  --skip-number
--attach-existing <assistantId> (advanced)  --detach  --release-number  --yes`;

export const CALLER_SCRIPT = `Test call script (say roughly this):
  1. "Hi, I need to talk to a person about my bill."
  2. Riley asks for your name, a one-line summary, and your account PIN. Give a name, say
     "my bill is higher than usual", and any four digits.
  3. When Riley confirms the transfer, stay on the line. You should hear the connecting
     message, then the lab agent's Agent Workspace shows "Bridgefu caller context".`;

export async function run(values) {
  const state = common.loadState();
  common.requireKeys(state, "bridgefu");
  const outputs = state.bridgefu.outputs;
  const templateAssistant = outputs.VapiAssistantId;
  if (!templateAssistant) throw new LabError("the Bridgefu stack has no VapiAssistantId output");

  if (values["release-number"]) return vapiPhone.release(state);
  if (values.detach) return vapiAssistant.detach(state);
  let target = templateAssistant;
  if (values["attach-existing"]) {
    await vapiAssistant.attachExisting(state, values["attach-existing"], values.yes);
    target = values["attach-existing"];
  } else if (!values["skip-persona"]) {
    await vapiAssistant.applyPersona(state, target, values["first-message"]);
  }
  const rows = [["assistant", target]];
  if (!values["skip-number"]) rows.push(...vapiPhone.describe(await vapiPhone.wire(values, state, target)));
  console.log("Vapi wiring complete.");
  common.printTable(rows);
  console.log("");
  console.log(CALLER_SCRIPT);
  console.log("");
  console.log("Before calling: open the Agent Workspace login from stage 1 and set the agent Available");
  console.log("(or run `node scripts/lab.mjs connect --agent-available`). Then verify with `node scripts/lab.mjs verify-phone`.");
}
