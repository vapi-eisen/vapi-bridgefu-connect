# 09 · Remote mode: labs for engineers without AWS access

The lab CLI runs the same either way; remote mode just moves the AWS stages
into GitHub Actions running in one owner-managed AWS account. Engineers need
GitHub access to this repository, Node, and their own Vapi org. Every Vapi
object a lab creates (assistants, tool, phone number, SIP endpoint) lands in
the engineer's org under the engineer's own private key; the owner never
handles that key.

```text
engineer's laptop                         GitHub Actions (OIDC role in the lab account)        AWS lab account
node lab.mjs remote provision  -------->  lab-provision.yml: unwrap key (KMS) into a secret  -> stacks bridgefu-<handle>-*
  (prompts for YOUR Vapi key and          preflight, connect, bridgefu, vapi, web-setup;        secret bridgefu/<handle>/vapi-private-key
   encrypts it to the lab's KMS key)      state pushed to S3; handout artifact
node lab.mjs remote handout    <--------  handout.json (state + optional web bearer, encrypted)
place the call / web-serve
gh workflow run lab-verify.yml  ------->  verify-phone / verify-web report
gh workflow run lab-teardown.yml ------>  teardown (deletes the secret too); nightly lab-reaper.yml
```

## How the engineer's Vapi key travels

The Bridgefu product stack reads the Vapi key from a Secrets Manager secret in
the account it runs in (its provisioner Lambda creates the template assistant
with it), so the key has to reach the lab account. It gets there without
passing through the owner, the repository, or the run logs:

1. `remote provision` (or the lower-level `key wrap`) prompts for the key on
   the engineer's laptop, checks it against the Vapi API, and encrypts a small
   payload `{engineer, key, exp}` with RSA-OAEP (SHA-256) to the public half of
   the sandbox's KMS key, published as the repository variable
   `LAB_WRAP_PUBLIC_KEY`.
2. The ciphertext is the workflow input `vapi_key_wrapped`. Workflow inputs are
   visible to collaborators, which is fine here: only the runner role can ask
   KMS to decrypt, the payload names the engineer, and it expires after an hour.
3. The `Unwrap` step decrypts through KMS inside the run and stores the key in
   the secret `bridgefu/<handle>/vapi-private-key`, tagged like the rest of the
   lab. Later runs (verify, teardown, the reaper) read that secret.
4. Teardown deletes the secret with the lab. The reaper does the same.

What this does not hide: administrators of the lab account can read the secret
while the lab exists, like any secret in that account. Engineers who want a
key they can discard afterwards should use a Vapi org dedicated to labs. Do not
rotate the key before teardown has finished: teardown uses it to delete the
Vapi objects.

## One-time setup (lab account owner)

`iam/lab-runner.yaml` turns a corner of an existing AWS account into a
protected sandbox for the labs. Push this repository to GitHub first (private;
note `owner/name`), then deploy the template once, as an administrator, in the
region the labs will use:

```bash
aws cloudformation deploy --region us-west-2 --stack-name bridgefu-lab-runner \
  --template-file iam/lab-runner.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides GitHubRepository=OWNER/REPO GitHubRefSuffix=ref:refs/heads/main \
    ParentHostedZoneId=Z0123456789ABC ParentZoneName=example.com LabSubdomain=lab \
    BudgetEmail=you@example.com MonthlyBudgetUsd=200 CreateOidcProvider=true \
  --tags Project=vapi-bridgefu-connect
```

Set `CreateOidcProvider=false` if `aws iam list-open-id-connect-providers`
already lists `token.actions.githubusercontent.com`. To use an existing public
zone instead of delegating a new one, pass `HostedZoneId` and `HostedZoneName`
and leave the `Parent*` parameters empty. `GitHubRefSuffix=*` trusts every
branch; the default `ref:refs/heads/main` trusts only workflows on `main`.

What the stack creates:

| Resource | Purpose |
|---|---|
| Role `BridgeFuLabRunner` | Assumed only by GitHub Actions workflows of `GitHubRepository` on `GitHubRefSuffix`; sessions last up to four hours. |
| Policy `BridgeFuLabRunner-boundary` | The runner's permissions **and** its permissions boundary, so nothing attached later can widen what it can do. |
| Hosted zone `lab.<parent>` plus one NS record in the parent | Every lab hostname lives here (`bridgefu-<handle>.lab.example.com`); the parent zone's own records are never touched. |
| Bucket `bridgefu-lab-state-<account>-<region>` | Private and versioned; holds each lab's state file for verify, teardown, and the reaper. |
| KMS key `alias/bridgefu-lab-wrap` (RSA-3072) | Engineers encrypt their own Vapi private key to its public half; only the runner can decrypt, inside a workflow run. About $1 per month. |
| Secrets `bridgefu/<handle>/vapi-private-key` | Not part of this stack: each provision run creates its lab's secret from the wrapped key; teardown and the reaper delete it. |
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
`bridgefu-*` roles and attach policies to them. Anyone who can run a workflow
on the trusted ref could therefore create a role with wide permissions and hand
it to a `bridgefu-*` Lambda or instance. Keep the repository private, protect
`main` with required reviews, and keep CloudTrail on for the account.

