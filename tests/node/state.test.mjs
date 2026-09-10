import assert from "node:assert/strict";
import test from "node:test";
import { LabError } from "../../scripts/lib/common.mjs";
import { staleDeployments } from "../../scripts/lib/reap.mjs";
import { buildHandout, decryptJson, encryptJson } from "../../scripts/lib/state_cmd.mjs";

const STATE = { region: "us-west-2", deployment_id: "alice", created_at: "2026-09-01T00:00:00.000Z", bridgefu: { outputs: { VapiAssistantId: "a1" } } };

test("handout carries the state and records whether the bearer is included", () => {
  const plain = buildHandout(STATE);
  assert.equal(plain.deployment_id, "alice");
  assert.equal(plain.handout.includes_web_bearer, false);
  assert.ok(!("lab_session_bearer" in plain));
  const withBearer = buildHandout(STATE, { webBearer: "bearer-value" });
  assert.equal(withBearer.lab_session_bearer, "bearer-value");
  assert.equal(withBearer.handout.includes_web_bearer, true);
  assert.deepEqual(STATE.bridgefu, { outputs: { VapiAssistantId: "a1" } }, "source state is not mutated");
});

test("encrypted handouts round-trip and reject the wrong passphrase", () => {
  const envelope = encryptJson(buildHandout(STATE, { webBearer: "secret" }), "correct horse battery");
  assert.equal(envelope.encrypted, true);
  assert.ok(!JSON.stringify(envelope).includes("secret"));
  assert.equal(decryptJson(envelope, "correct horse battery").lab_session_bearer, "secret");
  assert.throws(() => decryptJson(envelope, "wrong passphrase"), LabError);
  assert.throws(() => encryptJson({}, "short"), LabError);
  assert.throws(() => decryptJson({ encrypted: false }, "x"), LabError);
});

test("reaper selects only labs older than the limit", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  const entries = [
    { deployment_id: "old", created_at: "2026-09-01T00:00:00Z" },
    { deployment_id: "fresh", created_at: "2026-09-09T12:00:00Z" },
    { deployment_id: "nodate" },
    { deployment_id: "baddate", created_at: "yesterday" },
  ];
  assert.deepEqual(staleDeployments(entries, 3, now), ["old"]);
  assert.deepEqual(staleDeployments(entries, 30, now), []);
});
