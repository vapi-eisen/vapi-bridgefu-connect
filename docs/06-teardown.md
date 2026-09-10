# 06 · Stage 6: tear the lab down

## Order matters

The add-on attaches to product resources, the product attaches to the Connect
instance, and the Vapi objects point at endpoints that stop existing. Teardown
therefore runs:

1. Restore the host overlay (if applied) so the release configuration is back
   and BridgeFu is ready.
2. Unbind and delete the direct web Vapi objects (SIP endpoint, assistant,
   tool) and blank the SIP-auth secret.
3. Delete the `lab-web` stack (security-group rules, IAM policy, Lambdas, API,
   secrets).
4. Release the dial-in number (delete a lab-created one, or restore a
   bring-your-own number's previous assistant) and detach any assistant that
   was wired with `--attach-existing`.
5. Delete the BridgeFu stack and wait, then remove any records left under the
   lab hostname in the hosted zone. CloudFormation deletes the certificate but
   can leave its two ACM validation CNAMEs (`_<hash>.<host>` and
   `_<hash>.control.<host>`); teardown deletes those, the A record, and
   `control.<host>`, and never touches anything else in the zone.
6. Delete the Connect lab stack (skip with `--keep-connect`).
7. Empty every object version in the lab bucket and delete it.
8. Delete the Vapi key secret (skip with `--keep-vapi-secret`).

```bash
node scripts/lab.mjs teardown --dry-run
node scripts/lab.mjs teardown
```

A failed step is reported and the state file is kept so you can re-run.

## What retention mode leaves behind

| | `TestDelete` (lab default) | `ProductionRetain` (customer default) |
|---|---|---|
| DynamoDB context table | deleted | kept, deletion protection on |
| Runtime data volume | deleted | kept |
| AWS Backup vault and recovery points | not created | kept |
| Vapi template assistant, prepare tool, webhook credential | deleted by the provisioner | kept; remove them in Vapi yourself |
| CloudWatch log groups | deleted | deleted |
| Route53 A record, private control zone, ACM certificate | deleted | deleted |

## Manual checks after teardown

- Route53: the hosted zone has no record left under `<SipHostname>` (teardown removes leftovers automatically; confirm).
- Route53: no private hosted zone named `control.<SipHostname>`.
- Vapi dashboard: no `bridgefu-lab-*` numbers, no `BridgeFu Lab Web Assistant`, no `bridgefu_direct_handoff` tool, and (with `TestDelete`) no `Bridgefu Connect Support` assistant.
- Secrets Manager: no `bridgefu/<id>/...` secrets unless you kept the Vapi key.
- `.lab/state.json.last` is a reference copy of the final state; delete it when done.
