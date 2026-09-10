// Stage 5: the Bridgefu host overlay that enables the browser path.
//
// The published AMI configures only the phone recipe. The release qualification
// proved the browser path by installing a complete replacement configuration on
// the host for the duration of the smoke; this module renders the same
// configuration (adapted from qualification/bridgefu_web_runtime.py) with four
// deliberate deltas, ships it through the lab bucket, and applies or removes it
// over SSM with the upstream trap-and-restore pattern.
//
// Deltas: the WebSocket listener binds 0.0.0.0:<WssPort> (a laptop browser connects
// directly instead of through an SSM tunnel); the advertised signaling URI and
// allowed origin use the lab hostname and port; the SIP password environment
// variable is named for the lab; HAProxy additionally allows
// POST /v1/routes/vapi-direct-assistant/calls for the session Lambda.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, aws, log, sleep } from "./common.mjs";

export const WEB_ROUTE_ID = "vapi-direct-assistant";
export const CONNECT_ROUTE_ID = "amazon-connect";
export const PASSWORD_ENV = "BRIDGEFU_LAB_VAPI_SIP_PASSWORD";
const STUN_HOST_TEMPLATE = "stun.kinesisvideo.{region}.amazonaws.com";
const HOST_DIR = join(common.REPO_ROOT, "host");
const SSM_TIMEOUT_SECONDS = 900;

export const options = { yes: { type: "boolean", default: false } };
export const help = `web-overlay apply|restore|status|render  [--yes]`;

