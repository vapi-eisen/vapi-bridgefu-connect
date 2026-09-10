// Nightly cleanup for a shared lab account: tear down every lab whose saved state
// in the S3 state bucket is older than the allowed age. Runs in CI; safe to run
// by hand. Each lab is torn down with the normal teardown so nothing is stranded.
import { readFileSync } from "node:fs";
import * as common from "./common.mjs";
import { LabError, aws, log } from "./common.mjs";
import * as teardown from "./teardown.mjs";

export const options = {
  bucket: { type: "string" },
  "max-age-days": { type: "string", default: "3" },
  "dry-run": { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
};
export const help = `reap --bucket <state bucket> --max-age-days 3 [--dry-run] [--yes]`;

/** Deployments whose saved state is older than the limit. */
export function staleDeployments(entries, maxAgeDays, now = Date.now()) {
  const limit = maxAgeDays * 24 * 60 * 60 * 1000;
  return entries
    .filter((entry) => entry.deployment_id && entry.created_at)
    .filter((entry) => {
      const created = Date.parse(entry.created_at);
      return !Number.isNaN(created) && now - created > limit;
    })
    .map((entry) => entry.deployment_id);
}

export async function run(values) {
  if (!values.bucket) throw new LabError("--bucket is required");
  const maxAge = Number(values["max-age-days"]);
  if (!Number.isFinite(maxAge) || maxAge <= 0) throw new LabError("--max-age-days must be a positive number");
  const listing = (await aws(["s3api", "list-objects-v2", "--bucket", values.bucket, "--query", "Contents[].Key"], { allowFailure: true })) ?? [];
  const keys = (listing ?? []).filter((key) => /^[a-z][a-z0-9-]+\/state\.json$/.test(key));
  const entries = [];
  for (const key of keys) {
    const local = `${common.LAB_DIR}/reap-${key.split("/")[0]}.json`;
    common.saveState(common.loadState());
    await aws(["s3", "cp", `s3://${values.bucket}/${key}`, local, "--only-show-errors"], { output: "none" });
    try {
      const state = JSON.parse(readFileSync(local, "utf8"));
      entries.push({ deployment_id: state.deployment_id, created_at: state.created_at, region: state.region });
    } catch {
      log(`skipping unreadable state ${key}`);
    }
  }
  const stale = staleDeployments(entries, maxAge);
  log(`${entries.length} saved lab(s); ${stale.length} older than ${maxAge} day(s): ${stale.join(", ") || "none"}`);
  if (values["dry-run"] || !stale.length) return;
  await common.confirm(`Tear down ${stale.length} stale lab(s)?`, values.yes);
  for (const deployment of stale) {
    log(`== reaping ${deployment} ==`);
    await aws(["s3", "cp", `s3://${values.bucket}/${deployment}/state.json`, common.STATE_PATH, "--only-show-errors"], { output: "none" });
    try {
      await teardown.run({ "dry-run": false, "keep-connect": false, "keep-vapi-secret": false, yes: true });
      await aws(["s3", "rm", `s3://${values.bucket}/${deployment}/state.json`, "--only-show-errors"], { output: "none" });
    } catch (error) {
      log(`teardown of ${deployment} failed: ${error.message}; its state was kept for the next run`);
      await aws(["s3", "cp", common.STATE_PATH, `s3://${values.bucket}/${deployment}/state.json`, "--sse", "AES256", "--only-show-errors"], { output: "none", allowFailure: true });
    }
  }
}
