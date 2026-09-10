# 05 · Stage 5: a browser call handed off to Amazon Connect

## Why this path needs an add-on

The published stack configures only the phone recipe: Vapi dials *into*
BridgeFu. The browser path reverses the first leg. BridgeFu becomes the
browser's WebRTC server, dials *out* to a Vapi SIP assistant, and later replaces
that leg with Amazon Connect. Release 0.1.34 qualified this path
(`bridgefu-web-sdk-handoff` in the upstream matrix), but only by installing a
replacement configuration on the host for the duration of the test and running
the browser on the CI runner through an SSM tunnel. This stage makes the same
mechanism durable and reachable from your laptop with three pieces:

1. **`cloudformation/lab-web.yaml`**, an add-on stack that never modifies the
   product stack. It adds TLS egress to Vapi's two signaling addresses, opens
   one WSS port to your public IP, creates four secrets, and deploys two
   Lambdas behind one HTTP API: the **direct-handoff** Lambda (the released
   `transfer_destination.zip`, byte-identical to the one the product uses,
   selected by its exact S3 version) and a small new **session** Lambda
   (`lambda/direct_session/handler.py`).
2. **Vapi objects**: a function tool `bridgefu_direct_handoff`, a dedicated
   assistant that owns only that tool, and a SIP endpoint with digest
   credentials that BridgeFu dials. The credentials live in Secrets Manager.
   The endpoint's password is registered **once at creation** and written to the
   host secret in the same step; the lab never PATCHes or rotates it, because
   repeatedly rotating a `provider: vapi` endpoint's `authentication` can wedge
   that SIP username at Vapi's gateway (every INVITE then gets `403 Invalid
   credentials`, and the state survives deleting the number). A fresh username is
   minted whenever the endpoint is created.
3. **The host overlay**: a complete replacement `/etc/bridgefu/bridgefu.yaml`
   (the phone recipe plus two named routes, `api.tls`, a public WebSocket bind)
   and a `haproxy.cfg` that allows one extra path, applied over SSM with the
   upstream trap-and-restore pattern and removed at teardown.

## The full sequence

```mermaid
sequenceDiagram
    autonumber
    actor Browser
    participant W as web/server.mjs
    participant S as session Lambda
    participant B as Bridgefu
    participant V as Vapi SIP assistant
    participant H as direct-handoff Lambda
    participant D as DynamoDB
    participant C as Amazon Connect
    Browser->>W: POST /api/session (Idempotency-Key)
    W->>S: POST /v1/direct-session, Authorization: Bearer <lab bearer>
    S->>S: correlation_id = bf1_<43>, handoff JWT (iss/aud fixed by the released verifier)
    S->>B: POST /v1/routes/vapi-direct-assistant/calls {ingress: webrtc, metadata.handoff_token}
    B-->>S: call_id, browser leg, Vapi leg, attachment (wss URI, token, STUN)
    S->>D: put row MAPPED {direct_token_id, bridgefu_call_id, direct_leg_id, route amazon-connect}
    S-->>Browser: {session_id, tenant_id, call_id, leg_id, attachment}
    Browser->>B: WSS handshake with the three subprotocols; ICE via AWS STUN; DTLS-SRTP
    B->>V: SIP INVITE over TLS with X-Correlation-Id and X-Bridgefu_Handoff_Token
    Browser->>V: conversation with Riley
    V->>H: tool bridgefu_direct_handoff {4 fields, handoff_token from {{bridgefu_handoff_token}}}
    H->>D: verify JWT, update row PREPARED with the values
    H->>B: POST /v1/calls/{call}/legs/{vapi leg}/replace {route_id: amazon-connect}
    B->>C: StartWebRTCContact(attributes {correlation_id})
    C->>C: wrapper flow -> lookup Lambda -> agent guide -> target flow
    B-->>Browser: bridgefu.handoff.v1: preparing, ringing, attaching, connected
