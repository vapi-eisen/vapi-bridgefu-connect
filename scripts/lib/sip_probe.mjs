// Minimal SIP-over-TLS digest health check. Dials a `sip:user@host` endpoint, answers the 401
// digest challenge, and reports whether the authenticated INVITE is accepted (200) or rejected
// (403). web-setup uses it to confirm the direct Vapi SIP endpoint authenticates before handing
// the browser demo to the engineer, and to detect a username that Vapi's SIP gateway has wedged
// (returns 403 "Invalid credentials" to every digest, even a correct one). The pure helpers are
// exported for tests; probeDigest opens the network connection.
import { connect } from "node:tls";
import { createHash, randomBytes } from "node:crypto";

const md5 = (value) => createHash("md5").update(value).digest("hex");
const token = (bytes) => randomBytes(bytes).toString("hex");

/** RFC 2617/7616 digest response for qop=auth (or legacy no-qop). Pure. */
export function digestResponse({ username, realm, password, nonce, method, uri, qop, nc, cnonce }) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  return qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
}

/** Parse a `Digest realm="..", nonce="..", ...` challenge into its parameters. Pure. */
export function parseChallenge(header) {
  const params = {};
  for (const match of String(header).matchAll(/(\w+)=("([^"]*)"|[^,\s]+)/g)) params[match[1].toLowerCase()] = match[3] ?? match[2];
  return params;
}

/** Build the Authorization header value answering `challenge` for `method`/`uri`. Pure. */
export function buildAuthorization({ username, realm, password, challenge, method, uri, cnonce = token(8) }) {
  const nonce = challenge.nonce ?? "";
  const effectiveRealm = challenge.realm ?? realm;
  const qop = (challenge.qop ?? "").split(",").map((value) => value.trim()).includes("auth") ? "auth" : null;
  const nc = "00000001";
  const response = digestResponse({ username, realm: effectiveRealm, password, nonce, method, uri, qop, nc, cnonce });
  const parts = [`username="${username}"`, `realm="${effectiveRealm}"`, `nonce="${nonce}"`, `uri="${uri}"`, `response="${response}"`, `algorithm=${challenge.algorithm ?? "MD5"}`];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

/**
 * Dial `target` (default sip:username@host) over TLS and answer the digest challenge. Resolves to
 * { ok, status, reason }: ok true on a 2xx (auth accepted), false otherwise. status 0 with ok
 * false means the check could not be completed (timeout or socket error) and is inconclusive, not
 * a rejection — callers should not treat it as a wedged endpoint.
 */
export function probeDigest({ host = "sip.vapi.ai", port = 5061, username, realm = "sip.vapi.ai", password, target, fromUri = "sips:bridgefu@lab.invalid", timeoutMs = 12000 } = {}) {
  const requestUri = target ?? `sip:${username}@${host}`;
  const local = "127.0.0.1";
  const callId = `${token(12)}@healthcheck`;
  const fromTag = token(6);
  let cseq = 0;
  let retried = false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(result);
    };
    const invite = (authorization) => {
      cseq += 1;
      const lines = [
        `INVITE ${requestUri} SIP/2.0`,
        `Via: SIP/2.0/TLS ${local}:5061;branch=z9hG4bK${token(6)};rport`,
        "Max-Forwards: 70",
        `From: <${fromUri}>;tag=${fromTag}`,
        `To: <sip:${username}@${host}>`,
        `Call-ID: ${callId}`,
        `CSeq: ${cseq} INVITE`,
        `Contact: <sips:probe@${local}:5061;transport=tls>`,
        "User-Agent: vapi-bridgefu-connect-lab-healthcheck/1",
      ];
      if (authorization) lines.push(`Authorization: ${authorization}`);
      lines.push("Content-Length: 0", "", "");
      return lines.join("\r\n");
    };
    const followup = (verb, to) => {
      if (verb === "BYE") cseq += 1;
      return [`${verb} ${requestUri} SIP/2.0`, `Via: SIP/2.0/TLS ${local}:5061;branch=z9hG4bK${token(6)};rport`, "Max-Forwards: 70", `From: <${fromUri}>;tag=${fromTag}`, `To: ${to}`, `Call-ID: ${callId}`, `CSeq: ${cseq} ${verb}`, "Content-Length: 0", "", ""].join("\r\n");
    };
    const socket = connect({ host, port, servername: host }, () => socket.write(invite()));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let split;
      while ((split = buffer.indexOf("\r\n\r\n")) !== -1) {
        const head = buffer.slice(0, split);
        const bodyLength = Number(/Content-Length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        if (buffer.length < split + 4 + bodyLength) break;
        buffer = buffer.slice(split + 4 + bodyLength);
        const status = /^SIP\/2\.0 (\d{3})/m.exec(head);
        if (!status) continue;
        const code = Number(status[1]);
        const to = /^To:\s*(.*)$/m.exec(head)?.[1] ?? `<sip:${username}@${host}>`;
        if (code === 401 || code === 407) {
          socket.write(followup("ACK", to));
          if (retried) return finish({ ok: false, status: code, reason: "challenged again after the auth retry" });
          retried = true;
          const challenge = parseChallenge(/^(?:WWW|Proxy)-Authenticate:\s*(.*)$/im.exec(head)?.[1] ?? "");
          socket.write(invite(buildAuthorization({ username, realm, password, challenge, method: "INVITE", uri: requestUri })));
        } else if (code >= 200 && code < 300) {
          socket.write(followup("ACK", to));
          socket.write(followup("BYE", to));
          finish({ ok: true, status: code, reason: "accepted" });
        } else if (code >= 300) {
          socket.write(followup("ACK", to));
          const reason = /^(?:X-Reason|Reason|Warning):\s*(.*)$/im.exec(head)?.[1]?.trim() ?? status[0];
          finish({ ok: false, status: code, reason });
        }
      }
    });
    socket.on("error", (error) => finish({ ok: false, status: 0, reason: `socket error: ${error.message}` }));
    socket.setTimeout(timeoutMs, () => finish({ ok: false, status: 0, reason: "timed out waiting for a final response" }));
  });
}
