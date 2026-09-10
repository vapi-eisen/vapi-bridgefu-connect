import assert from "node:assert/strict";
import test from "node:test";
import { pythonAvailable, runUpstreamPython, upstreamAvailable } from "./helpers.mjs";
import { deriveCorrelationId, decodeItem } from "../../scripts/lib/verify.mjs";

test("correlation id has the released shape and depends on the call", () => {
  const key = Buffer.from("k".repeat(64));
  const value = deriveCorrelationId(key, "lab", "org-1", "call-1");
  assert.match(value, /^bf1_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(value, deriveCorrelationId(key, "lab", "org-1", "call-2"));
});

test("matches the released prepare Lambda derivation", { skip: !pythonAvailable() || !upstreamAvailable("lambda/common/bridgefu_handoff.py") ? "python3 or upstream checkout unavailable" : false }, () => {
  const theirs = runUpstreamPython(
    "lambda/common",
    'import bridgefu_handoff as m\nprint(m.derive_correlation_id(b"k" * 64, "lab", m.VapiIdentity(org_id="org-123", call_id="call-456")))',
  ).trim();
  assert.equal(deriveCorrelationId(Buffer.from("k".repeat(64)), "lab", "org-123", "call-456"), theirs);
});

test("DynamoDB items decode to plain values", () => {
  assert.deepEqual(decodeItem({ a: { S: "x" }, n: { N: "42" }, m: { M: { b: { BOOL: true } } } }), { a: "x", n: 42, m: { b: true } });
});
