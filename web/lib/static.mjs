// Static-file serving for the browser demo server (web/server.mjs).
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

export const SECURITY = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/**
 * Serve one file from `root`, refusing paths that escape it.
 * `pathname` is the URL path; "/" maps to `index`.
 */
export async function serveStatic(root, pathname, response, { index = "/index.html", headers = SECURITY } = {}) {
  let relative;
  try {
    relative = pathname === "/" ? index : decodeURIComponent(pathname);
  } catch {
    response.writeHead(400, headers);
    return response.end("bad request");
  }
  const target = normalize(join(root, relative));
  if (target !== root && !target.startsWith(root + sep)) {
    response.writeHead(403, headers);
    return response.end("forbidden");
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(target);
    response.writeHead(200, { ...headers, "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    return response.end(body);
  } catch {
    response.writeHead(404, headers);
    return response.end("not found");
  }
}
