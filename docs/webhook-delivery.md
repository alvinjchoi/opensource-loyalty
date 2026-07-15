# Webhook delivery

The reference platform can push CloudEvents to HTTP receivers using the
signature profile defined in [`spec/webhooks.md`](../spec/webhooks.md). Events
are emitted after successful mutations:

| Operation              | Event type                                          |
| ---------------------- | --------------------------------------------------- |
| Member enrollment      | `org.loyalty-interchange.member.enrolled.v1`        |
| Accrual posted         | `org.loyalty-interchange.order.accrued.v1`          |
| Order adjusted         | `org.loyalty-interchange.order.adjusted.v1`         |
| Redemption reserved    | `org.loyalty-interchange.redemption.reserved.v1`    |
| Redemption captured    | `org.loyalty-interchange.redemption.captured.v1`    |
| Redemption reversed    | `org.loyalty-interchange.redemption.reversed.v1`    |

Event ids are derived from the underlying resource ids (ledger entry,
reservation, member), so idempotent request replays re-deliver events with the
same CloudEvent `source` + `id`. Receivers deduplicate on that pair, as the
spec requires.

## Enabling delivery

Set environment variables before starting the server:

```bash
LIP_WEBHOOK_URL=https://receiver.example/hooks \
LIP_WEBHOOK_SECRET=your-shared-secret \
npm run lip -- serve --port 4010 --api-key local-dev-key
```

Optionally restrict the delivered event types with a comma-separated
allowlist:

```bash
LIP_WEBHOOK_EVENTS=org.loyalty-interchange.order.accrued.v1,org.loyalty-interchange.redemption.captured.v1
```

Programmatic embedders can pass subscriptions directly:

```ts
import { createDemoPlatform } from "@loyalty-interchange/server";

const platform = createDemoPlatform({
  databasePath: "./data/reference.db",
  webhooks: [{ url: "https://receiver.example/hooks", secret: "your-shared-secret" }]
});
```

`platform.webhooks` exposes the dispatcher, including `flush()` to await the
current retry cycle, `pendingDeliveries()` for the durable queue, and
`deliveries()` for recent process-local delivery results.

## Delivery semantics

- Each event is POSTed as JSON with `LIP-Webhook-Timestamp` and
  `LIP-Webhook-Signature: v1=<base64url>` headers.
- Failed deliveries (network errors or non-2xx responses) are retried with
  exponential backoff, three attempts per process run by default.
- Pending deliveries are stored in SQLite under a separate webhook-outbox
  state key. A normal server restart reloads and retries them; successful 2xx
  deliveries are removed. `--reset` clears both loyalty state and the outbox.
- Delivery is at-least-once. Receivers must verify the signature over the raw
  body and deduplicate using CloudEvent `source` + `id`.
- Receivers can verify with the SDK: `verifyWebhook` in
  `@loyalty-interchange/sdk`.

## Operator visibility

The Admin dashboard's **Developer** view shows whether delivery is enabled,
the number of pending outbox entries, retry attempts, last errors, and recent
process-local outcomes. Pending entries survive restart; completed history is
currently limited to the running process.
