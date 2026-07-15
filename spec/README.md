# LIP v1 working draft

This directory contains the normative Loyalty Interchange Protocol contract.
When prose, examples, and schemas disagree, the following precedence applies:

1. `core.md` and the selected profile define semantic behavior.
2. JSON Schema defines payload structure.
3. OpenAPI defines the HTTP binding.
4. Conformance tests demonstrate required observable behavior.

The checked-in files under `schemas/` and `openapi.yaml` are generated with
`npm run generate`. Changes must be made in `packages/protocol` or the generator.

## Documents

- `core.md`: transport-independent data and processing rules
- `lifecycle.md`: order, accrual, and redemption state transitions
- `account-experience.md`: program catalogs, account snapshots, tiers, and ledger queries
- `profiles/foodservice.md`: restaurant and franchise requirements
- `webhooks.md`: webhook signing and replay-protection profile
- `references.md`: composed standards and adjacent industry work
- `openapi.yaml`: normative HTTP binding
- `examples`: complete protocol messages used by tests

LIP uses JSON Schema Draft 2020-12, OpenAPI 3.1, CloudEvents 1.0 structured
events, and RFC 9457 problem details.
