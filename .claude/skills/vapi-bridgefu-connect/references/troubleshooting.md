# Troubleshooting: symptom -> what to check -> runbook

Runbooks live in `docs/upstream/bridgefu-vapi-awsconnect/runbooks/`.

| Symptom | Check first | Runbook |
|---|---|---|
| BridgeFu stack stuck in `CREATE_IN_PROGRESS` on the Runtime or Certificate resource for >15 min | Is the hosted zone really public and delegated? Did the ACM validation CNAME appear in the zone? | `dns-certificate.md`, `deployment-readiness.md` |
| Stack failed with `RuntimeInstance ... did not receive signal` | SSM into the host (`SsmStartSessionCommand` output), `systemctl status bridgefu haproxy`, `journalctl -u bridgefu` | `deployment-readiness.md` |
| Stack failed in the Configuration or Vapi nested stack | Connect instance not `ACTIVE`, flow not published, Vapi key invalid or wrong region for the secret | `vapi-provisioning.md` |
| Connect stack fails with an alias conflict | Aliases are global and a deleted instance's alias stays reserved for about 30 days; delete the failed stack, then `preflight --connect-alias <other-name>` and `connect` again | `docs/01-amazon-connect.md` |
| `verify-web` shows `vapi_transfer_invoked` UNKNOWN or Vapi says `customer-ended-call` | Expected on the direct path: Vapi never transfers, Bridgefu replaces the leg. The check passes once the DynamoDB row is `PREPARED` and the call ended | `docs/05-web-sdk-handoff.md` |
| Riley never transfers, just keeps talking | Prompt was edited without the rules; the model must call `prepare_handoff` first. Check the call's tool calls in the Vapi dashboard | `docs/03-vapi-wiring.md` |
| Vapi shows tool call `prepare_handoff` returned 401 or 403 | Identity binding does not match the calling assistant (403) or the webhook credential changed (401). After `--attach-existing` allow 5 minutes of secret cache | `vapi-provisioning.md` |
| Transfer fails with `handoff_not_prepared` (409) | `transferCall` fired without a successful `prepare_handoff`; fix the prompt | `handoff-context.md` |
| Agent sees "Context unavailable" | Lookup failed open: row expired (TTL), wrong table, or `correlation_id` attribute missing. `verify-phone` shows which | `handoff-context.md`, `amazon-connect.md` |
| Call reaches Connect but no agent rings | Agent not Available, wrong routing profile, or Agent Workspace not open | `amazon-connect.md` |
| Agent gets the call but the panel is blank | Security profile lacks `CustomViews.Access` / `Views.View`; using classic CCP instead of Agent Workspace | `amazon-connect.md` |
| Audio one way or none on the phone path | Vapi offered RTP/AVP and the stack is `sips_srtp`; or UDP 16384-32767 blocked | `capacity.md`, `docs/02-bridgefu-stack.md` |
| Browser page: "Could not start the call" | `lab-web` stack missing, overlay not applied, or session Lambda cannot reach `control.<host>` (HAProxy allowlist). Check `/aws/lambda/bridgefu-<id>-direct-session` logs for the result code | `docs/05-web-sdk-handoff.md` |
| Browser stuck at `preparing` or `attaching` | Your public IP changed (`web-setup --refresh-client-cidr`); port 8443 blocked outbound; UDP blocked (no TURN) | `docs/05-web-sdk-handoff.md` |
| Browser connected but Riley never answers | BridgeFu could not dial Vapi: SIP-auth secret empty, Vapi TLS egress missing, or the SIP endpoint's assistant unassigned. `web-overlay status`, then the runtime log group | `vapi-provisioning.md` |
| Handoff `failed`, Riley `resumed` | Direct-handoff Lambda rejected the tool call (token, identity binding, expired `MAPPED` row) or Connect rejected `StartWebRTCContact`. Check `/aws/lambda/bridgefu-<id>-direct-handoff` result codes | `handoff-context.md`, `amazon-connect.md` |
| Orphaned Connect contact after hangup | BridgeFu reconciles `StopContact`; do not bulk-stop contacts | `cleanup-backlog.md` |
| Host rebooted; browser path stopped | Overlay drift: `web-overlay status` then `web-overlay apply` | `docs/05-web-sdk-handoff.md` |
| Teardown reports a failed step | Re-run `teardown`; the state file is kept. `lab-web` must go before `bridgefu`, `bridgefu` before `connect` | `docs/06-teardown.md` |
| Remote mode: a workflow step fails with `AccessDenied` or `not authorized` | The runner role is bounded on purpose (names `bridgefu-*`, record names under the lab zone, two regions, ARM instance types). Read the denied action and Sid in the error against `iam/lab-runner.yaml` before widening anything | `docs/09-remote-lab.md` |
| Remote mode: the `Unwrap` step fails with `expired`, `made for engineer`, or `RAW Vapi key` | Wrapped keys last one hour and are bound to the handle: run `remote provision` (or `key wrap`) again for that handle. A raw key pasted into the input is visible to collaborators, so rotate it in the Vapi dashboard | `docs/09-remote-lab.md` |
| Remote mode: every workflow fails at `configure-aws-credentials` with `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The runner role's trust does not match the token subject. Compare `gh api repos/OWNER/REPO/actions/oidc/customization/sub` with the stack's `GitHubRepository` parameter (immutable subjects embed `owner@id/repo@id`) and redeploy `iam/lab-runner.yaml` | `docs/09-remote-lab.md` |
