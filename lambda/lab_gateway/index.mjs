// Front door of remote mode. Engineers without AWS access call this Lambda
// function URL; it checks who they are with GitHub, starts the lab runner
// (CodeBuild, in this account) and hands back progress, the encrypted handout,
// and verify reports. No GitHub Actions involved.
//
// Who may call: anyone whose GitHub token can read LAB_REPO (the same invitation
// that lets them clone the lab). The token is used for that check and to fetch
// the repository source of LAB_REF; it is never stored or logged.
// Whose lab: the first GitHub account to provision a handle owns it while the
// lab exists; only that account (or a LAB_ADMINS login) can verify, read, or
// tear it down.
//
// Routes (JSON in, JSON out; Authorization: Bearer <GitHub token>):
//   GET  /config                     region, zone, the wrap public key
//   POST /provision                  {engineer, stages, client_cidr, area_code, agent_auto_accept, connect_alias, vapi_key_wrapped, handout_public_key}
//   POST /verify                     {engineer, mode, since_minutes, session_id, runtime_filter}
//   POST /teardown                   {engineer, keep_connect}
//   GET  /labs/<engineer>            the lab record and its last job
//   GET  /jobs/<engineer>/<job>      status, current step, handout or report, log tail on failure
// An EventBridge schedule invokes the function directly with {"action":"reap"}.
import { createHash } from "node:crypto";

export const ENGINEER = /^[a-z][a-z0-9-]{2,23}$/;
export const JOB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMEOUTS = { provision: 150, verify: 20, teardown: 120, reap: 300 };
const USER_AGENT = "vapi-bridgefu-connect-gateway/1";
const IDENTITY_TTL_MS = 5 * 60_000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------ pure validation
function fail(message) {
  throw new HttpError(400, message);
}

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") fail("inputs must be strings");
  return String(value).trim();
}

export function assertEngineer(engineer) {
  if (!ENGINEER.test(engineer ?? "")) fail("engineer must be 3-24 lowercase letters, digits or hyphens, starting with a letter");
  return engineer;
}

export function looksLikeRawVapiKey(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? "").trim());
}

/** Validates a provision request; returns exactly the fields the runner reads. */
export function provisionJob(body) {
  const engineer = assertEngineer(text(body.engineer));
  const stages = text(body.stages, "phone");
  if (!["phone", "full"].includes(stages)) fail("stages must be phone or full");
  const clientCidr = text(body.client_cidr);
  if (stages === "full" && !clientCidr) fail("client_cidr is required for the full lab");
  if (clientCidr && !/^\d{1,3}(\.\d{1,3}){3}\/32$/.test(clientCidr)) fail("client_cidr must be x.x.x.x/32");
  const areaCode = text(body.area_code, "415");
  if (!/^\d{3}$/.test(areaCode)) fail("area_code must be three digits");
  const agentAutoAccept = text(body.agent_auto_accept, "true");
  if (!["true", "false"].includes(agentAutoAccept)) fail("agent_auto_accept must be true or false");
  const connectAlias = text(body.connect_alias);
  if (connectAlias && !/^[a-z0-9-]{1,45}$/.test(connectAlias)) fail("connect_alias must be lowercase letters, digits, hyphens");
  const wrapped = text(body.vapi_key_wrapped);
  if (looksLikeRawVapiKey(wrapped)) fail("vapi_key_wrapped is a RAW Vapi key; rotate it and send the output of `key wrap` instead");
  if (wrapped.length < 256 || wrapped.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(wrapped)) fail("vapi_key_wrapped must be the ciphertext made by `key wrap`");
  const handoutPublicKey = text(body.handout_public_key);
  if (handoutPublicKey.length < 64 || handoutPublicKey.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(handoutPublicKey)) fail("handout_public_key must be a base64 DER public key");
  return { action: "provision", engineer, stages, client_cidr: clientCidr, area_code: areaCode, agent_auto_accept: agentAutoAccept, connect_alias: connectAlias, vapi_key_wrapped: wrapped, handout_public_key: handoutPublicKey };
}

