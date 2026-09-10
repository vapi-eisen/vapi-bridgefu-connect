// Engineer side of remote mode. Everything here runs without AWS credentials:
// the AWS stages happen inside GitHub Actions in the owner's lab account, and
// these commands only talk to GitHub (`gh`), the Vapi CLI login, and the local
// machine. Claude Code runs them; the engineer's only manual moments are
// signing in to Vapi in the browser and using the phone or the demo page.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, log } from "./common.mjs";
import * as doctor from "./doctor.mjs";
import * as keyWrap from "./key_wrap.mjs";
import * as stateCmd from "./state_cmd.mjs";

export const PROVISION_WORKFLOW = "lab-provision.yml";
export const VERIFY_WORKFLOW = "lab-verify.yml";
export const TEARDOWN_WORKFLOW = "lab-teardown.yml";
export const REMOTE_PATH = join(common.LAB_DIR, "remote.json");

export const options = {
  engineer: { type: "string" },
  repo: { type: "string" },
  ref: { type: "string" },
  stages: { type: "string", default: "phone" },
  "client-cidr": { type: "string" },
  "area-code": { type: "string", default: "415" },
  "agent-auto-accept": { type: "string", default: "true" },
  "connect-alias": { type: "string" },
  "vapi-account": { type: "string" },
  "vapi-login": { type: "boolean", default: false },
  "skip-vapi-check": { type: "boolean", default: false },
  wait: { type: "boolean", default: false },
  "no-wait": { type: "boolean", default: false },
  "timeout-minutes": { type: "string", default: "60" },
  run: { type: "string" },
  dir: { type: "string", default: ".lab-handout" },
  mode: { type: "string", default: "phone" },
  "since-minutes": { type: "string", default: "30" },
  "session-id": { type: "string" },
  "keep-connect": { type: "boolean", default: false },
  fix: { type: "boolean", default: false },
};

export const help = `remote doctor [--fix]
    Checks Node, the GitHub CLI and its sign-in, access to this repository, the owner's setup, the Vapi CLI and its
    sign-in. With --fix it installs the CLIs, signs you in (relaying the GitHub one-time code), and accepts the invitation.
remote provision --engineer <handle> [--stages phone|full] [--client-cidr x.x.x.x/32|auto] [--vapi-account <name>] [--vapi-login]
                 [--area-code 415] [--agent-auto-accept true|false] [--connect-alias <alias>] [--repo owner/name] [--ref main]
    Takes your Vapi key from the Vapi CLI login (opening the dashboard to sign in when needed), wraps it for the lab
    account, makes a handout keypair in .lab/, and dispatches ${PROVISION_WORKFLOW}. Prints the run URL.
remote handout --engineer <handle> [--wait] [--timeout-minutes 60] [--run <id>]
    Downloads and imports the encrypted handout of the provision run (with --wait: after waiting for the run to finish).
remote agent
    Opens the Agent Workspace and puts the lab agent password on your clipboard.
remote verify --engineer <handle> --mode phone|web [--since-minutes 30] [--session-id <id>]
    Runs ${VERIFY_WORKFLOW}, waits, and prints the report.
remote teardown --engineer <handle> [--keep-connect] [--no-wait]
    Runs ${TEARDOWN_WORKFLOW} and waits for it; the lab and the secret holding your key are removed.`;

