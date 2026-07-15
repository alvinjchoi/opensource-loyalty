# Contributing to LIP

Loyalty Interchange Protocol is developed in the open. Changes to normative
behavior start as an issue or proposal and must include conformance fixtures.

## Local development

```sh
npm install
npm run verify
```

## Compatibility policy

- Patch releases clarify documentation and fix implementation defects.
- Minor releases may add optional fields, operations, event types, or profiles.
- Major releases may change required fields or existing semantics.
- Implementations must ignore unknown optional object properties unless a schema
  explicitly prohibits them.
- A normative change is incomplete until the JSON Schema, OpenAPI document,
  examples, and conformance tests agree.

## Design principles

1. Model the transaction lifecycle, not a vendor's product surface.
2. Keep financial values exact and make funding ownership explicit.
3. Make retries safe through idempotency.
4. Separate the cross-vertical core from profile-specific semantics.
5. Prefer existing Internet standards over custom transport conventions.
