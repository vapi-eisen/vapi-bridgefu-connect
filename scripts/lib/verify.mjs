// Stages 4 and 5 verification: prove a handoff from Vapi, DynamoDB, and Amazon Connect.
//
// The three sources are independent: Vapi says the assistant transferred, the
// DynamoDB row says the prepare step stored context, and the Connect contact
// attributes say Bridgefu delivered the correlation id and the lookup succeeded.
// Correlation ids are shown as fingerprints unless --reveal is given.
import { createHmac } from "node:crypto";
import * as common from "./common.mjs";
import { LabError, aws, log, vapiRequest } from "./common.mjs";

export const CHECKS = ["vapi_call_connected", "vapi_transfer_invoked", "handoff_context_stored", "bridgefu_received_correlation_header", "amazon_connect_contact_connected", "configured_screen_pop_visible"];

export const options = {
  "since-minutes": { type: "string", default: "30" },
  reveal: { type: "boolean", default: false },
  "session-id": { type: "string" },
  "runtime-filter": { type: "string" },
};
export const help = `--since-minutes 30  --reveal (print raw correlation ids)  --session-id <id from the web page> (verify-web only)
--runtime-filter '?sip ?INVITE'  (also print redacted Bridgefu runtime lines matching this CloudWatch filter pattern, any level; or set LAB_RUNTIME_FILTER)`;

const PREPARED = ["PREPARED", "RESERVED", "CONSUMED"];

/**
 * Whether the assistant handed the call off. On the phone path Vapi performs the
 * transfer itself and records a forwarded reason. On the direct browser path Vapi
 * never transfers: Bridgefu replaces the Vapi leg, which Vapi records as
 * `customer-ended-call`, so the proof is the handoff tool having fired (the
 * DynamoDB row reached PREPARED or later) while the call ended normally.
 */
export function transferVerdict(mode, calls, rows) {
  const ended = calls.some((call) => ["ended", "forwarding"].includes(String(call.status ?? "")));
  const forwarded = calls.some((call) => /forwarded|transfer/.test(String(call.endedReason ?? "")) || call.status === "forwarding");
  const prepared = rows.some((row) => PREPARED.includes(String(row.handoff_status ?? "")));
  if (mode === "phone") {
    if (forwarded) return "PASS";
    return ended ? "FAIL (call ended without a transfer; check the prompt and the transfer Lambda logs)" : "UNKNOWN";
  }
  if (prepared && ended) return "PASS (direct path: the handoff tool fired; Vapi records the leg replacement as customer-ended-call)";
  if (prepared) return "PASS (handoff tool fired; Vapi call still in progress or not yet listed)";
  return ended ? "FAIL (call ended but the handoff tool never fired; check the direct-handoff Lambda logs)" : "UNKNOWN";
}

/** CloudWatch filter and label per log group: Lambda text patterns, JSON level for the Bridgefu runtime. */
export function logFilterFor(group, runtimeGroup) {
  if (runtimeGroup && group === runtimeGroup) return { pattern: '{ $.level = "ERROR" || $.level = "error" }', label: "error-level runtime log lines" };
  return { pattern: "?ERROR ?Traceback ?internal_error", label: "lines matching ERROR, Traceback, or internal_error" };
}

/** Same derivation as the released prepare Lambda (lambda/common/bridgefu_handoff.py). */
export function deriveCorrelationId(correlationKey, deploymentId, orgId, callId) {
  const digest = createHmac("sha256", correlationKey).update(`bridgefu|${deploymentId}|${orgId}|${callId}`).digest();
  return `bf1_${digest.toString("base64url")}`;
}

export function decodeItem(item) {
  const out = {};
  for (const [key, value] of Object.entries(item ?? {})) {
    if ("S" in value) out[key] = value.S;
    else if ("N" in value) out[key] = /^-?\d+$/.test(value.N) ? Number(value.N) : value.N;
    else if ("M" in value) out[key] = decodeItem(value.M);
    else if ("BOOL" in value) out[key] = value.BOOL;
  }
  return out;
}

