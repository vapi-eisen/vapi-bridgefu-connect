# Definition of done, per stage

Check names in stages 4 and 5 are borrowed from the release qualification
matrix (`docs/upstream/bridgefu-vapi-awsconnect/qualification-matrix.yaml`) so
an engineer can map lab results onto what the release itself proves.

## Stage 0
- `preflight` exits 0 and `.lab/state.json` records region, account, deployment id, zone, hostname, and the Vapi secret ARN.

## Stage 1
- `bridgefu-<id>-connect-lab` is `CREATE_COMPLETE`.
- The lab agent can log into Agent Workspace and set Available.

## Stage 2
- `bridgefu-<id>` is `CREATE_COMPLETE`; `DashboardUrl` opens and shows BridgeFu ready.
- Vapi dashboard shows `Bridgefu Connect Support` with `prepare_handoff` and a `transferCall` tool with no destination.

## Stage 3
- A number or SIP URI is assigned to the lab assistant and recorded in state.
- The assistant's prompt is the Riley persona and still ends with the required Bridgefu rules.

## Stage 4 (`verify-phone`)
| Check | Passes when |
|---|---|
| `vapi_call_connected` | a call to the assistant exists in the window |
| `vapi_transfer_invoked` | phone: the call ended with a forwarded reason or is forwarding. Direct browser path: the handoff tool fired (row `PREPARED` or later) and the call ended; Vapi records that as `customer-ended-call` |
| `handoff_context_stored` | the derived correlation row is `PREPARED`, `RESERVED`, or `CONSUMED` with the four values |
| `bridgefu_received_correlation_header` | a Connect contact carries the same `correlation_id` |
| `amazon_connect_contact_connected` | that contact has an agent connection timestamp |
| `configured_screen_pop_visible` | `context_available=true` and `screen_pop_value_1` present; the engineer confirms the panel visually |
Human checks: audio in both directions, panel shows the four fields.

## Stage 5 (`verify-web`)
- All of the above for the direct assistant's call, plus the page timeline shows `preparing -> ringing -> attaching -> connected` twice and the browser connection never closed during the handoff.
- `web-overlay status` shows the overlay present, BridgeFu ready, listener on the WSS port.

## Stage 6
- All three stacks absent, lab bucket gone, no `bridgefu-lab-*` Vapi objects, hosted zone clean.
