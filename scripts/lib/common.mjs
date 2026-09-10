// Shared helpers for the lab CLI (Node 22+, zero dependencies, AWS CLI for AWS).
//
// Rules every module follows:
// - secrets are read when needed and never written to state, printed, or logged;
// - every AWS call goes through aws() so failures show the service error text;
// - state (.lab/state.json) holds identifiers only.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LAB_DIR = join(REPO_ROOT, ".lab");
export const STATE_PATH = join(LAB_DIR, "state.json");

export const PUBLISHED_TEMPLATE_URL =
  "https://bridgefu-vapi-awsconnect-225478700523-us-east-1.s3.us-east-1.amazonaws.com/latest/cloudformation/template.yaml";
export const SUPPORTED_REGIONS = ["us-west-2", "us-east-1"];
export const PREFERRED_REGION = "us-west-2";
export const VAPI_SIGNALING_CIDRS = ["44.229.228.186/32", "44.238.177.138/32"];
export const INSTANCE_TYPES = ["t4g.medium", "t4g.large", "t4g.xlarge", "t4g.2xlarge", "c7g.large", "c7g.xlarge", "c7g.2xlarge", "m7g.large", "m7g.xlarge", "m7g.2xlarge"];
export const DEFAULT_INSTANCE_TYPE = "t4g.medium";
export const VAPI_BASE_URL = "https://api.vapi.ai";
export const USER_AGENT = "vapi-bridgefu-connect-lab/1";
export const PROJECT_TAG = "vapi-bridgefu-connect";

export const DEPLOYMENT_ID = /^[a-z][a-z0-9-]{2,23}$/;
export const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
export const CORRELATION_ID = /^bf1_[A-Za-z0-9_-]{43}$/;
export const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export class LabError extends Error {}
export class VapiAmbiguousWrite extends LabError {}

