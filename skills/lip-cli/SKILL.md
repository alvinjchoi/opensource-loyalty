---
name: lip-cli
description: >-
  Operate the LIP CLI (lip binary) for local sandbox, diagnostics, conformance,
  and schema validation. Use when starting the reference server, running doctor
  or test checks, validating FoodserviceOrder JSON, or loading a custom program.
---

# LIP CLI

From the repo root (or any project with `lip.config.json`):

```bash
npm run lip -- init
npm run lip -- serve --api-key lip-dev-key
npm run lip -- doctor http://127.0.0.1:3210 --api-key lip-dev-key
npm run lip -- test http://127.0.0.1:3210 --api-key lip-dev-key
npm run lip -- validate ./order.json -s FoodserviceOrder
npm run lip -- schemas
```

## Custom program + webhooks

```bash
LIP_WEBHOOK_URL=http://127.0.0.1:8787/loyalty/webhook \
LIP_WEBHOOK_SECRET=your-shared-secret \
npm run lip -- serve --program ./my-program.json --api-key lip-dev-key
```

## After any integration change

Run `doctor` then `test`. Fix the provider or adapter — do not weaken tests.

## Reference

- [`packages/cli/src/cli.ts`](../../packages/cli/src/cli.ts)
- [Getting started](../../docs/getting-started.md)
