// Engineer side of remote mode. Everything here runs without AWS credentials:
// the AWS stages run in CodeBuild in the owner's lab account, started through
// the lab gateway (lambda/lab_gateway), and these commands only talk to that
// gateway (with the engineer's GitHub sign-in), the Vapi CLI login, and the
// local machine. Claude Code runs them; the engineer's only manual moments are
// signing in to GitHub and Vapi in the browser and using the phone or the demo page.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, log } from "./common.mjs";
import * as doctor from "./doctor.mjs";
import * as gateway from "./gateway_client.mjs";
import * as keyWrap from "./key_wrap.mjs";
import * as stateCmd from "./state_cmd.mjs";

export const REMOTE_PATH = join(common.LAB_DIR, "remote.json");

export const options = {
  engineer: { type: "string" },
  repo: { type: "string" },
  gateway: { type: "string" },
  stages: { type: "string", default: "phone" },
  "client-cidr": { type: "string" },
  "area-code": { type: "string", default: "415" },
  "runtime-filter": { type: "string" },
  "agent-auto-accept": { type: "string", default: "true" },
  "connect-alias": { type: "string" },
  "vapi-account": { type: "string" },
  "vapi-login": { type: "boolean", default: false },
  "skip-vapi-check": { type: "boolean", default: false },
  wait: { type: "boolean", default: false },
  "no-wait": { type: "boolean", default: false },
  "timeout-minutes": { type: "string", default: "60" },
  job: { type: "string" },
  mode: { type: "string", default: "phone" },
  "since-minutes": { type: "string", default: "30" },
  "session-id": { type: "string" },
  "keep-connect": { type: "boolean", default: false },
  fix: { type: "boolean", default: false },
};

export const help = `remote doctor [--fix]
    Checks Node, the GitHub CLI and its sign-in, access to this repository, the lab gateway, the Vapi CLI and its
    sign-in. With --fix it installs the CLIs, signs you in (relaying the GitHub one-time code), and accepts the invitation.
remote provision --engineer <handle> [--stages phone|full] [--client-cidr x.x.x.x/32|auto] [--vapi-account <name>] [--vapi-login]
                 [--area-code 415] [--agent-auto-accept true|false] [--connect-alias <alias>]
    Takes your Vapi key from the Vapi CLI login (opening the dashboard to sign in when needed), wraps it for the lab
    account, makes a handout keypair in .lab/, and starts the provision job through the lab gateway. Prints the job id.
remote handout --engineer <handle> [--wait] [--timeout-minutes 60] [--job <id>]
    Imports the encrypted handout of the provision job (with --wait: after waiting for the job to finish).
remote agent
    Opens the Agent Workspace and puts the lab agent password on your clipboard.
remote verify --engineer <handle> --mode phone|web [--since-minutes 30] [--session-id <id>] [--runtime-filter '?sip ?INVITE']
    Runs verify in the lab account, waits, and prints the report.
remote teardown --engineer <handle> [--keep-connect] [--no-wait]
    Runs teardown in the lab account and waits for it; the lab and the secret holding your key are removed.
All of them accept --gateway https://... to override remote-lab.json.`;

// ------------------------------------------------------------ pure helpers
/** Builds the gateway's provision request; pure so the shape is testable. */
export function provisionInputs({ engineer, stages, clientCidr = "", areaCode = "415", agentAutoAccept = "true", connectAlias = "", wrapped, handoutPublicKey }) {
  keyWrap.assertEngineer(engineer);
  if (!["phone", "full"].includes(stages)) throw new LabError("--stages must be phone or full");
  if (stages === "full" && !clientCidr) throw new LabError("--client-cidr is required for the full lab (auto detects your public IPv4)");
  if (clientCidr && !/^\d{1,3}(\.\d{1,3}){3}\/32$/.test(clientCidr)) throw new LabError("--client-cidr must be x.x.x.x/32");
  if (!/^\d{3}$/.test(areaCode)) throw new LabError("--area-code must be three digits");
  if (!["true", "false"].includes(agentAutoAccept)) throw new LabError("--agent-auto-accept must be true or false");
  if (connectAlias && !/^[a-z0-9-]{1,45}$/.test(connectAlias)) throw new LabError("--connect-alias must be lowercase letters, digits, hyphens");
  if (!keyWrap.isCiphertext(wrapped)) throw new LabError("the wrapped key is missing");
  if (!handoutPublicKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(handoutPublicKey)) throw new LabError("the handout public key must be base64 DER");
  return { engineer, stages, client_cidr: clientCidr, area_code: areaCode, agent_auto_accept: agentAutoAccept, connect_alias: connectAlias, vapi_key_wrapped: wrapped, handout_public_key: handoutPublicKey };
}

