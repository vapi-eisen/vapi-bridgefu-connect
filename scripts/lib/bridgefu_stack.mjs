// Stage 2: deploy the published Bridgefu CloudFormation product by URL, exactly as a customer would.
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, aws, log } from "./common.mjs";

const CREATE_TIMEOUT_SECONDS = 75 * 60;
const LAUNCH_IMMUTABLE = ["DeploymentId", "ConnectInstanceArn", "PublicHostedZoneId", "SipHostname", "SipSecurity", "MaxConcurrentCalls", "DataRetentionMode", "the release AMI"];

export const options = {
  "instance-type": { type: "string" },
  retention: { type: "string", default: "TestDelete" },
  "sip-security": { type: "string", default: "sips_optional_srtp" },
  "log-retention-days": { type: "string", default: "7" },
  "alarm-email": { type: "string", default: "" },
  "link-only": { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
};
export const help = `--instance-type t4g.medium  --retention TestDelete|ProductionRetain  --sip-security sips_optional_srtp|sips_srtp
--log-retention-days 7  --alarm-email you@example.com  --link-only (print the console Quick Create link)  --yes`;

export function quickCreateLink(region, name, parameters) {
  const query = [`templateURL=${encodeURIComponent(common.PUBLISHED_TEMPLATE_URL)}`, `stackName=${encodeURIComponent(name)}`];
  for (const [key, value] of Object.entries(parameters)) if (value) query.push(`param_${key}=${encodeURIComponent(value)}`);
  return `https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create/review?${query.join("&")}`;
}

export async function deploy(values) {
  const state = common.loadState();
  common.requireKeys(state, "region", "deployment_id", "hosted_zone_id", "sip_hostname", "vapi_secret_arn", "connect");
  if (!["TestDelete", "ProductionRetain"].includes(values.retention)) throw new LabError("--retention must be TestDelete or ProductionRetain");
  if (!["sips_optional_srtp", "sips_srtp"].includes(values["sip-security"])) throw new LabError("--sip-security must be sips_optional_srtp or sips_srtp");
  const instanceType = values["instance-type"] ?? state.instance_type ?? common.DEFAULT_INSTANCE_TYPE;
  if (!common.INSTANCE_TYPES.includes(instanceType)) throw new LabError(`--instance-type must be one of ${common.INSTANCE_TYPES.join(", ")}`);
  const region = common.regionOf(state);
  const name = common.stackNames(state).bridgefu;
  const connect = state.connect.outputs;
  const parameters = {
    DeploymentId: common.deploymentIdOf(state),
    InstanceType: instanceType,
    ConnectInstanceArn: connect.ConnectInstanceArn,
    TargetContactFlowArn: connect.TargetContactFlowArn,
    PublicHostedZoneId: state.hosted_zone_id,
    SipHostname: state.sip_hostname,
    VapiApiKeySecretArn: state.vapi_secret_arn,
    DataRetentionMode: values.retention,
    SipSecurity: values["sip-security"],
    LogRetentionDays: String(values["log-retention-days"]),
    AlarmEmail: values["alarm-email"],
  };
  console.log("Console alternative (same parameters):");
  console.log(`  ${quickCreateLink(region, name, parameters)}`);
  console.log("");
  if (values["link-only"]) return;

  const status = await common.stackStatus(name, region);
  if (status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE") {
    log(`${name} already exists (${status}); refreshing outputs`);
  } else if (status === null) {
    await common.confirm(
      `Create Bridgefu stack ${name} in ${region} from the published release template? EC2 ${instanceType} runs until you tear down (roughly $0.10/hour total for the lab). Creation takes 20-30 minutes.`,
      values.yes,
    );
    await aws(
      ["cloudformation", "create-stack", "--stack-name", name, "--template-url", common.PUBLISHED_TEMPLATE_URL, ...common.parameterFileArgs(parameters, join(common.LAB_DIR, "bridgefu-parameters.json")), "--capabilities", "CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "--tags", `Key=Project,Value=${common.PROJECT_TAG}`],
      { region },
    );
    log("creating the Bridgefu stack: ACM DNS validation, EC2 first boot, and readiness gate the EC2 resource");
    log(`launch-immutable settings: ${LAUNCH_IMMUTABLE.join(", ")}`);
    await common.waitForStack(name, region, { success: ["CREATE_COMPLETE"], timeoutSeconds: CREATE_TIMEOUT_SECONDS, pollSeconds: 30 });
  } else {
    throw new LabError(`${name} is in status ${status}; wait for it or delete it before continuing`);
  }
  const outputs = await common.stackOutputs(name, region);
  state.bridgefu = { stack_name: name, outputs, parameters };
  common.saveState(state);
  console.log(`Bridgefu stack ${name} is ready (release ${outputs.ReleaseVersion ?? "?"}).`);
  common.printTable([
    ["SIP URI", outputs.BridgefuSipUri ?? ""],
    ["public IP", outputs.BridgefuPublicIp ?? ""],
    ["template assistant", outputs.VapiAssistantId ?? ""],
    ["dashboard", outputs.DashboardUrl ?? ""],
    ["SSM session", outputs.SsmStartSessionCommand ?? ""],
    ["retention", parameters.DataRetentionMode],
  ]);
  console.log("");
  console.log("Next: `node scripts/lab.mjs vapi` to give the template assistant a persona and a dial-in number.");
}