Then:

1. Set the repository variables from the stack's `GitHubVariables` output:

```bash
aws cloudformation describe-stacks --region us-west-2 --stack-name bridgefu-lab-runner \
  --query "Stacks[0].Outputs[?OutputKey=='GitHubVariables'].OutputValue" --output text \
  | tr ' ' '\n' | while IFS== read -r name value; do gh variable set "$name" --body "$value" --repo OWNER/REPO; done
```

   That sets `AWS_LAB_ROLE_ARN`, `AWS_LAB_REGION`, `LAB_STATE_BUCKET`,
   `LAB_HOSTED_ZONE_ID`, `LAB_HOSTED_ZONE_NAME`, `LAB_WRAP_KEY_ARN`, and
   `LAB_MAX_AGE_DAYS` (3).

2. Publish the wrap key's public half so engineers can encrypt without AWS
   access (the stack output `PublishPublicKeyCommand` prints this exact command):

```bash
gh variable set LAB_WRAP_PUBLIC_KEY --repo OWNER/REPO --body "$(aws kms get-public-key --region us-west-2 --key-id alias/bridgefu-lab-wrap --query PublicKey --output text)"
```

3. Enable the workflows if they are disabled (`gh workflow enable <file>`), run
   `remote provision` once for yourself with your own Vapi key to confirm the
   role works, then `Lab teardown`. The nightly `Lab reaper` tears down anything
   older than `LAB_MAX_AGE_DAYS` so a forgotten lab costs at most a few dollars.

Each lab costs roughly $0.10 per hour while it exists and every engineer gets
their own BridgeFu stack because the product trusts exactly one Vapi assistant.

## Engineer flow (no AWS credentials)

You need `gh` logged in with write access to this repository (dispatching a
workflow requires it; check `gh auth status`), Node 22, and the **private** API
key of your own Vapi org (dashboard, Organization Settings, API Keys). Pick a
handle: 3 to 24 lowercase letters, digits, or hyphens. It becomes your
deployment id, your hostname `bridgefu-<handle>.<zone>`, and your Connect alias.

1. **Provision** (20-40 minutes). Run this yourself in a terminal; it prompts
   for your Vapi private key with typing hidden, checks it against the Vapi
   API, encrypts it to the lab account, and dispatches the workflow:

```bash
export LAB_HANDOUT_PASSPHRASE='choose eight or more characters'   # optional, recommended with --stages full
node scripts/lab.mjs remote provision --engineer <handle> --stages full --client-cidr auto --passphrase-env LAB_HANDOUT_PASSPHRASE
gh run watch
```

   Use `--stages phone` to skip the browser path. The passphrase encrypts the
   handout artifact, which carries the lab session bearer for the local demo
   server when the browser path is included. If you prefer the raw workflow,
   `node scripts/lab.mjs key wrap --engineer <handle>` prints the ciphertext to
   pass as `-f vapi_key_wrapped=...` to `gh workflow run lab-provision.yml`.
   Never put a raw key into a workflow input; if that happens, rotate it.

2. **Import the handout** from the finished run:

```bash
node scripts/lab.mjs remote handout --engineer <handle> --passphrase-env LAB_HANDOUT_PASSPHRASE
node scripts/lab.mjs status --no-aws
```

3. **Phone test**: the run summary lists the dial-in number and the Agent
   Workspace URL. Ask the owner for the lab agent password (the workflow never
   prints it; the owner reads it with the `AgentCredentialCommand` output).
   Set the agent Available, call, ask for a person, then:

```bash
gh workflow run lab-verify.yml -f engineer=<handle> -f mode=phone && gh run watch
```

   The report appears in the run summary.

4. **Browser demo**: `node scripts/lab.mjs web-serve`, open
   `http://127.0.0.1:8787`, talk to Riley, ask for a person, then run the verify
   workflow with `-f mode=web`.

5. **Teardown** when done (or let the reaper do it). It also deletes the secret
   holding your key; keep the key valid until this finishes:

```bash
gh workflow run lab-teardown.yml -f engineer=<handle>
```

## What changes versus running with your own AWS access

| Local with AWS | Remote |
|---|---|
| `preflight`, `connect`, `bridgefu`, `vapi`, `web-setup` on your laptop | the same commands inside `lab-provision.yml` |
| `verify-phone`, `verify-web` on your laptop | `lab-verify.yml`, report in the run summary |
| `web-serve` reads the bearer from Secrets Manager | `web-serve` reads it from the imported handout |
| `teardown` on your laptop | `lab-teardown.yml` or the nightly reaper |
| Your Vapi key from `VAPI_PRIVATE_KEY` or your secret | still your own key: wrapped on your laptop, unwrapped inside the run into a per-lab secret, deleted at teardown |

Things that still require the owner: the agent password (a Secrets Manager
read), changing your public IP for the browser path after provisioning (re-run
`Lab provision` with `stages=full` and the new `client_cidr`; it updates the
existing stack), and anything the runbooks say needs an SSM session on the host.