const label = (value, reveal) => (reveal ? value : `${common.fingerprint(value)} (fingerprint)`);

async function recentCalls(state, assistantId, since) {
  let calls = (await vapiRequest(state, "GET", `/call?assistantId=${assistantId}&limit=25`)) ?? [];
  if (!Array.isArray(calls)) calls = calls.results ?? [];
  return calls
    .filter((call) => {
      const when = Date.parse(String(call.createdAt ?? ""));
      return !Number.isNaN(when) && when >= since.getTime();
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function dynamoGet(table, region, correlationId) {
  const value = await aws(["dynamodb", "get-item", "--table-name", table, "--key", JSON.stringify({ correlation_id: { S: correlationId } }), "--consistent-read"], { region });
  return value?.Item ? decodeItem(value.Item) : null;
}

async function dynamoRecentDirect(table, region) {
  const value = await aws(["dynamodb", "scan", "--table-name", table, "--filter-expression", "attribute_exists(direct_token_id)", "--max-items", "50"], { region });
  return (value?.Items ?? []).map(decodeItem).sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0)).slice(0, 5);
}

async function connectContacts(instanceId, region, since) {
  const stamp = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const value = await aws(
    ["connect", "search-contacts", "--instance-id", instanceId, "--time-range", `Type=INITIATION_TIMESTAMP,StartTime=${stamp(since)},EndTime=${stamp(new Date())}`, "--max-results", "25"],
    { region, allowFailure: true },
  );
  const contacts = value?.Contacts ?? [];
  for (const contact of contacts) {
    const attributes = await aws(["connect", "get-contact-attributes", "--instance-id", instanceId, "--initial-contact-id", contact.Id], { region, allowFailure: true });
    contact._attributes = attributes?.Attributes ?? {};
  }
  return contacts.sort((a, b) => String(b.InitiationTimestamp ?? "").localeCompare(String(a.InitiationTimestamp ?? "")));
}

async function logMatches(group, pattern, region, since, maxItems = 50) {
  const value = await aws(["logs", "filter-log-events", "--log-group-name", group, "--start-time", String(since.getTime()), "--filter-pattern", pattern, "--max-items", String(maxItems)], { region, allowFailure: true });
  return value === null ? null : (value.events ?? []);
}

const SAMPLE_LINES = 6;
const SAMPLE_WIDTH = 320;
// Fields worth reading from a JSON runtime line; everything else (tokens, SDP, headers) stays out.
const RUNTIME_FIELDS = ["level", "target", "message", "msg", "event", "error", "err", "reason", "code", "status", "leg", "leg_id", "call_id", "route", "route_id", "peer", "uri", "sip_status", "cause"];

/**
 * One log line reduced to what a person needs in order to open the right runbook. Correlation
 * ids become fingerprints, long opaque tokens are dropped, and JSON lines keep only known fields.
 */
export function redactLogLine(raw, { reveal = false } = {}) {
  let text = String(raw ?? "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const fields = { ...parsed, ...(typeof parsed.fields === "object" ? parsed.fields : {}) };
      const parts = [];
      for (const key of RUNTIME_FIELDS) {
        if (fields[key] === undefined || fields[key] === null) continue;
        const value = typeof fields[key] === "object" ? JSON.stringify(fields[key]) : String(fields[key]);
        parts.push(`${key}=${value}`);
      }
      text = parts.length ? parts.join(" ") : text;
    }
  } catch {
    // not JSON; fall through with the plain text
  }
  // Correlation ids are the one long token worth keeping (as fingerprints, or raw with --reveal).
  const ids = [];
  text = text.replace(/bf1_[A-Za-z0-9_-]{43}/g, (id) => {
    ids.push(reveal ? id : `${common.fingerprint(id)} (fingerprint)`);
    return `\u0000${ids.length - 1}\u0000`;
  });
  text = text.replace(/(bearer|token|password|secret|authorization)(["'=:\s]+)[^\s"',}]{8,}/gi, "$1$2<redacted>");
  text = text.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "<opaque>");
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => ids[Number(i)]);
  return text.length > SAMPLE_WIDTH ? `${text.slice(0, SAMPLE_WIDTH)}...` : text;
}

function printLogSample(events, reveal, limit = SAMPLE_LINES) {
  const seen = new Set();
  let shown = 0;
  for (const event of events) {
    const line = redactLogLine(event.message, { reveal });
    // Collapse lines that differ only in addresses, ports, ids, or counters.
    const shape = line.replace(/\[[0-9a-f:.]+\]|\b\d[\d.:]*\b/gi, "#");
    if (seen.has(shape)) continue;
    seen.add(shape);
    const at = event.timestamp ? new Date(Number(event.timestamp)).toISOString() : "";
    console.log(`      ${at} ${line}`);
    if (++shown >= limit) break;
  }
  if (events.length > shown) console.log(`      (${events.length - shown} more; repeated lines collapsed)`);
}

function summarizeValues(row) {
  if (row.screen_pop_values && typeof row.screen_pop_values === "object" && Object.keys(row.screen_pop_values).length) {
    return Object.entries(row.screen_pop_values).map(([k, v]) => `${k}=${v}`).join(", ");
  }
  const keys = ["customer_name", "issue_summary", "intent", "verification_status"].filter((k) => k in row);
  return keys.length ? keys.map((k) => `${k}=${row[k]}`).join(", ") : "(no values yet)";
}

export async function run(values, mode) {
  const state = common.loadState();
  common.requireKeys(state, "bridgefu", "connect");
  const region = common.regionOf(state);
  const outputs = state.bridgefu.outputs;
  const deploymentId = common.deploymentIdOf(state);
  const minutes = Number(values["since-minutes"]);
  if (!Number.isInteger(minutes) || minutes <= 0) throw new LabError("--since-minutes must be a positive integer");
  const since = new Date(Date.now() - minutes * 60_000);
  const results = Object.fromEntries(CHECKS.map((check) => [check, "UNKNOWN"]));

  let assistantId;
  if (mode === "web") {
    assistantId = state.web?.vapi?.assistant_id;
    if (!assistantId) throw new LabError("stage 5 has not created the direct web assistant yet (run web-setup)");
  } else {
    assistantId = state.vapi?.attached_assistant?.id ?? outputs.VapiAssistantId;
  }

  console.log(`== Vapi calls for assistant ${assistantId} since ${since.toISOString()} ==`);
  const calls = await recentCalls(state, assistantId, since);
  if (!calls.length) console.log("  (none)");
  const correlationIds = [];
  let correlationKey = null;
  for (const call of calls) {
    const ended = String(call.endedReason ?? "");
    const status = String(call.status ?? "");
    console.log(`  call ${common.fingerprint(String(call.id))} ${call.createdAt} status=${status} endedReason=${ended || "-"}`);
    if (["in-progress", "ended", "forwarding"].includes(status)) results.vapi_call_connected = "PASS";
    if (mode === "phone" && call.orgId && call.id) {
      correlationKey = correlationKey ?? Buffer.from(await common.secretValue(outputs.CorrelationKeySecretArn, region), "utf8");
      correlationIds.push(deriveCorrelationId(correlationKey, deploymentId, String(call.orgId), String(call.id)));
    }
  }

  console.log("");
  console.log(`== DynamoDB ${outputs.HandoffTableName} ==`);
  const table = outputs.HandoffTableName;
  let rows = [];
  if (mode === "phone") {
    for (const id of correlationIds) {
      const row = await dynamoGet(table, region, id);
      if (row) rows.push(row);
    }
  } else if (values["session-id"]) {
    const row = await dynamoGet(table, region, values["session-id"]);
    rows = row ? [row] : [];
  } else {
    rows = await dynamoRecentDirect(table, region);
  }
  if (!rows.length) console.log("  (no rows for these calls)");
  for (const row of rows) {
    const id = String(row.correlation_id ?? "");
    correlationIds.push(id);
    const status = String(row.handoff_status ?? "");
    console.log(`  ${label(id, values.reveal)} status=${status} ${summarizeValues(row)}`);
    if (PREPARED.includes(status)) results.handoff_context_stored = "PASS";
    else if (status === "MAPPED" && results.handoff_context_stored === "UNKNOWN") results.handoff_context_stored = "PENDING (browser attached, tool not yet called)";
  }
  results.vapi_transfer_invoked = transferVerdict(mode, calls, rows);
  if (mode === "web") console.log("  note: on the direct path Vapi records the Bridgefu leg replacement as customer-ended-call; that is expected.");

  console.log("");
  const instanceId = state.connect.outputs.ConnectInstanceId;
  console.log(`== Amazon Connect contacts on ${instanceId} ==`);
  const contacts = await connectContacts(instanceId, region, since);
  if (!contacts.length) console.log("  (none in the window)");
  for (const contact of contacts) {
    const attributes = contact._attributes ?? {};
    const correlation = String(attributes.correlation_id ?? "");
    const matched = correlationIds.includes(correlation);
    const connected = Boolean(contact.AgentInfo?.ConnectedToAgentTimestamp);
    console.log(
      `  contact ${common.fingerprint(String(contact.Id))} ${contact.InitiationTimestamp} correlation=${correlation ? label(correlation, values.reveal) : "-"} matched=${matched} context_available=${attributes.context_available ?? "-"} agent_connected=${connected ? "yes" : "no"}`,
    );
    for (let index = 1; index <= 4; index += 1) {
      const heading = attributes[`screen_pop_label_${index}`];
      if (heading) console.log(`      ${heading}: ${attributes[`screen_pop_value_${index}`] ?? ""}`);
    }
    if (correlation && matched) results.bridgefu_received_correlation_header = "PASS";
    if (connected) results.amazon_connect_contact_connected = "PASS";
    if (attributes.context_available === "true" && attributes.screen_pop_value_1) results.configured_screen_pop_visible = "PASS (attributes present; confirm visually in Agent Workspace)";
  }

  console.log("");
  console.log("== CloudWatch: log lines matching error patterns in the window (counts are matches, not confirmed failures) ==");
  const runtimeGroup = outputs.RuntimeLogGroupName ?? "";
  const groups = [`/aws/lambda/bridgefu-${deploymentId}-prepare`, `/aws/lambda/bridgefu-${deploymentId}-transfer`, `/aws/lambda/bridgefu-${deploymentId}-lookup`, runtimeGroup];
  if (mode === "web") groups.push(`/aws/lambda/bridgefu-${deploymentId}-direct-handoff`, `/aws/lambda/bridgefu-${deploymentId}-direct-session`);
  for (const group of groups.filter(Boolean)) {
    const { pattern, label: what } = logFilterFor(group, runtimeGroup);
    const events = await logMatches(group, pattern, region, since);
    console.log(`  ${group}: ${events === null ? "unavailable" : `${events.length} ${what}`}`);
    if (events?.length) printLogSample(events, values.reveal);
  }
  console.log("  (samples above are redacted; open a group in the CloudWatch console for the full lines)");
  const runtimeFilter = values["runtime-filter"] ?? process.env.LAB_RUNTIME_FILTER;
  if (runtimeFilter && runtimeGroup) {
    console.log("");
    console.log(`== Bridgefu runtime lines matching ${JSON.stringify(runtimeFilter)} (any level, redacted) ==`);
    const events = await logMatches(runtimeGroup, runtimeFilter, region, since, 500);
    if (events === null) console.log("  unavailable");
    else if (!events.length) console.log("  (none in the window)");
    else printLogSample(events, values.reveal, 80);
  }

  console.log("");
  console.log("== Checks ==");
  common.printTable(CHECKS.map((check) => [check, results[check]]));
  if (CHECKS.some((check) => results[check] === "UNKNOWN")) {
    log("some checks are UNKNOWN; see the troubleshooting map in .claude/skills/vapi-bridgefu-connect/references/troubleshooting.md");
  }
}

export const verifyPhone = (values) => run(values, "phone");
export const verifyWeb = (values) => run(values, "web");
