import assert from "node:assert/strict";
import test from "node:test";
import { gatewayPackage, parameterOverrides } from "../../scripts/lib/owner.mjs";
import { plan } from "../../scripts/lib/runner.mjs";

const ENV = { LAB_STATE_BUCKET: "bucket", AWS_REGION: "us-west-2", LAB_HOSTED_ZONE_ID: "Z1", LAB_HOSTED_ZONE_NAME: "lab.example.com", LAB_WRAP_KEY_ARN: "arn:aws:kms:us-west-2:1:key/k" };
const names = (steps) => steps.map((step) => step.name);

test("provision runs the same stages the workflow did, saving state even after a failure", () => {
  const steps = plan({ action: "provision", engineer: "alice", stages: "full", client_cidr: "203.0.113.7/32", area_code: "212", agent_auto_accept: "true", connect_alias: "", vapi_key_wrapped: "W", handout_public_key: "P" }, ENV);
  assert.deepEqual(names(steps), ["Restore saved state", "Unwrap the Vapi key into this lab's secret", "Preflight", "Stage 1 Amazon Connect", "Stage 2 Bridgefu", "Stage 3 Vapi wiring", "Stage 5 browser path", "Save state", "Write the handout", "Summary"]);
  const byName = Object.fromEntries(steps.map((step) => [step.name, step]));
  assert.deepEqual(byName["Unwrap the Vapi key into this lab's secret"].env, { LAB_WRAPPED_KEY: "W" });
  assert.ok(!byName["Unwrap the Vapi key into this lab's secret"].args.includes("W"), "the wrapped key travels in the environment, not argv");
  assert.ok(byName.Preflight.args.includes("bridgefu-alice.lab.example.com"));
  assert.ok(byName["Save state"].always);
  assert.deepEqual(byName["Write the handout"].args.slice(-4), ["--with-web-bearer", "--with-agent-password", "--encrypt-to", "P"]);
  assert.ok(byName["Stage 3 Vapi wiring"].args.includes("212"));
  const phone = plan({ action: "provision", engineer: "alice", stages: "phone", vapi_key_wrapped: "W", handout_public_key: "P", connect_alias: "alice-2" }, ENV);
  assert.ok(!names(phone).includes("Stage 5 browser path"));
  assert.ok(phone.find((step) => step.name === "Preflight").args.includes("alice-2"));
});

test("verify, teardown and reap plans", () => {
  const verify = plan({ action: "verify", engineer: "alice", mode: "web", since_minutes: "15", session_id: "s1", runtime_filter: "?sip" }, ENV);
  assert.deepEqual(verify[1].args, ["verify-web", "--since-minutes", "15", "--session-id", "s1"]);
  assert.ok(verify[1].report);
  assert.deepEqual(verify[1].env, { LAB_RUNTIME_FILTER: "?sip" });
  const teardown = plan({ action: "teardown", engineer: "alice", keep_connect: "true" }, ENV);
  assert.deepEqual(names(teardown), ["Restore saved state", "Teardown", "Forget the lab", "Keep partial state for a retry"]);
  assert.ok(teardown[1].args.includes("--keep-connect"));
  assert.equal(teardown[3].when, "failure");
  const reap = plan({ action: "reap", max_age_days: "3", dry_run: "true" }, ENV);
  assert.deepEqual(reap[0].args, ["reap", "--bucket", "bucket", "--max-age-days", "3", "--yes", "--dry-run"]);
  assert.throws(() => plan({ action: "provision", engineer: "Alice" }, ENV), /engineer/);
  assert.throws(() => plan({ action: "verify", engineer: "alice", mode: "phone" }, { AWS_REGION: "us-west-2" }), /LAB_STATE_BUCKET/);
  assert.throws(() => plan({ action: "shell", engineer: "alice" }, ENV), /unknown job action/);
});

test("the gateway package is deterministic and owner params are checked", () => {
  const first = gatewayPackage(Buffer.from("export const handler = () => 1;\n"));
  const second = gatewayPackage(Buffer.from("export const handler = () => 1;\n"));
  assert.equal(first.key, second.key);
  assert.match(first.key, /^gateway\/[0-9a-f]{16}\.zip$/);
  assert.notEqual(gatewayPackage(Buffer.from("x")).key, first.key);
  assert.deepEqual(parameterOverrides(["BudgetEmail=a@b.c"]), ["BudgetEmail=a@b.c"]);
  assert.throws(() => parameterOverrides(["--bad"]), /Key=Value/);
});
