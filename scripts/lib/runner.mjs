// The lab runner: what used to be the GitHub Actions workflows. CodeBuild in the
// lab account runs `node scripts/lab.mjs runner` with the job the gateway
// (lambda/lab_gateway) validated in $LAB_JOB, as the bounded BridgeFuLabRunner
// role. Each step is an ordinary lab command in a child process; progress, the
// encrypted handout, and verify reports go to s3://$LAB_STATE_BUCKET/jobs/<engineer>/<job>/
// where the gateway hands them to the engineer.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, aws, log } from "./common.mjs";

export const options = {};
export const help = `runner   (lab account only) runs the job in $LAB_JOB inside CodeBuild; engineers use \`remote\` instead`;

const LAB = join(common.REPO_ROOT, "scripts", "lab.mjs");

function required(env, name) {
  const value = env[name];
  if (!value) throw new LabError(`${name} is not set; the runner only works inside the lab CodeBuild project`);
  return value;
}

/**
 * The steps of one job; pure so the shape is testable. A step with `always`
 * runs even after an earlier failure; `report` captures its output for the
 * engineer; `when` is "success" or "failure" relative to the earlier steps.
 */
export function plan(job, env) {
  const bucket = required(env, "LAB_STATE_BUCKET");
  const region = required(env, "AWS_REGION");
  const { engineer } = job;
  if (job.action !== "reap" && !common.DEPLOYMENT_ID.test(engineer ?? "")) throw new LabError("the job names no valid engineer");
  const pull = (ifExists) => ({ name: "Restore saved state", args: ["state", "pull", "--bucket", bucket, "--deployment", engineer, ...(ifExists ? ["--if-exists"] : [])] });
  if (job.action === "provision") {
    const zoneName = required(env, "LAB_HOSTED_ZONE_NAME");
    const steps = [
      pull(true),
      { name: "Unwrap the Vapi key into this lab's secret", args: ["key", "unwrap", "--engineer", engineer, "--key-arn", required(env, "LAB_WRAP_KEY_ARN"), "--region", region], env: { LAB_WRAPPED_KEY: job.vapi_key_wrapped } },
      {
        name: "Preflight",
        args: ["preflight", "--region", region, "--deployment-id", engineer, "--hosted-zone-id", required(env, "LAB_HOSTED_ZONE_ID"), "--sip-hostname", `bridgefu-${engineer}.${zoneName}`, ...(job.connect_alias ? ["--connect-alias", job.connect_alias] : [])],
      },
      { name: "Stage 1 Amazon Connect", args: ["connect", "--yes", "--agent-auto-accept", job.agent_auto_accept ?? "true"] },
      { name: "Stage 2 Bridgefu", args: ["bridgefu", "--yes"] },
      { name: "Stage 3 Vapi wiring", args: ["vapi", "--yes", "--area-code", job.area_code ?? "415"] },
    ];
    if (job.stages === "full") steps.push({ name: "Stage 5 browser path", args: ["web-setup", "--yes", "--client-cidr", job.client_cidr] });
    steps.push({ name: "Save state", args: ["state", "push", "--bucket", bucket, "--deployment", engineer], always: true });
    steps.push({
      name: "Write the handout",
      args: ["state", "export", "--out", "{work}/handout.json", ...(job.stages === "full" ? ["--with-web-bearer"] : []), "--with-agent-password", "--encrypt-to", job.handout_public_key],
      upload: { from: "{work}/handout.json", to: "handout.json" },
    });
    steps.push({ name: "Summary", args: ["status", "--no-aws"], always: true, report: true });
    return steps;
  }
  if (job.action === "verify") {
    const args = [`verify-${job.mode}`, "--since-minutes", job.since_minutes ?? "30"];
    if (job.session_id) args.push("--session-id", job.session_id);
    return [pull(false), { name: `Verify ${job.mode}`, args, report: true, env: job.runtime_filter ? { LAB_RUNTIME_FILTER: job.runtime_filter } : {} }];
  }
  if (job.action === "teardown") {
    return [
      pull(false),
      { name: "Teardown", args: ["teardown", "--yes", ...(job.keep_connect === "true" ? ["--keep-connect"] : [])] },
      { name: "Forget the lab", args: ["state", "delete", "--bucket", bucket, "--deployment", engineer] },
      { name: "Keep partial state for a retry", args: ["state", "push", "--bucket", bucket, "--deployment", engineer], when: "failure" },
    ];
  }
  if (job.action === "reap") {
    const maxAge = String(job.max_age_days ?? env.LAB_MAX_AGE_DAYS ?? "3");
    if (!/^\d{1,3}$/.test(maxAge)) throw new LabError("max_age_days must be a number");
    return [{ name: "Reap stale labs", args: ["reap", "--bucket", bucket, "--max-age-days", maxAge, "--yes", ...(job.dry_run === "true" ? ["--dry-run"] : [])], report: true }];
  }
  throw new LabError(`unknown job action ${JSON.stringify(job.action)}`);
}