/** Reuses the handout keypair in .lab/ or makes one; returns the base64 DER public half. */
export function ensureHandoutKeypair(path = stateCmd.HANDOUT_KEY_PATH) {
  let pem;
  if (existsSync(path)) {
    pem = readFileSync(path, "utf8");
  } else {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    pem = privateKey.export({ type: "pkcs8", format: "pem" });
    mkdirSync(common.LAB_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, pem, { mode: 0o600 });
    log(`made a handout keypair at ${path}; only this machine can open the handout`);
  }
  return createPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");
}

function readRemote() {
  if (!existsSync(REMOTE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REMOTE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeRemote(value) {
  mkdirSync(common.LAB_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(REMOTE_PATH, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function timeoutMinutes(values) {
  const minutes = Number(values["timeout-minutes"]);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) throw new LabError("--timeout-minutes must be between 1 and 240");
  return minutes;
}

function assertJob(job) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(job ?? ""))) throw new LabError("--job must be a job id printed by remote provision, verify, or teardown");
  return String(job);
}

// ------------------------------------------------------------ gateway jobs
const jobPath = (engineer, job) => `/jobs/${engineer}/${job}`;

/** Waits for a job to finish, logging the current step when it changes and every couple of minutes. */
export async function waitForJob(values, engineer, job, { minutes, pollMs = 20_000 } = {}) {
  const deadline = Date.now() + minutes * 60_000;
  let lastStep = "";
  let lastLog = 0;
  while (Date.now() < deadline) {
    const view = await gateway.call("GET", jobPath(engineer, job), undefined, { gateway: values.gateway });
    if (view.done) return view;
    const step = view.step ?? view.status;
    if (step !== lastStep || Date.now() - lastLog > 120_000) {
      log(`job ${job}: ${step}`);
      lastStep = step;
      lastLog = Date.now();
    }
    await common.sleep(pollMs);
  }
  throw new LabError(`job ${job} did not finish within ${minutes} minutes; it keeps running, re-run with --wait later`);
}

/** Turns a finished, unsuccessful job into an error that carries the end of its log. */
function jobFailure(view, what) {
  if (view.log_tail?.length) process.stderr.write(`--- last lines of the ${what} job log ---\n${view.log_tail.join("\n")}\n---\n`);
  return new LabError(`${what} job ${view.job} ended with ${view.status}${view.failed_step ? ` at step: ${view.failed_step}` : ""}`);
}

// ------------------------------------------------------------ commands
export async function provision(values) {
  const engineer = keyWrap.assertEngineer(values.engineer);
  let clientCidr = values["client-cidr"] ?? "";
  if (clientCidr === "auto") clientCidr = `${await common.publicIpv4()}/32`;
  const base = { engineer, stages: values.stages, clientCidr, areaCode: values["area-code"], agentAutoAccept: values["agent-auto-accept"], connectAlias: values["connect-alias"] ?? "" };
  provisionInputs({ ...base, wrapped: "A".repeat(256), handoutPublicKey: "AAAA" }); // validate before touching the key
  const config = await gateway.labConfig({ gateway: values.gateway });
  const key = await keyWrap.obtainKey(values);
  const wrapped = keyWrap.wrapPayload(keyWrap.buildWrapPayload({ engineer, key }), config.wrap_public_key);
  const handoutPublicKey = ensureHandoutKeypair();
  const started = await gateway.call("POST", "/provision", provisionInputs({ ...base, wrapped, handoutPublicKey }), { gateway: values.gateway });
  writeRemote({ engineer, provision_job: started.job, commit: started.commit, started_at: common.nowIso() });
  log(`provision job ${started.job} started in the lab account (code at ${String(started.commit ?? "").slice(0, 7)}) as GitHub user ${config.you}`);
  log(`your key travelled only as ciphertext; the job keeps it in secret bridgefu/${engineer}/vapi-private-key until teardown`);
  log(`next: node scripts/lab.mjs remote handout --engineer ${engineer} --wait   (20-40 minutes)`);
  process.stdout.write(`${started.job}\n`);
}

export async function handout(values) {
  const engineer = keyWrap.assertEngineer(values.engineer);
  const remote = readRemote();
  let job = values.job ?? (remote.engineer === engineer ? remote.provision_job : null);
  if (!job) {
    const lab = await gateway.call("GET", `/labs/${engineer}`, undefined, { gateway: values.gateway });
    if (lab.last_action !== "provision") throw new LabError(`the last job of ${engineer} was ${lab.last_action}, not provision; pass --job <id>`);
    job = lab.last_job;
  }
  job = assertJob(job);
  let view;
  if (values.wait) {
    log(`waiting for provision job ${job} (up to ${timeoutMinutes(values)} minutes)`);
    view = await waitForJob(values, engineer, job, { minutes: timeoutMinutes(values) });
  } else {
    view = await gateway.call("GET", jobPath(engineer, job), undefined, { gateway: values.gateway });
    if (!view.done) throw new LabError(`provision job ${job} is still running (${view.step ?? view.status}); use --wait`);
  }
  if (view.status !== "SUCCEEDED") throw jobFailure(view, "provision");
  if (!view.handout) throw new LabError(`provision job ${job} finished but its handout is gone (handouts are kept for 2 days); re-run remote provision`);
  mkdirSync(common.LAB_DIR, { recursive: true, mode: 0o700 });
  const file = join(common.LAB_DIR, "handout.download.json");
  writeFileSync(file, JSON.stringify(view.handout), { mode: 0o600 });
  try {
    await stateCmd.run({ out: "handout.json", "with-web-bearer": false, "with-agent-password": false, "key-file": stateCmd.HANDOUT_KEY_PATH, force: true, "if-exists": false }, ["import", file]);
  } finally {
    rmSync(file, { force: true });
  }
  const state = common.loadState();
  state.remote = { engineer, gateway: gateway.gatewayUrl(values.gateway) };
  common.saveState(state);
  summary(state);
}

function summary(state) {
  const connect = state.connect?.outputs ?? {};
  const phone = state.vapi?.phone;
  const rows = [
    ["deployment", String(state.deployment_id ?? "-")],
    ["dial-in", phone ? String(phone.number ?? phone.sipUri ?? phone.id) : "-"],
    ["agent workspace", String(connect.ConnectLoginUrl ?? "-")],
    ["agent username", String(connect.AgentUsername ?? "-")],
    ["agent password", state.lab_agent_password ? "run: node scripts/lab.mjs remote agent" : "ask the lab owner"],
  ];
  if (state.lab_web) rows.push(["browser demo", "run: node scripts/lab.mjs web-serve   then open http://127.0.0.1:8787"]);
  common.printTable(rows);
}

export async function agent() {
  const state = common.loadState();
  const connect = state.connect?.outputs ?? {};
  if (!connect.ConnectLoginUrl) throw new LabError("no Connect lab in the state; import the handout first (remote handout)");
  const password = state.lab_agent_password;
  if (!password) throw new LabError("the handout did not include the agent password; ask the lab owner for it");
  const username = String(connect.AgentUsername ?? "lab-agent");
  if (common.copyToClipboard(String(password))) {
    log("the agent password is on your clipboard");
  } else {
    const file = join(common.LAB_DIR, "agent-password.txt");
    writeFileSync(file, `${password}\n`, { mode: 0o600 });
    log(`no clipboard tool found; the agent password is in ${file}`);
  }
  const opened = common.openInBrowser(String(connect.ConnectLoginUrl));
  log(opened ? "opened the Agent Workspace in your browser" : `open ${connect.ConnectLoginUrl}`);
  common.printTable([
    ["agent workspace", String(connect.ConnectLoginUrl)],
    ["username", username],
    ["password", "pasted from your clipboard"],
    ["then", "set yourself Available before calling"],
  ]);
}

export async function verify(values) {
  const engineer = keyWrap.assertEngineer(values.engineer);
  if (!["phone", "web"].includes(values.mode)) throw new LabError("--mode must be phone or web");
  if (!/^\d{1,4}$/.test(values["since-minutes"])) throw new LabError("--since-minutes must be a number");
  const body = { engineer, mode: values.mode, since_minutes: values["since-minutes"], session_id: values["session-id"] ?? "", runtime_filter: values["runtime-filter"] ?? "" };
  const started = await gateway.call("POST", "/verify", body, { gateway: values.gateway });
  log(`verify job ${started.job} started`);
  const view = await waitForJob(values, engineer, started.job, { minutes: Math.min(timeoutMinutes(values), 30), pollMs: 10_000 });
  if (view.report) process.stdout.write(view.report);
  else log("the job left no report");
  if (view.status !== "SUCCEEDED") throw jobFailure(view, "verify");
}

export async function teardown(values) {
  const engineer = keyWrap.assertEngineer(values.engineer);
  const body = { engineer, keep_connect: values["keep-connect"] ? "true" : "false" };
  const started = await gateway.call("POST", "/teardown", body, { gateway: values.gateway });
  log(`teardown job ${started.job} started`);
  if (values["no-wait"]) return;
  const view = await waitForJob(values, engineer, started.job, { minutes: timeoutMinutes(values) });
  if (view.status !== "SUCCEEDED") throw jobFailure(view, "teardown");
  for (const file of [common.STATE_PATH, REMOTE_PATH, join(common.LAB_DIR, "agent-password.txt")]) rmSync(file, { force: true });
  log(`lab ${engineer} is gone, including the secret that held your Vapi key; local state cleared`);
}

export async function run(values, positionals) {
  const [action] = positionals;
  if (action === "doctor") return doctor.doctor(values);
  if (action === "provision") return provision(values);
  if (action === "handout") return handout(values);
  if (action === "agent") return agent(values);
  if (action === "verify") return verify(values);
  if (action === "teardown") return teardown(values);
  throw new LabError(`remote needs an action: doctor | provision | handout | agent | verify | teardown\n${help}`);
}
