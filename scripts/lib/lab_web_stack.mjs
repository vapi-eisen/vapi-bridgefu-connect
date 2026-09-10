// Stage 5: the lab-web add-on stack (secrets, SG rules, handoff + session Lambdas, HTTP API).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, aws, log } from "./common.mjs";
import { buildZip } from "./zip.mjs";

const TEMPLATE = join(common.REPO_ROOT, "cloudformation", "lab-web.yaml");
const HANDLER = join(common.REPO_ROOT, "lambda", "direct_session", "handler.py");
const SESSION_KEY_PREFIX = "lambda/direct_session";
const TIMEOUT_SECONDS = 20 * 60;
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export const options = {
  "client-cidr": { type: "string", default: "auto" },
  "wss-port": { type: "string", default: "8443" },
  yes: { type: "boolean", default: false },
};
export const help = `--client-cidr auto|203.0.113.7/32  --wss-port 8443  --yes`;

/** Read the exact released transfer_destination.zip coordinates from the running product stack. */
export async function discoverReleaseArtifact(state) {
  const region = common.regionOf(state);
  const name = common.stackNames(state).bridgefu;
  const resource = await aws(["cloudformation", "describe-stack-resource", "--stack-name", name, "--logical-resource-id", "HandoffService"], { region });
  const nested = resource?.StackResourceDetail?.PhysicalResourceId;
  if (!nested) throw new LabError("the Bridgefu stack has no HandoffService nested stack");
  const parameters = await common.stackParameters(nested, region);
  for (const key of ["ArtifactBucket", "TransferArtifactKey", "TransferArtifactVersion"]) {
    if (!parameters[key]) throw new LabError(`nested HandoffService stack has no ${key} parameter`);
  }
  return { bucket: parameters.ArtifactBucket, key: parameters.TransferArtifactKey, version: parameters.TransferArtifactVersion };
}

export async function ensureBucket(state) {
  const region = common.regionOf(state);
  const name = common.labBucketName(state);
  const exists = await aws(["s3api", "head-bucket", "--bucket", name], { region, output: "none", allowFailure: true });
  if (exists === null) {
    const probe = await aws(["s3api", "get-bucket-location", "--bucket", name], { region, allowFailure: true });
    if (probe === null) {
      log(`creating lab bucket ${name}`);
      const create = ["s3api", "create-bucket", "--bucket", name];
      if (region !== "us-east-1") create.push("--create-bucket-configuration", `LocationConstraint=${region}`);
      await aws(create, { region });
      await aws(["s3api", "put-public-access-block", "--bucket", name, "--public-access-block-configuration", "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"], { region, output: "none" });
      await aws(["s3api", "put-bucket-versioning", "--bucket", name, "--versioning-configuration", "Status=Enabled"], { region, output: "none" });
      await aws(["s3api", "put-bucket-encryption", "--bucket", name, "--server-side-encryption-configuration", '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'], { region, output: "none" });
    }
  }
  state.lab_bucket = name;
  common.saveState(state);
  return name;
}

/** Deterministic zip (fixed timestamp, one file) so re-uploads are byte-identical. */
export function buildSessionZip() {
  return buildZip([{ name: "handler.py", data: readFileSync(HANDLER), mode: 0o100644 }]);
}

export async function uploadSessionZip(state, bucket) {
  const data = buildSessionZip();
  const digest = common.sha256(data);
  const key = `${SESSION_KEY_PREFIX}/${digest.slice(0, 16)}/direct_session.zip`;
  mkdirSync(common.LAB_DIR, { recursive: true, mode: 0o700 });
  const local = join(common.LAB_DIR, "direct_session.zip");
  writeFileSync(local, data);
  const version = await aws(["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", local, "--server-side-encryption", "AES256", "--query", "VersionId"], { region: common.regionOf(state), output: "text" });
  if (!version || version === "None") throw new LabError("the lab bucket did not return an object version; is versioning enabled?");
  return { key, version };
}

export async function resolveClientCidr(value) {
  if (value === "auto") return `${await common.publicIpv4()}/32`;
  if (!CIDR.test(value)) throw new LabError("--client-cidr must look like 203.0.113.7/32");
  return value;
}

