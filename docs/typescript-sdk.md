# TypeScript SDK

`@loyalty-interchange/sdk` is the idiomatic application interface for LIP. It
validates requests before network I/O, validates successful responses, creates
protocol context automatically, and exposes stable typed errors.

## Client

```ts
import { LipClient } from "@loyalty-interchange/sdk";

const lip = new LipClient({
  baseUrl: "https://loyalty.example.com",
  apiKey: process.env.LIP_API_KEY!,
  source: { system: "restaurant-ordering", instance: "production" }
});

const member = await lip.members.enroll({
  program_id: "brand-program",
  identity: { type: "token", value: guestToken }
});
```

The client supplies `protocol_version`, `profile`, `request_id`,
`idempotency_key`, `occurred_at`, and `source` on every operation.

The idiomatic client delegates paths, authentication requirements, request and
response schema names, and retry-safety metadata to a client generated from the
checked-in OpenAPI document. `npm run generate` updates both artifacts.

## Operations

```ts
lip.discover();
lip.capabilities();
lip.programs.get(...);
lip.accounts.get(...);
lip.ledger.list(...);
lip.ledger.adjust(...);
lip.members.lookup(...);
lip.members.enroll(...);
lip.orders.evaluate(...);
lip.orders.adjust(...);
lip.accruals.post(...);
lip.redemptions.reserve(...);
lip.redemptions.capture(...);
lip.redemptions.reverse(...);
```

Classified operator adjustments support bonus, gift, migration,
service-recovery, and correction entries:

```ts
await lip.ledger.adjust(
  {
    member_id: memberId,
    program_id: programId,
    adjustment_id: `support:${ticketId}`,
    amount: 100,
    classification: "service_recovery",
    reason: "Late order credit",
    qualifies_for_tier: false
  },
  { idempotencyKey: `support:${ticketId}` }
);
```

Program, account, ledger, lookup, evaluation, discovery, and capabilities reads
use bounded retries for network errors, HTTP 429, and server errors. Mutations
are not silently retried. When an application retries a mutation after losing
the response, it should supply the same business identifier and
`idempotencyKey`:

```ts
await lip.accruals.post(
  { member_id: memberId, order },
  { idempotencyKey: `accrual:${order.order_id}` }
);
```

Render the member's loyalty home without assembling multiple vendor-specific
responses:

```ts
const [{ program }, account, history] = await Promise.all([
  lip.programs.get({ program_id: programId }),
  lip.accounts.get({ program_id: programId, member_id: memberId }),
  lip.ledger.list({ program_id: programId, member_id: memberId, limit: 25 })
]);
```

## Errors

- `LipValidationError`: the local request or successful server response did not
  match the negotiated contract; includes JSON-path issues.
- `LipApiError`: the server returned RFC 9457 problem details; includes HTTP
  status, stable code, and the original problem.
- `LipTransportError`: the request could not be completed after allowed retries.

## Exact money

```ts
import { money, moneyFromDecimal, formatMoney } from "@loyalty-interchange/sdk";

money(1234, "USD");                  // 1234 minor units
moneyFromDecimal("12.34", "USD"); // exact conversion, no binary float
formatMoney({ amount: 1234, currency: "USD" });
```

Decimal conversion rejects excess precision instead of silently rounding.

## Restaurant order builder

`FoodserviceOrderBuilder` calculates line subtotals and order totals, allocates
required zero values, and runs full foodservice reconciliation before returning
an order. Invalid parent lines, currencies, quantities, and paid tenders fail
locally.

Run the complete example against `npm run quickstart`:

```sh
npm run example:sdk
```

The example at `examples/typescript/full-lifecycle.ts` enrolls a unique member,
earns points, reserves and captures a reward, reverses it, and posts a refund.
It is fewer than 50 non-empty application lines and constructs no protocol
context.

## Generated low-level client

Use the generated client when an adapter needs direct access to the OpenAPI
operations and is prepared to construct complete protocol requests:

```ts
import { createLipOpenApiClient } from "@loyalty-interchange/sdk";

const openapi = createLipOpenApiClient({
  baseUrl: "https://loyalty.example.com",
  apiKey: process.env.LIP_API_KEY!
});

const health = await openapi.getHealth();
```

The low-level client is intentionally thin: it supplies generated types,
resolved paths, bearer authentication, abort signals, and stable HTTP/response
errors. Most applications should use `LipClient` for context, validation, safe
retries, and domain-oriented methods.

## Webhook verification

Verify the raw body before calling `JSON.parse`:

```ts
import { verifyWebhook } from "@loyalty-interchange/sdk";

await verifyWebhook({
  payload: rawRequestBody,
  secret: process.env.LIP_WEBHOOK_SECRET!,
  timestamp: request.headers["lip-webhook-timestamp"],
  signature: request.headers["lip-webhook-signature"]
});
```

Verification checks timestamp tolerance and all `v1` signatures using
constant-time comparison. See `spec/webhooks.md` for the normative profile.