export function log(message) {
  process.stderr.write(`[lab] ${message}\n`);
}
export function warn(message) {
  process.stderr.write(`[lab] WARNING: ${message}\n`);
}
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------ state
export function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (error) {
    throw new LabError(`${STATE_PATH} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LabError(`${STATE_PATH} must contain a JSON object`);
  return value;
}

export function saveState(state) {
  mkdirSync(LAB_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${STATE_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, sortedReplacer, 2) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, STATE_PATH);
}

function sortedReplacer(_key, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
  }
  return value;
}

export function requireKeys(state, ...keys) {
  const missing = keys.filter((key) => !(key in state));
  if (missing.length) throw new LabError(`state is missing ${missing.join(", ")}; run the earlier stage first`);
}
export function regionOf(state) {
  requireKeys(state, "region");
  return String(state.region);
}
export function deploymentIdOf(state) {
  requireKeys(state, "deployment_id");
  return String(state.deployment_id);
}
export function stackNames(state) {
  const deployment = deploymentIdOf(state);
  return { connect: `bridgefu-${deployment}-connect-lab`, bridgefu: `bridgefu-${deployment}`, lab_web: `bridgefu-${deployment}-lab-web` };
}
export function labBucketName(state) {
  requireKeys(state, "account_id", "region");
  return `vapi-bridgefu-connect-lab-${state.account_id}-${state.region}`;
}

// ------------------------------------------------------------------ processes
export function run(command, args, { input, timeout = 300_000, cwd, env } = {}) {
  return new Promise((done, fail) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (error) {
      return fail(new LabError(`${command} could not start: ${error.message}`));
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new LabError(`${command} ${args.slice(0, 2).join(" ")} timed out`));
    }, timeout);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new LabError(error.code === "ENOENT" ? `${command} is not installed or not on PATH` : `${command} failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

/** Run one AWS CLI command. output: "json" (parsed) | "text" (trimmed) | "none". */
export async function aws(args, { region, output = "json", input, timeout = 300_000, allowFailure = false } = {}) {
  const command = [...args];
  if (region) command.push("--region", region);
  if (output !== "none") command.push("--output", output);
  const completed = await run("aws", command, { input, timeout });
  if (completed.code !== 0) {
    if (allowFailure) return null;
    const detail = (completed.stderr || completed.stdout).trim();
    throw new LabError(`aws ${args.slice(0, 2).join(" ")} failed: ${detail.slice(0, 600)}`);
  }
  if (output === "json") {
    const text = completed.stdout.trim();
    return text ? JSON.parse(text) : null;
  }
  if (output === "text") return completed.stdout.trim();
  return null;
}

export async function callerIdentity(region) {
  const value = await aws(["sts", "get-caller-identity"], { region });
  if (!value || !value.Account) throw new LabError("could not read the AWS caller identity; run `aws login` or configure credentials");
  return { accountId: String(value.Account), arn: String(value.Arn ?? "") };
}

export async function secretValue(arn, region) {
  const value = await aws(["secretsmanager", "get-secret-value", "--secret-id", arn, "--query", "SecretString"], { region, output: "text" });
  if (!value) throw new LabError(`secret ${fingerprint(arn)} has no SecretString`);
  return value;
}

export async function putSecretValue(arn, value, region) {
  await aws(["secretsmanager", "put-secret-value", "--secret-id", arn, "--secret-string", "file:///dev/stdin"], { region, input: value, output: "none" });
}

export async function stackStatus(name, region) {
  const value = await aws(["cloudformation", "describe-stacks", "--stack-name", name, "--query", "Stacks[0].StackStatus"], { region, output: "text", allowFailure: true });
  return value || null;
}

export async function stackOutputs(name, region) {
  const value = await aws(["cloudformation", "describe-stacks", "--stack-name", name, "--query", "Stacks[0].Outputs"], { region });
  const outputs = {};
  for (const item of value ?? []) if (item && item.OutputKey) outputs[item.OutputKey] = String(item.OutputValue ?? "");
  return outputs;
}

export async function stackParameters(name, region) {
  const value = await aws(["cloudformation", "describe-stacks", "--stack-name", name, "--query", "Stacks[0].Parameters"], { region });
  const parameters = {};
  for (const item of value ?? []) if (item && item.ParameterKey) parameters[item.ParameterKey] = String(item.ParameterValue ?? "");
  return parameters;
}

/** Human-readable failure reasons, descending into failed nested stacks. */
export async function failedStackEvents(name, region, depth = 0) {
  const lines = [];
  const events = await aws(["cloudformation", "describe-stack-events", "--stack-name", name, "--max-items", "200"], { region, allowFailure: true });
  for (const event of events?.StackEvents ?? []) {
    const status = String(event.ResourceStatus ?? "");
    if (!status.endsWith("_FAILED")) continue;
    const reason = String(event.ResourceStatusReason ?? "").trim();
    if (/cancelled/i.test(reason)) continue;
    const type = String(event.ResourceType ?? "");
    lines.push(`${"  ".repeat(depth)}${event.LogicalResourceId} (${type}): ${reason.slice(0, 400)}`);
    if (type === "AWS::CloudFormation::Stack" && depth < 3 && String(event.PhysicalResourceId ?? "").startsWith("arn:")) {
      lines.push(...(await failedStackEvents(event.PhysicalResourceId, region, depth + 1)));
    }
  }
  return lines;
}

export async function waitForStack(name, region, { success, timeoutSeconds, pollSeconds = 20 }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last;
  while (Date.now() < deadline) {
    const status = await stackStatus(name, region);
    if (status !== last) {
      log(`${name}: ${status ?? "absent"}`);
      last = status;
    }
    if (success.includes(status)) return status;
    if (status === null && success.includes("DELETE_COMPLETE")) return "DELETE_COMPLETE";
    if (status && (status.endsWith("_FAILED") || status.includes("ROLLBACK")) && !status.endsWith("_IN_PROGRESS")) {
      const detail = await failedStackEvents(name, region);
      throw new LabError(`stack ${name} ended in ${status}.\n${detail.length ? detail.join("\n") : "no failure events found"}`);
    }
    await sleep(pollSeconds * 1000);
  }
  throw new LabError(`stack ${name} did not finish within ${Math.floor(timeoutSeconds / 60)} minutes (last status ${last})`);
}

export function parameterArgs(parameters) {
  return ["--parameters", ...Object.entries(parameters).map(([key, value]) => `ParameterKey=${key},ParameterValue=${value}`)];
}

/** Values containing commas or quotes must travel as a JSON file, not shorthand. */
export function parameterFileArgs(parameters, path) {
  mkdirSync(LAB_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }))));
  return ["--parameters", `file://${path}`];
}

