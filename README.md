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

The lab is driven by the Claude Code skill in this repository. You clone the
repo, open Claude Code inside it, and ask for the lab; Claude runs the stages,
explains what each one proves, confirms before anything that costs money or
deletes resources, and tells you the few moments you must act yourself.

### 1. Before you start

- Accept the **invitation email** to this repository (one click; the repo is private).
- Have **Claude Code** (the `claude` command, the desktop app, or the IDE extension).
- Have **Node 22 or newer** (`node --version`) and **git**. Nothing to `npm install`.

That is all for **remote mode**, which most engineers use. Claude installs the
GitHub CLI and the Vapi CLI if they are missing, signs you in to both (GitHub
puts a one-time code on your clipboard and opens the page; Vapi opens its
dashboard where you pick your org), and runs the AWS side in the shared lab
account through GitHub Actions. You need access to a Vapi org; the lab creates
its assistants and a free phone number there. Your Vapi key never leaves your
machine unencrypted.

To run against **your own AWS account** instead, also have the **AWS CLI v2**
with credentials for a disposable account in `us-west-2` or `us-east-1`, a
public Route53 hosted zone you control, and your Vapi org's private API key.

### 2. Clone and open Claude Code in the folder

```bash
git clone https://github.com/vapi-eisen/vapi-bridgefu-connect.git && cd vapi-bridgefu-connect && claude
```

### 3. Ask for the lab

Say one of these; the skill loads on its own because you are in this folder:

- **"Run the BridgeFu lab in remote mode"** when you have no AWS account. The
  AWS stages run in the shared lab account through GitHub Actions.
- **"Run the BridgeFu lab"** when you are using your own AWS account.

Later: "continue the lab at stage 5", "verify my phone call", "tear down the lab".

Claude runs every command. What you do yourself, when it tells you: complete
the GitHub and Vapi sign-ins in your browser (first time only), log into the
Amazon Connect Agent Workspace (Claude puts the password on your clipboard),
place the phone call, and talk to the browser demo. No terminal, no AWS.

A lab costs roughly $0.10 per hour while it exists; in remote mode a nightly
reaper removes labs older than three days. Read
[docs/00-overview.md](docs/00-overview.md) if you want the architecture before
you start, and [docs/09-remote-lab.md](docs/09-remote-lab.md) for what remote
mode does with your key.

The skill drives `node scripts/lab.mjs`; every stage is also a plain command
(`node scripts/lab.mjs --help`) if you ever need to run one without Claude.

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