/** Canonical JSON: sorted keys, no whitespace (same bytes Python's json.dumps(sort_keys=True, separators=(",",":")) produces for ASCII). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildRuntimeConfig({ region, deploymentId, sipHostname, publicIp, connectInstanceArn, connectFlowId, vapiSipUsername, wssPort, sipSecurity = "sips_optional_srtp", maxConcurrentCalls = 100 }) {
  if (!common.SUPPORTED_REGIONS.includes(region)) throw new LabError("region is not supported");
  if (!common.HOSTNAME.test(sipHostname) || !common.RESOURCE_ID.test(vapiSipUsername)) throw new LabError("overlay identity is invalid");
  if (!common.IPV4.test(publicIp)) throw new LabError("public IP is invalid");
  if (!(wssPort >= 1024 && wssPort <= 65535) || !(maxConcurrentCalls >= 1 && maxConcurrentCalls <= 1000)) throw new LabError("overlay port or capacity is out of range");
  const instanceId = connectInstanceArn.split("/").pop();
  // SIP over TLS to Vapi's 5061 listener rather than a sips: URI, because Vapi's
  // Contact does not preserve the sips scheme (same choice as upstream).
  const target = `sip:${vapiSipUsername}@sip.vapi.ai:5061;transport=tls`;
  const signalingOrigin = `wss://${sipHostname}:${wssPort}`;
  const stun = `stun:${STUN_HOST_TEMPLATE.replace("{region}", region)}:443`;
  const connectDestination = {
    direction: "outbound",
    signaling_initiator: "bridgefu",
    media_flow: "send_receive",
    endpoint: { type: "amazon_connect", config: { instance_id: instanceId, contact_flow_id: connectFlowId } },
    amazon_connect_start: {
      profile: "support-connect",
      instance_id: instanceId,
      contact_flow_id: connectFlowId,
      attributes: { integration: "bridgefu", handoff_route: "vapi-assistant" },
      display_name: "Vapi caller",
      description: "Bridgefu managed Vapi handoff",
    },
  };
  return {
    config_version: 1,
    aws: { region },
    edge: {
      public_host: sipHostname,
      media_public_addr: `${publicIp}:0`,
      sip_tls: { bind: "0.0.0.0:5061", advertised_addr: `${publicIp}:5061`, certificate_chain: "/etc/bridgefu/tls/fullchain.pem", private_key: "/etc/bridgefu/tls/private-key.pem" },
    },
    api: {
      enabled: true,
      tls: { certificate_chain: "/etc/bridgefu/tls/fullchain.pem", private_key: "/etc/bridgefu/tls/private-key.pem" },
      bearer_token: "env:BRIDGEFU_API_BEARER_TOKEN",
      control_hmac_key: "env:BRIDGEFU_CONTROL_HMAC_KEY",
      static_tenant: "support",
      rate_limit: {
        enabled: true,
        control_requests_per_second: 20,
        control_burst: 40,
        diagnostics_requests_per_second: 5,
        diagnostics_burst: 10,
        webhook_requests_per_second: 5,
        webhook_burst: 10,
        max_tracked_identities: 1024,
        identity_idle_ttl_secs: 300,
      },
      // The browser needs one public IPv4/UDP candidate to reach the IPv4-only EC2
      // edge; AWS's regional STUN service supplies it through the attachment.
      route_attachments: { webrtc: { signaling_uri: `${signalingOrigin}/webrtc`, ice_servers: [{ urls: [stun] }] } },
      routes: {
        [WEB_ROUTE_ID]: {
          tenant_id: "support",
          ingress: ["webrtc"],
          webrtc_ingress_profile: "lab-browser",
          destination_profile: { type: "sip", profile_id: "lab-vapi-assistant" },
          destination: {
            direction: "outbound",
            signaling_initiator: "bridgefu",
            media_flow: "send_receive",
            endpoint: { type: "sip", config: { uri: target, initial_context: "required" } },
          },
        },
        [CONNECT_ROUTE_ID]: {
          tenant_id: "support",
          ingress: ["webrtc"],
          webrtc_ingress_profile: "lab-browser",
          destination_profile: { type: "amazon_connect", profile_id: "support-connect" },
          destination: connectDestination,
        },
      },
    },
    recipes: {
      support: {
        use: "builtin:vapi-amazon-connect-screen-pop@1",
        with: { vapi_signaling_cidrs: [...common.VAPI_SIGNALING_CIDRS], connect_instance_arn: connectInstanceArn, connect_entry_contact_flow_id: connectFlowId, sip_security: sipSecurity },
      },
    },
    sip_profiles: {
      "lab-vapi-assistant": {
        allowed_targets: [target],
        from_uri: `sips:bridgefu@${sipHostname}`,
        auth: { type: "digest", realm: "sip.vapi.ai", username: vapiSipUsername, password: `env:${PASSWORD_ENV}` },
        tls_roots: ["/etc/pki/tls/certs/ca-bundle.crt"],
        srtp: "preferred",
        codecs: ["pcmu", "opus"],
        metadata_keys: ["correlation_id", "handoff_token"],
      },
    },
    webrtc_profiles: { "lab-browser": { allowed_signaling_origins: [signalingOrigin], ice_servers: [], codecs: ["opus"], data_channels: true } },
    context: { allow_headers: { "X-Correlation-Id": "correlation_id", "X-Bridgefu_Handoff_Token": "handoff_token" } },
    generic_bridge: {
      enabled: true,
      sip_bind: "127.0.0.1:5070",
      webrtc_ws_bind: `0.0.0.0:${wssPort}`,
      webrtc_whip_bind: "127.0.0.1:8081",
      sip: { srtp: "preferred" },
      webrtc: {
        udp_port_range: { bind_ip: "0.0.0.0", port_start: 20000, port_end: 20399 },
        audio_codecs: ["opus"],
        // rvoip 0.3.8 does not apply nat_1to1_ips to gathered candidates, so the
        // server also gathers a server-reflexive candidate via STUN.
        ice_servers: [{ urls: [stun] }],
        nat_1to1_ips: [],
        nat_1to1_candidate_type: "host",
        gather_timeout_secs: 10,
        connection_timeout_secs: 30,
        trickle_ice: true,
      },
    },
    persistence: { backend: "sqlite", database_url: "sqlite:///var/lib/bridgefu/bridgefu.db", deployment_id: deploymentId },
    observability: { log_level: "info", log_format: "json", http_bind: "127.0.0.1:9090" },
    runtime: { mode: "all-in-one", max_concurrent_calls: maxConcurrentCalls, setup_timeout_secs: 15, media_idle_timeout_secs: 120, drain_timeout_secs: 60 },
  };
}

/** Canonical JSON (a valid YAML document) with a guard against embedded secrets. */
export function encodeConfig(config) {
  const encoded = `${canonicalJson(config)}\n`;
  const password = config.sip_profiles?.["lab-vapi-assistant"]?.auth?.password;
  if (password !== `env:${PASSWORD_ENV}` || encoded.toLowerCase().includes("api_key") || Buffer.byteLength(encoded) > 64 * 1024) {
    throw new LabError("rendered configuration violates the secret-free contract");
  }
  return encoded;
}

export function renderHaproxy(privateIp) {
  if (!common.IPV4.test(privateIp)) throw new LabError("private IP is invalid");
  return readFileSync(join(HOST_DIR, "haproxy.lab.cfg.tmpl"), "utf8").replace("__CONTROL_BIND__", `${privateIp}:443 ssl crt /etc/haproxy/bridgefu.pem alpn h2,http/1.1`);
}

