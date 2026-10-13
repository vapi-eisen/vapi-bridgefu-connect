#!/usr/bin/env node
// vapi-bridgefu-connect lab: deploy, wire, test, and tear down a Vapi -> Bridgefu -> Amazon Connect lab.
//
// Stages (run in order; each records what it made in .lab/state.json):
//   preflight    check tools, region, hosted zone, Vapi key; record inputs
//   connect      stage 1: Amazon Connect lab instance (queue, flow, agent)
//   bridgefu     stage 2: the published Bridgefu CloudFormation product (20-30 min)
//   vapi         stage 3: persona + dial-in number for the stack assistant (or --attach-existing)
//   verify-phone stage 4: prove a phone transfer from Vapi, DynamoDB, and Connect
//   web-setup    stage 5: lab-web add-on stack, direct Vapi assistant, host runtime overlay
//   web-serve    stage 5: run the local browser demo (http://127.0.0.1:8787)
//   verify-web   stage 5: prove a browser handoff
//   web-overlay  stage 5: apply | restore | status | render for the Bridgefu host overlay
//   lab-web-stack stage 5: only (re)deploy the lab-web stack
//   status       show recorded state and stack statuses
//   state        export | import | push | pull | delete state (handouts for engineers without AWS, the runner)
//   remote       doctor | provision | handout | agent | verify | teardown: engineer side of remote mode (no AWS)
//   key          wrap | unwrap | public-key: the key wrapping behind remote mode
//   owner        deploy: the lab account's sandbox stack and remote-mode gateway (owner, AWS admin)
//   runner       run the job the gateway queued (inside the lab account's CodeBuild project only)
//   reap         tear down stale labs listed in the S3 state bucket (nightly, from the runner)
//   teardown     stage 6: remove everything in a safe order
import { parseArgs } from "node:util";
import * as bridgefuStack from "./lib/bridgefu_stack.mjs";
import { LabError } from "./lib/common.mjs";
import * as connectStack from "./lib/connect_stack.mjs";
import * as keyWrap from "./lib/key_wrap.mjs";
import * as labWebStack from "./lib/lab_web_stack.mjs";
import * as owner from "./lib/owner.mjs";
import * as preflight from "./lib/preflight.mjs";
import * as reap from "./lib/reap.mjs";
import * as remote from "./lib/remote.mjs";
import * as runWeb from "./lib/run_web.mjs";
import * as runner from "./lib/runner.mjs";
import * as stateCmd from "./lib/state_cmd.mjs";
import * as status from "./lib/status.mjs";
import * as teardown from "./lib/teardown.mjs";
import * as vapiWiring from "./lib/vapi_wiring.mjs";
import * as verify from "./lib/verify.mjs";
import * as webRuntime from "./lib/web_runtime.mjs";
import * as webSetup from "./lib/web_setup.mjs";

export const COMMANDS = {
  preflight: { module: preflight, run: preflight.run, help: "check prerequisites and record inputs" },
  connect: { module: connectStack, run: connectStack.deploy, help: "stage 1: Amazon Connect lab stack" },
  bridgefu: { module: bridgefuStack, run: bridgefuStack.deploy, help: "stage 2: published Bridgefu stack" },
  vapi: { module: vapiWiring, run: vapiWiring.run, help: "stage 3: assistant persona and dial-in number" },
  "verify-phone": { module: verify, run: verify.verifyPhone, help: "stage 4: verify a phone handoff" },
  "web-setup": { module: webSetup, run: webSetup.run, help: "stage 5: add-on stack, direct assistant, runtime overlay" },
  "web-overlay": { module: webRuntime, run: webRuntime.run, help: "stage 5: apply | restore | status | render the host overlay", positionals: true },
  "web-serve": { module: runWeb, run: runWeb.run, help: "stage 5: run the local browser demo" },
  "verify-web": { module: verify, run: verify.verifyWeb, help: "stage 5: verify a browser handoff" },
  "lab-web-stack": { module: labWebStack, run: labWebStack.deploy, help: "stage 5: only (re)deploy the lab-web stack" },
  status: { module: status, run: status.run, help: "show lab state" },
  remote: { module: remote, run: remote.run, help: "doctor | provision | handout | agent | verify | teardown: run the lab in the shared account with your own Vapi org, no AWS access needed", positionals: true },
  key: { module: keyWrap, run: keyWrap.run, help: "wrap | unwrap | public-key: carry an engineer's own Vapi key into the lab account (remote mode)", positionals: true },
  state: { module: stateCmd, run: stateCmd.run, help: "export | import | push | pull | delete lab state (handouts, runner, S3)", positionals: true },
  owner: { module: owner, run: owner.run, help: "deploy: the lab account's sandbox stack and remote-mode gateway (lab owner, AWS admin)", positionals: true },
  runner: { module: runner, run: runner.run, help: "run the job the remote-mode gateway queued (lab account CodeBuild only)" },
  reap: { module: reap, run: reap.run, help: "tear down labs older than --max-age-days from the S3 state bucket (nightly runner job)" },
  teardown: { module: teardown, run: teardown.run, help: "stage 6: remove everything" },
};

function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = ["usage: node scripts/lab.mjs <command> [options]", "", "commands:"];
  for (const [name, spec] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(width)}  ${spec.help}`);
  lines.push("", "Run `node scripts/lab.mjs <command> --help` for the options of one command.");
  return lines.join("\n");
}

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    console.log(usage());
    return 0;
  }
  const spec = COMMANDS[name];
  if (!spec) {
    console.error(`unknown command: ${name}\n\n${usage()}`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`node scripts/lab.mjs ${name}  ${spec.help}\n${spec.module.help ?? ""}`);
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: spec.module.options ?? {}, allowPositionals: Boolean(spec.positionals), strict: true });
  } catch (error) {
    console.error(`error: ${error.message}\n${spec.module.help ?? ""}`);
    return 2;
  }
  try {
    await spec.run(parsed.values, parsed.positionals ?? []);
    return process.exitCode ?? 0;
  } catch (error) {
    if (error instanceof LabError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1] && (await import("node:url")).fileURLToPath(import.meta.url) === (await import("node:path")).resolve(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
