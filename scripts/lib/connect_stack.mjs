// Stage 1: create the lab Amazon Connect stack and manage the lab agent.
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, aws, log } from "./common.mjs";

const TEMPLATE = join(common.REPO_ROOT, "cloudformation", "connect-lab.yaml");
const CREATE_TIMEOUT_SECONDS = 30 * 60;
const ALIAS_CONFLICT = /alias|ResourceConflict|already (exists|in use)|not available/i;

export const options = {
  "agent-username": { type: "string", default: "lab-agent" },
  "agent-auto-accept": { type: "string", default: "true" },
  "agent-available": { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
};
export const help = `--agent-username lab-agent  --agent-auto-accept true|false  --agent-available (only flip the agent to Available)  --yes`;

export async function deploy(values) {
  const state = common.loadState();
  common.requireKeys(state, "region", "deployment_id");
  const region = common.regionOf(state);
  const name = common.stackNames(state).connect;
  if (values["agent-available"]) return setAgentAvailable(state);
  if (!["true", "false"].includes(values["agent-auto-accept"])) throw new LabError("--agent-auto-accept must be true or false");
  const status = await common.stackStatus(name, region);
  if (status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE") {
    log(`${name} already exists (${status}); refreshing outputs`);
  } else if (status === null) {
    await common.confirm(`Create the Amazon Connect lab stack ${name} in ${region}? This creates a Connect instance, queue, flow, and one agent.`, values.yes);
    const defaultAlias = `${common.deploymentIdOf(state)}-connect`;
    const parameters = {
      DeploymentId: common.deploymentIdOf(state),
      InstanceAlias: state.connect_alias && state.connect_alias !== defaultAlias ? String(state.connect_alias) : "",
      AgentUsername: values["agent-username"],
      AgentAutoAccept: values["agent-auto-accept"],
      LogRetentionDays: "7",
    };
    await aws(
      ["cloudformation", "create-stack", "--stack-name", name, "--template-body", `file://${TEMPLATE}`, ...common.parameterArgs(parameters), "--capabilities", "CAPABILITY_IAM", "--tags", `Key=Project,Value=${common.PROJECT_TAG}`],
      { region },
    );
    log(`creating ${name}; a Connect instance usually takes 5-10 minutes`);
    try {
      await common.waitForStack(name, region, { success: ["CREATE_COMPLETE"], timeoutSeconds: CREATE_TIMEOUT_SECONDS });
    } catch (error) {
      if (error instanceof LabError && ALIAS_CONFLICT.test(error.message)) {
        throw new LabError(
          `${error.message}\n\nThis looks like a Connect alias conflict. Aliases are globally unique and Amazon Connect keeps a deleted ` +
            `instance's alias reserved for about 30 days. Delete the failed stack (aws cloudformation delete-stack --stack-name ${name}), ` +
            "then re-run `node scripts/lab.mjs preflight --connect-alias <other-name>` and `node scripts/lab.mjs connect`.",
        );
      }
      throw error;
    }
  } else {
    throw new LabError(`${name} is in status ${status}; wait for it to finish or delete it before continuing`);
  }
  const outputs = await common.stackOutputs(name, region);
  state.connect = { stack_name: name, outputs };
  common.saveState(state);
  console.log(`Amazon Connect lab stack ${name} is ready.`);
  common.printTable([
    ["instance ARN", outputs.ConnectInstanceArn ?? ""],
    ["alias", outputs.ConnectAlias ?? ""],
    ["target flow ARN", outputs.TargetContactFlowArn ?? ""],
    ["agent username", outputs.AgentUsername ?? ""],
    ["agent login", outputs.ConnectLoginUrl ?? ""],
    ["admin console", outputs.ConnectAdminUrl ?? ""],
  ]);
  console.log("");
  console.log("Read the agent password yourself (it is never printed by these scripts):");
  console.log(`  ${outputs.AgentCredentialCommand ?? ""}`);
  console.log("");
  console.log("Next: `node scripts/lab.mjs bridgefu` (20-30 minutes).");
}

/** Select the lab agent's routable Available status (Agent Workspace must be open for audio). */
export async function setAgentAvailable(state) {
  common.requireKeys(state, "connect");
  const region = common.regionOf(state);
  const outputs = state.connect.outputs;
  const instanceId = outputs.ConnectInstanceId;
  const username = outputs.AgentUsername;
  const users = await aws(["connect", "list-users", "--instance-id", instanceId, "--max-results", "100"], { region });
  const statuses = await aws(["connect", "list-agent-statuses", "--instance-id", instanceId, "--max-results", "100"], { region });
  const userMatches = (users?.UserSummaryList ?? []).filter((u) => u.Username === username);
  const statusMatches = (statuses?.AgentStatusSummaryList ?? []).filter((s) => s.Name === "Available" && s.Type === "ROUTABLE");
  if (userMatches.length !== 1 || statusMatches.length !== 1) throw new LabError("could not find exactly one lab agent and one routable Available status");
  await aws(["connect", "put-user-status", "--instance-id", instanceId, "--user-id", userMatches[0].Id, "--agent-status-id", statusMatches[0].Id], { region, output: "none" });
  console.log(`Agent ${username} is now Available. Keep Agent Workspace open: ${outputs.ConnectLoginUrl ?? ""}`);
}
