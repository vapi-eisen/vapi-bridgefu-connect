import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { ROOT } from "./helpers.mjs";

const LAB = join(ROOT, "scripts", "lab.mjs");

test("help lists every stage", () => {
  const result = spawnSync(process.execPath, [LAB, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const command of ["preflight", "connect", "bridgefu", "vapi", "verify-phone", "web-setup", "web-serve", "verify-web", "web-overlay", "status", "remote", "key", "teardown"]) {
    assert.ok(result.stdout.includes(command), command);
  }
});

test("unknown options are rejected with the command help", () => {
  const result = spawnSync(process.execPath, [LAB, "connect", "--bogus"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /agent-username/);
});

test("status without state is friendly", () => {
  const result = spawnSync(process.execPath, [LAB, "status", "--no-aws"], { encoding: "utf8", env: { ...process.env, HOME: process.env.HOME } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No lab state yet|region/);
});
