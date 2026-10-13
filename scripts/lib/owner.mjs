// Owner side of remote mode: deploys (or updates) the lab account's sandbox
// stack, iam/lab-runner.yaml, with the gateway Lambda packaged from
// lambda/lab_gateway, then records the gateway URL in remote-lab.json for
// engineers. Needs administrator credentials in the lab account.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, aws, log } from "./common.mjs";
import { repoFromGit } from "./doctor.mjs";
import { CONFIG_PATH } from "./gateway_client.mjs";
import { buildZip } from "./zip.mjs";

export const DEFAULT_STACK = "bridgefu-lab-runner";
const TEMPLATE = join(common.REPO_ROOT, "iam", "lab-runner.yaml");
const GATEWAY_SOURCE = join(common.REPO_ROOT, "lambda", "lab_gateway", "index.mjs");

export const options = {
  region: { type: "string", default: common.PREFERRED_REGION },
  stack: { type: "string", default: DEFAULT_STACK },
  repo: { type: "string" },
  ref: { type: "string" },
  admins: { type: "string" },
  param: { type: "string", multiple: true, default: [] },
};

export const help = `owner deploy [--region us-west-2] [--stack ${DEFAULT_STACK}] [--repo owner/name] [--ref main] [--admins login1,login2]
             [--param Key=Value ...]
    (lab account owner, with AWS administrator credentials) Packages the gateway Lambda, deploys iam/lab-runner.yaml
    and writes the gateway URL to remote-lab.json; commit that file so engineers find the gateway. A first deploy
    needs the DNS and budget parameters, e.g. --param ParentHostedZoneId=Z... --param ParentZoneName=example.com
    --param BudgetEmail=you@example.com; later deploys keep the previous values.`;

/** Deterministic package: the same source always gives the same S3 key. */
export function gatewayPackage(source = readFileSync(GATEWAY_SOURCE)) {
  const zip = buildZip([{ name: "index.mjs", data: source }]);
  return { zip, key: `gateway/${createHash("sha256").update(zip).digest("hex").slice(0, 16)}.zip` };
}

export function parameterOverrides(params) {
  return params.map((item) => {
    if (!/^[A-Za-z][A-Za-z0-9]*=/.test(item)) throw new LabError(`--param must be Key=Value (got ${JSON.stringify(item)})`);
    return item;
  });
}

async function deployStack(values, overrides) {
  log(`deploying ${values.stack} in ${values.region} (a few minutes)`);
  await aws(
    ["cloudformation", "deploy", "--stack-name", values.stack, "--template-file", TEMPLATE, "--capabilities", "CAPABILITY_NAMED_IAM", "--no-fail-on-empty-changeset", "--tags", `Project=${common.PROJECT_TAG}`, "--parameter-overrides", ...overrides],
    { region: values.region, output: "none", timeout: 1_800_000 },
  );
}

async function deploy(values) {
  const repo = values.repo ?? repoFromGit();
  if (!repo) throw new LabError("could not determine the GitHub repository; pass --repo owner/name");
  const overrides = [`LabRepository=${repo}`, ...parameterOverrides(values.param)];
  if (values.ref) overrides.push(`LabRef=${values.ref}`);
  if (values.admins) overrides.push(`LabAdmins=${values.admins}`);
  else if (!overrides.some((item) => item.startsWith("LabAdmins="))) overrides.push(`LabAdmins=${repo.split("/")[0]}`);
  const identity = await common.callerIdentity(values.region);
  log(`lab account ${identity.accountId} as ${identity.arn}`);
  if (!(await common.stackStatus(values.stack, values.region))) {
    log("first deploy: creating the sandbox without the gateway so its bucket exists");
    await deployStack(values, overrides);
  }
  const { StateBucketName: bucket } = await common.stackOutputs(values.stack, values.region);
  if (!bucket) throw new LabError(`${values.stack} has no StateBucketName output`);
  const pkg = gatewayPackage();
  await aws(["s3", "cp", "-", `s3://${bucket}/${pkg.key}`, "--sse", "AES256", "--only-show-errors"], { region: values.region, output: "none", input: pkg.zip });
  log(`gateway package s3://${bucket}/${pkg.key}`);
  await deployStack(values, [...overrides, `GatewayCodeKey=${pkg.key}`]);
  const outputs = await common.stackOutputs(values.stack, values.region);
  if (!outputs.GatewayUrl) throw new LabError(`${values.stack} has no GatewayUrl output`);
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ gateway_url: outputs.GatewayUrl, region: values.region, stack: values.stack }, null, 2)}\n`);
  common.printTable([
    ["gateway", outputs.GatewayUrl],
    ["runner project", outputs.RunnerProject ?? "-"],
    ["lab zone", outputs.LabZoneName ?? "-"],
    ["state bucket", bucket],
  ]);
  log(`wrote ${CONFIG_PATH}; commit and push it so engineers' remote commands find the gateway`);
}

export async function run(values, positionals) {
  const [action] = positionals;
  if (action === "deploy") return deploy(values);
  throw new LabError(`owner needs an action: deploy\n${help}`);
}