// ------------------------------------------------------------------ Vapi API
let vapiKeyCache = null;

/** The Vapi private key comes from the environment or the lab's Secrets Manager secret. */
export async function vapiApiKey(state) {
  if (vapiKeyCache) return vapiKeyCache;
  let key = (process.env.VAPI_PRIVATE_KEY ?? "").trim();
  if (!key) {
    requireKeys(state, "vapi_secret_arn", "region");
    key = (await secretValue(String(state.vapi_secret_arn), regionOf(state))).trim();
  }
  if (key.length < 8 || key.length > 1024) throw new LabError("the Vapi private key has an unexpected length");
  vapiKeyCache = key;
  return key;
}

export async function vapiRequest(state, method, path, payload, { allowMissing = false, timeout = 30_000 } = {}) {
  if (!path.startsWith("/") || path.includes("..")) throw new LabError("Vapi API path is invalid");
  const headers = { authorization: `Bearer ${await vapiApiKey(state)}`, accept: "application/json", "user-agent": USER_AGENT };
  let body;
  if (payload !== undefined && payload !== null) {
    body = JSON.stringify(payload);
    headers["content-type"] = "application/json";
  }
  const write = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  let response;
  try {
    response = await fetch(VAPI_BASE_URL + path, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    if (write) throw new VapiAmbiguousWrite(`Vapi ${method} ${path} did not complete: ${error.message}`);
    throw new LabError(`Vapi ${method} ${path} request failed: ${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    if (allowMissing && response.status === 404) return null;
    if (write && response.status >= 500) throw new VapiAmbiguousWrite(`Vapi ${method} ${path} returned HTTP ${response.status}`);
    throw new LabError(`Vapi ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new LabError(`Vapi ${method} ${path} returned invalid JSON`);
  }
}

export async function vapiList(state, resource, { limit = 100 } = {}) {
  let value = await vapiRequest(state, "GET", `/${resource}?limit=${limit}`);
  if (value && !Array.isArray(value) && Array.isArray(value.results)) value = value.results;
  if (!Array.isArray(value)) throw new LabError(`Vapi GET /${resource} returned an unexpected shape`);
  return value.filter((item) => item && typeof item === "object");
}

// ------------------------------------------------------------------ utilities
export function fingerprint(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12);
}
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function confirm(question, assumeYes) {
  if (assumeYes) return;
  if (!process.stdin.isTTY) throw new LabError(`confirmation required for: ${question} (re-run with --yes)`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((done) => rl.question(`${question} [y/N] `, done));
  rl.close();
  if (!["y", "yes"].includes(answer.trim().toLowerCase())) throw new LabError("cancelled");
}

export async function promptSecret(label) {
  if (!process.stdin.isTTY) throw new LabError(`${label} must be supplied via the environment when not interactive`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const original = rl._writeToOutput;
  rl._writeToOutput = (text) => {
    if (text.startsWith(`${label}: `)) original.call(rl, `${label}: `);
  };
  const value = await new Promise((done) => rl.question(`${label}: `, done));
  rl._writeToOutput = original;
  rl.close();
  process.stdout.write("\n");
  if (!value.trim()) throw new LabError(`${label} was empty`);
  return value.trim();
}

export function printTable(rows) {
  const width = Math.max(0, ...rows.map(([key]) => key.length));
  for (const [key, value] of rows) console.log(`  ${key.padEnd(width)}  ${value}`);
}

export async function httpGet(url, { timeout = 20_000 } = {}) {
  try {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    throw new LabError(`GET ${url} failed: ${error.message}`);
  }
}

export async function publicIpv4() {
  const raw = (await httpGet("https://checkip.amazonaws.com", { timeout: 10_000 })).trim();
  if (!IPV4.test(raw)) throw new LabError("could not determine this machine's public IPv4 address");
  return raw;
}

export async function commandVersion(command, flag = "--version") {
  try {
    const completed = await run(command, [flag], { timeout: 30_000 });
    if (completed.code !== 0) return null;
    return (completed.stdout || completed.stderr).trim().split("\n")[0];
  } catch {
    return null;
  }
}

export function nowIso() {
  return new Date().toISOString();
}
