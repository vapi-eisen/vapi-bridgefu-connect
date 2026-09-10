# Vendored upstream documentation

These files are verbatim copies from the `bridgefu-vapi-awsconnect` repository
(MIT License, see `LICENSE` in this directory) at release **v0.1.34**
(commit `31270c8c3200454da829fc4ef611640ff184a1ce`, the release attestation).
They are included so the lab is self-contained for engineers who do not have
the upstream checkout.

| File | Upstream path | Use it for |
|---|---|---|
| `deploy.md` | `docs/deploy.md` | The customer deployment guide: regions, the four AWS values, the Vapi secret, the Quick Create launch, prompt rules, choosing how calls enter Vapi, field customization |
| `operations.md` | `docs/operations.md` | Monitoring, updates, the launch-immutable settings, release upgrades by parallel deployment, credential rotation, what deletion retains |
| `qualification-matrix.yaml` | `qualification/matrix.yaml` | The release's required smokes and checks; the lab's definition of done borrows its check names |
| `runbooks/README.md` | `runbooks/README.md` | Runbook index and the single-gateway posture |
| `runbooks/amazon-connect.md` | | No agent gets the call, blank screen pop, contact-start failure |
| `runbooks/capacity.md` | | Concurrency, CPU, media drops |
| `runbooks/cleanup-backlog.md` | | Orphaned contacts and route reservations |
| `runbooks/deployment-readiness.md` | | Stack creation failures and host readiness |
| `runbooks/dns-certificate.md` | | ACM validation and TLS SIP problems |
| `runbooks/handoff-context.md` | | Handoff API status codes, DynamoDB, context availability |
| `runbooks/starter-recovery.md` | | Host or AZ loss, AWS Backup restore |
| `runbooks/vapi-provisioning.md` | | Provisioner failures, 401/403 webhooks, ownership collisions |

The lab-specific symptom map that points into these runbooks is
`.claude/skills/vapi-bridgefu-connect/references/troubleshooting.md`.
