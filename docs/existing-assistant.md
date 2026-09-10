# Advanced: wire an assistant you already have

## Why this is the advanced path

The BridgeFu stack creates its own template assistant and writes an identity
binding (`{"status":"bound","organization_id":...,"assistant_id":...}`) into
Secrets Manager. Every prepare and transfer request is checked against that
binding, so a request from any other assistant gets HTTP 403. The product does
this on purpose: it never wants to mutate a customer's production assistant or
accept context from an assistant it did not provision.

You can still wire your own assistant, with two caveats you must accept:

1. Only one assistant is trusted at a time. While yours is bound, the template
   assistant's transfers fail.
2. Any update to the BridgeFu stack re-runs the provisioner, which rebinds to
   the template assistant. Re-run the attach command afterwards. Lambdas cache
   secrets for 300 seconds, so allow up to five minutes after any rebind.

## What the attach does

```bash
node scripts/lab.mjs vapi --attach-existing <assistantId> --skip-number
```

1. Refuses if the assistant already sends server messages to a different URL
   (the stack must own `server.url` to answer `transfer-destination-request`).
2. Adds the stack's `prepare_handoff` tool id to `model.toolIds`, appends the
   destination-less `transferCall` tool from `vapi/transfer-tool.json` if none
   exists, sets `server` to the transfer URL with the stack's webhook credential,
   adds `transfer-destination-request` to `serverMessages`, adds the credential
   to `credentialIds`, and appends the five required rules to the system prompt.
3. Rebinds the identity secret to your assistant's org and id.
4. Records the assistant's previous configuration in `.lab/state.json` so
   `--detach` can restore it and rebind the template assistant.

Then assign a number to it as usual (`node scripts/lab.mjs vapi --skip-persona`),
or reuse one you already have.

## Undo

```bash
node scripts/lab.mjs vapi --detach
```

Teardown runs the same detach automatically.
