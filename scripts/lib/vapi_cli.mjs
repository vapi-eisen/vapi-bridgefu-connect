// Reads the engineer's Vapi key from the official Vapi CLI instead of asking
// anyone to paste it. `vapi auth login` is a browser handoff: the CLI listens on
// 127.0.0.1, the Vapi dashboard signs the engineer in, lets them pick an org,
// and posts an API key back, which the CLI stores in ~/.vapi-cli.yaml. `vapi
// auth token` only prints a masked key, so we read that file directly. Nothing
// here prints a key.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LabError, log } from "./common.mjs";

export const CONFIG_CANDIDATES = [".vapi-cli.yaml", ".vapi-cli.yml"];
export const INSTALL_HINT = "install the Vapi CLI with `curl -sSL https://vapi.ai/install.sh | bash`, then re-run; it signs you in through the Vapi dashboard";

export function configPath(home = homedir()) {
  for (const name of CONFIG_CANDIDATES) {
    const path = join(home, name);
    if (existsSync(path)) return path;
  }
  return null;
}

function unquote(value) {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

/** Minimal YAML reader for the flat/nested maps of scalars the Vapi CLI writes. */
export function parseVapiCliConfig(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const match = /^([^:]+?):(?:\s+(.*))?$/.exec(line.trim());
    if (!match) continue;
    const key = unquote(match[1]);
    const value = match[2] === undefined ? "" : match[2].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (value === "" || value === "{}") {
      parent[key] = value === "{}" ? {} : {};
      stack.push({ indent, node: parent[key] });
    } else {
      parent[key] = unquote(value);
    }
  }
  return root;
}

export function readConfig() {
  const path = configPath();
  if (!path) return {};
  try {
    return parseVapiCliConfig(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LabError(`could not read ${path}: ${error.message}`);
  }
}

/** Account list without keys, safe to print. */
export function listAccounts(config) {
  const accounts = config?.accounts && typeof config.accounts === "object" ? config.accounts : {};
  return Object.entries(accounts).map(([name, account]) => ({
    name,
    organization: String(account?.organization ?? ""),
    email: String(account?.email ?? ""),
    active: name === config.active_account,
  }));
}

export function describeAccounts(accounts) {
  return accounts.map((a) => `  - ${a.name}${a.organization ? ` (${a.organization})` : ""}${a.email ? ` <${a.email}>` : ""}${a.active ? "  [active]" : ""}`).join("\n");
}

/** Chooses one login. With several logins the caller must name one, so the engineer picks the org. */
export function pickAccount(config, requested) {
  const accounts = listAccounts(config);
  const withKey = (account) => {
    const key = String(config.accounts?.[account.name]?.apikey ?? "").trim();
    if (!key) throw new LabError(`the Vapi CLI account ${account.name} has no stored key; run: vapi auth login`);
    return { name: account.name, organization: account.organization, key };
  };
  if (requested) {
    const hit = accounts.find((a) => a.name === requested);
    if (!hit) throw new LabError(`no Vapi CLI login named ${JSON.stringify(requested)}; known logins:\n${describeAccounts(accounts) || "  (none)"}`);
    return withKey(hit);
  }
  if (accounts.length === 1) return withKey(accounts[0]);
  if (accounts.length > 1) {
    throw new LabError(`the Vapi CLI is logged into ${accounts.length} orgs; choose one with --vapi-account <name>:\n${describeAccounts(accounts)}`);
  }
  const legacy = String(config.api_key ?? "").trim();
  if (legacy) return { name: "default", organization: "", key: legacy };
  throw new LabError("the Vapi CLI has no login yet; run: vapi auth login");
}

export function vapiCliInstalled() {
  const result = spawnSync("vapi", ["--version"], { stdio: "ignore", timeout: 10_000 });
  return !result.error && result.status === 0;
}

/** Runs `vapi auth login` and relays its progress lines (the browser URL) to stderr. */
export function login({ timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("vapi", ["auth", "login"], { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    const relay = (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) log(`vapi: ${line}`);
      }
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new LabError(`the Vapi login was not completed within ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new LabError(error.code === "ENOENT" ? INSTALL_HINT : `vapi auth login failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) log(`vapi: ${buffer.trim()}`);
      code === 0 ? resolve() : reject(new LabError(`vapi auth login exited with code ${code}`));
    });
  });
}

/** The engineer's key from the Vapi CLI, logging in through the browser first when needed. */
export async function keyFromVapiCli({ account, forceLogin = false, timeoutMs } = {}) {
  let config = readConfig();
  const accounts = listAccounts(config);
  if (forceLogin || (accounts.length === 0 && !String(config.api_key ?? "").trim())) {
    log(accounts.length ? "starting another Vapi login: a browser page opens, sign in and pick the org" : "no Vapi login yet: a browser page opens, sign in and pick your org");
    await login({ timeoutMs });
    config = readConfig();
  }
  return pickAccount(config, account);
}
