# 04 · Stage 4: place a call and prove the screen pop

## Before you dial

1. Open the Agent Workspace URL from stage 1 in a browser and log in as the lab
   agent (password via the printed `get-secret-value` command). Allow the
   microphone.
2. Set the status to **Available**, or run
   `node scripts/lab.mjs connect --agent-available`.
3. Note the time; the verifier looks back 30 minutes by default.

## The call

Dial the number from stage 3 and follow the caller script:

> "Hi, I need to talk to a person about my bill."
> Give a name, say "my bill is higher than usual", and answer the PIN question with any four digits.

Riley calls `prepare_handoff` (you hear nothing; the tool is silent), then the
transfer tool. Vapi speaks the transfer message and sends a SIP INVITE to
BridgeFu over TLS. Within a few seconds Agent Workspace rings (or auto-accepts)
and the **Bridgefu caller context** panel shows:

| Row | Source |
|---|---|
| Customer | `customer_name` you gave Riley |
| Issue | `issue_summary` |
| Intent | `intent` |
| Verification | `verification_status` |
| Context available / Voice AI call reference | lookup result and the Vapi call id |

Then the wrapper flow transfers the contact into the lab target flow and the
queue. Say something on both sides to confirm two-way audio, then hang up from
either end.

If the lookup fails, the call still reaches the agent and the panel says
"Context unavailable" with a prompt to ask the caller for a summary. That
fail-open behaviour is deliberate: a missing pop must never drop a caller.

## Prove it from three independent sources

```bash
node scripts/lab.mjs verify-phone            # last 30 minutes
node scripts/lab.mjs verify-phone --since-minutes 120 --reveal
```

The verifier prints:

- **Vapi**: recent calls on the assistant with `status` and `endedReason`
  (a successful transfer ends with a forwarded reason).
- **DynamoDB**: the row for each call, found by re-deriving the correlation id
  exactly the way the prepare Lambda does (HMAC of deployment, org, and call id
  with the stack's correlation key). Status `PREPARED` means the tool stored
  context; `RESERVED` means the transfer destination was minted; the four
  values are printed.
- **Amazon Connect**: contacts in the window with their `correlation_id`,
  `context_available`, and `screen_pop_label_N/value_N` attributes, and
  whether an agent connected.
- **CloudWatch**: how many log lines in the prepare, transfer, lookup, and
  runtime groups match error patterns (a text pattern for the Lambdas, the JSON
  `level` field for the Bridgefu runtime). These are matches to read, not
  confirmed failures.

The closing checklist mirrors the release qualification's required checks:
`vapi_call_connected`, `vapi_transfer_invoked`, `handoff_context_stored`,
`bridgefu_received_correlation_header`, `amazon_connect_contact_connected`,
`configured_screen_pop_visible`. Audio in both directions and the visible panel
remain human checks.

## Reading the wire

To see the transfer destination Vapi received, open the call in the Vapi
dashboard: the transfer destination is `sip:<token>@<SipHostname>:5061;transport=tls`
with a single `X-Correlation-Id` header. The token is single-use and expires in
two minutes; that is why nothing in the prompt or the assistant holds an
address.

## Definition of done

All six checks pass in `verify-phone`, you heard both directions, and you saw
the four fields in Agent Workspace before the call reached the queue.
