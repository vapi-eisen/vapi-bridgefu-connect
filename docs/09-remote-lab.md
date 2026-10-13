# 09 · Remote mode: labs for engineers without AWS access

The lab CLI runs the same either way; remote mode just moves the AWS stages
into a CodeBuild project in one owner-managed AWS account. Engineers need read
access to this GitHub repository, Node, and their own Vapi org. Every Vapi
object a lab creates (assistants, tool, phone number, SIP endpoint) lands in
the engineer's org under the engineer's own private key; the owner never
handles that key. Nothing runs in GitHub Actions: GitHub only hosts the code
and decides who is invited.

```text
engineer (Claude Code)                 lab gateway (Lambda URL)                  runner (CodeBuild, bounded role)
remote provision  ------------------>  checks GitHub repo access, owner of     -> unwrap key (KMS) into a secret,
  (key from the Vapi CLI login,          the handle; snapshots main from          preflight, connect, bridgefu, vapi,
   wrapped to the lab's KMS key;         GitHub into S3; starts the job           web-setup; state to S3; encrypted
   handout keypair; GitHub token)                                                 handout to jobs/<handle>/<job>/
remote handout --wait  <-----------  job status, step, handout, log tail
remote agent / phone call / web-serve
remote verify  --------------------->  verify job                              -> verify-phone / verify-web report
remote teardown  ------------------->  teardown job (deletes the secret too)  -> teardown
                                       nightly schedule                        -> reap labs older than LabMaxAgeDays
```

## Who can do what

Every gateway call carries the engineer's GitHub token (`gh auth token`). The
gateway asks GitHub who the token belongs to and whether it can read
`LabRepository`; it keeps neither the token nor anything derived from it beyond
a five-minute in-memory cache. The same token downloads the repository at
`LabRef` (default `main`) into `s3://<state bucket>/source/<commit>.zip`; the
runner executes exactly that snapshot, so the code that runs is what is on
`main`, as it was with GitHub Actions.

The first GitHub account to provision a handle owns it for as long as the lab
exists (its saved state is in the bucket or a job is running). Only that
account, or a login listed in `LabAdmins` (owner deploy defaults it to the
repository owner), can verify, read the handout of, or tear down the lab. One
job per handle runs at a time, and the gateway refuses new handles once
`MaxLabs` labs exist.

## How the engineer's Vapi key travels

The Bridgefu product stack reads the Vapi key from a Secrets Manager secret in
the account it runs in (its provisioner Lambda creates the template assistant
with it), so the key has to reach the lab account. Nobody types or pastes it:

1. `remote provision` takes the key from the **Vapi CLI** login. If the CLI has
   no login yet it runs `vapi auth login`, which opens the Vapi dashboard in the
   engineer's browser; they sign in, pick their org, and the dashboard hands the
   CLI a key for that org (stored in `~/.vapi-cli.yaml`). With several logins,
   the command lists the org names and asks for `--vapi-account <name>`.
   `VAPI_PRIVATE_KEY` in the environment overrides all of this for scripts.
2. The command checks the key against the Vapi API, then encrypts a small
   payload `{engineer, key, exp}` with RSA-OAEP (SHA-256) to the public half of
   the sandbox's KMS key, which the gateway serves from `/config`. That
   ciphertext travels in the provision request and sits in the CodeBuild job's
   environment, which lab-account administrators can see. That is fine: only
   the runner role can ask KMS to decrypt, the payload names the engineer, and
   it expires after an hour.
3. The `Unwrap` step decrypts through KMS inside the job and stores the key in
   the secret `bridgefu/<handle>/vapi-private-key`, tagged like the rest of the
   lab. Later runs (verify, teardown, the reaper) read that secret.
4. Teardown deletes the secret with the lab. The reaper does the same.

The handout travels the other way with the same idea: `remote provision` makes
an RSA keypair in `.lab/handout.key` and sends the public half as the input
`handout_public_key`; the job encrypts the handout (lab state, the Connect
agent password, and for `full` labs the browser session bearer) to it, so only
the engineer's machine can open it. Handouts and reports expire from the
bucket after two days. `remote agent` puts the agent
password on the clipboard instead of printing it.

What this does not hide: administrators of the lab account can read the
per-lab secret while the lab exists, like any secret in that account. Engineers
who want a key they can discard afterwards should use a Vapi org dedicated to
labs. Do not rotate the key before teardown has finished: teardown uses it to
delete the Vapi objects.