export function renderScript(name, replacements) {
  let text = readFileSync(join(HOST_DIR, name), "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    if (!/^[A-Za-z0-9:/._=@+-]{1,512}$/.test(value)) throw new LabError(`overlay value for ${key} contains unexpected characters`);
    text = text.replaceAll(`__${key}__`, value);
  }
  if (/__[A-Z_]+__/.test(text)) throw new LabError(`${name} still contains unrendered placeholders`);
  // SSM sends the script as a list of command lines; empty lines are dropped, and the
  // templates are written to tolerate that.
  return text.split("\n").filter((line) => line.trim()).join("\n");
}

export function statusScript() {
  return [
    "set -u",
    "dropin=/etc/systemd/system/bridgefu.service.d/lab-web-overlay.conf",
    'present=false; [ -f "$dropin" ] && present=true',
    "active=false; systemctl is-active --quiet bridgefu.service && active=true",
    "ready=$(curl --silent --max-time 2 http://127.0.0.1:9090/readyz 2>/dev/null | python3 -c 'import json,sys; v=json.load(sys.stdin); print(\"true\" if v.get(\"ok\") is True else \"false\")' 2>/dev/null || echo false)",
    "listeners=$(ss -ltnH | awk '{print $4}' | tr '\\n' ' ')",
    "sha=$(sha256sum /etc/bridgefu/bridgefu.yaml | awk '{print $1}')",
    'printf \'%s\\n\' "{\\"schema_version\\":1,\\"producer\\":\\"vapi-bridgefu-connect-lab-overlay@1\\",\\"action\\":\\"status\\",\\"overlay_present\\":$present,\\"bridgefu_active\\":$active,\\"bridgefu_ready\\":$ready,\\"config_sha256\\":\\"$sha\\",\\"listeners\\":\\"$listeners\\"}"',
  ].join("\n");
}

