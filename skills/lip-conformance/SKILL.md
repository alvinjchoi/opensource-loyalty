---
name: lip-conformance
description: >-
  Validate LIP implementations with doctor, test, lip validate, and unit tests.
  Use when checking a deployment, fixing conformance failures, or adding e2e
  tests that boot the real reference server.
---

# LIP conformance

## HTTP checks

```bash
npm run lip -- doctor http://127.0.0.1:3210 --api-key lip-dev-key
npm run lip -- test http://127.0.0.1:3210 --api-key lip-dev-key
```

## Payload validation

```bash
npm run lip -- validate ./order.json -s FoodserviceOrder
npm run lip -- schemas
```

## Unit and integration tests

```bash
npm run test
npm run verify
```

## End-to-end pattern

Boot LIP + your BFF as child processes, drive HTTP lifecycle, use temp databases.
A companion BFF's end-to-end test suite is a good reference pattern.

## When tests fail

Map failures to `spec/` sections. Fix the adapter — do not skip or weaken checks.

## Reference

- [`tests/conformance/`](../../tests/conformance/)
- [API endpoints](../../docs/api-endpoints.md)
