"""Lab session API for the direct-browser handoff.

One POST /v1/direct-session call reproduces what the upstream qualification
controller did by hand before each browser smoke:

1. authenticate the local demo server with the lab bearer;
2. mint an opaque correlation id and a signed handoff token whose issuer and
   audience match the constants baked into the released handoff Lambda;
3. ask Bridgefu (through the private control endpoint) for a named-route call
   with WebRTC ingress, which returns a two-minute, one-use browser attachment;
4. stage the DynamoDB row (status MAPPED) that the released handoff Lambda will
   later promote when the Vapi tool fires;
5. return the attachment plus the leg identifiers the SDK needs.

The browser never sees the Bridgefu bearer, the signing key, or the lab bearer.
Everything below the ``lambda_handler`` boundary that does not touch AWS is a
pure function so it can be unit-tested without boto3.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from typing import Any

HANDOFF_ISSUER = "bridgefu-vapi-awsconnect-qualification"
HANDOFF_AUDIENCE = "bridgefu-direct-handoff"
ROUTE_KEY = "POST /v1/direct-session"
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
UUID = re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")
CORRELATION = re.compile(r"^bf1_[A-Za-z0-9_-]{43}$")
ATTACHMENT_KEYS = {"type", "signaling_uri", "token", "signaling_credential", "subprotocols", "ice_servers", "expires_at"}
MAX_RESPONSE_BYTES = 1024 * 1024

_SECRET_CACHE: dict[str, tuple[float, str]] = {}


class SessionError(Exception):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


# --------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def issue_handoff_token(signing_key: str, correlation_id: str, token_id: str, *, now: int, lifetime_seconds: int) -> str:
    """HS256 JWT with exactly the claims the released verifier requires."""
    if not 32 <= len(signing_key) <= 4096:
        raise SessionError("signing_key_invalid", 500)
    if not CORRELATION.fullmatch(correlation_id) or not IDENTIFIER.fullmatch(token_id):
        raise SessionError("identity_invalid", 500)
    if not 60 <= lifetime_seconds <= 7200:
        raise SessionError("lifetime_invalid", 500)
    header = {"alg": "HS256", "typ": "JWT"}
    claims = {
        "aud": HANDOFF_AUDIENCE,
        "exp": now + lifetime_seconds,
        "iat": now,
        "iss": HANDOFF_ISSUER,
        "jti": token_id,
        "sub": correlation_id,
    }
    encoded_header = b64url(json.dumps(header, separators=(",", ":"), sort_keys=True).encode("ascii"))
    encoded_claims = b64url(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode("ascii"))
    signing_input = f"{encoded_header}.{encoded_claims}".encode("ascii")
    signature = b64url(hmac.new(signing_key.encode("utf-8"), signing_input, hashlib.sha256).digest())
    return f"{encoded_header}.{encoded_claims}.{signature}"


def verify_bearer(authorization: str | None, expected: str) -> None:
    if not isinstance(authorization, str) or not authorization.startswith("Bearer "):
        raise SessionError("unauthorized", 401)
    presented = authorization[len("Bearer "):].strip()
    if not hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8")):
        raise SessionError("unauthorized", 401)


def route_request(correlation_id: str, handoff_token: str) -> dict[str, Any]:
    return {
        "ingress": "webrtc",
        "context": {"correlation_id": correlation_id, "metadata": {"handoff_token": handoff_token}},
    }


def parse_route_response(value: Any, expected_route_id: str) -> dict[str, Any]:
    """Bind the inbound WebRTC leg (browser) and the outbound SIP leg (Vapi)."""
    if not isinstance(value, dict) or value.get("route_id") != expected_route_id:
        raise SessionError("route_response_invalid", 502)
    tenant = value.get("tenant_id")
    call_id = value.get("call_id")
    legs = value.get("legs")
    attachment = value.get("attachment")
    if (
        not isinstance(tenant, str)
        or not IDENTIFIER.fullmatch(tenant)
        or not isinstance(call_id, str)
        or not UUID.fullmatch(call_id)
        or not isinstance(legs, list)
        or len(legs) != 2
        or not isinstance(attachment, dict)
        or set(attachment) != ATTACHMENT_KEYS
        or attachment.get("type") != "webrtc"
    ):
        raise SessionError("route_response_invalid", 502)
    inbound = [leg for leg in legs if isinstance(leg, dict) and leg.get("direction") == "inbound" and leg.get("kind") == "webrtc"]
    outbound = [leg for leg in legs if isinstance(leg, dict) and leg.get("direction") == "outbound" and leg.get("kind") == "sip"]
    if len(inbound) != 1 or len(outbound) != 1:
        raise SessionError("route_legs_ambiguous", 502)
    browser_leg = inbound[0].get("leg_id")
    vapi_leg = outbound[0].get("leg_id")
    if not all(isinstance(item, str) and UUID.fullmatch(item) for item in (browser_leg, vapi_leg)):
        raise SessionError("route_leg_invalid", 502)
    return {
        "tenant_id": tenant,
        "call_id": call_id,
        "browser_leg_id": browser_leg,
        "vapi_leg_id": vapi_leg,
        "attachment": attachment,
    }


def mapped_item(
    *,
    correlation_id: str,
    token_id: str,
    call_id: str,
    vapi_leg_id: str,
    connect_route_id: str,
    schema_hash: str,
    now: int,
    ttl_seconds: int,
) -> dict[str, dict[str, str]]:
    """The exact DynamoDB row shape the released handoff Lambda expects to find."""
    idempotency = "lab_" + hashlib.sha256(f"{correlation_id}|{call_id}|{vapi_leg_id}".encode("ascii")).hexdigest()[:32]
    fields: dict[str, int | str] = {
        "schema_version": 2,
        "correlation_id": correlation_id,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + ttl_seconds,
        "handoff_status": "MAPPED",
        "screen_pop_schema_hash": schema_hash,
        "direct_token_id": token_id,
        "bridgefu_call_id": call_id,
        "direct_leg_id": vapi_leg_id,
        "direct_route_id": connect_route_id,
        "direct_idempotency_key": idempotency,
    }
    return {key: ({"N": str(value)} if isinstance(value, int) else {"S": value}) for key, value in fields.items()}


def response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(body, separators=(",", ":"), sort_keys=True),
    }


# --------------------------------------------------------------------------
# AWS and network boundary
# --------------------------------------------------------------------------


def _secret(arn: str) -> str:
    import boto3  # Lambda-provided; imported lazily so tests need no AWS SDK

    cached = _SECRET_CACHE.get(arn)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    value = boto3.client("secretsmanager").get_secret_value(SecretId=arn).get("SecretString", "")
    if not isinstance(value, str) or not value:
        raise SessionError("secret_unavailable", 500)
    _SECRET_CACHE[arn] = (time.monotonic() + 300, value)
    return value


def create_route_call(base_url: str, bearer: str, route_id: str, payload: dict[str, Any], idempotency_key: str) -> Any:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/routes/{route_id}/calls",
        data=json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key,
            "User-Agent": "vapi-bridgefu-connect-lab-session/1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as reply:
            raw = reply.read(MAX_RESPONSE_BYTES + 1)
            status = reply.status
    except urllib.error.HTTPError as error:
        print(json.dumps({"event": "bridgefu_route_call_failed", "status": error.code}))
        raise SessionError("bridgefu_route_call_failed", 502) from None
    except (OSError, TimeoutError):
        print(json.dumps({"event": "bridgefu_route_call_unreachable"}))
        raise SessionError("bridgefu_unreachable", 502) from None
    if status != 201 or len(raw) > MAX_RESPONSE_BYTES:
        raise SessionError("bridgefu_route_call_failed", 502)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise SessionError("route_response_invalid", 502) from None


def stage_row(table: str, item: dict[str, dict[str, str]]) -> None:
    import boto3

    boto3.client("dynamodb").put_item(
        TableName=table,
        Item=item,
        ConditionExpression="attribute_not_exists(correlation_id)",
    )


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    started = time.monotonic()
    result = "internal_error"
    try:
        if event.get("routeKey") != ROUTE_KEY:
            raise SessionError("not_found", 404)
        headers = {str(k).lower(): str(v) for k, v in (event.get("headers") or {}).items()}
        verify_bearer(headers.get("authorization"), _secret(os.environ["LAB_SESSION_BEARER_SECRET_ARN"]))
        idempotency_key = headers.get("idempotency-key") or f"lab-{secrets.token_hex(16)}"
        if not IDENTIFIER.fullmatch(idempotency_key):
            raise SessionError("idempotency_key_invalid", 400)
        now = int(time.time())
        ttl = int(os.environ.get("CONTEXT_TTL_SECONDS", "3600"))
        correlation_id = "bf1_" + secrets.token_urlsafe(32)
        token_id = "lab_" + secrets.token_hex(16)
        token = issue_handoff_token(
            _secret(os.environ["DIRECT_HANDOFF_SIGNING_KEY_SECRET_ARN"]),
            correlation_id,
            token_id,
            now=now,
            lifetime_seconds=ttl,
        )
        route_id = os.environ.get("DIRECT_ROUTE_ID", "vapi-direct-assistant")
        raw = create_route_call(
            os.environ["BRIDGEFU_CONTROL_BASE_URL"],
            _secret(os.environ["BRIDGEFU_API_BEARER_SECRET_ARN"]),
            route_id,
            route_request(correlation_id, token),
            idempotency_key,
        )
        binding = parse_route_response(raw, route_id)
        stage_row(
            os.environ["HANDOFF_TABLE_NAME"],
            mapped_item(
                correlation_id=correlation_id,
                token_id=token_id,
                call_id=binding["call_id"],
                vapi_leg_id=binding["vapi_leg_id"],
                connect_route_id=os.environ.get("CONNECT_ROUTE_ID", "amazon-connect"),
                schema_hash=os.environ["SCREEN_POP_SCHEMA_HASH"],
                now=now,
                ttl_seconds=ttl,
            ),
        )
        result = "session_created"
        return response(
            200,
            {
                "session_id": correlation_id,
                "tenant_id": binding["tenant_id"],
                "call_id": binding["call_id"],
                "leg_id": binding["browser_leg_id"],
                "attachment": binding["attachment"],
            },
        )
    except SessionError as error:
        result = error.code
        return response(error.status, {"error": error.code})
    except Exception:  # noqa: BLE001 - never leak internals to the caller
        result = "internal_error"
        return response(500, {"error": "internal_error"})
    finally:
        print(json.dumps({"event": "direct_session", "result": result, "duration_ms": int((time.monotonic() - started) * 1000)}))
