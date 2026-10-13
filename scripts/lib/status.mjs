// Print what the lab currently has: recorded inputs, stack statuses, and Vapi objects.
import * as common from "./common.mjs";

export const options = { "no-aws": { type: "boolean", default: false } };
export const help = `--no-aws (only print the recorded state)`;

export async function run(values) {
  const state = common.loadState();
  if (!Object.keys(state).length) {
    console.log("No lab state yet. Start with `node scripts/lab.mjs preflight`.");
    return;
  }
  const rows = [
    ["region", String(state.region ?? "-")],
    ["account", String(state.account_id ?? "-")],
    ["deployment id", String(state.deployment_id ?? "-")],
    ["SIP hostname", String(state.sip_hostname ?? "-")],
  ];
  if (!values["no-aws"] && state.region && state.deployment_id) {
    for (const [kind, name] of Object.entries(common.stackNames(state))) {
      rows.push([`stack ${kind}`, `${name}: ${(await common.stackStatus(name, state.region)) ?? "absent"}`]);
    }
  }
  if (state.remote) rows.push(["mode", `remote: the shared lab account via ${state.remote.gateway ?? "the lab gateway"}`]);
  const connect = state.connect?.outputs ?? {};
  if (connect.ConnectLoginUrl) rows.push(["agent workspace", String(connect.ConnectLoginUrl)]);
  if (connect.AgentUsername) rows.push(["agent username", String(connect.AgentUsername)]);
  if (state.lab_agent_password) rows.push(["agent password", "in the handout: node scripts/lab.mjs remote agent"]);
  const phone = state.vapi?.phone;
  if (phone) rows.push(["dial-in", String(phone.number ?? phone.sipUri ?? phone.id)]);
  if (state.vapi?.attached_assistant) rows.push(["attached assistant", String(state.vapi.attached_assistant.id)]);
  if (state.web?.vapi) rows.push(["web assistant", String(state.web.vapi.assistant_id)]);
  if (state.web?.overlay) rows.push(["runtime overlay", String(state.web.overlay.status ?? "applied")]);
  common.printTable(rows);
}
