import assert from "node:assert/strict";
import test from "node:test";
import { LabError } from "../../scripts/lib/common.mjs";
import { staleDeployments } from "../../scripts/lib/reap.mjs";
import { generateKeyPairSync } from "node:crypto";
import { agentPasswordFrom, buildHandout, decryptJson, decryptJsonWithPrivateKey, encryptJson, encryptJsonToPublicKey } from "../../scripts/lib/state_cmd.mjs";

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

test("handouts encrypted to the engineer's keypair open only with that private key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const publicDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const handout = buildHandout(STATE, { webBearer: "bearer-value", agentPassword: "agent-pw" });
  assert.equal(handout.handout.includes_agent_password, true);
  const envelope = encryptJsonToPublicKey(handout, publicDer);
  assert.equal(envelope.kdf, "rsa-oaep-sha256");
  const text = JSON.stringify(envelope);
  assert.ok(!text.includes("agent-pw") && !text.includes("bearer-value"));
  const opened = decryptJsonWithPrivateKey(envelope, privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.equal(opened.lab_agent_password, "agent-pw");
  assert.equal(opened.lab_session_bearer, "bearer-value");
  assert.throws(() => decryptJsonWithPrivateKey(envelope, other.export({ type: "pkcs8", format: "pem" })), /different handout key/);
  assert.throws(() => decryptJson(envelope, "some passphrase"), /not a passphrase-encrypted/);
});

test("the agent password is read from the Connect secret in either shape", () => {
  assert.equal(agentPasswordFrom(JSON.stringify({ username: "lab-agent", password: "P4ssw0rd" })), "P4ssw0rd");
  assert.equal(agentPasswordFrom("bare-password\n"), "bare-password");
});