## One-time setup (lab account owner)

`iam/lab-runner.yaml` turns a corner of an existing AWS account into a
protected sandbox for the labs. With administrator credentials for that
account, from a checkout of this repository:

```bash
node scripts/lab.mjs owner deploy --region us-west-2 \
  --param ParentHostedZoneId=Z0123456789ABC --param ParentZoneName=example.com \
  --param BudgetEmail=you@example.com --param MonthlyBudgetUsd=200
```

It packages `lambda/lab_gateway` into the state bucket, deploys the stack
(`LabRepository` comes from the git remote, `LabAdmins` defaults to the
repository owner; `--repo`, `--ref`, `--admins` override), and writes the
gateway URL to `remote-lab.json`. Commit and push that file; engineers' remote
commands read it. Later runs keep the previous parameter values, so after a
change to the gateway or the template just run `owner deploy` again. To use an
existing public zone instead of delegating a new one, pass `HostedZoneId` and
`HostedZoneName` and leave the `Parent*` parameters empty. Changes to the lab
CLI itself need no deploy: every job fetches `main` from GitHub.

What the stack creates:

| Resource | Purpose |
|---|---|
| Role `BridgeFuLabRunner` | Assumed only by the CodeBuild project below. |
| Policy `BridgeFuLabRunner-boundary` | The runner's permissions **and** its permissions boundary, so nothing attached later can widen what it can do. An inline deny keeps the runner away from the gateway, its project, schedule, and bucket records. |
| CodeBuild project `BridgeFuLabRunner` | Runs one job per build (`node scripts/lab.mjs runner`); logs in `/bridgefu-lab/BridgeFuLabRunner` for 14 days. About $0.005 per build minute. |
| Lambda `BridgeFuLabRunnerGateway` with a function URL | The engineers' front door (routes listed in `lambda/lab_gateway/index.mjs`). The URL is public; every call must carry a GitHub token that can read the repository. Its role can only start and read runner builds, read job logs, read the bucket, write `labs/` and `source/`, and read the wrap key's public half. |
| Schedule `BridgeFuLabRunner-reaper` | Nightly at 05:17 UTC: a reap job tears down labs older than `LabMaxAgeDays` (3). |
| Hosted zone `lab.<parent>` plus one NS record in the parent | Every lab hostname lives here (`bridgefu-<handle>.lab.example.com`); the parent zone's own records are never touched. |
| Bucket `bridgefu-lab-state-<account>-<region>` | Private and versioned: each lab's state (`<handle>/state.json`), handle owners (`labs/`), repository snapshots (`source/`, 60 days), job progress, handouts and reports (`jobs/`, 2 days), the gateway package (`gateway/`). |
| KMS key `alias/bridgefu-lab-wrap` (RSA-3072) | Engineers encrypt their own Vapi private key to its public half; only the runner can decrypt, inside a job. About $1 per month. |
| Secrets `bridgefu/<handle>/vapi-private-key` | Not part of this stack: each provision job creates its lab's secret from the wrapped key; teardown and the reaper delete it. |
| Budget `bridgefu-lab-monthly` (only with `BudgetEmail`) | Emails at 60 % and 80 % of actual and 100 % of forecast spend against `MonthlyBudgetUsd`. It counts only resources tagged `Project=vapi-bridgefu-connect` (the CLI tags every lab stack and CloudFormation propagates the tag), so other workloads in the account do not trip it. The `Project` key must be active as a cost-allocation tag, which only an organization's management account can do; pass `BudgetTagValue=` (empty) to measure the whole account instead. Untagged usage such as data transfer is not counted. |

Guardrails built into the runner policy:

- **Names.** Stacks, IAM roles and instance profiles, Lambda functions,
  DynamoDB tables, SNS topics, and secrets must start with `bridgefu-`
  (secrets may also use the `bridgefu/` prefix). S3 access covers the lab and
  state buckets plus read-only access to the published release artifacts.
- **DNS.** Record writes are allowed only for names beneath the lab zone
  (`route53:ChangeResourceRecordSetsNormalizedRecordNames`), whichever zone
  the request targets, so pointing the runner at the parent zone cannot change
  the parent's records. Zone-level actions cover the private `control.` zone
  the product creates per lab.
- **Regions.** Regional actions are denied outside `LabRegions` (default
  `us-west-2,us-east-1`, the two regions the BridgeFu release supports).