/** Runs one lab command, streaming its output to the build log; returns the combined output. */
function runLab(args, extraEnv) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [LAB, ...args], { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const relay = (stream) => (chunk) => {
      output += chunk;
      stream.write(chunk);
    };
    child.stdout.on("data", relay(process.stdout));
    child.stderr.on("data", relay(process.stderr));
    child.on("close", (code) => done({ code: code ?? 1, output }));
    child.on("error", (error) => done({ code: 1, output: `${output}\n${error.message}` }));
  });
}

async function upload(bucket, key, { file, body }) {
  const source = file ?? "-";
  await aws(["s3", "cp", source, `s3://${bucket}/${key}`, "--sse", "AES256", "--only-show-errors"], { output: "none", input: file ? undefined : body });
}

export async function run() {
  const env = process.env;
  let job;
  try {
    job = JSON.parse(required(env, "LAB_JOB"));
  } catch (error) {
    if (error instanceof LabError) throw error;
    throw new LabError("LAB_JOB is not JSON");
  }
  const bucket = required(env, "LAB_STATE_BUCKET");
  const jobId = String(env.CODEBUILD_BUILD_ID ?? `local:${Date.now()}`).split(":").pop();
  const prefix = job.action === "reap" ? `jobs/_reaper/${jobId}` : `jobs/${job.engineer}/${jobId}`;
  const steps = plan(job, env);
  const work = mkdtempSync(join(tmpdir(), "bridgefu-runner-"));
  const fill = (value) => value.replaceAll("{work}", work);
  const progress = { action: job.action, engineer: job.engineer ?? null, step: null, failed_step: null, done: [] };
  const report = [];
  const save = () => upload(bucket, `${prefix}/progress.json`, { body: JSON.stringify(progress) }).catch((error) => log(`could not save progress: ${error.message}`));
  log(`== ${job.action}${job.engineer ? ` for ${job.engineer}` : ""} (job ${jobId}) ==`);
  try {
    for (const step of steps) {
      const failed = progress.failed_step !== null;
      const wanted = step.when === "failure" ? failed : step.always || !failed;
      if (!wanted) continue;
      progress.step = step.name;
      await save();
      log(`== ${step.name} ==`);
      const result = await runLab(step.args.map(fill), step.env ?? {});
      if (step.report) report.push(`## ${step.name}`, result.output.trimEnd(), "");
      if (result.code === 0 && step.upload) {
        const file = fill(step.upload.from);
        if (existsSync(file)) await upload(bucket, `${prefix}/${step.upload.to}`, { file });
        else result.code = 1;
      }
      if (result.code === 0) progress.done.push(step.name);
      else if (!failed) progress.failed_step = step.name;
    }
  } finally {
    progress.step = progress.failed_step ? `failed at: ${progress.failed_step}` : "finished";
    await save();
    if (report.length) await upload(bucket, `${prefix}/report.txt`, { body: `${report.join("\n")}\n` }).catch((error) => log(`could not save the report: ${error.message}`));
    rmSync(work, { recursive: true, force: true });
  }
  if (progress.failed_step) throw new LabError(`${job.action} failed at step: ${progress.failed_step}`);
  log(`== ${job.action} finished ==`);
}
