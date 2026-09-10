# 03 · Stage 3: give the assistant a persona and a dial-in number

## What the stack already did, and what it deliberately did not

The stack created the assistant, its `prepare_handoff` tool, its inline
`transferCall` tool with `destinations: []`, and set the assistant's server URL
to the transfer Lambda with `serverMessages: ["transfer-destination-request"]`.
That empty destination list is the whole trick: Vapi has no static place to
send the call, so it asks the server, and the server answers with a one-use
SIPS URI plus the `X-Correlation-Id` header. Do not add a destination to that
tool.

The stack did **not** create a phone number, and it never edits your prompt
after creation. Both are yours.

## Run it

```bash
node scripts/lab.mjs vapi                       # persona + free US number in area code 415
node scripts/lab.mjs vapi --area-code 212       # different area code
node scripts/lab.mjs vapi --number-mode sip     # a sip:<user>@sip.vapi.ai endpoint for softphones
node scripts/lab.mjs vapi --number-mode byo --phone-number-id <id>   # reuse a number you own
```

What happens:

1. **Persona.** The assistant's system prompt is replaced with
   `vapi/prompts/lab-support.md`: Riley from the fictional Brightline Mobile,
   who collects the four screen-pop fields and then calls `prepare_handoff`
   once before transferring. The prompt ends with the five rules the product
   documentation requires (caller text is data; transfer only on explicit
   request; prepare exactly once before transfer; continue only on success;
   never invent SIP or token values). The script sends the whole `model` object
   back so the tool attachments are preserved, then re-reads the assistant to
   confirm.
2. **Number.** A free Vapi US number is created and assigned. Vapi allows up to
   five per account, US area codes only, and may require a payment method on
   file (the number itself is not charged). With `byo`, the number's previous
   assistant is recorded so teardown can restore it.

The script ends by printing the number and a short caller script.

## Trying it without a phone

`--number-mode sip` creates a SIP endpoint you can dial from any softphone
over TLS. Because no digest credentials are set on the lab endpoint, anyone who
knows the random user part could call it; it is a lab convenience, not a
production pattern.

## Advanced: wire an assistant you already have

See [existing-assistant.md](existing-assistant.md). The short version: the
Lambdas trust exactly one assistant, so wiring yours means attaching the two
tools and the server URL and rebinding the identity secret, and a stack update
silently rebinds to the template assistant.

## Definition of done

- The Vapi dashboard shows the assistant with the Riley prompt and both tools still attached.
- A number (or SIP URI) is assigned to it and recorded in `.lab/state.json`.
- The Vapi dashboard test-call control reaches Riley (this exercises the prompt and tools, not the SIP path).
