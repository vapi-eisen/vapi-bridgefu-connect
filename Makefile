NODE ?= node
PYTHON ?= python3
MJS := scripts/lab.mjs web/server.mjs web/lib/static.mjs $(wildcard scripts/lib/*.mjs)

.PHONY: check lint templates syntax node-test py-test

check: lint templates syntax node-test py-test

lint:
	ruff check lambda tests/python

templates:
	cfn-lint cloudformation/connect-lab.yaml cloudformation/lab-web.yaml iam/lab-runner.yaml

syntax:
	@for f in $(MJS); do $(NODE) --check $$f || exit 1; done; echo "node syntax ok"

node-test:
	$(NODE) --test "tests/node/**/*.test.mjs"

py-test:
	$(PYTHON) -m unittest discover -s tests/python -v

