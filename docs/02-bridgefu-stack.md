# 02 · Stage 2: deploy the published BridgeFu CloudFormation product

## Why deploy by URL

The product is distributed as a public CloudFormation template plus regional
AMIs and Lambda zips, pinned by exact S3 object versions. Deploying from the
published URL is exactly what a customer does, so nothing in this repo needs to
be kept in sync with the release. The lab records the `ReleaseVersion` output
and, in stage 5, reads the exact artifact coordinates back from the running
stack.

Public template: `https://bridgefu-vapi-awsconnect-225478700523-us-east-1.s3.us-east-1.amazonaws.com/latest/cloudformation/template.yaml`

Supported regions: `us-west-2` (preferred; Vapi's US SIP edges live there) and
`us-east-1`. The template rejects other regions before creating anything.

## Inputs and where they come from

| Parameter | Lab value | Why |
|---|---|---|
| `DeploymentId` | from preflight (`lab`) | Prefix of every resource name. Launch-immutable. |
| `InstanceType` | `t4g.medium` | Cheapest allowed size; the product default `c7g.2xlarge` is roughly eight times the price. |
| `ConnectInstanceArn`, `TargetContactFlowArn` | stage 1 outputs | The stack validates both are active and in this account/region. |
| `PublicHostedZoneId`, `SipHostname` | preflight | ACM issues the SIP TLS certificate with DNS validation, and the public A record points Vapi at the gateway. The hostname must be new and strictly beneath the zone. |
| `VapiApiKeySecretArn` | preflight | Only the provisioning Lambda reads it, to create the template assistant, its prepare tool, and its webhook credential. |
| `DataRetentionMode` | `TestDelete` | Deletes DynamoDB and the Vapi template objects with the stack. Customers use `ProductionRetain`. Launch-immutable. |
| `SipSecurity` | `sips_optional_srtp` | TLS signaling always; SRTP when Vapi offers it (today Vapi does not). `sips_srtp` would reject those transfers. |
| everything else | defaults | Four screen-pop fields, no alternate routing, one-hour context TTL, 100 concurrent calls. |

## Run it

```bash
node scripts/lab.mjs bridgefu
```

Expect 20-30 minutes. The EC2 resource does not signal success until ACM has
validated the certificate, the host has rendered its configuration, BridgeFu
reports ready, and the private control endpoint answers over TLS. The script
prints the equivalent console Quick Create link if you prefer to watch in the
console, and on failure it prints the first failing resource, descending into
nested stacks.

## What the stack builds (read the console while you wait)

- **Network**: a dedicated VPC `10.42.0.0/16` with public and private subnets, no NAT, and VPC endpoints for DynamoDB, S3, Secrets Manager, and CloudWatch Logs.
- **Runtime**: one ARM64 EC2 gateway with an Elastic IP, an encrypted data volume, HAProxy on the private address terminating TLS for the control API, a Route53 A record for `SipHostname`, and a private zone for `control.<SipHostname>`.
- **Handoff service**: DynamoDB table `bridgefu-<id>-handoffs`, three Lambdas (prepare, transfer, lookup), an HTTP API with `POST /v1/prepare-handoff` and `POST /v1/transfer-destination`, and four secrets (correlation key, webhook bearer, identity binding, control bearer).
- **Connect integration**: the lookup Lambda association plus two flows in your instance, the wrapper `bridgefu-<id>-entry` and the guide `bridgefu-<id>-agent-guide`.
- **Vapi**: a new assistant named `Bridgefu Connect Support` with a `prepare_handoff` function tool and a destination-less `transferCall` tool, and an identity binding that makes the Lambdas trust exactly that assistant.
- **Observability**: a dashboard, alarms, and log groups; the `DashboardUrl` output.

Security group summary: UDP 16384-32767 open for media, TCP 5061 only from
Vapi's two US signaling addresses, TCP 443 only from the transfer Lambda. There
is no SSH; use the `SsmStartSessionCommand` output for host inspection.

## Launch-immutable settings

`DeploymentId`, `ConnectInstanceArn`, `PublicHostedZoneId`, `SipHostname`,
`SipSecurity`, `MaxConcurrentCalls`, `DataRetentionMode`, and the release AMI
cannot change after creation. Upgrades are parallel deployments, not in-place
updates. Details in the vendored `upstream/bridgefu-vapi-awsconnect/operations.md`.

## Definition of done

- Stack `bridgefu-<id>` is `CREATE_COMPLETE`; `DashboardUrl` shows BridgeFu ready.
- `.lab/state.json` holds the outputs (`VapiAssistantId`, `BridgefuSipUri`, `ConnectWrapperFlowArn`, ...).
- In the Vapi dashboard a new assistant `Bridgefu Connect Support` exists with two tools attached.
