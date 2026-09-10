// Stage 6: remove everything the lab created, in an order that never strands a resource.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, aws, log } from "./common.mjs";
import * as vapiAssistant from "./vapi_assistant.mjs";
import * as vapiPhone from "./vapi_phone.mjs";
import * as vapiWebObjects from "./vapi_web_objects.mjs";
import * as webRuntime from "./web_runtime.mjs";

const DELETE_TIMEOUT_SECONDS = 75 * 60;

export const options = {
  "dry-run": { type: "boolean", default: false },
  "keep-connect": { type: "boolean", default: false },
  "keep-vapi-secret": { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
};
export const help = `--dry-run  --keep-connect  --keep-vapi-secret  --yes`;

async function deleteStack(name, region) {
  const status = await common.stackStatus(name, region);
  if (status === null) {
    log(`${name}: absent`);
    return;
  }
  await aws(["cloudformation", "delete-stack", "--stack-name", name], { region, output: "none" });
  await common.waitForStack(name, region, { success: ["DELETE_COMPLETE"], timeoutSeconds: DELETE_TIMEOUT_SECONDS, pollSeconds: 30 });
}

/**
 * Records that belong to the lab hostname: the SIP A record, control.<host>, and
 * the ACM validation CNAMEs (_<hash>.<host>, _<hash>.control.<host>) that
 * CloudFormation can leave behind after the certificate is deleted. Never the
 * zone apex, NS, or SOA.
 */
export function labRecordsToDelete(recordSets, sipHostname) {
  const host = sipHostname.toLowerCase().replace(/\.$/, "");
  return (recordSets ?? []).filter((record) => {
    const name = String(record.Name ?? "").toLowerCase().replace(/\.$/, "").replace(/\\052/g, "*");
    if (["NS", "SOA"].includes(String(record.Type ?? ""))) return false;
    return name === host || name === `control.${host}` || name.endsWith(`.${host}`);
  });
}

async function cleanupDns(state) {
  const zone = state.hosted_zone_id;
  const host = state.sip_hostname;
  if (!zone || !host) return;
  const region = common.regionOf(state);
  let start = host;
  let startType;
  const leftovers = [];
  for (let page = 0; page < 10; page += 1) {
    const args = ["route53", "list-resource-record-sets", "--hosted-zone-id", zone, "--start-record-name", start, "--max-items", "100"];
    if (startType) args.push("--start-record-type", startType);
    const listing = (await aws(args, { region })) ?? {};
    const sets = listing.ResourceRecordSets ?? [];
    leftovers.push(...labRecordsToDelete(sets, host));
    const stillUnder = sets.length && labRecordsToDelete(sets.slice(-1), host).length;
    if (!listing.IsTruncated || !stillUnder) break;
    start = listing.NextRecordName;
    startType = listing.NextRecordType;
  }
  if (!leftovers.length) {
    log(`Route53: no leftover records under ${host}`);
    return;
  }
  const batch = { Changes: leftovers.map((record) => ({ Action: "DELETE", ResourceRecordSet: record })) };
  const file = join(common.LAB_DIR, "route53-cleanup.json");
  writeFileSync(file, JSON.stringify(batch));
  await aws(["route53", "change-resource-record-sets", "--hosted-zone-id", zone, "--change-batch", `file://${file}`], { region, output: "none" });
  log(`Route53: removed ${leftovers.length} leftover record(s) under ${host}: ${leftovers.map((r) => `${r.Type} ${r.Name}`).join(", ")}`);
}

async function emptyAndDeleteBucket(name, region) {
  const exists = await aws(["s3api", "head-bucket", "--bucket", name], { region, output: "none", allowFailure: true });
  if (exists === null && (await aws(["s3api", "get-bucket-location", "--bucket", name], { region, allowFailure: true })) === null) {
    log(`bucket ${name}: absent`);
    return;
  }
  for (;;) {
    const listing = (await aws(["s3api", "list-object-versions", "--bucket", name, "--max-items", "500"], { region })) ?? {};
    const objects = [...(listing.Versions ?? []), ...(listing.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    if (!objects.length) break;
    await aws(["s3api", "delete-objects", "--bucket", name, "--delete", JSON.stringify({ Objects: objects, Quiet: true })], { region, output: "none" });
  }
  await aws(["s3api", "delete-bucket", "--bucket", name], { region, output: "none" });
  log(`bucket ${name}: deleted`);
}

export async function run(values) {
  const state = common.loadState();
  if (!Object.keys(state).length) {
    console.log("Nothing to tear down: no lab state.");
    return;
  }
  const region = common.regionOf(state);
  const names = common.stackNames(state);
  const retention = state.bridgefu?.parameters?.DataRetentionMode ?? "TestDelete";
  const bucket = state.account_id ? common.labBucketName(state) : "-";
  const plan = [
    "1. restore the Bridgefu host overlay (if applied)",
    "2. delete the direct web Vapi objects (assistant, tool, SIP endpoint) and unbind",
    `3. delete stack ${names.lab_web}`,
    "4. release the dial-in number and detach any attached assistant",
    `5. delete stack ${names.bridgefu} (${retention})`,
    `   then remove leftover Route53 records under ${state.sip_hostname ?? "-"} (ACM validation CNAMEs)`,
    `6. delete stack ${names.connect}${values["keep-connect"] ? " (skipped: --keep-connect)" : ""}`,
    `7. empty and delete bucket ${bucket}`,
    `8. delete the Vapi key secret${values["keep-vapi-secret"] ? " (skipped: --keep-vapi-secret)" : ""}`,
  ];
  console.log("Teardown plan:");
  for (const line of plan) console.log(`  ${line}`);
  if (values["dry-run"]) {
    console.log("(dry run; nothing deleted)");
    return;
  }
  await common.confirm("Proceed with teardown? This deletes the lab stacks and Vapi lab objects.", values.yes);

  const errors = [];
  const step = async (labelText, action) => {
    try {
      await action();
    } catch (error) {
      errors.push(`${labelText}: ${error.message}`);
      log(`${labelText} failed: ${error.message}`);
    }
  };

  if (state.web?.overlay) await step("overlay restore", () => webRuntime.restoreOverlay(state, true));
  if (state.web?.vapi) {
    await step("vapi direct objects", async () => {
      const problems = await vapiWebObjects.remove(state);
      if (problems.length) throw new LabError(problems.join("; "));
    });
  }
  await step("lab-web stack", () => deleteStack(names.lab_web, region));
  if (state.vapi?.phone) await step("release number", () => vapiPhone.release(state));
  if (state.vapi?.attached_assistant) await step("detach assistant", () => vapiAssistant.detach(state));
  await step("bridgefu stack", () => deleteStack(names.bridgefu, region));
  await step("route53 cleanup", () => cleanupDns(state));
  if (!values["keep-connect"]) await step("connect stack", () => deleteStack(names.connect, region));
  if (state.account_id) await step("lab bucket", () => emptyAndDeleteBucket(common.labBucketName(state), region));
  if (!values["keep-vapi-secret"] && state.vapi_secret_arn) {
    await step("vapi key secret", () => aws(["secretsmanager", "delete-secret", "--secret-id", state.vapi_secret_arn, "--force-delete-without-recovery"], { region, output: "none" }));
  }

  if (errors.length) {
    console.log("Teardown finished with problems:");
    for (const error of errors) console.log(`  - ${error}`);
    console.log("Fix them and re-run teardown; the state file was kept.");
    throw new LabError("teardown incomplete");
  }
  const backup = join(common.LAB_DIR, "state.json.last");
  if (existsSync(common.STATE_PATH)) renameSync(common.STATE_PATH, backup);
  console.log("Teardown complete. Remaining manual checks (docs/06-teardown.md):");
  console.log(`  - Route53 zone ${state.hosted_zone_id}: leftover records under ${state.sip_hostname} were removed; confirm none remain`);
  if (retention === "ProductionRetain") console.log("  - ProductionRetain: the DynamoDB table, data volume, backup vault, and Vapi template objects were kept on purpose");
  console.log("  - Vapi dashboard: no leftover bridgefu-lab-* numbers, assistants, or tools");
  console.log(`  - state saved to ${backup} for reference; delete it when done`);
}
