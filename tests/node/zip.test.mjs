import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pythonAvailable } from "./helpers.mjs";
import { buildZip, crc32 } from "../../scripts/lib/zip.mjs";
import { buildSessionZip } from "../../scripts/lib/lab_web_stack.mjs";

test("crc32 matches the reference value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("zip output is deterministic and well-formed", () => {
  const a = buildZip([{ name: "handler.py", data: Buffer.from("print('hi')\n") }]);
  const b = buildZip([{ name: "handler.py", data: Buffer.from("print('hi')\n") }]);
  assert.ok(a.equals(b));
  assert.equal(a.readUInt32LE(0), 0x04034b50);
  assert.equal(a.readUInt32LE(a.length - 22), 0x06054b50);
  assert.ok(buildSessionZip().equals(buildSessionZip()));
});

test("python zipfile accepts the session package", { skip: !pythonAvailable() ? "python3 unavailable" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vbc-zip-"));
  const path = join(dir, "direct_session.zip");
  writeFileSync(path, buildSessionZip());
  const result = spawnSync("python3", ["-c", `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.namelist()); print(z.read("handler.py")[:40])`, path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\['handler\.py'\]/);
});
