// Moves an engineer's OWN Vapi private key into the lab account without anyone
// else seeing it.
//
// Remote mode runs the AWS stages in the owner's account, but every engineer
// works in their own Vapi org with their own key. The Bridgefu product stack
// reads that key from a Secrets Manager secret in the lab account (its
// provisioner Lambda creates the template assistant with it), so the key has to
// get there. It travels as an RSA-OAEP ciphertext made on the engineer's laptop
// with the public half of the sandbox's KMS key. Only the runner role can
// decrypt it, inside the lab runner (CodeBuild), where it lands in a per-engineer
// secret that teardown deletes. The ciphertext names the engineer and expires
// after an hour, so a copied job request cannot be replayed later or for someone else.
import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, log } from "./common.mjs";
import * as gateway from "./gateway_client.mjs";
import * as vapiCli from "./vapi_cli.mjs";

export const WRAP_VERSION = 1;
export const WRAP_TTL_SECONDS = 3600;
export const KEY_ARN_VARIABLE = "LAB_WRAP_KEY_ARN";
export const DEFAULT_KEY_ALIAS = "alias/bridgefu-lab-wrap";

export const options = {
  engineer: { type: "string" },
  gateway: { type: "string" },
  "public-key": { type: "string" },
  wrapped: { type: "string" },
  "key-arn": { type: "string" },
  region: { type: "string" },
  "skip-vapi-check": { type: "boolean", default: false },
  "vapi-account": { type: "string" },
  "vapi-login": { type: "boolean", default: false },
};

export const help = `key wrap --engineer <handle> [--gateway https://...] [--public-key <base64 DER | PEM file>] [--vapi-account <name>] [--vapi-login] [--skip-vapi-check]
    Takes YOUR Vapi private key from the Vapi CLI login (signing you in through the dashboard when needed; $VAPI_PRIVATE_KEY
    overrides), checks it against the Vapi API and prints a one-hour ciphertext (remote provision does this for you).
key unwrap --engineer <handle> [--wrapped <ciphertext> | $LAB_WRAPPED_KEY] [--key-arn <kms arn> | $${KEY_ARN_VARIABLE}] [--region r]
    (lab runner) Decrypts with KMS and stores the key in secret bridgefu/<handle>/vapi-private-key, recorded in the lab state.
key public-key [--key-arn <kms arn or alias>] [--region r]
    (owner) Prints the base64 public key the gateway serves to engineers.`;

// ------------------------------------------------------------ pure functions
export function assertEngineer(engineer) {
  if (!common.DEPLOYMENT_ID.test(engineer ?? "")) throw new LabError("--engineer must be 3-24 lowercase letters, digits or hyphens, starting with a letter");
  return engineer;
}

export function buildWrapPayload({ engineer, key, now = Date.now() }) {
  assertEngineer(engineer);
  const trimmed = String(key ?? "").trim();
  if (trimmed.length < 8 || trimmed.length > 128) throw new LabError("the Vapi private key has an unexpected length");
  if (/\s/.test(trimmed)) throw new LabError("the Vapi private key must not contain whitespace");
  return { v: WRAP_VERSION, engineer, key: trimmed, exp: Math.floor(now / 1000) + WRAP_TTL_SECONDS };
}

