---
name: lip-sdk
description: >-
  Use @loyalty-interchange/sdk LipClient for LIP integrations. Use when writing
  enroll, evaluate, accrue, reserve, capture, reverse, or adjust calls, handling
  LipApiError, building FoodserviceOrder payloads, or verifying webhooks.
---

# LIP TypeScript SDK

Prefer `LipClient` over raw `fetch`. It supplies protocol context, validates
requests and responses, and exposes typed errors.

```ts
import { LipClient } from "@loyalty-interchange/sdk";

const lip = new LipClient({
  baseUrl: process.env.LIP_URL!,
  apiKey: process.env.LIP_API_KEY!,
  source: { system: "my-app", instance: "production" }
});
```

## Idempotency (required for mutations)

Derive keys from business ids, not random UUIDs per retry:

```ts
await lip.accruals.post(
  { member_id: memberId, order },
  { idempotencyKey: `accrual:${order.order_id}` }
);
```

For operator-issued bonus, gift, migration, service-recovery, or correction
points, call `lip.ledger.adjust(...)` with a stable `adjustment_id`, a signed
nonzero amount, a reason, and an explicit `qualifies_for_tier` boolean.

## Runnable example

```bash
npm run example:sdk
```

Source: [`examples/typescript/full-lifecycle.ts`](../../examples/typescript/full-lifecycle.ts)

## Reference

- [TypeScript SDK](../../docs/typescript-sdk.md)
- [`packages/sdk/src/client.ts`](../../packages/sdk/src/client.ts)