export async function ssmRun(instanceId, region, script, labelText) {
  const commands = script.split("\n").filter((line) => line.trim());
  mkdirSync(common.LAB_DIR, { recursive: true, mode: 0o700 });
  const parameterFile = join(common.LAB_DIR, "ssm-parameters.json");
  writeFileSync(parameterFile, JSON.stringify({ commands, executionTimeout: [String(SSM_TIMEOUT_SECONDS)] }));
  const commandId = await aws(
    ["ssm", "send-command", "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript", "--comment", `vapi-bridgefu-connect ${labelText}`.slice(0, 100), "--parameters", `file://${parameterFile}`, "--timeout-seconds", "600", "--query", "Command.CommandId"],
    { region, output: "text" },
  );
  log(`${labelText}: SSM command ${commandId} sent`);
  const deadline = Date.now() + (SSM_TIMEOUT_SECONDS + 120) * 1000;
  let invocation = {};
  while (Date.now() < deadline) {
    await sleep(5000);
    invocation = (await aws(["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId], { region, allowFailure: true })) ?? {};
    if (["Success", "Failed", "Cancelled", "TimedOut", "Cancelling"].includes(String(invocation.Status ?? ""))) break;
  }
  const status = String(invocation.Status ?? "Unknown");
  const stdout = String(invocation.StandardOutputContent ?? "");
  const stderr = String(invocation.StandardErrorContent ?? "");
  if (status !== "Success") throw new LabError(`${labelText} failed on the host (${status}). stderr tail:\n${stderr.slice(-1500)}\nstdout tail:\n${stdout.slice(-800)}`);
  for (const line of stdout.trim().split("\n").reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const value = JSON.parse(trimmed);
        if (value && typeof value === "object") return value;
      } catch {
        /* keep looking */
      }
    }
  }
  throw new LabError(`${labelText} produced no JSON result. stdout tail:\n${stdout.slice(-800)}`);
}

function inputs(state) {
  common.requireKeys(state, "bridgefu", "lab_web", "web");
  const outputs = state.bridgefu.outputs;
  const parameters = state.bridgefu.parameters ?? {};
  const labWeb = state.lab_web.outputs;
  const webVapi = state.web.vapi ?? {};
  if (!webVapi.sip_username) throw new LabError("the direct web assistant's SIP endpoint has not been created yet (web-setup runs that first)");
  return {
    region: common.regionOf(state),
    deploymentId: common.deploymentIdOf(state),
    sipHostname: String(state.sip_hostname),
    publicIp: outputs.BridgefuPublicIp,
    privateIp: outputs.BridgefuInstancePrivateIp,
    instanceId: outputs.BridgefuInstanceId,
    connectInstanceArn: parameters.ConnectInstanceArn ?? state.connect.outputs.ConnectInstanceArn,
    connectFlowId: String(outputs.ConnectWrapperFlowArn).split("/").pop(),
    sipSecurity: parameters.SipSecurity ?? "sips_optional_srtp",
    maxConcurrentCalls: Number(parameters.MaxConcurrentCalls ?? 100) || 100,
    vapiSipUsername: webVapi.sip_username,
    wssPort: Number(labWeb.WssPort),
    sipAuthSecretArn: labWeb.DirectVapiSipAuthSecretArn,
  };
}

export function renderAll(state) {
  const i = inputs(state);
  const encoded = encodeConfig(buildRuntimeConfig(i));
  return { encoded, haproxy: renderHaproxy(i.privateIp), inputs: i };
}

export async function applyOverlay(state, assumeYes) {
  const { encoded, haproxy, inputs: i } = renderAll(state);
  const configSha = common.sha256(encoded);
  const haproxySha = common.sha256(haproxy);
  const bucket = common.labBucketName(state);
  const prefix = `runtime/${configSha.slice(0, 16)}`;
  await common.confirm(`Apply the browser-path overlay to Bridgefu host ${i.instanceId}? Bridgefu restarts once (any active call drops) and starts listening on 0.0.0.0:${i.wssPort} for WSS.`, assumeYes);
  mkdirSync(common.LAB_DIR, { recursive: true, mode: 0o700 });
  const configPath = join(common.LAB_DIR, "overlay-bridgefu.json");
  const haproxyPath = join(common.LAB_DIR, "overlay-haproxy.cfg");
  writeFileSync(configPath, encoded);
  writeFileSync(haproxyPath, haproxy);
  for (const [local, key] of [[configPath, "bridgefu.json"], [haproxyPath, "haproxy.cfg"]]) {
    await aws(["s3", "cp", local, `s3://${bucket}/${prefix}/${key}`, "--sse", "AES256", "--only-show-errors"], { region: i.region, output: "none" });
  }
  const script = renderScript("install.sh.tmpl", {
    REGION: i.region,
    SOURCE_PREFIX: `s3://${bucket}/${prefix}`,
    CONFIG_SHA: configSha,
    HAPROXY_SHA: haproxySha,
    SIP_AUTH_SECRET_ARN: i.sipAuthSecretArn,
    WSS_PORT: String(i.wssPort),
  });
  const result = await ssmRun(i.instanceId, i.region, script, "overlay apply");
  if (!(result.configuration_installed && result.bridgefu_ready && result.wss_listener_ready)) throw new LabError(`overlay apply returned an unexpected result: ${JSON.stringify(result)}`);
  state.web = state.web ?? {};
  state.web.overlay = { status: "applied", config_sha256: configSha, s3_prefix: `s3://${bucket}/${prefix}`, wss_port: i.wssPort };
  common.saveState(state);
  log(`overlay applied; Bridgefu ready and listening for WSS on port ${i.wssPort}`);
  return result;
}

export async function restoreOverlay(state, assumeYes) {
  common.requireKeys(state, "bridgefu");
  const outputs = state.bridgefu.outputs;
  await common.confirm("Restore the release Bridgefu configuration on the host? Bridgefu restarts once.", assumeYes);
  const result = await ssmRun(outputs.BridgefuInstanceId, common.regionOf(state), renderScript("restore.sh.tmpl", {}), "overlay restore");
  if (!result.bridgefu_ready) throw new LabError(`overlay restore returned an unexpected result: ${JSON.stringify(result)}`);
  if (state.web) delete state.web.overlay;
  common.saveState(state);
  log("release configuration restored");
  return result;
}

export async function overlayStatus(state) {
  common.requireKeys(state, "bridgefu");
  const result = await ssmRun(state.bridgefu.outputs.BridgefuInstanceId, common.regionOf(state), statusScript(), "overlay status");
  const recorded = state.web?.overlay ?? {};
  if (recorded.config_sha256 && result.config_sha256 !== recorded.config_sha256) {
    result.drift = "host configuration differs from the recorded overlay (reboot or manual change); re-run apply";
  }
  return result;
}

export async function run(values, positionals) {
  const action = positionals[0];
  if (!["apply", "restore", "status", "render"].includes(action)) throw new LabError("usage: web-overlay apply|restore|status|render");
  const state = common.loadState();
  if (action === "render") {
    const { encoded, haproxy, inputs: i } = renderAll(state);
    console.log(encoded);
    console.log(haproxy);
    console.log(`# wss port ${i.wssPort}, instance ${i.instanceId}`);
    return;
  }
  const result = action === "apply" ? await applyOverlay(state, values.yes) : action === "restore" ? await restoreOverlay(state, values.yes) : await overlayStatus(state);
  console.log(JSON.stringify(result, null, 2));
}
