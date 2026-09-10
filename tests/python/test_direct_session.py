import base64
import hashlib
import hmac
import json
import unittest

from _support import load_handler, upstream_module

handler = load_handler()

KEY = "k" * 64
CORRELATION = "bf1_" + "A" * 43
TOKEN_ID = "lab_0123456789abcdef0123456789abcdef"
CALL_ID = "11111111-1111-4111-8111-111111111111"
BROWSER_LEG = "22222222-2222-4222-8222-222222222222"
VAPI_LEG = "33333333-3333-4333-8333-333333333333"
ATTACHMENT = {
    "type": "webrtc",
    "signaling_uri": "wss://bridgefu-lab.example.com:8443/webrtc",
    "token": "T" * 43,
    "signaling_credential": {"usage": "bridgefu-webrtc-signaling", "token": "bfs1.abc", "expires_at": "2030-01-01T00:02:00Z"},
    "subprotocols": ["rvoip.webrtc.v1", "token.bfs1.abc", "bridgefu.attach." + "T" * 43],
    "ice_servers": [{"urls": ["stun:stun.kinesisvideo.us-west-2.amazonaws.com:443"]}],
    "expires_at": "2030-01-01T00:02:00Z",
}
ROUTE = {
    "route_id": "vapi-direct-assistant",
    "tenant_id": "support",
    "call_id": CALL_ID,
    "legs": [
        {"leg_id": BROWSER_LEG, "direction": "inbound", "kind": "webrtc"},
        {"leg_id": VAPI_LEG, "direction": "outbound", "kind": "sip"},
    ],
    "attachment": ATTACHMENT,
}


def _decode(part: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


class TokenTests(unittest.TestCase):
    def test_token_has_exactly_the_released_claim_set(self):
        token = handler.issue_handoff_token(KEY, CORRELATION, TOKEN_ID, now=1_700_000_000, lifetime_seconds=3600)
        header, claims, signature = token.split(".")
        self.assertEqual(_decode(header), {"alg": "HS256", "typ": "JWT"})
        decoded = _decode(claims)
        self.assertEqual(set(decoded), {"aud", "exp", "iat", "iss", "jti", "sub"})
        self.assertEqual(decoded["iss"], "bridgefu-vapi-awsconnect-qualification")
        self.assertEqual(decoded["aud"], "bridgefu-direct-handoff")
        self.assertEqual(decoded["sub"], CORRELATION)
        self.assertEqual(decoded["jti"], TOKEN_ID)
        self.assertEqual(decoded["exp"] - decoded["iat"], 3600)
        expected = hmac.new(KEY.encode(), f"{header}.{claims}".encode(), hashlib.sha256).digest()
        self.assertEqual(base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)), expected)

    def test_released_verifier_accepts_the_token(self):
        upstream = upstream_module("lambda/common/bridgefu_handoff.py", "bridgefu_handoff")
        if upstream is None:
            self.skipTest("upstream checkout not available")
        now = 1_700_000_000
        token = handler.issue_handoff_token(KEY, CORRELATION, TOKEN_ID, now=now, lifetime_seconds=3600)
        session_id, token_id = upstream.verify_direct_handoff_token(token, KEY.encode(), now=now + 30)
        self.assertEqual((session_id, token_id), (CORRELATION, TOKEN_ID))

    def test_rejects_short_key_and_bad_lifetime(self):
        with self.assertRaises(handler.SessionError):
            handler.issue_handoff_token("short", CORRELATION, TOKEN_ID, now=1, lifetime_seconds=3600)
        with self.assertRaises(handler.SessionError):
            handler.issue_handoff_token(KEY, CORRELATION, TOKEN_ID, now=1, lifetime_seconds=10)


class BearerTests(unittest.TestCase):
    def test_accepts_exact_bearer(self):
        handler.verify_bearer("Bearer secret-value", "secret-value")

    def test_rejects_missing_or_wrong_bearer(self):
        for value in (None, "", "secret-value", "Bearer other", "Basic secret-value"):
            with self.assertRaises(handler.SessionError) as caught:
                handler.verify_bearer(value, "secret-value")
            self.assertEqual(caught.exception.status, 401)


class RouteResponseTests(unittest.TestCase):
    def test_binds_browser_and_vapi_legs(self):
        binding = handler.parse_route_response(ROUTE, "vapi-direct-assistant")
        self.assertEqual(binding["browser_leg_id"], BROWSER_LEG)
        self.assertEqual(binding["vapi_leg_id"], VAPI_LEG)
        self.assertEqual(binding["call_id"], CALL_ID)
        self.assertEqual(binding["attachment"], ATTACHMENT)

    def test_rejects_wrong_route_or_ambiguous_legs(self):
        with self.assertRaises(handler.SessionError):
            handler.parse_route_response(ROUTE, "amazon-connect")
        ambiguous = dict(ROUTE, legs=[ROUTE["legs"][0], dict(ROUTE["legs"][0], leg_id=VAPI_LEG)])
        with self.assertRaises(handler.SessionError):
            handler.parse_route_response(ambiguous, "vapi-direct-assistant")
        with self.assertRaises(handler.SessionError):
            handler.parse_route_response(dict(ROUTE, attachment={"type": "webrtc"}), "vapi-direct-assistant")

    def test_route_request_shape(self):
        request = handler.route_request(CORRELATION, "jwt")
        self.assertEqual(request, {"ingress": "webrtc", "context": {"correlation_id": CORRELATION, "metadata": {"handoff_token": "jwt"}}})


class MappedItemTests(unittest.TestCase):
    def test_item_matches_the_qualified_shape(self):
        now = 1_700_000_000
        item = handler.mapped_item(
            correlation_id=CORRELATION,
            token_id=TOKEN_ID,
            call_id=CALL_ID,
            vapi_leg_id=VAPI_LEG,
            connect_route_id="amazon-connect",
            schema_hash="0" * 64,
            now=now,
            ttl_seconds=3600,
        )
        expected_keys = {
            "schema_version", "correlation_id", "created_at", "updated_at", "expires_at", "handoff_status",
            "screen_pop_schema_hash", "direct_token_id", "bridgefu_call_id", "direct_leg_id", "direct_route_id",
            "direct_idempotency_key",
        }
        self.assertEqual(set(item), expected_keys)
        self.assertEqual(item["schema_version"], {"N": "2"})
        self.assertEqual(item["handoff_status"], {"S": "MAPPED"})
        self.assertEqual(item["expires_at"], {"N": str(now + 3600)})
        self.assertEqual(item["direct_leg_id"], {"S": VAPI_LEG})
        self.assertEqual(item["direct_route_id"], {"S": "amazon-connect"})
        digest = hashlib.sha256(f"{CORRELATION}|{CALL_ID}|{VAPI_LEG}".encode()).hexdigest()[:32]
        self.assertEqual(item["direct_idempotency_key"], {"S": "lab_" + digest})

    def test_response_is_json_and_no_store(self):
        reply = handler.response(200, {"ok": True})
        self.assertEqual(reply["statusCode"], 200)
        self.assertEqual(reply["headers"]["cache-control"], "no-store")
        self.assertEqual(json.loads(reply["body"]), {"ok": True})


if __name__ == "__main__":
    unittest.main()