export function publicKeyObject(material) {
  const text = String(material ?? "").trim();
  try {
    if (text.includes("BEGIN PUBLIC KEY")) return createPublicKey({ key: text, format: "pem" });
    if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) throw new Error("not base64");
    return createPublicKey({ key: Buffer.from(text.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" });
  } catch (error) {
    throw new LabError(`the wrap public key must be PEM or base64 DER (SubjectPublicKeyInfo): ${error.message}`);
  }
}

export function wrapPayload(payload, publicKeyMaterial) {
  const key = publicKeyObject(publicKeyMaterial);
  if (key.asymmetricKeyType !== "rsa") throw new LabError(`the wrap key must be RSA (got ${key.asymmetricKeyType})`);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const capacity = key.asymmetricKeyDetails.modulusLength / 8 - 2 * 32 - 2; // RSA-OAEP with SHA-256
  if (plaintext.length > capacity) throw new LabError(`the wrapped payload is ${plaintext.length} bytes but the key fits ${capacity}`);
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, plaintext).toString("base64");
}

export function parseUnwrapped(plaintext, { engineer, now = Date.now() }) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(plaintext).toString("utf8"));
  } catch {
    throw new LabError("the decrypted payload is not JSON");
  }
  if (payload?.v !== WRAP_VERSION) throw new LabError(`unsupported wrapped-key version ${JSON.stringify(payload?.v ?? null)}`);
  if (payload.engineer !== engineer) throw new LabError(`this wrapped key was made for engineer ${JSON.stringify(payload.engineer)}, not ${JSON.stringify(engineer)}`);
  if (!Number.isInteger(payload.exp) || payload.exp * 1000 < now) throw new LabError("this wrapped key has expired (they last one hour); run `key wrap` again");
  if (typeof payload.key !== "string" || payload.key.length < 8 || payload.key.length > 128) throw new LabError("the decrypted payload holds no usable key");
  return payload.key;
}

export function looksLikeRawVapiKey(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? "").trim());
}

