import assert from "node:assert/strict";
import test from "node:test";
import { LabError } from "../../scripts/lib/common.mjs";
import { listAccounts, parseVapiCliConfig, pickAccount } from "../../scripts/lib/vapi_cli.mjs";

const CONFIG = `# written by the Vapi CLI
active_account: acme
base_url: https://api.vapi.ai
disable_analytics: false
accounts:
    acme:
        apikey: 11111111-2222-3333-4444-555555555555
        organization: "Acme Voice"
        org_id: org_acme
        email: alice@acme.example
        logintime: 2026-09-10T12:00:00Z
    sandbox:
        apikey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        organization: Alice Sandbox
timeout: 30
`;

test("the Vapi CLI config parses into accounts without leaking keys in the listing", () => {
  const config = parseVapiCliConfig(CONFIG);
  assert.equal(config.active_account, "acme");
  assert.equal(config.accounts.acme.apikey, "11111111-2222-3333-4444-555555555555");
  assert.equal(config.accounts.acme.organization, "Acme Voice");
  assert.equal(config.accounts.sandbox.apikey, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(config.timeout, "30");
  const listed = listAccounts(config);
  assert.deepEqual(listed.map((a) => [a.name, a.organization, a.active]), [["acme", "Acme Voice", true], ["sandbox", "Alice Sandbox", false]]);
  assert.ok(!JSON.stringify(listed).includes("1111"), "listings never carry keys");
});

test("with several logins the engineer must choose; with one it is used; legacy keys still work", () => {
  const config = parseVapiCliConfig(CONFIG);
  assert.throws(() => pickAccount(config), /logged into 2 orgs[\s\S]*acme[\s\S]*sandbox/);
  assert.equal(pickAccount(config, "sandbox").key, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.throws(() => pickAccount(config, "nope"), LabError);
  const single = parseVapiCliConfig("accounts:\n  only:\n    apikey: 99999999-2222-3333-4444-555555555555\n    organization: Solo\n");
  assert.equal(pickAccount(single).organization, "Solo");
  assert.equal(pickAccount(parseVapiCliConfig("api_key: legacy-key-value-000\n")).key, "legacy-key-value-000");
  assert.throws(() => pickAccount(parseVapiCliConfig("")), /no login yet/);
});
