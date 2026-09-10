// `state` subcommands: move the lab state between an engineer's laptop, the CI
// runner, and the owner's S3 bucket, and export a handout an engineer without AWS
// access can import. State holds identifiers only; the one secret a handout may
// carry (the lab session bearer for the browser demo) is opt-in and can be
// encrypted with a passphrase (AES-256-GCM, scrypt), so the artifact is safe to
// pass through a CI artifact store.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, aws, log } from "./common.mjs";

export const options = {
  out: { type: "string", default: "handout.json" },
  bucket: { type: "string" },
  deployment: { type: "string" },
  "with-web-bearer": { type: "boolean", default: false },
  "passphrase-env": { type: "string" },
  force: { type: "boolean", default: false },
  "if-exists": { type: "boolean", default: false },
};
export const help = `state export [--out handout.json] [--with-web-bearer] [--passphrase-env VAR]
state import <file> [--passphrase-env VAR] [--force]
state push --bucket <bucket>            (uploads .lab/state.json to s3://bucket/<deployment>/state.json)
state pull --bucket <bucket> --deployment <id> [--if-exists]
state delete --bucket <bucket> --deployment <id>`;

const ENCRYPTED_KEYS = ["encrypted", "kdf", "salt", "iv", "tag", "ciphertext"];

export function encryptJson(value, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 8) throw new LabError("the passphrase must be at least 8 characters");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { encrypted: true, kdf: "scrypt", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function decryptJson(envelope, passphrase) {
  if (!envelope || envelope.encrypted !== true || ENCRYPTED_KEYS.some((key) => !(key in envelope))) throw new LabError("this file is not an encrypted handout");
  if (typeof passphrase !== "string" || !passphrase) throw new LabError("this handout is encrypted; pass --passphrase-env <VAR> holding the passphrase");
  const key = scryptSync(passphrase, Buffer.from(envelope.salt, "base64"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  try {
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  } catch {
    throw new LabError("could not decrypt the handout: wrong passphrase or corrupted file");
  }
}

/** The handout is the state plus provenance; the bearer is added only on request. */
export function buildHandout(state, { webBearer = null } = {}) {
  const handout = JSON.parse(JSON.stringify(state));
  handout.handout = { exported_at: common.nowIso(), includes_web_bearer: Boolean(webBearer), source: "vapi-bridgefu-connect state export" };
  if (webBearer) handout.lab_session_bearer = webBearer;
  return handout;
}

function passphraseFrom(values) {
  const name = values["passphrase-env"];
  if (!name) return null;
  const value = process.env[name];
  if (!value) throw new LabError(`environment variable ${name} is empty`);
  return value;
}

async function exportState(values) {
  const state = common.loadState();
  if (!Object.keys(state).length) throw new LabError("no lab state to export");
  let bearer = null;
  if (values["with-web-bearer"]) {
    common.requireKeys(state, "lab_web");
    bearer = await common.secretValue(state.lab_web.outputs.LabSessionBearerArn, common.regionOf(state));
  }
  const handout = buildHandout(state, { webBearer: bearer });
  const passphrase = passphraseFrom(values);
  const payload = passphrase ? encryptJson(handout, passphrase) : handout;
  writeFileSync(values.out, `${JSON.stringify(payload, null, passphrase ? 0 : 2)}\n`, { mode: 0o600 });
  log(`wrote ${values.out}${bearer ? " (includes the lab session bearer" + (passphrase ? ", encrypted)" : "; keep it private)") : ""}`);
}

function importState(file, values) {
  if (!file) throw new LabError("usage: state import <file>");
  let payload = JSON.parse(readFileSync(file, "utf8"));
  if (payload && payload.encrypted === true) payload = decryptJson(payload, passphraseFrom(values));
  if (!payload || typeof payload !== "object" || !payload.deployment_id) throw new LabError("the file does not look like a lab handout");
  if (existsSync(common.STATE_PATH) && !values.force) throw new LabError(`${common.STATE_PATH} already exists; pass --force to replace it`);
  common.saveState(payload);
  log(`imported lab state for deployment ${payload.deployment_id} (region ${payload.region})${payload.lab_session_bearer ? "; web-serve can use the included session bearer" : ""}`);
}

function stateKey(deployment) {
  if (!common.DEPLOYMENT_ID.test(deployment)) throw new LabError("deployment id is invalid");
  return `${deployment}/state.json`;
}

async function push(values) {
  const state = common.loadState();
  if (!values.bucket) throw new LabError("--bucket is required");
  const deployment = values.deployment ?? state.deployment_id;
  if (!deployment) throw new LabError("no deployment id in state; run preflight first");
  await aws(["s3", "cp", common.STATE_PATH, `s3://${values.bucket}/${stateKey(deployment)}`, "--sse", "AES256", "--only-show-errors"], { region: state.region, output: "none" });
  log(`state pushed to s3://${values.bucket}/${stateKey(deployment)}`);
}

async function pull(values) {
  if (!values.bucket || !values.deployment) throw new LabError("--bucket and --deployment are required");
  const key = stateKey(values.deployment);
  const target = join(common.LAB_DIR, "state.json");
  common.saveState(common.loadState()); // ensures .lab exists with the right mode
  const result = await aws(["s3", "cp", `s3://${values.bucket}/${key}`, target, "--only-show-errors"], { output: "none", allowFailure: values["if-exists"] });
  if (result === null && values["if-exists"]) {
    log(`no saved state at s3://${values.bucket}/${key}; starting fresh`);
    if (existsSync(target) && !Object.keys(common.loadState()).length) return;
    return;
  }
  log(`state pulled from s3://${values.bucket}/${key}`);
}

async function remove(values) {
  if (!values.bucket || !values.deployment) throw new LabError("--bucket and --deployment are required");
  await aws(["s3", "rm", `s3://${values.bucket}/${stateKey(values.deployment)}`, "--only-show-errors"], { output: "none", allowFailure: true });
  log(`removed s3://${values.bucket}/${stateKey(values.deployment)}`);
}

export async function run(values, positionals) {
  const [action, file] = positionals;
  switch (action) {
    case "export":
      return exportState(values);
    case "import":
      return importState(file, values);
    case "push":
      return push(values);
    case "pull":
      return pull(values);
    case "delete":
      return remove(values);
    default:
      throw new LabError("usage: state export|import|push|pull|delete");
  }
}