export function verifyJob(body) {
  const engineer = assertEngineer(text(body.engineer));
  const mode = text(body.mode, "phone");
  if (!["phone", "web"].includes(mode)) fail("mode must be phone or web");
  const since = text(body.since_minutes, "30");
  if (!/^\d{1,4}$/.test(since)) fail("since_minutes must be a number");
  const sessionId = text(body.session_id);
  if (sessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) fail("session_id has unexpected characters");
  const runtimeFilter = text(body.runtime_filter);
  if (runtimeFilter.length > 200 || /[\r\n]/.test(runtimeFilter)) fail("runtime_filter must be one line of at most 200 characters");
  return { action: "verify", engineer, mode, since_minutes: since, session_id: sessionId, runtime_filter: runtimeFilter };
}

export function teardownJob(body) {
  const engineer = assertEngineer(text(body.engineer));
  const keep = text(body.keep_connect, "false");
  if (!["true", "false"].includes(keep)) fail("keep_connect must be true or false");
  return { action: "teardown", engineer, keep_connect: keep };
}

/** "project:uuid" -> uuid */
export function jobIdOf(buildId) {
  return String(buildId ?? "").split(":").pop();
}

export function isAdmin(login, admins) {
  const wanted = String(login ?? "").toLowerCase();
  return String(admins ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}

/** May this GitHub identity act on a lab whose record is `record`? */
export function mayUse(record, identity, admins) {
  if (!record || record.github_id === undefined) return true;
  return String(record.github_id) === String(identity.id) || isAdmin(identity.login, admins);
}

const RUNNING = new Set(["IN_PROGRESS"]);

export function jobView(build, { progress = null, artifacts = {}, logTail = null } = {}) {
  const env = Object.fromEntries((build.environment?.environmentVariables ?? []).map((item) => [item.name, item.value]));
  let job = {};
  try {
    job = JSON.parse(env.LAB_JOB ?? "{}");
  } catch {
    job = {};
  }
  const view = {
    job: jobIdOf(build.id),
    action: job.action ?? null,
    engineer: job.engineer ?? null,
    status: build.buildStatus,
    done: !RUNNING.has(build.buildStatus),
    step: progress?.step ?? build.currentPhase ?? null,
    failed_step: progress?.failed_step ?? null,
    started_at: build.startTime ? new Date(build.startTime).toISOString() : null,
    ended_at: build.endTime ? new Date(build.endTime).toISOString() : null,
  };
  if (artifacts.handout) view.handout = artifacts.handout;
  if (artifacts.report !== undefined && artifacts.report !== null) view.report = artifacts.report;
  if (logTail) view.log_tail = logTail;
  return view;
}

// ------------------------------------------------------------ AWS clients (lazy so the pure part imports anywhere)
let clients;
async function aws() {
  if (!clients) {
    const [{ S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command }, { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand }, { CloudWatchLogsClient, GetLogEventsCommand }, { KMSClient, GetPublicKeyCommand }] = await Promise.all([
      import("@aws-sdk/client-s3"),
      import("@aws-sdk/client-codebuild"),
      import("@aws-sdk/client-cloudwatch-logs"),
      import("@aws-sdk/client-kms"),
    ]);
    clients = {
      s3: new S3Client({}),
      codebuild: new CodeBuildClient({}),
      logs: new CloudWatchLogsClient({}),
      kms: new KMSClient({}),
      GetObjectCommand,
      PutObjectCommand,
      HeadObjectCommand,
      ListObjectsV2Command,
      StartBuildCommand,
      BatchGetBuildsCommand,
      GetLogEventsCommand,
      GetPublicKeyCommand,
    };
  }
  return clients;
}

const env = (name, fallback) => process.env[name] ?? fallback;
const bucket = () => env("LAB_STATE_BUCKET");

async function getText(key) {
  const c = await aws();
  try {
    const result = await c.s3.send(new c.GetObjectCommand({ Bucket: bucket(), Key: key }));
    return await result.Body.transformToString();
  } catch (error) {
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function getJson(key) {
  const value = await getText(key);
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function putJson(key, value) {
  const c = await aws();
  await c.s3.send(new c.PutObjectCommand({ Bucket: bucket(), Key: key, Body: JSON.stringify(value), ContentType: "application/json", ServerSideEncryption: "AES256" }));
}

async function exists(key) {
  const c = await aws();
  try {
    await c.s3.send(new c.HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function liveLabCount() {
  const c = await aws();
  let token;
  let count = 0;
  do {
    const page = await c.s3.send(new c.ListObjectsV2Command({ Bucket: bucket(), ContinuationToken: token }));
    count += (page.Contents ?? []).filter((item) => /^[a-z][a-z0-9-]+\/state\.json$/.test(item.Key)).length;
    token = page.NextContinuationToken;
  } while (token);
  return count;
}

async function getBuild(jobId) {
  const c = await aws();
  const result = await c.codebuild.send(new c.BatchGetBuildsCommand({ ids: [`${env("LAB_PROJECT")}:${jobId}`] }));
  return result.builds?.[0] ?? null;
}

async function logTail(build, lines = 80) {
  const group = build.logs?.groupName;
  const stream = build.logs?.streamName;
  if (!group || !stream) return null;
  const c = await aws();
  try {
    const result = await c.logs.send(new c.GetLogEventsCommand({ logGroupName: group, logStreamName: stream, limit: lines, startFromHead: false }));
    return (result.events ?? []).map((event) => event.message.replace(/\s+$/, ""));
  } catch {
    return null;
  }
}

let publicKeyCache;
async function wrapPublicKey() {
  if (!publicKeyCache) {
    const c = await aws();
    const result = await c.kms.send(new c.GetPublicKeyCommand({ KeyId: env("LAB_WRAP_KEY_ARN") }));
    publicKeyCache = Buffer.from(result.PublicKey).toString("base64");
  }
  return publicKeyCache;
}

// ------------------------------------------------------------ GitHub
async function github(path, token, { raw = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": USER_AGENT, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(20_000),
  });
  if (raw) return response;
  if (!response.ok) return null;
  return response.json();
}

const identities = new Map();
async function identify(headers) {
  const header = headers?.authorization ?? headers?.Authorization ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!token) throw new HttpError(401, "send your GitHub token: Authorization: Bearer $(gh auth token)");
  const cacheKey = createHash("sha256").update(token).digest("hex");
  const cached = identities.get(cacheKey);
  if (cached && cached.expires > Date.now()) return { ...cached.identity, token };
  const user = await github("/user", token);
  if (!user?.login) throw new HttpError(401, "GitHub did not accept that token; run `gh auth login` again");
  const repo = await github(`/repos/${env("LAB_REPO")}`, token);
  if (!repo?.full_name) throw new HttpError(403, `${user.login} cannot read ${env("LAB_REPO")}; ask the lab owner for an invitation`);
  const identity = { login: user.login, id: user.id };
  identities.set(cacheKey, { identity, expires: Date.now() + IDENTITY_TTL_MS });
  return { ...identity, token };
}

/** Copies the repository at LAB_REF into the bucket once per commit; the runner runs exactly that. */
async function sourceFor(token) {
  const ref = env("LAB_REF", "main");
  const commit = await github(`/repos/${env("LAB_REPO")}/commits/${encodeURIComponent(ref)}`, token);
  if (!commit?.sha) throw new HttpError(502, `could not resolve ${env("LAB_REPO")}@${ref} on GitHub`);
  const key = `source/${commit.sha}.zip`;
  if (!(await exists(key))) {
    const response = await github(`/repos/${env("LAB_REPO")}/zipball/${commit.sha}`, token, { raw: true });
    if (!response.ok) throw new HttpError(502, `could not download ${env("LAB_REPO")}@${commit.sha.slice(0, 7)} (${response.status})`);
    const body = Buffer.from(await response.arrayBuffer());
    const c = await aws();
    await c.s3.send(new c.PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: "application/zip", ServerSideEncryption: "AES256" }));
  }
  await putJson("source/latest.json", { key, sha: commit.sha, ref, saved_at: new Date().toISOString() });
  return { key, sha: commit.sha };
}

async function startJob(job, source) {
  const c = await aws();
  const result = await c.codebuild.send(
    new c.StartBuildCommand({
      projectName: env("LAB_PROJECT"),
      timeoutInMinutesOverride: TIMEOUTS[job.action],
      environmentVariablesOverride: [
        { name: "LAB_JOB", value: JSON.stringify(job), type: "PLAINTEXT" },
        { name: "LAB_SOURCE_KEY", value: source.key, type: "PLAINTEXT" },
      ],
    }),
  );
  return jobIdOf(result.build.id);
}

// ------------------------------------------------------------ routes
async function labRecord(engineer) {
  return getJson(`labs/${engineer}.json`);
}

/** A handle is held while its lab state exists or its last job is still running. */
async function holder(engineer) {
  const record = await labRecord(engineer);
  if (!record) return { record: null, held: false, running: false };
  const build = record.last_job ? await getBuild(record.last_job) : null;
  const running = build?.buildStatus === "IN_PROGRESS";
  const held = running || (await exists(`${engineer}/state.json`));
  return { record, held, running, build };
}

async function claim(engineer, identity, { requireLab }) {
  const { record, held, running } = await holder(engineer);
  if (held && !mayUse(record, identity, env("LAB_ADMINS", ""))) throw new HttpError(403, `lab ${engineer} belongs to GitHub user ${record.github_login}; pick another handle`);
  if (running) throw new HttpError(409, `lab ${engineer} is busy with a ${record.last_action} job (${record.last_job}); wait for it first`);
  if (requireLab && !held) throw new HttpError(404, `there is no lab called ${engineer}`);
  return { record, held };
}

/** owner: the existing record while the lab is held, else null (the caller becomes the owner). */
async function record(engineer, identity, action, jobId, owner) {
  await putJson(`labs/${engineer}.json`, {
    engineer,
    github_id: owner?.github_id ?? identity.id,
    github_login: owner?.github_login ?? identity.login,
    created_at: owner?.created_at ?? new Date().toISOString(),
    last_job: jobId,
    last_action: action,
    last_by: identity.login,
    updated_at: new Date().toISOString(),
  });
}

async function provision(identity, body) {
  const job = provisionJob(body);
  const { record: previous, held } = await claim(job.engineer, identity, { requireLab: false });
  const max = Number(env("LAB_MAX_LABS", "40"));
  if (!held && (await liveLabCount()) >= max) throw new HttpError(429, `the lab account already holds ${max} labs; tear one down or ask the owner`);
  const source = await sourceFor(identity.token);
  const jobId = await startJob(job, source);
  // a reclaimed (torn-down) handle passes to whoever provisions it next
  await record(job.engineer, identity, "provision", jobId, held ? previous : null);
  return { job: jobId, engineer: job.engineer, commit: source.sha };
}

async function simpleJob(identity, job) {
  const { record: owner } = await claim(job.engineer, identity, { requireLab: true });
  const source = await sourceFor(identity.token);
  const jobId = await startJob(job, source);
  await record(job.engineer, identity, job.action, jobId, owner);
  return { job: jobId, engineer: job.engineer, commit: source.sha };
}

async function jobStatus(identity, engineer, jobId) {
  assertEngineer(engineer);
  if (!JOB.test(jobId)) fail("job must be a job id returned by provision, verify, or teardown");
  const record = await labRecord(engineer);
  if (!mayUse(record, identity, env("LAB_ADMINS", ""))) throw new HttpError(403, `lab ${engineer} belongs to GitHub user ${record.github_login}`);
  const build = await getBuild(jobId);
  const view = build ? jobView(build) : null;
  if (!view || view.engineer !== engineer) throw new HttpError(404, `no job ${jobId} for ${engineer}`);
  const prefix = `jobs/${engineer}/${jobId}`;
  const progress = await getJson(`${prefix}/progress.json`);
  const artifacts = {};
  if (view.done) {
    artifacts.handout = await getJson(`${prefix}/handout.json`);
    artifacts.report = await getText(`${prefix}/report.txt`);
  }
  const failed = view.done && view.status !== "SUCCEEDED";
  return jobView(build, { progress, artifacts, logTail: failed ? await logTail(build) : null });
}

async function labStatus(identity, engineer) {
  assertEngineer(engineer);
  const { record, held, running, build } = await holder(engineer);
  if (!record) throw new HttpError(404, `there is no lab called ${engineer}`);
  if (!mayUse(record, identity, env("LAB_ADMINS", ""))) throw new HttpError(403, `lab ${engineer} belongs to GitHub user ${record.github_login}`);
  return { ...record, exists: held, running, last_status: build?.buildStatus ?? null };
}

async function reap() {
  const source = await getJson("source/latest.json");
  if (!source?.key) {
    console.log("reap skipped: no source has been fetched yet (no lab was ever provisioned)");
    return { skipped: true };
  }
  const jobId = await startJob({ action: "reap", max_age_days: env("LAB_MAX_AGE_DAYS", "3"), dry_run: "false" }, source);
  console.log(`reap job ${jobId} started on ${source.sha}`);
  return { job: jobId };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (raw.length > 32_768) fail("request too large");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("send a JSON object");
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail("send a JSON object");
  }
}

export async function route(method, path, identity, body) {
  if (method === "GET" && path === "/config") {
    return { repo: env("LAB_REPO"), ref: env("LAB_REF", "main"), region: env("AWS_REGION"), zone: env("LAB_HOSTED_ZONE_NAME"), max_age_days: env("LAB_MAX_AGE_DAYS", "3"), wrap_public_key: await wrapPublicKey(), you: identity.login };
  }
  if (method === "POST" && path === "/provision") return provision(identity, body);
  if (method === "POST" && path === "/verify") return simpleJob(identity, verifyJob(body));
  if (method === "POST" && path === "/teardown") return simpleJob(identity, teardownJob(body));
  let match = /^\/labs\/([^/]+)$/.exec(path);
  if (method === "GET" && match) return labStatus(identity, match[1]);
  match = /^\/jobs\/([^/]+)\/([^/]+)$/.exec(path);
  if (method === "GET" && match) return jobStatus(identity, match[1], match[2]);
  throw new HttpError(404, `no route ${method} ${path}`);
}

function reply(status, value) {
  return { statusCode: status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) };
}

export async function handler(event) {
  if (!event?.requestContext?.http) {
    if (event?.action === "reap") return reap();
    return { ignored: true };
  }
  const method = event.requestContext.http.method;
  const path = (event.rawPath || "/").replace(/\/+$/, "") || "/";
  try {
    const identity = await identify(event.headers);
    const body = method === "POST" ? parseBody(event) : {};
    const result = await route(method, path, identity, body);
    console.log(JSON.stringify({ who: identity.login, method, path, engineer: body.engineer ?? null, job: result?.job ?? null }));
    return reply(200, result);
  } catch (error) {
    if (error instanceof HttpError) {
      console.log(JSON.stringify({ method, path, status: error.status, error: error.message }));
      return reply(error.status, { error: error.message });
    }
    console.error(error);
    return reply(500, { error: `gateway error: ${error.name ?? "Error"}` });
  }
}