export async function deploy(values) {
  const state = common.loadState();
  common.requireKeys(state, "bridgefu", "sip_hostname");
  const wssPort = Number(values["wss-port"]);
  if (!Number.isInteger(wssPort) || wssPort < 1024 || wssPort > 65535) throw new LabError("--wss-port must be between 1024 and 65535");
  const region = common.regionOf(state);
  const outputs = state.bridgefu.outputs;
  const productParameters = state.bridgefu.parameters ?? {};
  const name = common.stackNames(state).lab_web;

  const artifact = await discoverReleaseArtifact(state);
  const bucket = await ensureBucket(state);
  const session = await uploadSessionZip(state, bucket);
  const clientCidr = await resolveClientCidr(values["client-cidr"]);
  const parameters = {
    DeploymentId: common.deploymentIdOf(state),
    SipHostname: state.sip_hostname,
    LabClientCidr: clientCidr,
    WssPort: String(wssPort),
    LogRetentionDays: "7",
    BridgefuGatewaySecurityGroupId: outputs.BridgefuGatewaySecurityGroupId,
    BridgefuGatewayRoleName: outputs.BridgefuGatewayRoleName,
    BridgefuTransferSecurityGroupId: outputs.BridgefuTransferSecurityGroupId,
    BridgefuPrivateSubnetIds: outputs.BridgefuPrivateSubnetIds,
    HandoffTableName: outputs.HandoffTableName,
    HandoffTableArn: outputs.HandoffTableArn,
    VapiWebhookSecretArn: outputs.VapiWebhookSecretArn,
    BridgefuApiBearerSecretArn: outputs.BridgefuApiBearerSecretArn,
    ScreenPopFieldsJson: outputs.ScreenPopFieldsJson,
    ScreenPopSchemaHash: outputs.ScreenPopSchemaHash,
    SipSecurity: productParameters.SipSecurity ?? "sips_optional_srtp",
    ReleaseArtifactBucket: artifact.bucket,
    TransferArtifactKey: artifact.key,
    TransferArtifactVersion: artifact.version,
    LabArtifactBucket: bucket,
    SessionArtifactKey: session.key,
    SessionArtifactVersion: session.version,
  };
  const parameterFile = join(common.LAB_DIR, "lab-web-parameters.json");
  const status = await common.stackStatus(name, region);
  if (status === null) {
    await common.confirm(`Create lab-web stack ${name} (two small Lambdas, an HTTP API, four secrets, and security-group rules opening WSS port ${wssPort} to ${clientCidr})?`, values.yes);
    await aws(
      ["cloudformation", "create-stack", "--stack-name", name, "--template-body", `file://${TEMPLATE}`, ...common.parameterFileArgs(parameters, parameterFile), "--capabilities", "CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "--tags", `Key=Project,Value=${common.PROJECT_TAG}`],
      { region },
    );
    await common.waitForStack(name, region, { success: ["CREATE_COMPLETE"], timeoutSeconds: TIMEOUT_SECONDS });
  } else if (["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(status)) {
    log(`${name} exists; updating it (client CIDR ${clientCidr}, session zip ${session.version.slice(0, 8)}...)`);
    const updated = await aws(
      ["cloudformation", "update-stack", "--stack-name", name, "--template-body", `file://${TEMPLATE}`, ...common.parameterFileArgs(parameters, parameterFile), "--capabilities", "CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
      { region, allowFailure: true },
    );
    if (updated !== null) await common.waitForStack(name, region, { success: ["UPDATE_COMPLETE"], timeoutSeconds: TIMEOUT_SECONDS });
    else log("no stack changes were needed");
  } else {
    throw new LabError(`${name} is in status ${status}; wait or delete it before continuing`);
  }
  const labOutputs = await common.stackOutputs(name, region);
  state.lab_web = { stack_name: name, outputs: labOutputs, parameters };
  common.saveState(state);
  console.log(`lab-web stack ${name} is ready.`);
  common.printTable([
    ["direct handoff URL", labOutputs.DirectHandoffUrl ?? ""],
    ["session API URL", labOutputs.DirectSessionUrl ?? ""],
    ["WSS port", labOutputs.WssPort ?? ""],
    ["client CIDR", labOutputs.LabClientCidr ?? ""],
  ]);
  return labOutputs;
}