export function isCiphertext(value) {
  const text = String(value ?? "").trim();
  return text.length >= 256 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

// ------------------------------------------------------------ Vapi
export async function checkVapiKey(key) {
  let response;
  try {
    response = await fetch(`${common.VAPI_BASE_URL}/assistant?limit=1`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": common.USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new LabError(`could not reach the Vapi API to check the key: ${error.message}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new LabError(`the Vapi API rejected this key (${response.status}); use the PRIVATE key of your org (Vapi dashboard, Organization Settings, API Keys)`);
  }
  if (!response.ok) throw new LabError(`the Vapi API answered ${response.status} while checking the key`);
}

/**
 * The engineer's Vapi private key, never printed. Order: an environment
 * variable (scripts), the Vapi CLI login (the normal path; it opens the Vapi
 * dashboard when there is no login yet and refuses to guess between several
 * orgs), and finally a hidden terminal prompt when there is a TTY.
 */
export async function obtainKey(values) {
  const check = values["skip-vapi-check"] ? async () => {} : checkVapiKey;
  const fromEnv = (process.env.VAPI_PRIVATE_KEY ?? process.env.VAPI_API_KEY ?? "").trim();
  if (fromEnv) {
    await check(fromEnv);
    log("using the Vapi key from the environment");
    return fromEnv;
  }
  if (vapiCli.vapiCliInstalled()) {
    const { key, name, organization } = await vapiCli.keyFromVapiCli({ account: values["vapi-account"], forceLogin: values["vapi-login"] });
    await check(key);
    log(`using the Vapi CLI login ${name}${organization ? ` (${organization})` : ""}`);
    return key;
  }
  if (process.stdin.isTTY) {
    const key = await common.promptSecret("Your Vapi PRIVATE key (typing is hidden)");
    await check(key);
    return key;
  }
  throw new LabError(`no Vapi key available: ${vapiCli.INSTALL_HINT}; or set VAPI_PRIVATE_KEY`);
}

function currentState() {
  try {
    return common.loadState();
  } catch {
    return {};
  }
}

// ------------------------------------------------------------ commands
export async function wrap(values) {
  const engineer = assertEngineer(values.engineer);
  let material;
  if (values["public-key"]) {
    material = existsSync(values["public-key"]) ? readFileSync(values["public-key"], "utf8") : values["public-key"];
    publicKeyObject(material);
  } else {
    material = (await gateway.labConfig({ gateway: values.gateway })).wrap_public_key;
    publicKeyObject(material);
  }
  const key = await obtainKey(values);
  const ciphertext = wrapPayload(buildWrapPayload({ engineer, key }), material);
  log(`wrapped for ${engineer}; valid ${WRAP_TTL_SECONDS / 60} minutes; only the lab account's KMS key can open it.`);
  process.stdout.write(`${ciphertext}\n`);
  return ciphertext;
}

async function storeSecret(name, key, region) {
  try {
    const created = await common.withSecretFile(key, (uri) =>
      common.aws(
        ["secretsmanager", "create-secret", "--name", name, "--description", "Vapi private API key for one vapi-bridgefu-connect lab; deleted by teardown", "--secret-string", uri, "--tags", `Key=Project,Value=${common.PROJECT_TAG}`],
        { region },
      ),
    );
    if (!created?.ARN) throw new LabError("secret creation returned no ARN");
    return String(created.ARN);
  } catch (error) {
    if (!(error instanceof LabError) || !/ResourceExistsException/.test(error.message)) throw error;
  }
  const existing = await common.aws(["secretsmanager", "describe-secret", "--secret-id", name], { region });
  if (!existing?.ARN) throw new LabError(`secret ${name} exists but could not be described`);
  await common.putSecretValue(String(existing.ARN), key, region);
  return String(existing.ARN);
}

export async function unwrap(values) {
  const engineer = assertEngineer(values.engineer);
  const wrapped = (values.wrapped ?? process.env.LAB_WRAPPED_KEY ?? "").trim();
  if (!wrapped) throw new LabError("pass --wrapped <ciphertext> or set LAB_WRAPPED_KEY");
  if (looksLikeRawVapiKey(wrapped)) {
    throw new LabError("that is a RAW Vapi key, not a wrapped one. Rotate it in the Vapi dashboard now (job requests are visible to the lab account's administrators), then run `node scripts/lab.mjs key wrap` locally and pass its output");
  }
  if (!isCiphertext(wrapped)) throw new LabError("the wrapped key is not the base64 ciphertext printed by `key wrap`");
  const keyArn = values["key-arn"] ?? process.env[KEY_ARN_VARIABLE];
  if (!keyArn) throw new LabError(`pass --key-arn or set ${KEY_ARN_VARIABLE}`);
  const state = currentState();
  const region = values.region ?? state.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new LabError("pass --region or set AWS_REGION");
  const scratch = mkdtempSync(join(tmpdir(), "bridgefu-wrap-"));
  let decrypted;
  try {
    const blob = join(scratch, "wrapped.bin");
    writeFileSync(blob, Buffer.from(wrapped, "base64"), { mode: 0o600 });
    decrypted = await common.aws(["kms", "decrypt", "--key-id", keyArn, "--encryption-algorithm", "RSAES_OAEP_SHA_256", "--ciphertext-blob", `fileb://${blob}`], { region });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!decrypted?.Plaintext) throw new LabError("KMS returned no plaintext");
  const key = parseUnwrapped(Buffer.from(String(decrypted.Plaintext), "base64"), { engineer });
  const name = `bridgefu/${engineer}/vapi-private-key`;
  const arn = await storeSecret(name, key, region);
  state.vapi_secret_arn = arn;
  state.region ??= region;
  common.saveState(state);
  log(`stored ${engineer}'s Vapi key in secret ${name} (${common.fingerprint(arn)}); teardown deletes it`);
  return arn;
}

export async function publicKey(values) {
  const keyId = values["key-arn"] ?? process.env[KEY_ARN_VARIABLE] ?? DEFAULT_KEY_ALIAS;
  const region = values.region ?? currentState().region ?? process.env.AWS_REGION ?? common.PREFERRED_REGION;
  const result = await common.aws(["kms", "get-public-key", "--key-id", keyId], { region });
  if (!result?.PublicKey) throw new LabError("KMS returned no public key");
  publicKeyObject(result.PublicKey);
  process.stdout.write(`${result.PublicKey}\n`);
  return String(result.PublicKey);
}

export async function run(values, positionals) {
  const [action] = positionals;
  if (action === "wrap") return wrap(values);
  if (action === "unwrap") return unwrap(values);
  if (action === "public-key") return publicKey(values);
  throw new LabError(`key needs an action: wrap | unwrap | public-key\n${help}`);
}
