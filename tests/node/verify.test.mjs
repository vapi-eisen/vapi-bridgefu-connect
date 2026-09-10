import assert from "node:assert/strict";
import test from "node:test";
import { logFilterFor, transferVerdict } from "../../scripts/lib/verify.mjs";

const forwarded = [{ status: "ended", endedReason: "assistant-forwarded-call" }];
const hungUp = [{ status: "ended", endedReason: "customer-ended-call" }];
const prepared = [{ handoff_status: "PREPARED" }];
const mapped = [{ handoff_status: "MAPPED" }];

test("phone path passes on a forwarded call and fails on a call that ended without transferring", () => {
  assert.equal(transferVerdict("phone", forwarded, []), "PASS");
  assert.match(transferVerdict("phone", hungUp, []), /^FAIL/);
  assert.equal(transferVerdict("phone", [], []), "UNKNOWN");
});

test("direct path treats customer-ended-call plus a fired handoff tool as success", () => {
  assert.match(transferVerdict("web", hungUp, prepared), /^PASS \(direct path/);
  assert.match(transferVerdict("web", [{ status: "in-progress" }], prepared), /^PASS \(handoff tool fired/);
  assert.match(transferVerdict("web", hungUp, mapped), /^FAIL/);
  assert.equal(transferVerdict("web", [], mapped), "UNKNOWN");
});

test("runtime log group uses a JSON level filter, Lambda groups use text patterns", () => {
  const runtime = logFilterFor("/bridgefu/lab/runtime", "/bridgefu/lab/runtime");
  assert.match(runtime.pattern, /\$\.level = "ERROR"/);
  assert.match(runtime.label, /error-level/);
  const lambda = logFilterFor("/aws/lambda/bridgefu-lab-prepare", "/bridgefu/lab/runtime");
  assert.equal(lambda.pattern, "?ERROR ?Traceback ?internal_error");
});

test("redactLogLine keeps readable fields and hides ids, tokens, and opaque blobs", async () => {
  const { redactLogLine } = await import("../../scripts/lib/verify.mjs");
  const id = `bf1_${"a".repeat(43)}`;
  const line = JSON.stringify({ level: "ERROR", target: "bridgefu::sip", message: `INVITE failed for ${id}`, sip_status: 403, token: "x".repeat(50), sdp: "v=0\\r\\n".repeat(50) });
  const out = redactLogLine(line);
  assert.match(out, /level=ERROR/);
  assert.match(out, /sip_status=403/);
  assert.ok(!out.includes(id));
  assert.ok(!out.includes("x".repeat(50)));
  assert.ok(!out.includes("v=0"));
  assert.equal(redactLogLine("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer <redacted>");
  assert.ok(redactLogLine(`plain ${id}`, { reveal: true }).includes(id));
  assert.ok(redactLogLine("y".repeat(1000)).length < 400);
});
