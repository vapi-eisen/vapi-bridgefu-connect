// Talks to the lab gateway (lambda/lab_gateway) for remote mode. The gateway URL
// is committed in remote-lab.json by the lab owner (`owner deploy` writes it);
// $LAB_GATEWAY_URL overrides it. Every call carries the engineer's GitHub token
// from `gh auth token`: the gateway uses it to check repository access and
// never stores it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError } from "./common.mjs";

export const CONFIG_PATH = join(common.REPO_ROOT, "remote-lab.json");

export function gatewayUrl(explicit) {
  let url = explicit ?? process.env.LAB_GATEWAY_URL;
  if (!url && existsSync(CONFIG_PATH)) {
    try {
      url = JSON.parse(readFileSync(CONFIG_PATH, "utf8")).gateway_url;
    } catch {
      throw new LabError(`${CONFIG_PATH} is not valid JSON`);
    }
  }
  if (!url) throw new LabError("no lab gateway is configured (remote-lab.json); the lab owner runs `node scripts/lab.mjs owner deploy` (docs/09-remote-lab.md)");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(url)) throw new LabError(`the lab gateway URL ${JSON.stringify(url)} must be https://host/`);
  return url.replace(/\/+$/, "");
}

let tokenCache;
export async function githubToken() {
  if (tokenCache) return tokenCache;
  const fromEnv = (process.env.LAB_GITHUB_TOKEN ?? "").trim();
  if (fromEnv) return (tokenCache = fromEnv);
  const binary = common.ghBinary();
  if (!binary) throw new LabError("the GitHub CLI is not installed; run: node scripts/lab.mjs remote doctor --fix");
  const completed = await common.run(binary, ["auth", "token"], { timeout: 30_000 });
  const token = completed.stdout.trim();
  if (completed.code !== 0 || !token) throw new LabError("you are not signed in to GitHub; run: node scripts/lab.mjs remote doctor --fix");
  return (tokenCache = token);
}

/** One gateway call; the gateway's error message becomes the LabError. */
export async function call(method, path, body, { gateway, timeout = 60_000 } = {}) {
  const url = `${gatewayUrl(gateway)}${path}`;
  const headers = { authorization: `Bearer ${await githubToken()}`, accept: "application/json", "user-agent": common.USER_AGENT };
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    throw new LabError(`could not reach the lab gateway: ${error.message}`);
  }
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { error: text.slice(0, 300) };
  }
  if (!response.ok) throw new LabError(`lab gateway ${method} ${path}: ${value.error ?? response.status}`);
  return value;
}

let configCache;
export async function labConfig(options = {}) {
  configCache ??= await call("GET", "/config", undefined, options);
  return configCache;
}
