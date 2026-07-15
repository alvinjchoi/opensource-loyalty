---
name: lip-webhooks
description: >-
  Configure and verify LIP webhook delivery. Use when enabling CloudEvents from
  the reference server, implementing POST /loyalty/webhook receivers, verifying
  LIP-Webhook-Signature headers, or deduplicating events.
---

# LIP webhooks

The reference platform emits signed CloudEvents after mutations. Profile:
[`spec/webhooks.md`](../../spec/webhooks.md).

## Enable delivery

```bash
LIP_WEBHOOK_URL=https://your-app/loyalty/webhook \
LIP_WEBHOOK_SECRET=your-shared-secret \
npm run lip -- serve --api-key lip-dev-key
```

## Verify in receivers

Verify the **raw body** before `JSON.parse`:

```ts
import { verifyWebhook } from "@loyalty-interchange/sdk";

await verifyWebhook({
  payload: rawBody,
  secret: process.env.LIP_WEBHOOK_SECRET!,
  timestamp: headers["lip-webhook-timestamp"],
  signature: headers["lip-webhook-signature"]
});
```

Deduplicate on CloudEvent `source` + `id` (idempotent replays reuse resource ids).

## Event types

- `org.loyalty-interchange.member.enrolled.v1`
- `org.loyalty-interchange.order.accrued.v1`
- `org.loyalty-interchange.order.adjusted.v1`
- `org.loyalty-interchange.redemption.reserved.v1`
- `org.loyalty-interchange.redemption.captured.v1`
- `org.loyalty-interchange.redemption.reversed.v1`

## Reference

- [Webhook delivery](../../docs/webhook-delivery.md)
- [`packages/server/src/webhooks.ts`](../../packages/server/src/webhooks.ts)
