// Stage 5: run the local demo web server with the lab bearer in its environment only.
import { spawn } from "node:child_process";
import { join } from "node:path";
import * as common from "./common.mjs";

const SERVER = join(common.REPO_ROOT, "web", "server.mjs");

export const options = { port: { type: "string", default: "8787" }, host: { type: "string", default: "127.0.0.1" } };
export const help = `--port 8787  --host 127.0.0.1`;

export async function run(values) {
  const state = common.loadState();
  common.requireKeys(state, "lab_web");
  const labWeb = state.lab_web.outputs;
  const bearer = state.lab_session_bearer ? String(state.lab_session_bearer) : await common.secretValue(labWeb.LabSessionBearerArn, common.regionOf(state));
  const env = {
    ...process.env,
    LAB_SESSION_API_URL: labWeb.DirectSessionUrl,
    LAB_SESSION_BEARER: bearer,
    LAB_WEB_HOST: values.host,
    LAB_WEB_PORT: String(values.port),
    LAB_WEB_ROOT: join(common.REPO_ROOT, "web"),
  };
  console.log(`Serving the browser demo at http://${values.host}:${values.port} (Ctrl-C to stop).`);
  console.log("Session ids are printed here as calls start; pass one to `verify-web --session-id`.");
  const child = spawn(process.execPath, [SERVER], { env, stdio: "inherit" });
  const forward = (signal) => () => child.kill(signal);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  await new Promise((done) => child.on("close", (code) => done(process.exitCode = code ?? 0)));
}