- **Compute.** `ec2:RunInstances` is denied for anything but the ten ARM
  types the product template allows (`t4g.*`, `c7g.large` to `c7g.2xlarge`,
  `m7g.large` to `m7g.2xlarge`).
- **Identity.** No IAM users, access keys, login profiles, groups, identity
  providers, Organizations or Account actions, and the runner cannot modify its
  own role or boundary.

What the guardrails do **not** do: the product template creates IAM roles for
the gateway host and its Lambdas, so the runner must be able to create
`bridgefu-*` roles and attach policies to them. Anyone who can push to
`LabRef` decides what the runner executes, and could therefore create a role
with wide permissions and hand it to a `bridgefu-*` Lambda or instance.
Invited collaborators on a personal repository can push; keep the repository
private, invite only people you trust with that, and keep CloudTrail on for the
account.

Then run `remote provision` once for yourself with your own Vapi key to
confirm the runner works, and `remote teardown`.

Each lab costs roughly $0.10 per hour while it exists and every engineer gets
their own BridgeFu stack because the product trusts exactly one Vapi assistant.

## Engineer flow (no AWS credentials)

Open the repository in Claude Code and say **"run the BridgeFu lab in remote
mode"**. The skill runs the commands below itself; they are listed so you know
what happens. You need Node 22, an invitation to this repository, and access
to your own Vapi org. Your handle (3 to 24 lowercase letters, digits, or
hyphens) becomes the deployment id, the hostname `bridgefu-<handle>.<zone>`,
and the Connect alias.

0. **Doctor.** `node scripts/lab.mjs remote doctor --fix` installs the GitHub
   CLI and the Vapi CLI when missing (no sudo: Homebrew or winget, and the
   Vapi installer writes to `~/.vapi`), signs you in to GitHub with a one-time
   code, accepts your invitation to this repository, checks that the lab
   gateway answers,
   and signs you in to Vapi through the dashboard. Its table names anything
   left for you to do.

1. **Provision** (20-40 minutes). `remote provision` signs you in to Vapi
   through your browser if needed, wraps your key, and starts the job:

```bash
node scripts/lab.mjs remote provision --engineer <handle> --stages full --client-cidr auto
node scripts/lab.mjs remote handout --engineer <handle> --wait
```

   `--stages phone` skips the browser path. `remote handout --wait` waits for
   the job, imports the encrypted handout, and prints the dial-in number, the
   Agent Workspace URL, and the agent username.

2. **Agent login**: `node scripts/lab.mjs remote agent` opens the Agent
   Workspace with the agent password on your clipboard. Paste it, then set
   yourself Available.

3. **Phone test**: call the dial-in number, ask Riley for a person, answer the
   questions, confirm. Then:

```bash
node scripts/lab.mjs remote verify --engineer <handle> --mode phone
```

4. **Browser demo** (`full` only): `node scripts/lab.mjs web-serve`, open
   `http://127.0.0.1:8787`, talk to Riley, ask for a person, then
   `remote verify --engineer <handle> --mode web`.

5. **Teardown** when done (or let the reaper do it). It also deletes the secret
   holding your key; keep the key valid until this finishes:

```bash
node scripts/lab.mjs remote teardown --engineer <handle>
```

## What changes versus running with your own AWS access

| Local with AWS | Remote |
|---|---|
| `preflight`, `connect`, `bridgefu`, `vapi`, `web-setup` on your laptop | the same commands in a provision job (`scripts/lib/runner.mjs`) |
| `verify-phone`, `verify-web` on your laptop | `remote verify` runs a verify job and prints the report |
| `web-serve` reads the bearer from Secrets Manager | `web-serve` reads it from the imported handout |
| `teardown` on your laptop | `remote teardown` runs a teardown job; the nightly reaper is the backstop |
| Your Vapi key from `VAPI_PRIVATE_KEY` or your secret | still your own key, taken from the Vapi CLI login: wrapped on your laptop, unwrapped inside the job into a per-lab secret, deleted at teardown |
| Agent password from your own Secrets Manager | inside the encrypted handout; `remote agent` copies it to your clipboard |

Things that still require the owner: anything the runbooks say needs an SSM
session on the host. Changing your public IP for the browser path after
provisioning is a re-run of `remote provision` with `--stages full` and the new
`--client-cidr`; it updates the existing stack.
