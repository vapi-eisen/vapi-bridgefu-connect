import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const UPSTREAM = process.env.LAB_UPSTREAM_REPO ?? join(homedir(), "Developer", "bridgefu-vapi-awsconnect");

export function pythonAvailable() {
  return spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
}

export function upstreamAvailable(relative) {
  return existsSync(join(UPSTREAM, relative));
}

/** Run a Python snippet with the upstream module directory on sys.path; returns stdout. */
export function runUpstreamPython(moduleDir, code) {
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8", env: { ...process.env, PYTHONPATH: join(UPSTREAM, moduleDir) } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

export function bashSyntaxOk(script) {
  return spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status === 0;
}
