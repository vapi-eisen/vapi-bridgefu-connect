import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import test from "node:test";
import { LabError } from "../../scripts/lib/common.mjs";
import { WRAP_TTL_SECONDS, buildWrapPayload, isCiphertext, looksLikeRawVapiKey, parseUnwrapped, wrapPayload } from "../../scripts/lib/key_wrap.mjs";
import { provisionInputs } from "../../scripts/lib/remote.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_DER = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const KEY = "0f8d1c2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

// Stands in for KMS Decrypt with RSAES_OAEP_SHA_256.
function kmsDecrypt(ciphertext) {
  return privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(ciphertext, "base64"));
}

test("wrapped keys round-trip through RSA-OAEP and are bound to one engineer for one hour", () => {
  const payload = buildWrapPayload({ engineer: "alice", key: ` ${KEY}\n`, now: NOW });
  assert.equal(payload.exp, NOW / 1000 + WRAP_TTL_SECONDS);
  const ciphertext = wrapPayload(payload, PUBLIC_DER);
  assert.ok(isCiphertext(ciphertext));
  assert.ok(!ciphertext.includes(KEY));
  assert.equal(parseUnwrapped(kmsDecrypt(ciphertext), { engineer: "alice", now: NOW + 60_000 }), KEY);
  assert.throws(() => parseUnwrapped(kmsDecrypt(ciphertext), { engineer: "bob", now: NOW }), /made for engineer "alice"/);
  assert.throws(() => parseUnwrapped(kmsDecrypt(ciphertext), { engineer: "alice", now: NOW + (WRAP_TTL_SECONDS + 1) * 1000 }), /expired/);
});

test("PEM public keys work too and OAEP randomises every ciphertext", () => {
  const pem = publicKey.export({ format: "pem", type: "spki" });
  const payload = buildWrapPayload({ engineer: "alice", key: KEY, now: NOW });
  const first = wrapPayload(payload, pem);
  const second = wrapPayload(payload, PUBLIC_DER);
  assert.notEqual(first, second);
  assert.equal(parseUnwrapped(kmsDecrypt(first), { engineer: "alice", now: NOW }), KEY);
});

test("bad material is rejected before anything is encrypted or stored", () => {
  assert.throws(() => buildWrapPayload({ engineer: "Alice", key: KEY }), LabError);
  assert.throws(() => buildWrapPayload({ engineer: "alice", key: "short" }), LabError);
  assert.throws(() => buildWrapPayload({ engineer: "alice", key: "has a space inside" }), LabError);
  assert.throws(() => wrapPayload(buildWrapPayload({ engineer: "alice", key: KEY }), "not a key"), LabError);
  assert.throws(() => parseUnwrapped(Buffer.from("not json"), { engineer: "alice" }), /not JSON/);
  assert.throws(() => parseUnwrapped(Buffer.from(JSON.stringify({ v: 2, engineer: "alice", key: KEY, exp: 9e9 })), { engineer: "alice" }), /version/);
  assert.ok(looksLikeRawVapiKey(KEY));
  assert.ok(!looksLikeRawVapiKey("abc"));
  assert.ok(!isCiphertext(KEY), "a raw key must never pass as ciphertext");
});

test("provision inputs carry the wrapped key and never a raw one", () => {
  const wrapped = wrapPayload(buildWrapPayload({ engineer: "alice", key: KEY, now: NOW }), PUBLIC_DER);
  const inputs = provisionInputs({ engineer: "alice", stages: "full", clientCidr: "203.0.113.7/32", wrapped, passphrase: "correct horse" });
  assert.deepEqual(Object.keys(inputs).sort(), ["agent_auto_accept", "area_code", "client_cidr", "connect_alias", "engineer", "passphrase", "stages", "vapi_key_wrapped"]);
  assert.equal(inputs.vapi_key_wrapped, wrapped);
  assert.ok(!JSON.stringify(inputs).includes(KEY));
  assert.throws(() => provisionInputs({ engineer: "alice", stages: "full", wrapped }), /client-cidr/);
  assert.throws(() => provisionInputs({ engineer: "alice", stages: "phone", wrapped: KEY }), /wrapped key/);
  assert.throws(() => provisionInputs({ engineer: "alice", stages: "phone", wrapped, passphrase: "short" }), /passphrase/);
  const keyed = provisionInputs({ engineer: "alice", stages: "phone", wrapped, handoutPublicKey: PUBLIC_DER });
  assert.equal(keyed.handout_public_key, PUBLIC_DER);
  assert.ok(!("passphrase" in keyed));
  assert.throws(() => provisionInputs({ engineer: "alice", stages: "phone", wrapped, handoutPublicKey: "not base64!" }), /base64/);
});
