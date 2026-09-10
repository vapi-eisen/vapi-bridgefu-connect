# 08 · Scoping checklist for FDEs

Questions to settle with a customer before promising a BridgeFu deployment. Each
maps to something concrete in this lab.

## Contact center

- [ ] Amazon Connect instance exists, is `ACTIVE`, and is in `us-west-2` or `us-east-1`. Same AWS account as the deployment? (The stack validates account and region.)
- [ ] Which **published** flow should receive the call after the screen pop? BridgeFu transfers into it and never edits it. Does it already route to the right queue?
- [ ] Do agents use **Agent Workspace**? The screen pop is a Connect view; the classic CCP alone will not render it. Do agent security profiles include `CustomViews.Access` and `Views.View`?
- [ ] Alternate routing by a choice field (for example `department`)? The product supports a reviewed choice-to-flow map (`RoutingJson`) while keeping the default field keys.
- [ ] Expected concurrent transfers and peak hour (drives `InstanceType` and `MaxConcurrentCalls`).

## Voice AI side

- [ ] Phone calls, browser calls, or both? Phone needs only the product stack. Browser needs the direct add-on and a TURN story if callers sit behind restrictive NATs.
- [ ] Which Vapi org and who holds the private API key? The key goes into Secrets Manager in the customer account; only the provisioning Lambda reads it.
- [ ] One assistant or several? The stack trusts one. Plan an entry assistant or one stack per assistant.
- [ ] Which four facts should the agent see? Keep the default keys; agree labels and any choice lists.
- [ ] Which phone numbers move to the new assistant, and when (cutover window)? The stack never touches numbers.
- [ ] SRTP requirement? Vapi does not offer SRTP today; `sips_optional_srtp` accepts RTP/AVP audio between Vapi and BridgeFu over the public internet.

## AWS plumbing

- [ ] A public Route53 hosted zone the customer controls, and a new hostname beneath it for the SIP edge. ACM DNS validation must complete inside the stack's 30-minute EC2 window.
- [ ] IAM permission to create named roles, EC2, VPC, ACM with export, Lambda, API Gateway, DynamoDB, Secrets Manager, Connect flows, and (for `ProductionRetain`) AWS Backup.
- [ ] Retention choice: `ProductionRetain` keeps context data, the data volume, backups, and the Vapi objects on deletion.
- [ ] Who receives alarms (`AlarmEmail`) and who can open SSM sessions to the host?

## Operations and expectations

- [ ] Single-gateway, recovery-not-failover posture is acceptable for the pilot.
- [ ] Upgrade path understood: parallel deployment with a new `DeploymentId` and hostname, then move numbers.
- [ ] Runbooks reviewed (vendored under `docs/upstream/bridgefu-vapi-awsconnect/runbooks/`).
- [ ] Success criteria written down: the six checks from `verify-phone`, plus audio both ways and the visible panel.
