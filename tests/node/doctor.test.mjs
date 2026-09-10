import assert from "node:assert/strict";
import test from "node:test";
import { findInvitation, ghAssetName, nodeVersionOk, parseRepoFromRemote } from "../../scripts/lib/doctor.mjs";

test("the repository is derived from any GitHub remote form", () => {
  assert.equal(parseRepoFromRemote("https://github.com/vapi-eisen/vapi-bridgefu-connect.git"), "vapi-eisen/vapi-bridgefu-connect");
  assert.equal(parseRepoFromRemote("git@github.com:vapi-eisen/vapi-bridgefu-connect.git\n"), "vapi-eisen/vapi-bridgefu-connect");
  assert.equal(parseRepoFromRemote("https://github.com/vapi-eisen/vapi-bridgefu-connect/"), "vapi-eisen/vapi-bridgefu-connect");
  assert.equal(parseRepoFromRemote("https://gitlab.com/x/y.git"), null);
});

test("pending invitations are matched to this repository case-insensitively", () => {
  const invitations = [{ id: 1, repository: { full_name: "Other/Repo" } }, { id: 2, repository: { full_name: "Vapi-Eisen/vapi-bridgefu-connect" } }];
  assert.equal(findInvitation(invitations, "vapi-eisen/vapi-bridgefu-connect")?.id, 2);
  assert.equal(findInvitation(invitations, "vapi-eisen/missing"), null);
  assert.equal(findInvitation(undefined, "a/b"), null);
});

test("node version gate", () => {
  assert.ok(nodeVersionOk("22.1.0"));
  assert.ok(nodeVersionOk("26.0.0"));
  assert.ok(!nodeVersionOk("20.19.0"));
});

test("the GitHub CLI release asset matches the platform", () => {
  assert.equal(ghAssetName("2.60.0", "darwin", "arm64"), "gh_2.60.0_macOS_arm64.zip");
  assert.equal(ghAssetName("2.60.0", "linux", "x64"), "gh_2.60.0_linux_amd64.tar.gz");
  assert.equal(ghAssetName("2.60.0", "win32", "x64"), null);
  assert.equal(ghAssetName("2.60.0", "linux", "ia32"), null);
});
