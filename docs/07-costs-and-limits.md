# 07 · Costs, limits, and known constraints

## Rough hourly cost of an idle lab (us-west-2, estimate)

| Item | Approximate |
|---|---|
| EC2 `t4g.medium` (Graviton) | $0.034/h |
| Elastic IP attached to a running instance | included; small charge if left unattached |
| Two interface VPC endpoints (Secrets Manager, Logs) across two AZs | about $0.04/h |
| DynamoDB on-demand, Lambda, API Gateway, Secrets Manager, CloudWatch | cents per day at lab volume |
| Amazon Connect | per-minute voice usage only while calls are active; the instance itself is free |
| Vapi | per-minute assistant usage; the free number is not charged |

Roughly $0.10 per hour, about $2.50 per day, while the lab exists. The product
default `c7g.2xlarge` would be about $0.29/h for EC2 alone. Tear down when you
are done.

## Time

- Connect lab stack: 5-10 minutes.
- BridgeFu stack: 20-30 minutes (ACM validation plus EC2 readiness; the EC2 resource has a 30-minute creation timeout).
- Teardown: 20-40 minutes, dominated by the BridgeFu stack.

## Vapi limits

- Free Vapi numbers: US area codes only, up to five per account, a payment method may be required (the number is not charged).
- Vapi's two US SIP signaling addresses (`44.229.228.186`, `44.238.177.138`) are hardcoded in the product template and in the lab add-on. If Vapi changes them, TLS SIP stops until the rules are updated.
- Vapi currently does not offer SRTP in its transfer SDP, which is why the product default is `sips_optional_srtp`.

## Product constraints worth knowing when scoping

- One trusted assistant per stack (the identity binding). A customer with several assistants routes them through one entry assistant or deploys one stack each.
- Screen-pop **keys** should stay the default four (`customer_name`, `issue_summary`, `intent`, `verification_status`); labels, descriptions, and choice lists can change. Release 0.1.34 only applies a custom field set for a tool name the provisioner does not use, so adding or renaming keys makes `prepare_handoff` reject the call's arguments.
- Eight launch-immutable settings (see 02); upgrades are parallel deployments.
- Single EC2 gateway, no HA: recovery via AWS Backup, not failover. Do not put a generic load balancer in front of SIP/RTP.
- Regions: `us-west-2` and `us-east-1` only.
- The browser path adds: no TURN server (STUN only), one client CIDR at a time, a host overlay that must be restored, and public WSS that upstream never qualified end to end.
