#!/usr/bin/env node
// Zero-dependency local server for the browser demo (Node 22+).
//
// This process plays the part of "the customer's web backend" in the browser
// path: it serves the demo page and proxies POST /api/session to the lab's
// session API while adding the lab bearer. The bearer lives only in this
// process's environment; the browser never sees it. Start it with
// `python3 scripts/lab.py web-serve`, which supplies the environment.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SECURITY, serveStatic } from "./lib/static.mjs";

const ROOT = resolve(process.env.LAB_WEB_ROOT ?? fileURLToPath(new URL(".", import.meta.url)));
const HOST = process.env.LAB_WEB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LAB_WEB_PORT ?? 8787);
const SESSION_URL = process.env.LAB_SESSION_API_URL;
const BEARER = process.env.LAB_SESSION_BEARER;

if (!SESSION_URL || !BEARER) {
  console.error("LAB_SESSION_API_URL and LAB_SESSION_BEARER are required; run `python3 scripts/lab.py web-serve`.");
  process.exit(64);
}

async function proxySession(request, response) {
  for await (const _chunk of request) {
    /* the session request carries no body; drain it */
  }
  const supplied = request.headers["idempotency-key"];
  const idempotencyKey = typeof supplied === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(supplied) ? supplied : randomUUID();
  let upstream;
  try {
    upstream = await fetch(SESSION_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BEARER}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: "{}",
    });
  } catch (error) {
    console.error(`[session] upstream unreachable: ${error?.message ?? error}`);
    response.writeHead(502, { ...SECURITY, "content-type": "application/json; charset=utf-8" });
    return response.end(JSON.stringify({ error: "session_api_unreachable" }));
  }
  const text = await upstream.text();
  if (upstream.ok) {
    try {
      const session = JSON.parse(text);
      console.log(`[session] ${new Date().toISOString()} session_id=${session.session_id} call_id=${session.call_id}`);
    } catch {
      /* logged below as a non-JSON body */
    }
  } else {
    console.error(`[session] upstream returned ${upstream.status}: ${text.slice(0, 200)}`);
  }
  response.writeHead(upstream.status, { ...SECURITY, "content-type": "application/json; charset=utf-8" });
  return response.end(text);
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (request.method === "POST" && url.pathname === "/api/session") return proxySession(request, response);
  if ((request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/")) {
    return serveStatic(ROOT, url.pathname, response);
  }
  response.writeHead(405, SECURITY);
  return response.end("method not allowed");
}).listen(PORT, HOST, () => {
  console.log(`[web] serving ${ROOT} at http://${HOST}:${PORT}`);
});