```

Three details are worth pausing on when you teach this:

- The **handoff token** is application correlation authority, not a BridgeFu
  credential. BridgeFu projects it into the SIP header
  `X-Bridgefu_Handoff_Token`; Vapi turns that header into the template variable
  `bridgefu_handoff_token`; the tool sends it back as a *static* parameter the
  model cannot see or alter. The released Lambda verifies the HS256 signature
  with the signing-key secret and only then touches the row.
- The **issuer string** contains the word "qualification" because it is a
  constant in the released verifier. The lab reuses it deliberately so the
  released artifact can be used unmodified.
- The **row is staged before the call**. The Lambda that handles the tool call
  only ever updates a row in status `MAPPED`; it cannot be tricked into
  replacing a leg it was not told about.

## Run it

```bash
node scripts/lab.mjs web-setup             # stack + Vapi objects + overlay, with confirmations
node scripts/lab.mjs web-serve             # local demo at http://127.0.0.1:8787
node scripts/lab.mjs verify-web            # after a call
```

`web-setup` does, in order:

1. Discovers the released Lambda artifact from the running stack's nested
   `HandoffService` parameters, creates a private versioned lab bucket
   `vapi-bridgefu-connect-lab-<account>-<region>`, uploads a deterministic zip
   of the session handler, detects your public IPv4, and creates the `lab-web`
   stack.
2. Creates the Vapi tool, assistant, and SIP endpoint; writes the digest
   credentials to the SIP-auth secret; binds the direct identity secret to the
   new assistant.
3. Renders the overlay, uploads both files to the lab bucket, and runs the
   install script on the host over SSM: back up both files, `bridgefu validate`,
   `haproxy -c`, install, restart, wait for `/readyz`, and confirm the listener
   on `0.0.0.0:8443`. If anything fails the script restores the originals.

Then open `http://127.0.0.1:8787`, click **Talk to support**, allow the
microphone, and talk to Riley. Ask for a person. The timeline shows the
handoff states; the second `connected` means the agent is on the line and Agent
Workspace shows the same "Bridgefu caller context" panel as the phone path.
The page prints the session id; `verify-web --session-id <id>` inspects that
exact row. Expect Vapi's call history to show `customer-ended-call` for the
direct assistant: Vapi never transfers on this path, Bridgefu replaces the leg,
and `verify-web` counts the handoff as invoked when the tool fired (the row
reached `PREPARED`) and the call ended normally.

If your public IP changes (VPN, new network): `node scripts/lab.mjs web-setup --refresh-client-cidr`.

## Networking, explained once

| Question | Answer |
|---|---|
| Does the browser need a special origin? | No. `getUserMedia` works on `http://127.0.0.1` (a secure context), WebSocket connections are not CORS-restricted, and BridgeFu's `allowed_signaling_origins` refers to its own advertised `wss://` origin, not to your page. |
| How does the browser reach the host? | WSS to `wss://<SipHostname>:8443/webrtc`. BridgeFu terminates TLS itself with the ACM-issued certificate the release already exports to the host; the security group allows that port only from your `/32`. |
| Media ports? | UDP 20000-20399 on the host, already inside the product's public RTP range (16384-32767), so no new rule. |
| NAT traversal? | Both sides use AWS's regional STUN server (`stun.kinesisvideo.<region>.amazonaws.com:443`) because rvoip 0.3.8 does not apply `nat_1to1_ips` to gathered candidates. There is no TURN server, so a browser behind a symmetric NAT or a network that blocks UDP will fail ICE. |
| Why port 8443? | HAProxy already owns 443 on the private address for the control API. If 8443 is blocked outbound on your network, the documented fallback is a HAProxy `/webrtc` frontend on 443 forwarding to a loopback plain-WS bind (HAProxy preserves the `Sec-WebSocket-Protocol` values the attachment credentials are bound to); that variant is not scripted. |
| How does the session Lambda reach BridgeFu? | Through `https://control.<SipHostname>` (the product's private zone) with the transfer Lambda's security group; the overlay adds `POST /v1/routes/vapi-direct-assistant/calls` to HAProxy's allowlist. The VPC has no NAT; DynamoDB and Secrets Manager are reached through the product's VPC endpoints. |

## What differs from the qualified overlay

The rendered configuration is the upstream qualification configuration with
four deltas, and a unit test pins that: the WebSocket bind is `0.0.0.0:8443`
instead of loopback, the advertised signaling URI and allowed origin use your
hostname and that port, the SIP-profile password environment variable is named
for the lab, and HAProxy allows the extra route path. `web-overlay status`
reports drift (for example after a reboot); `web-overlay apply` is idempotent;
`web-overlay restore` puts the release files back byte-exact.

## Definition of done

- `lab-web` stack `CREATE_COMPLETE`; `web-overlay status` shows the overlay present, BridgeFu ready, and a listener on the WSS port.
- The page connects, Riley answers, and asking for a person produces `preparing -> ringing -> attaching -> connected` twice while the page stays connected.
- Agent Workspace shows the four fields; `verify-web` shows the row `PREPARED`, a Connect contact with the matching `correlation_id`, and no Lambda errors.
