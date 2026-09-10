// Stage 0: verify prerequisites and record the lab inputs before spending 25 minutes on a stack.
import * as common from "./common.mjs";
import { LabError, aws, log, warn } from "./common.mjs";

export const options = {
  region: { type: "string" },
  "deployment-id": { type: "string", default: "lab" },
  "hosted-zone-id": { type: "string" },
  "sip-hostname": { type: "string" },
  "vapi-secret-arn": { type: "string" },
  "create-vapi-secret": { type: "boolean", default: false },
  "instance-type": { type: "string", default: common.DEFAULT_INSTANCE_TYPE },
  "connect-alias": { type: "string" },
};
const CONNECT_ALIAS = /^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/;
export const help = `--region us-west-2|us-east-1  --deployment-id lab  --hosted-zone-id Z...  --sip-hostname bridgefu-lab.example.com
--vapi-secret-arn <arn> | --create-vapi-secret (reads $VAPI_PRIVATE_KEY or prompts)  --instance-type t4g.medium
--connect-alias <name>  (default <deployment-id>-connect; use another name if Connect still holds a deleted lab's alias)`;

async function checkVersions() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new LabError(`Node ${process.versions.node} is too old; Node 22 or newer is required`);
  const awsVersion = await common.commandVersion("aws");
  if (!awsVersion || !awsVersion.includes("aws-cli/2")) throw new LabError("AWS CLI v2 is required (`aws --version`)");
}

async function checkZone(zoneId, hostname, region) {
  const zone = await aws(["route53", "get-hosted-zone", "--id", zoneId], { region });
  const hosted = zone?.HostedZone ?? {};
  const name = String(hosted.Name ?? "").replace(/\.$/, "").toLowerCase();
  if (!name) throw new LabError(`hosted zone ${zoneId} was not found`);
  if (hosted.Config?.PrivateZone) throw new LabError(`hosted zone ${zoneId} (${name}) is private; the product needs a public zone for ACM validation`);
  if (!hostname.endsWith(`.${name}`) || hostname === name) throw new LabError(`${hostname} is not strictly beneath the zone ${name}`);
  for (const candidate of [hostname, `control.${hostname}`]) {
    const records = await aws(["route53", "list-resource-record-sets", "--hosted-zone-id", zoneId, "--start-record-name", candidate, "--max-items", "3"], { region });
    for (const record of records?.ResourceRecordSets ?? []) {
      if (String(record.Name ?? "").replace(/\.$/, "").toLowerCase() === candidate) {
        throw new LabError(`a DNS record for ${candidate} already exists in zone ${name}; choose an unused hostname`);
      }
    }
  }
  return name;
}

async function checkConnectAlias(alias, region) {
  const instances = await aws(["connect", "list-instances", "--max-results", "100"], { region });
  for (const instance of instances?.InstanceSummaryList ?? []) {
    if (instance.InstanceAlias === alias) throw new LabError(`a Connect instance with alias ${alias} already exists in this account/region; pass --connect-alias <other-name>`);
  }
  log(`Connect alias ${alias} is not used by a live instance in this account. Aliases are globally unique and a deleted instance keeps its alias reserved for about 30 days; that cannot be checked ahead of time, so if stage 1 fails with an alias conflict, re-run preflight with --connect-alias <other-name>.`);
}

async function ensureVapiSecret(values, state, region) {
  if (values["vapi-secret-arn"]) return values["vapi-secret-arn"];
  if (state.vapi_secret_arn && !values["create-vapi-secret"]) return String(state.vapi_secret_arn);
  if (!values["create-vapi-secret"]) throw new LabError("pass --vapi-secret-arn <arn> or --create-vapi-secret (reads $VAPI_PRIVATE_KEY or prompts)");
  const key = (process.env.VAPI_PRIVATE_KEY ?? "").trim() || (await common.promptSecret("Vapi private API key"));
  const name = `bridgefu/${values["deployment-id"]}/vapi-private-key`;
  const created = await aws(
    ["secretsmanager", "create-secret", "--name", name, "--description", "Vapi private API key for the vapi-bridgefu-connect lab", "--secret-string", "file:///dev/stdin", "--tags", `Key=Project,Value=${common.PROJECT_TAG}`],
    { region, input: key },
  );
  if (!created?.ARN) throw new LabError("secret creation returned no ARN");
  log(`created secret ${name}`);
  return String(created.ARN);
}

export async function run(values) {
  const state = common.loadState();
  const region = values.region ?? state.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!common.SUPPORTED_REGIONS.includes(region)) {
    throw new LabError(`--region must be one of ${common.SUPPORTED_REGIONS.join(", ")} (got ${JSON.stringify(region ?? null)}); Oregon is preferred for a Vapi US org`);
  }
  const deploymentId = values["deployment-id"];
  if (!common.DEPLOYMENT_ID.test(deploymentId)) throw new LabError("--deployment-id must match ^[a-z][a-z0-9-]+$ and be 3-24 characters");
  const hostname = String(values["sip-hostname"] ?? state.sip_hostname ?? "").toLowerCase();
  const zoneId = values["hosted-zone-id"] ?? state.hosted_zone_id;
  if (!hostname || !zoneId) throw new LabError("--hosted-zone-id and --sip-hostname are required the first time");
  if (!common.HOSTNAME.test(hostname)) throw new LabError(`${hostname} is not a valid lowercase DNS hostname`);
  if (!common.INSTANCE_TYPES.includes(values["instance-type"])) throw new LabError(`--instance-type must be one of ${common.INSTANCE_TYPES.join(", ")}`);
  const connectAlias = String(values["connect-alias"] ?? state.connect_alias ?? `${deploymentId}-connect`).toLowerCase();
  if (!CONNECT_ALIAS.test(connectAlias)) throw new LabError("--connect-alias must be 1-45 lowercase letters, digits, or hyphens");

  await checkVersions();
  const identity = await common.callerIdentity(region);
  log(`AWS account ${identity.accountId} in ${region}`);
  const zoneName = await checkZone(zoneId, hostname, region);
  await checkConnectAlias(connectAlias, region);

  Object.assign(state, {
    region,
    account_id: identity.accountId,
    deployment_id: deploymentId,
    hosted_zone_id: zoneId,
    hosted_zone_name: zoneName,
    sip_hostname: hostname,
    instance_type: values["instance-type"],
    connect_alias: connectAlias,
    created_at: state.created_at ?? common.nowIso(),
  });
  state.vapi_secret_arn = await ensureVapiSecret(values, state, region);
  common.saveState(state);
  await common.vapiRequest(state, "GET", "/assistant?limit=1");
  log("Vapi private key accepted by api.vapi.ai");

  console.log("Preflight passed. Recorded in .lab/state.json:");
  common.printTable([
    ["region", region],
    ["account", identity.accountId],
    ["deployment id", deploymentId],
    ["hosted zone", `${zoneId} (${zoneName})`],
    ["SIP hostname", hostname],
    ["instance type", values["instance-type"]],
    ["Connect alias", connectAlias],
    ["Vapi key secret", `${common.fingerprint(state.vapi_secret_arn)} (fingerprint)`],
  ]);
  console.log("");
  console.log("Expect: Connect stack ~5-10 min, BridgeFu stack ~20-30 min (ACM validation + EC2 readiness).");
  console.log(`Estimated lab cost on ${values["instance-type"]}: roughly $0.10/hour for EC2 + EIP + VPC endpoints,`);
  console.log("plus Amazon Connect and Vapi per-minute usage. Tear down when finished (stage 6).");
  if (!(await common.commandVersion("node"))) warn("node not found on PATH for child processes; stage 5 needs Node 22+");
}
