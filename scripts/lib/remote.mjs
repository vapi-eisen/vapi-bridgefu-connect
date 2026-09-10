// Engineer-side helpers for remote mode: dispatch the provision workflow with a
// wrapped Vapi key, and fetch the handout it produces. Verify and teardown stay
// plain `gh workflow run` commands (docs/09-remote-lab.md).
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, log } from "./common.mjs";
import * as keyWrap from "./key_wrap.mjs";
import * as stateCmd from "./state_cmd.mjs";

export const WORKFLOW = "lab-provision.yml";

export const options = {
  engineer: { type: "string" },
  repo: { type: "string" },
  ref: { type: "string" },
  stages: { type: "string", default: "phone" },
  "client-cidr": { type: "string" },
  "area-code": { type: "string", default: "415" },
  "agent-auto-accept": { type: "string", default: "true" },
  "connect-alias": { type: "string" },
  "passphrase-env": { type: "string" },
  "skip-vapi-check": { type: "boolean", default: false },
  run: { type: "string" },
  dir: { type: "string", default: ".lab-handout" },
  force: { type: "boolean", default: false },
};

export const help = `remote provision --engineer <handle> [--stages phone|full] [--client-cidr x.x.x.x/32|auto] [--area-code 415]
                 [--agent-auto-accept true|false] [--connect-alias <alias>] [--passphrase-env VAR] [--repo owner/name] [--ref main]
    Prompts for YOUR Vapi private key, wraps it for the lab account and dispatches ${WORKFLOW}. Run it in your own terminal.
remote handout --engineer <handle> [--passphrase-env VAR] [--run <id>] [--dir .lab-handout] [--force] [--repo owner/name]
    Downloads the lab-handout-<handle> artifact from the latest successful provision run and imports it into .lab/state.json.`;

/** Builds the workflow_dispatch inputs; pure so the shape is testable. */
export function provisionInputs({ engineer, stages, clientCidr = "", areaCode = "415", agentAutoAccept = "true", connectAlias = "", wrapped, passphrase = "" }) {
  keyWrap.assertEngineer(engineer);
  if (!["phone", "full"].includes(stages)) throw new LabError("--stages must be phone or full");
  if (stages === "full" && !clientCidr) throw new LabError("--client-cidr is required for the full lab (auto detects your public IPv4)");
  if (clientCidr && !/^\d{1,3}(\.\d{1,3}){3}\/32$/.test(clientCidr)) throw new LabError("--client-cidr must be x.x.x.x/32");
  if (!/^\d{3}$/.test(areaCode)) throw new LabError("--area-code must be three digits");
  if (!["true", "false"].includes(agentAutoAccept)) throw new LabError("--agent-auto-accept must be true or false");
  if (connectAlias && !/^[a-z0-9-]{1,45}$/.test(connectAlias)) throw new LabError("--connect-alias must be lowercase letters, digits, hyphens");
  if (!keyWrap.isCiphertext(wrapped)) throw new LabError("the wrapped key is missing");
  if (passphrase && passphrase.length < 8) throw new LabError("the handout passphrase must have at least 8 characters");
  const inputs = { engineer, stages, client_cidr: clientCidr, area_code: areaCode, agent_auto_accept: agentAutoAccept, connect_alias: connectAlias, vapi_key_wrapped: wrapped };
  if (passphrase) inputs.passphrase = passphrase;
  return inputs;
}

export async function provision(values) {
  const engineer = keyWrap.assertEngineer(values.engineer);
  let clientCidr = values["client-cidr"] ?? "";
  if (clientCidr === "auto") clientCidr = `${await common.publicIpv4()}/32`;
  let passphrase = "";
  if (values["passphrase-env"]) {
    passphrase = process.env[values["passphrase-env"]] ?? "";
    if (passphrase.length < 8) throw new LabError(`$${values["passphrase-env"]} must hold a passphrase of at least 8 characters`);
  }
  // Validate everything that does not need the key before asking for the key.
  provisionInputs({ engineer, stages: values.stages, clientCidr, areaCode: values["area-code"], agentAutoAccept: values["agent-auto-accept"], connectAlias: values["connect-alias"] ?? "", wrapped: "A".repeat(256), passphrase });
  const repo = await keyWrap.resolveRepo(values.repo);
  const material = await keyWrap.fetchPublicKey(repo);
  const key = await keyWrap.obtainKey(values);
  const wrapped = keyWrap.wrapPayload(keyWrap.buildWrapPayload({ engineer, key }), material);
  const inputs = provisionInputs({ engineer, stages: values.stages, clientCidr, areaCode: values["area-code"], agentAutoAccept: values["agent-auto-accept"], connectAlias: values["connect-alias"] ?? "", wrapped, passphrase });
  const args = ["workflow", "run", WORKFLOW, "--repo", repo, "--json"];
  if (values.ref) args.push("--ref", values.ref);
  await keyWrap.gh(args, { input: JSON.stringify(inputs) });
  log(`dispatched ${WORKFLOW} for ${engineer} on ${repo}. Your key travelled only as ciphertext; the run stores it in secret bridgefu/${engineer}/vapi-private-key, which teardown deletes.`);
  log(`watch:  gh run watch --repo ${repo}`);
  log(`then:   node scripts/lab.mjs remote handout --engineer ${engineer}${passphrase ? ` --passphrase-env ${values["passphrase-env"]}` : ""}`);
}

async function recentSuccessfulRuns(repo) {
  const text = await keyWrap.gh(["run", "list", "--repo", repo, "--workflow", WORKFLOW, "--status", "success", "--limit", "20", "--json", "databaseId", "--jq", ".[].databaseId"]);
  return text.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
}

export async function handout(values) {
  const engineer = keyWrap.assertEngineer(values.engineer);
  const repo = await keyWrap.resolveRepo(values.repo);
  const artifact = `lab-handout-${engineer}`;
  const dir = values.dir;
  mkdirSync(dir, { recursive: true });
  const runs = values.run ? [String(values.run)] : await recentSuccessfulRuns(repo);
  if (values.run && !/^\d+$/.test(values.run)) throw new LabError("--run must be a numeric run id");
  let downloaded = null;
  for (const id of runs) {
    const result = await keyWrap.gh(["run", "download", id, "--repo", repo, "--name", artifact, "--dir", dir], { allowFailure: true });
    if (result !== null) {
      downloaded = id;
      break;
    }
  }
  if (!downloaded) throw new LabError(`no successful provision run among the last ${runs.length} carries artifact ${artifact}; artifacts expire after 2 days, re-run the provision workflow`);
  const file = join(dir, "handout.json");
  if (!existsSync(file)) throw new LabError(`downloaded ${artifact} from run ${downloaded} but ${file} is missing`);
  log(`downloaded ${artifact} from run ${downloaded}`);
  await stateCmd.run({ out: "handout.json", "with-web-bearer": false, "passphrase-env": values["passphrase-env"], force: values.force, "if-exists": false }, ["import", file]);
}

export async function run(values, positionals) {
  const [action] = positionals;
  if (action === "provision") return provision(values);
  if (action === "handout") return handout(values);
  throw new LabError(`remote needs an action: provision | handout\n${help}`);
}
