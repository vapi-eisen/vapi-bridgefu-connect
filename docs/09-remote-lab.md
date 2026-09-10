# 09 · Remote mode: labs for engineers without AWS access

The lab CLI runs the same either way; remote mode just moves the AWS stages
into GitHub Actions running in one owner-managed AWS account. Engineers need
GitHub access to this repository and nothing else. Vapi objects are created in
a shared training org whose private key lives in one Secrets Manager secret in
the lab account, so engineers do not need a Vapi key locally either.

```text
engineer's laptop            GitHub Actions (OIDC role in the lab account)         AWS lab account
gh workflow run  ---------->  lab-provision.yml: preflight, connect, bridgefu,  -> stacks bridgefu-<handle>-*
                              vapi, web-setup; state pushed to S3; handout artifact
gh run download  <----------  handout.json (state + optional web bearer, encrypted)
node lab.mjs state import
place the call / web-serve
gh workflow run  ---------->  lab-verify.yml: verify-phone / verify-web report
gh workflow run  ---------->  lab-teardown.yml; nightly lab-reaper.yml
```

## One-time setup (lab account owner)

1. Push this repository to GitHub (private). Note `owner/name`.
2. Deploy `iam/lab-runner.yaml` in the lab account, in the region the labs will use:

```bash
aws cloudformation deploy --region us-west-2 --stack-name bridgefu-lab-runner \
  --template-file iam/lab-runner.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides GitHubRepository=OWNER/REPO HostedZoneId=Z0123456789ABC CreateOidcProvider=true
```

   It creates the GitHub OIDC provider (set `CreateOidcProvider=false` if the
   account already has one), the `BridgeFuLabRunner` role trusted only by that
   repository, a private versioned state bucket, and an empty secret for the
   Vapi key. The role is bounded to `bridgefu-*` names where AWS supports it
   and is otherwise broad (EC2, Connect, Route53 on the zone), so treat the
   account as a lab account.
3. Put the Vapi training-org private key into the secret (the stack output
   `SetVapiKeyCommand` prints this exact command; the key never touches the repo):

```bash
aws secretsmanager put-secret-value --region us-west-2 --secret-id bridgefu/lab/vapi-private-key --secret-string file:///dev/stdin
```

4. Set the repository variables the workflows read (values are in the stack's
   `GitHubVariables` output):

```bash
gh variable set AWS_LAB_ROLE_ARN --body arn:aws:iam::123456789012:role/BridgeFuLabRunner
gh variable set AWS_LAB_REGION --body us-west-2
gh variable set LAB_STATE_BUCKET --body bridgefu-lab-state-123456789012-us-west-2
gh variable set LAB_HOSTED_ZONE_ID --body Z0123456789ABC
gh variable set LAB_HOSTED_ZONE_NAME --body lab.example.com
gh variable set LAB_VAPI_SECRET_ARN --body arn:aws:secretsmanager:us-west-2:123456789012:secret:bridgefu/lab/vapi-private-key-AbCdEf
gh variable set LAB_MAX_AGE_DAYS --body 3
```

5. Run `Lab provision` once for yourself to confirm the role works, then `Lab
   teardown`. The nightly `Lab reaper` tears down anything older than
   `LAB_MAX_AGE_DAYS` (default 3) so a forgotten lab costs at most a few dollars.

Each lab costs roughly $0.10 per hour while it exists and every engineer gets
their own BridgeFu stack because the product trusts exactly one Vapi assistant.

## Engineer flow (no AWS credentials)

You need `gh` logged in (`gh auth status`) and Node 22 for the local steps.
Pick a handle: 3 to 24 lowercase letters, digits, or hyphens. It becomes your
deployment id, your hostname `bridgefu-<handle>.<zone>`, and your Connect alias.

1. **Provision** (20-40 minutes; the run summary shows progress):

```bash
gh workflow run lab-provision.yml -f engineer=<handle> -f stages=full -f client_cidr="$(curl -s https://checkip.amazonaws.com)/32" -f passphrase='choose eight or more characters'
gh run watch
```

   Use `-f stages=phone` to skip the browser path. The passphrase is optional
   but recommended when the browser path is included, because the handout then
   carries the lab session bearer for the local demo server.

2. **Import the handout** from the finished run:

```bash
gh run download --name lab-handout-<handle> --dir .lab-handout
LAB_HANDOUT_PASSPHRASE='the passphrase' node scripts/lab.mjs state import .lab-handout/handout.json --passphrase-env LAB_HANDOUT_PASSPHRASE
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

5. **Teardown** when done (or let the reaper do it):

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
| Your Vapi key from `VAPI_PRIVATE_KEY` or your secret | the shared training-org key in the lab account |

Things that still require the owner: the agent password (a Secrets Manager
read), changing your public IP for the browser path after provisioning (re-run
`Lab provision` with `stages=full` and the new `client_cidr`; it updates the
existing stack), and anything the runbooks say needs an SSM session on the host.
