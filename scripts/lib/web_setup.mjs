// Stage 5 orchestration: add-on stack, Vapi direct objects, host overlay.
import * as common from "./common.mjs";
import * as labWebStack from "./lab_web_stack.mjs";
import * as vapiWebObjects from "./vapi_web_objects.mjs";
import * as webRuntime from "./web_runtime.mjs";

export const options = {
  ...labWebStack.options,
  "skip-stack": { type: "boolean", default: false },
  "skip-vapi": { type: "boolean", default: false },
  "skip-overlay": { type: "boolean", default: false },
  "refresh-client-cidr": { type: "boolean", default: false },
};
export const help = `--client-cidr auto|x.x.x.x/32  --wss-port 8443  --skip-stack  --skip-vapi  --skip-overlay  --refresh-client-cidr  --yes`;

export async function run(values) {
  if (values["refresh-client-cidr"]) return labWebStack.deploy(values);
  if (!values["skip-stack"]) await labWebStack.deploy(values);
  let state = common.loadState();
  common.requireKeys(state, "lab_web");
  if (!values["skip-vapi"]) {
    await vapiWebObjects.create(state);
    state = common.loadState();
  }
  if (!values["skip-overlay"]) {
    await webRuntime.applyOverlay(state, values.yes);
    state = common.loadState();
  }
  const web = state.web ?? {};
  console.log("");
  console.log("Browser path is ready.");
  common.printTable([
    ["direct assistant", String(web.vapi?.assistant_id ?? "-")],
    ["Bridgefu dials", String(web.vapi?.sip_uri ?? "-")],
    ["WSS", `wss://${state.sip_hostname}:${state.lab_web.outputs.WssPort}/webrtc`],
    ["overlay", String(web.overlay?.status ?? "not applied")],
  ]);
  console.log("");
  console.log("Next: `node scripts/lab.mjs web-serve`, open http://127.0.0.1:8787, click Talk to support,");
  console.log("ask for a person, then watch Agent Workspace. Verify with `node scripts/lab.mjs verify-web`.");
}
