import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { HttpError, isAdmin, jobIdOf, jobView, mayUse, provisionJob, teardownJob, verifyJob } from "../../lambda/lab_gateway/index.mjs";

const PUBLIC_DER = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
const WRAPPED = "A".repeat(512);
const KEY = "0f8d1c2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";

test("provision requests are validated down to the fields the runner reads", () => {
  const job = provisionJob({ engineer: "alice", stages: "full", client_cidr: "203.0.113.7/32", vapi_key_wrapped: WRAPPED, handout_public_key: PUBLIC_DER, extra: "ignored" });
  assert.deepEqual(Object.keys(job).sort(), ["action", "agent_auto_accept", "area_code", "client_cidr", "connect_alias", "engineer", "handout_public_key", "stages", "vapi_key_wrapped"]);
  assert.equal(job.action, "provision");
  assert.equal(job.area_code, "415");
  const bad = (body, pattern) => assert.throws(() => provisionJob({ engineer: "alice", vapi_key_wrapped: WRAPPED, handout_public_key: PUBLIC_DER, ...body }), (error) => error instanceof HttpError && error.status === 400 && pattern.test(error.message));
  bad({ engineer: "Alice" }, /engineer/);
  bad({ stages: "full" }, /client_cidr/);
  bad({ stages: "phone", client_cidr: "0.0.0.0/0" }, /client_cidr/);
  bad({ vapi_key_wrapped: KEY }, /RAW Vapi key/);
  bad({ vapi_key_wrapped: "short" }, /ciphertext/);
  bad({ handout_public_key: "" }, /handout_public_key/);
  bad({ area_code: "41" }, /area_code/);
  bad({ connect_alias: "Bad Alias" }, /connect_alias/);
  bad({ area_code: { $ne: 1 } }, /strings/);
});

test("verify and teardown requests are validated", () => {
  assert.deepEqual(verifyJob({ engineer: "alice", mode: "web", session_id: "abc_1" }), { action: "verify", engineer: "alice", mode: "web", since_minutes: "30", session_id: "abc_1", runtime_filter: "" });
  assert.throws(() => verifyJob({ engineer: "alice", mode: "sms" }), /mode/);
  assert.throws(() => verifyJob({ engineer: "alice", runtime_filter: "a\nb" }), /one line/);
  assert.throws(() => verifyJob({ engineer: "alice", session_id: "x; rm -rf /" }), /session_id/);
  assert.deepEqual(teardownJob({ engineer: "alice", keep_connect: true }), { action: "teardown", engineer: "alice", keep_connect: "true" });
  assert.throws(() => teardownJob({ engineer: "alice", keep_connect: "maybe" }), /keep_connect/);
});

test("a lab belongs to the GitHub account that provisioned it, and admins", () => {
  const record = { github_id: 42, github_login: "alice" };
  assert.ok(mayUse(null, { id: 7, login: "bob" }, ""), "an unclaimed handle is free");
  assert.ok(mayUse(record, { id: 42, login: "renamed-alice" }, ""), "ownership follows the numeric id, not the login");
  assert.ok(!mayUse(record, { id: 7, login: "bob" }, ""));
  assert.ok(mayUse(record, { id: 7, login: "Owner" }, "owner, other"));
  assert.ok(isAdmin("OTHER", "owner, other"));
  assert.ok(!isAdmin("", ""));
});

test("job views never leak the request and carry artifacts and the log tail", () => {
  const build = {
    id: "BridgeFuLabRunner:0f8d1c2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f",
    buildStatus: "FAILED",
    currentPhase: "COMPLETED",
    startTime: new Date("2026-10-13T10:00:00Z"),
    endTime: new Date("2026-10-13T10:20:00Z"),
    environment: { environmentVariables: [{ name: "LAB_JOB", value: JSON.stringify({ action: "provision", engineer: "alice", vapi_key_wrapped: WRAPPED }) }] },
  };
  assert.equal(jobIdOf(build.id), "0f8d1c2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f");
  const view = jobView(build, { progress: { step: "failed at: Stage 2 Bridgefu", failed_step: "Stage 2 Bridgefu" }, logTail: ["boom"] });
  assert.equal(view.engineer, "alice");
  assert.equal(view.done, true);
  assert.equal(view.failed_step, "Stage 2 Bridgefu");
  assert.deepEqual(view.log_tail, ["boom"]);
  assert.ok(!JSON.stringify(view).includes(WRAPPED), "the wrapped key stays in CodeBuild");
  assert.equal(jobView({ ...build, buildStatus: "IN_PROGRESS" }).done, false);
});
