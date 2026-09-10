import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { ROOT } from "./helpers.mjs";
import { serveStatic } from "../../web/lib/static.mjs";

function rawGet(port, path) {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("serves the demo index and refuses to escape the root", async () => {
  const root = join(ROOT, "web");
  const server = createServer((req, res) => serveStatic(root, new URL(req.url, "http://x").pathname, res));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try {
    const index = await rawGet(port, "/");
    assert.equal(index.status, 200);
    assert.match(index.headers["content-type"], /text\/html/);
    assert.equal(index.headers["x-frame-options"], "DENY");
    assert.match(index.body, /Brightline Mobile/);
    const sdk = await rawGet(port, "/vendor/bridgefu-webrtc-browser/dist/index.js");
    assert.equal(sdk.status, 200);
    assert.match(sdk.headers["content-type"], /text\/javascript/);
    assert.equal((await rawGet(port, "/..%2f..%2fLICENSE")).status, 403);
    assert.equal((await rawGet(port, "/does-not-exist.js")).status, 404);
  } finally {
    server.close();
  }
});
