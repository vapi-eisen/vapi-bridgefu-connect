import assert from "node:assert/strict";
import test from "node:test";
import { bashSyntaxOk, pythonAvailable, runUpstreamPython, upstreamAvailable } from "./helpers.mjs";
import { buildRuntimeConfig, canonicalJson, encodeConfig, renderHaproxy, renderScript, statusScript } from "../../scripts/lib/web_runtime.mjs";
import { LabError } from "../../scripts/lib/common.mjs";

const INPUTS = {
  region: "us-west-2",
  deploymentId: "lab",
  sipHostname: "bridgefu-lab.example.com",
  publicIp: "203.0.113.10",
  connectInstanceArn: "arn:aws:connect:us-west-2:123456789012:instance/11111111-1111-4111-8111-111111111111",
  connectFlowId: "22222222-2222-4222-8222-222222222222",
  vapiSipUsername: "lab_0123456789abcdef",
  wssPort: 8443,
};
const REPLACEMENTS = {
  REGION: "us-west-2",
  SOURCE_PREFIX: "s3://vapi-bridgefu-connect-lab-123456789012-us-west-2/runtime/abc123",
  CONFIG_SHA: "a".repeat(64),
  HAPROXY_SHA: "b".repeat(64),
  SIP_AUTH_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:bridgefu/lab/lab/vapi-sip-auth-AbCdEf",
  WSS_PORT: "8443",
};

test("public WSS listener and advertised URI agree", () => {
  const config = buildRuntimeConfig(INPUTS);
  assert.equal(config.generic_bridge.webrtc_ws_bind, "0.0.0.0:8443");
  assert.equal(config.api.route_attachments.webrtc.signaling_uri, "wss://bridgefu-lab.example.com:8443/webrtc");
  assert.deepEqual(config.webrtc_profiles["lab-browser"].allowed_signaling_origins, ["wss://bridgefu-lab.example.com:8443"]);
  assert.ok(config.api.tls);
});

test("phone recipe preserved, both routes present, deployment id carried", () => {
  const config = buildRuntimeConfig(INPUTS);
  assert.equal(config.recipes.support.use, "builtin:vapi-amazon-connect-screen-pop@1");
  assert.deepEqual(Object.keys(config.api.routes).sort(), ["amazon-connect", "vapi-direct-assistant"]);
  assert.equal(config.api.routes["vapi-direct-assistant"].destination.endpoint.config.uri, "sip:lab_0123456789abcdef@sip.vapi.ai:5061;transport=tls");
  assert.equal(config.api.routes["amazon-connect"].destination.endpoint.config.contact_flow_id, INPUTS.connectFlowId);
  assert.deepEqual(config.context.allow_headers, { "X-Correlation-Id": "correlation_id", "X-Bridgefu_Handoff_Token": "handoff_token" });
  assert.equal(config.persistence.deployment_id, "lab");
});

test("STUN follows the region", () => {
  const east = buildRuntimeConfig({ ...INPUTS, region: "us-east-1", connectInstanceArn: INPUTS.connectInstanceArn.replace("us-west-2", "us-east-1") });
  assert.deepEqual(east.generic_bridge.webrtc.ice_servers, [{ urls: ["stun:stun.kinesisvideo.us-east-1.amazonaws.com:443"] }]);
});

test("encoding is canonical and secret-free", () => {
  const config = buildRuntimeConfig(INPUTS);
  const encoded = encodeConfig(config);
  assert.ok(encoded.endsWith("\n"));
  assert.deepEqual(JSON.parse(encoded), JSON.parse(canonicalJson(config)));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  const leaked = JSON.parse(JSON.stringify(config));
  leaked.sip_profiles["lab-vapi-assistant"].auth.password = "plaintext-password-value";
  assert.throws(() => encodeConfig(leaked), LabError);
});

test("matches the qualified upstream overlay except the documented deltas", { skip: !pythonAvailable() || !upstreamAvailable("qualification/bridgefu_web_runtime.py") ? "python3 or upstream checkout unavailable" : false }, () => {
  const theirs = runUpstreamPython(
    "qualification",
    `import json, bridgefu_web_runtime as m
print(json.dumps(m.build_runtime_config(region="us-west-2", deployment_id="lab", sip_hostname="bridgefu-lab.example.com", public_ip="203.0.113.10", connect_instance_arn="${INPUTS.connectInstanceArn}", connect_flow_id="${INPUTS.connectFlowId}", vapi_sip_username="lab_0123456789abcdef", signaling_port=8443), sort_keys=True))`,
  )
    .replaceAll("qualification-browser", "lab-browser")
    .replaceAll("qualification-vapi-assistant", "lab-vapi-assistant")
    .replaceAll("BRIDGEFU_QUALIFICATION_VAPI_SIP_PASSWORD", "BRIDGEFU_LAB_VAPI_SIP_PASSWORD")
    .replaceAll('"127.0.0.1:8080"', '"0.0.0.0:8443"');
  assert.deepEqual(JSON.parse(theirs), JSON.parse(canonicalJson(buildRuntimeConfig(INPUTS))));
});

test("HAProxy keeps the release paths and adds the lab route", () => {
  const rendered = renderHaproxy("10.42.1.23");
  assert.match(rendered, /bind 10\.42\.1\.23:443 ssl crt \/etc\/haproxy\/bridgefu\.pem/);
  assert.match(rendered, /\/v1\/routes\/support\/calls/);
  assert.match(rendered, /\/v1\/routes\/vapi-direct-assistant\/calls/);
  assert.match(rendered, /\/replace\$/);
  assert.doesNotMatch(rendered, /__/);
});

test("install and restore scripts render without placeholders or blank lines and parse in bash", () => {
  for (const [name, replacements] of [["install.sh.tmpl", REPLACEMENTS], ["restore.sh.tmpl", {}]]) {
    const script = renderScript(name, replacements);
    assert.doesNotMatch(script, /__[A-Z_]+__/, name);
    assert.ok(script.split("\n").every((line) => line.trim()), `${name} has a blank line`);
    assert.ok(bashSyntaxOk(script), `${name} failed bash -n`);
  }
  assert.ok(bashSyntaxOk(statusScript()));
});

test("install script refuses unexpected values", () => {
  assert.throws(() => renderScript("install.sh.tmpl", { ...REPLACEMENTS, WSS_PORT: "8443; rm -rf /" }), LabError);
});
