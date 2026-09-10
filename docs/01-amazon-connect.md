# 01 · Stage 1: an Amazon Connect instance to transfer into

## Why this stage exists

The BridgeFu product never creates a Connect instance. Customers already have
one, and the stack is built to transfer *into* an existing published flow
without modifying it. The lab needs something to stand in for the customer's
instance, so `cloudformation/connect-lab.yaml` creates a minimal, nonproduction
one. It is adapted from the disposable instance the upstream release
qualification uses, so what you deploy is the same shape the release was tested
against.

## What the template creates

| Resource | Purpose |
|---|---|
| `AWS::Connect::Instance` (alias `<DeploymentId>-connect`, or `InstanceAlias` if set) | Connect-managed users, inbound calls on, outbound off, flow logs on. Aliases are globally unique, and Amazon Connect keeps a deleted instance's alias reserved for roughly 30 days; a taken or held alias fails the stack within a few minutes. |
| Hours of operation (24x7 UTC) and queue `bridgefu-<id>-support` | Where the handoff lands. |
| Target flow `bridgefu-<id>-lab-target` | Plays the role of "the customer's published flow": `UpdateContactTargetQueue` then `TransferContactToQueue`. BridgeFu's wrapper flow transfers here after the screen-pop lookup. |
| Routing profile (VOICE, concurrency 1) | Puts the agent on the queue. |
| Security profile `[BasicAgentAccess, CustomViews.Access, Views.View]` | The last two permissions are what let Agent Workspace render BridgeFu's "Bridgefu caller context" view. Without them the call arrives but the pop is blank. |
| Secrets Manager secret with a generated password and one `SOFT_PHONE` user | The lab agent. `AgentAutoAccept` defaults to `true` so one person can be caller and agent; set it to `false` to click Accept yourself. |

No Connect phone number is claimed. Calls enter through `StartWebRTCContact`
from BridgeFu, not through the PSTN, so a claimed number would only add cost
and teardown steps.

## Run it

```bash
node scripts/lab.mjs connect
```

If the stack fails with an alias conflict (typically because an earlier lab used
the same deployment id within the last month), delete the failed stack, re-run
preflight with an explicit alias, and try again:

```bash
node scripts/lab.mjs preflight --connect-alias bridgefu-lab-2
```

Preflight checks live instances in your account for the alias, but it cannot see
reservations left by deleted instances, which is why the override exists.

The script creates the stack, waits, and records the outputs in
`.lab/state.json`. It prints the Agent Workspace URL and the exact
`aws secretsmanager get-secret-value` command for the agent password; the
scripts never print the password themselves.

To flip the agent to Available from the command line (Agent Workspace must be
open in a browser for the softphone to receive audio):

```bash
node scripts/lab.mjs connect --agent-available
```

## What to look at in the console

Open the admin console (`ConnectAdminUrl` output). Under **Routing → Flows**
you will see only the lab target flow now. After stage 2, two more flows appear
that BridgeFu owns: `bridgefu-<id>-entry` (the wrapper) and
`bridgefu-<id>-agent-guide` (the view). Notice that the lab target flow is never
edited: that is the product's contract with customers.

## Definition of done

- Stack `bridgefu-<id>-connect-lab` is `CREATE_COMPLETE`.
- You can log into Agent Workspace as the lab agent and set the status to Available.
- `.lab/state.json` contains `connect.outputs.ConnectInstanceArn` and `TargetContactFlowArn`.