// ------------------------------------------------------------ pure helpers
/** Builds the workflow_dispatch inputs; pure so the shape is testable. */
export function provisionInputs({ engineer, stages, clientCidr = "", areaCode = "415", agentAutoAccept = "true", connectAlias = "", wrapped, handoutPublicKey = "", passphrase = "" }) {
  keyWrap.assertEngineer(engineer);
  if (!["phone", "full"].includes(stages)) throw new LabError("--stages must be phone or full");
  if (stages === "full" && !clientCidr) throw new LabError("--client-cidr is required for the full lab (auto detects your public IPv4)");
  if (clientCidr && !/^\d{1,3}(\.\d{1,3}){3}\/32$/.test(clientCidr)) throw new LabError("--client-cidr must be x.x.x.x/32");
  if (!/^\d{3}$/.test(areaCode)) throw new LabError("--area-code must be three digits");
  if (!["true", "false"].includes(agentAutoAccept)) throw new LabError("--agent-auto-accept must be true or false");
  if (connectAlias && !/^[a-z0-9-]{1,45}$/.test(connectAlias)) throw new LabError("--connect-alias must be lowercase letters, digits, hyphens");
  if (!keyWrap.isCiphertext(wrapped)) throw new LabError("the wrapped key is missing");
  if (handoutPublicKey && !/^[A-Za-z0-9+/]+={0,2}$/.test(handoutPublicKey)) throw new LabError("the handout public key must be base64 DER");
  if (passphrase && passphrase.length < 8) throw new LabError("the handout passphrase must have at least 8 characters");
  const inputs = { engineer, stages, client_cidr: clientCidr, area_code: areaCode, agent_auto_accept: agentAutoAccept, connect_alias: connectAlias, vapi_key_wrapped: wrapped };
  if (handoutPublicKey) inputs.handout_public_key = handoutPublicKey;
  if (passphrase) inputs.passphrase = passphrase;
  return inputs;
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

// ------------------------------------------------------------ GitHub runs
async function dispatch(repo, workflow, inputs, ref) {
  const since = Date.now() - 5_000;
  const args = ["workflow", "run", workflow, "--repo", repo, "--json"];
  if (ref) args.push("--ref", ref);
  await keyWrap.gh(args, { input: JSON.stringify(inputs) });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await common.sleep(5_000);
    const text = await keyWrap.gh(["run", "list", "--repo", repo, "--workflow", workflow, "--limit", "5", "--json", "databaseId,createdAt,url,event"], { allowFailure: true });
    const runs = text ? JSON.parse(text) : [];
    const mine = runs.filter((run) => run.event === "workflow_dispatch" && Date.parse(run.createdAt) >= since).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (mine.length) return { id: String(mine[0].databaseId), url: String(mine[0].url) };
  }
  throw new LabError(`dispatched ${workflow} but could not find the run; check gh run list --repo ${repo}`);
}

/** Waits for a run to complete, logging the current step every couple of minutes. */
export async function waitForRun(repo, id, { minutes, pollMs = 20_000 } = {}) {
  const deadline = Date.now() + minutes * 60_000;
  let lastStep = "";
  let lastLog = 0;
  while (Date.now() < deadline) {
    const text = await keyWrap.gh(["run", "view", id, "--repo", repo, "--json", "status,conclusion,jobs,url"]);
    const run = JSON.parse(text);
    if (run.status === "completed") {
      const failed = (run.jobs ?? []).flatMap((job) => (job.steps ?? []).filter((step) => step.conclusion === "failure").map((step) => step.name));
      return { conclusion: String(run.conclusion), failedSteps: failed, url: String(run.url) };
    }
    const current = (run.jobs ?? []).flatMap((job) => job.steps ?? []).find((step) => step.status === "in_progress")?.name ?? run.status;
    if (current !== lastStep || Date.now() - lastLog > 120_000) {
      log(`run ${id}: ${current}`);
      lastStep = current;
      lastLog = Date.now();
    }
    await common.sleep(pollMs);
  }
  throw new LabError(`run ${id} did not finish within ${minutes} minutes; it keeps running, re-run with --wait later`);
}

async function downloadArtifact(repo, runIds, artifact, dir) {
  mkdirSync(dir, { recursive: true });
  for (const id of runIds) {
    const result = await keyWrap.gh(["run", "download", id, "--repo", repo, "--name", artifact, "--dir", dir], { allowFailure: true });
    if (result !== null) return id;
  }
  return null;
}

async function recentRuns(repo, workflow, { status = "success", limit = 20 } = {}) {
  const text = await keyWrap.gh(["run", "list", "--repo", repo, "--workflow", workflow, "--status", status, "--limit", String(limit), "--json", "databaseId", "--jq", ".[].databaseId"]);
  return text.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
}

// ------------------------------------------------------------ commands
export async function provision(values) {
  const engineer = keyWrap.assertEngineer(values.engineer);
  let clientCidr = values["client-cidr"] ?? "";
  if (clientCidr === "auto") clientCidr = `${await common.publicIpv4()}/32`;
  const base = { engineer, stages: values.stages, clientCidr, areaCode: values["area-code"], agentAutoAccept: values["agent-auto-accept"], connectAlias: values["connect-alias"] ?? "" };
  provisionInputs({ ...base, wrapped: "A".repeat(256) }); // validate before touching the key
  const repo = await keyWrap.resolveRepo(values.repo);
  const material = await keyWrap.fetchPublicKey(repo);
  const key = await keyWrap.obtainKey(values);
  const wrapped = keyWrap.wrapPayload(keyWrap.buildWrapPayload({ engineer, key }), material);
  const handoutPublicKey = ensureHandoutKeypair();
  const inputs = provisionInputs({ ...base, wrapped, handoutPublicKey });
  const run = await dispatch(repo, PROVISION_WORKFLOW, inputs, values.ref);
  writeRemote({ repo, engineer, provision_run_id: run.id, provision_run_url: run.url, dispatched_at: common.nowIso() });
  log(`provision run started: ${run.url}`);
  log(`your key travelled only as ciphertext; the run keeps it in secret bridgefu/${engineer}/vapi-private-key until teardown`);
  log(`next: node scripts/lab.mjs remote handout --engineer ${engineer} --wait   (20-40 minutes)`);
  process.stdout.write(`${run.url}\n`);
}

