// `state` subcommands: move the lab state between an engineer's laptop, the CI
// runner, and the owner's S3 bucket, and export a handout an engineer without AWS
// access can import. State holds identifiers only; the secrets a handout may
// carry (the lab session bearer for the browser demo, the lab agent password)
// are opt-in and require encryption: to the engineer's handout keypair
// (AES-256-GCM data key wrapped with RSA-OAEP, made by `remote provision`) or
// with a passphrase (AES-256-GCM, scrypt), so the artifact is safe to pass
// through a CI artifact store.
import { constants, createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, aws, log } from "./common.mjs";
import { publicKeyObject } from "./key_wrap.mjs";

export const HANDOUT_KEY_PATH = join(common.LAB_DIR, "handout.key");

export const options = {
  out: { type: "string", default: "handout.json" },
  bucket: { type: "string" },
  deployment: { type: "string" },
  "with-web-bearer": { type: "boolean", default: false },
  "with-agent-password": { type: "boolean", default: false },
  "encrypt-to": { type: "string" },
  "key-file": { type: "string" },
  "passphrase-env": { type: "string" },
  force: { type: "boolean", default: false },
  "if-exists": { type: "boolean", default: false },
};
export const help = `state export [--out handout.json] [--with-web-bearer] [--with-agent-password] [--encrypt-to <base64 DER public key | PEM file> | --passphrase-env VAR]
state import <file> [--key-file .lab/handout.key] [--passphrase-env VAR] [--force]
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

/** Hybrid encryption to the engineer's handout public key: only their laptop can open it. */
export function encryptJsonToPublicKey(value, publicKeyMaterial) {
  const publicKey = publicKeyObject(publicKeyMaterial);
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, dataKey);
  return { encrypted: true, kdf: "rsa-oaep-sha256", wrapped_key: wrappedKey.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function decryptJsonWithPrivateKey(envelope, privateKeyPem) {
  if (!envelope || envelope.encrypted !== true || envelope.kdf !== "rsa-oaep-sha256" || !envelope.wrapped_key) throw new LabError("this file is not a key-encrypted handout");
  if (!privateKeyPem) throw new LabError(`this handout is encrypted to a handout key; expected it at ${HANDOUT_KEY_PATH} (pass --key-file)`);
  let dataKey;
  try {
    dataKey = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope.wrapped_key, "base64"));
  } catch {
    throw new LabError("could not open the handout: it was encrypted to a different handout key than the one in .lab/handout.key");
  }
  const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  try {
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  } catch {
    throw new LabError("could not decrypt the handout: corrupted file");
  }
}

export function decryptJson(envelope, passphrase) {
  if (!envelope || envelope.encrypted !== true || (envelope.kdf ?? "scrypt") !== "scrypt" || ENCRYPTED_KEYS.some((key) => !(key in envelope))) throw new LabError("this file is not a passphrase-encrypted handout");
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

/** The handout is the state plus provenance; secrets are added only on request. */
export function buildHandout(state, { webBearer = null, agentPassword = null } = {}) {
  const handout = JSON.parse(JSON.stringify(state));
  handout.handout = { exported_at: common.nowIso(), includes_web_bearer: Boolean(webBearer), includes_agent_password: Boolean(agentPassword), source: "vapi-bridgefu-connect state export" };
  if (webBearer) handout.lab_session_bearer = webBearer;
  if (agentPassword) handout.lab_agent_password = agentPassword;
  return handout;
}

/** The Connect lab stores {"username": ..., "password": ...}; older stacks stored the bare password. */
export function agentPasswordFrom(secretString) {
  try {
    const parsed = JSON.parse(secretString);
    if (parsed && typeof parsed === "object" && typeof parsed.password === "string") return parsed.password;
  } catch {
    /* not JSON: the whole value is the password */
  }
  return String(secretString).trim();
}

function publicKeyMaterialFrom(values) {
  const value = values["encrypt-to"];
  if (!value) return null;
  return existsSync(value) ? readFileSync(value, "utf8") : value;
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
  const publicKeyMaterial = publicKeyMaterialFrom(values);
  const passphrase = passphraseFrom(values);
  if (publicKeyMaterial && passphrase) throw new LabError("use either --encrypt-to or --passphrase-env, not both");
  const encrypted = Boolean(publicKeyMaterial || passphrase);
  let bearer = null;
  if (values["with-web-bearer"]) {
    common.requireKeys(state, "lab_web");
    bearer = await common.secretValue(state.lab_web.outputs.LabSessionBearerArn, common.regionOf(state));
  }
  let agentPassword = null;
  if (values["with-agent-password"]) {
    if (!encrypted) throw new LabError("--with-agent-password requires --encrypt-to or --passphrase-env");
    common.requireKeys(state, "connect");
    const arn = state.connect.outputs?.AgentCredentialSecretArn;
    if (!arn) throw new LabError("the Connect stack outputs have no AgentCredentialSecretArn");
    agentPassword = agentPasswordFrom(await common.secretValue(arn, common.regionOf(state)));
  }
  const handout = buildHandout(state, { webBearer: bearer, agentPassword });
  const payload = publicKeyMaterial ? encryptJsonToPublicKey(handout, publicKeyMaterial) : passphrase ? encryptJson(handout, passphrase) : handout;
  writeFileSync(values.out, `${JSON.stringify(payload, null, encrypted ? 0 : 2)}\n`, { mode: 0o600 });
  const carried = [bearer && "the lab session bearer", agentPassword && "the agent password"].filter(Boolean).join(" and ");
  log(`wrote ${values.out}${carried ? ` (includes ${carried}${encrypted ? ", encrypted" : "; keep it private"})` : ""}`);
}

function importState(file, values) {
  if (!file) throw new LabError("usage: state import <file>");
  let payload = JSON.parse(readFileSync(file, "utf8"));
  if (payload && payload.encrypted === true && payload.kdf === "rsa-oaep-sha256") {
    const keyFile = values["key-file"] ?? HANDOUT_KEY_PATH;
    payload = decryptJsonWithPrivateKey(payload, existsSync(keyFile) ? readFileSync(keyFile, "utf8") : null);
  } else if (payload && payload.encrypted === true) {
    payload = decryptJson(payload, passphraseFrom(values));
  }
  if (!payload || typeof payload !== "object" || !payload.deployment_id) throw new LabError("the file does not look like a lab handout");
  if (existsSync(common.STATE_PATH) && !values.force) throw new LabError(`${common.STATE_PATH} already exists; pass --force to replace it`);
  common.saveState(payload);
  const extras = [payload.lab_session_bearer && "web-serve can use the included session bearer", payload.lab_agent_password && "`remote agent` can hand over the agent password"].filter(Boolean).join("; ");
  log(`imported lab state for deployment ${payload.deployment_id} (region ${payload.region})${extras ? `; ${extras}` : ""}`);
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
