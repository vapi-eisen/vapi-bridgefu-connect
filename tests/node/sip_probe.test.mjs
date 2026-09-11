import assert from "node:assert/strict";
import test from "node:test";
import { buildAuthorization, digestResponse, parseChallenge } from "../../scripts/lib/sip_probe.mjs";

test("digestResponse matches the RFC 2617 qop=auth reference vector", () => {
  const response = digestResponse({
    username: "Mufasa",
    realm: "testrealm@host.com",
    password: "Circle Of Life",
    method: "GET",
    uri: "/dir/index.html",
    nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
    qop: "auth",
    nc: "00000001",
    cnonce: "0a4f113b",
  });
  assert.equal(response, "6629fae49393a05397450978507c4ef1");
});

test("parseChallenge reads Vapi's Digest challenge (quoted and unquoted params)", () => {
  const params = parseChallenge('Digest realm="sip.vapi.ai", algorithm=MD5, qop="auth", nonce="178908229607400"');
  assert.equal(params.realm, "sip.vapi.ai");
  assert.equal(params.algorithm, "MD5");
  assert.equal(params.qop, "auth");
  assert.equal(params.nonce, "178908229607400");
});

test("buildAuthorization emits a qop=auth header whose response recomputes", () => {
  const challenge = parseChallenge('Digest realm="sip.vapi.ai", algorithm=MD5, qop="auth", nonce="abc123"');
  const uri = "sip:lab_x@sip.vapi.ai:5061;transport=tls";
  const header = buildAuthorization({ username: "lab_x", realm: "sip.vapi.ai", password: "secret", challenge, method: "INVITE", uri, cnonce: "deadbeef" });
  assert.match(header, /^Digest /);
  assert.match(header, /qop=auth/);
  assert.match(header, /nc=00000001/);
  assert.match(header, /algorithm=MD5/);
  assert.match(header, /username="lab_x"/);
  const expected = digestResponse({ username: "lab_x", realm: "sip.vapi.ai", password: "secret", method: "INVITE", uri, nonce: "abc123", qop: "auth", nc: "00000001", cnonce: "deadbeef" });
  assert.ok(header.includes(`response="${expected}"`));
});
