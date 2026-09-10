# vapi-bridgefu-connect

A hands-on training lab, packaged as a Claude Code skill, for Vapi agent
engineers and forward-deployed engineers who need to scope and deploy
**BridgeFu**: the media gateway that moves a Vapi voice call (phone or browser)
into **Amazon Connect** with the caller's context landing on the agent desktop.

You deploy everything into your own AWS account and Vapi org with the published
BridgeFu CloudFormation release, place a real call, watch the screen pop, run a
browser call that is handed off mid-conversation, and tear it all down.

```text
phone   caller -> Vapi number -> assistant -> [prepare_handoff] -> transfer -> Bridgefu -> Amazon Connect agent + screen pop
browser laptop -> Bridgefu (WebRTC) -> Vapi SIP assistant -> [bridgefu_direct_handoff] -> Bridgefu replaces the leg -> Amazon Connect agent + screen pop
```

## Quick start

Prerequisites: **Node 22+** and the **AWS CLI v2** with credentials for a
disposable account, a public Route53 hosted zone you control, and a Vapi private
API key. No packages to install.

Pick one way to drive the lab (they all run the same commands):

- **Claude Code**: open this repository and say **"run the BridgeFu lab"**. The
  skill in `.claude/skills/vapi-bridgefu-connect/` sequences the stages, explains
  each one, and confirms before anything that costs money or deletes resources.
- **Terminal**:

```bash
node scripts/lab.mjs preflight --region us-west-2 --hosted-zone-id Z0123456789ABC \
  --sip-hostname bridgefu-lab.example.com --create-vapi-secret     # reads $VAPI_PRIVATE_KEY
node scripts/lab.mjs connect          # stage 1: Amazon Connect lab instance (5-10 min)
node scripts/lab.mjs bridgefu         # stage 2: published Bridgefu stack (20-30 min)
node scripts/lab.mjs vapi             # stage 3: persona + free dial-in number
node scripts/lab.mjs verify-phone     # stage 4: after your test call
node scripts/lab.mjs web-setup        # stage 5: browser path add-on
node scripts/lab.mjs web-serve        # stage 5: http://127.0.0.1:8787
node scripts/lab.mjs verify-web       # stage 5: after your browser call
node scripts/lab.mjs teardown         # stage 6
```

Roughly $0.10/hour while the lab exists. Read [docs/00-overview.md](docs/00-overview.md) first.

**No AWS access?** The AWS stages can run in a shared lab account through
GitHub Actions; engineers then need only GitHub access and Node. See
[docs/09-remote-lab.md](docs/09-remote-lab.md) for the one-time owner setup
(`iam/lab-runner.yaml`) and the engineer flow (`gh workflow run lab-provision.yml ...`).

## What is in the repository

| Path | What |
|---|---|
| `docs/00-overview.md` ... `docs/08-scoping-checklist.md` | The lab narrative: architecture, one doc per stage, teardown, costs and limits, a customer scoping checklist |
| `docs/existing-assistant.md` | Advanced: wiring an assistant you already have |
| `docs/upstream/bridgefu-vapi-awsconnect/` | Vendored MIT copies of the release deploy guide, operations guide, runbooks, and qualification matrix |
| `.claude/skills/vapi-bridgefu-connect/` | The skill (`SKILL.md`) plus definition-of-done and troubleshooting references |
| `cloudformation/connect-lab.yaml` | Nonproduction Connect instance, queue, flow, agent |
| `cloudformation/lab-web.yaml` | Browser-path add-on: SG rules, secrets, the released handoff Lambda, the lab session Lambda, HTTP API |
| `iam/lab-runner.yaml`, `.github/workflows/` | Remote mode: GitHub OIDC runner role, state bucket, and the provision, verify, teardown, and nightly reaper workflows |
| `lambda/direct_session/handler.py` | The one new Lambda (runs in AWS): mints the browser attachment and stages the handoff row |
| `host/` | Bridgefu host overlay templates (HAProxy config, install and restore scripts) |
| `scripts/lab.mjs`, `scripts/lib/` | The CLI: Node 22, standard library only, AWS through the AWS CLI |
| `vapi/` | Assistant prompts and the destination-less transfer tool |
| `web/` | The browser demo: static page, the vendored `@bridgefu/webrtc-browser` SDK, a zero-dependency Node server |
| `tests/node/`, `tests/python/` | Offline tests; the Node suite includes parity checks against the upstream checkout when present |

## Development

```bash
make check      # ruff + cfn-lint (Python dev tools), node --check, node --test, python unittest
```

Python is a development-only dependency here (cfn-lint, the Lambda's unit tests,
and parity tests that import the upstream Python modules). Engineers running the
lab need only Node and the AWS CLI. Nothing in `make check` touches the network.

## Where the pieces come from

- The BridgeFu product (`bridgefu-vapi-awsconnect`, release 0.1.34, MIT) is deployed from its public template URL; nothing from it is vendored except documentation and, in the add-on, the exact released Lambda artifact by S3 version.
- The Connect lab template and the browser-path overlay are adapted from that project's release qualification, which is what proved both paths.
- `@bridgefu/webrtc-browser` is built from the BridgeFu commit compiled into the release AMI; provenance and digests are in `web/vendor/bridgefu-webrtc-browser/VENDORED_FROM.md`.
- The prompts, the page captions, and the same-origin session pattern follow the StandardCharter reference implementation.

MIT licensed; see `LICENSE`.
