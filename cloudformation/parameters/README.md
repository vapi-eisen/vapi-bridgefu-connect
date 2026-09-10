# Example parameter files

`scripts/lab.py` assembles parameters from `.lab/state.json`; these examples
show the same values for engineers who prefer the console or plain
`aws cloudformation create-stack --parameters file://...`. The BridgeFu product
template itself is deployed from its public URL (see `docs/02-bridgefu-stack.md`);
`lab-web.yaml` takes its values from the running BridgeFu stack's outputs, so it
has no static example.