export async function handout(values) {
  const engineer = keyWrap.assertEngineer(values.engineer);
  const remote = readRemote();
  const repo = await keyWrap.resolveRepo(values.repo ?? remote.repo);
  const artifact = `lab-handout-${engineer}`;
  let runId = values.run ?? (remote.engineer === engineer ? remote.provision_run_id : null) ?? null;
  if (runId && !/^\d+$/.test(String(runId))) throw new LabError("--run must be a numeric run id");
  if (values.wait) {
    if (!runId) throw new LabError("no provision run is recorded for this handle; pass --run <id>");
    log(`waiting for provision run ${runId} (up to ${timeoutMinutes(values)} minutes)`);
    const result = await waitForRun(repo, String(runId), { minutes: timeoutMinutes(values) });
    if (result.conclusion !== "success") {
      throw new LabError(`provision run ${runId} ended with ${result.conclusion}${result.failedSteps.length ? ` at step: ${result.failedSteps.join(", ")}` : ""}; see ${result.url}`);
    }
  }
  const candidates = runId ? [String(runId)] : await recentRuns(repo, PROVISION_WORKFLOW);
  const downloaded = await downloadArtifact(repo, candidates, artifact, values.dir);
  if (!downloaded) throw new LabError(`no finished provision run carries artifact ${artifact}; if the run is still going, use --wait (artifacts also expire after 2 days)`);
  const file = join(values.dir, "handout.json");
  if (!existsSync(file)) throw new LabError(`downloaded ${artifact} from run ${downloaded} but ${file} is missing`);
  log(`downloaded ${artifact} from run ${downloaded}`);
  await stateCmd.run({ out: "handout.json", "with-web-bearer": false, "with-agent-password": false, "key-file": stateCmd.HANDOUT_KEY_PATH, force: true, "if-exists": false }, ["import", file]);
  const state = common.loadState();
  state.remote = { repo, engineer };
  common.saveState(state);
  rmSync(values.dir, { recursive: true, force: true });
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
  const remote = readRemote();
  const repo = await keyWrap.resolveRepo(values.repo ?? remote.repo);
  const inputs = { engineer, mode: values.mode, since_minutes: values["since-minutes"], session_id: values["session-id"] ?? "", reveal: "false" };
  const run = await dispatch(repo, VERIFY_WORKFLOW, inputs, values.ref);
  log(`verify run started: ${run.url}`);
  const result = await waitForRun(repo, run.id, { minutes: Math.min(timeoutMinutes(values), 30) });
  const dir = join(values.dir, "verify");
  const downloaded = await downloadArtifact(repo, [run.id], `lab-verify-${engineer}-${values.mode}`, dir);
  const file = join(dir, "verify.log");
  if (downloaded && existsSync(file)) {
    process.stdout.write(readFileSync(file, "utf8"));
    rmSync(dir, { recursive: true, force: true });
  } else {
    log(`no report artifact; read the run summary at ${result.url}`);
  }
  if (result.conclusion !== "success") throw new LabError(`verify run ended with ${result.conclusion}; see ${result.url}`);
}

export async function teardown(values) {
  const engineer = keyWrap.assertEngineer(values.engineer);
  const remote = readRemote();
  const repo = await keyWrap.resolveRepo(values.repo ?? remote.repo);
  const inputs = { engineer, keep_connect: values["keep-connect"] ? "true" : "false" };
  const run = await dispatch(repo, TEARDOWN_WORKFLOW, inputs, values.ref);
  log(`teardown run started: ${run.url}`);
  if (values["no-wait"]) return;
  const result = await waitForRun(repo, run.id, { minutes: timeoutMinutes(values) });
  if (result.conclusion !== "success") {
    throw new LabError(`teardown run ended with ${result.conclusion}${result.failedSteps.length ? ` at step: ${result.failedSteps.join(", ")}` : ""}; re-run remote teardown; see ${result.url}`);
  }
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
