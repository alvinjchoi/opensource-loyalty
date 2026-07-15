# API endpoints

This guide describes the current LIP HTTP API. It covers the reference server
started by `npm run quickstart`, but the operation contract comes from the
generated OpenAPI document at `spec/openapi.yaml`.

## Base URL

Local quickstart:

```text
http://127.0.0.1:3210/lip/v1
```

Production providers should expose the same routes under their own origin and
publish discovery metadata at `/.well-known/lip`.

## Authentication

All `/lip/v1` routes require Bearer authentication except public discovery and
health checks.

```sh
curl http://127.0.0.1:3210/lip/v1/capabilities \
  -H 'Authorization: Bearer lip-dev-key'
```

The reference token is for local development only. Production providers should
issue scoped credentials, rotate secrets, and document rate limits.

## Discovery

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/.well-known/lip` | No | Find API, health, profile, and auth metadata. |
| `GET` | `/health` | No | Check service health. |
| `GET` | `/lip/v1/capabilities` | Yes | Negotiate operations, reward effects, event types, and limits. |

Examples:

```sh
curl http://127.0.0.1:3210/.well-known/lip
curl http://127.0.0.1:3210/health
curl http://127.0.0.1:3210/lip/v1/capabilities \
  -H 'Authorization: Bearer lip-dev-key'
```

## Current operations

| Area | Method | Path | Purpose | SDK method |
| --- | --- | --- | --- | --- |
| Programs | `POST` | `/lip/v1/programs/get` | Read program, account units, tier ladder, and reward catalog. | `lip.programs.get` |
| Accounts | `POST` | `/lip/v1/accounts/get` | Read balances, metrics, expiring lots, and tier progress. | `lip.accounts.get` |
| Ledger | `POST` | `/lip/v1/ledger/list` | Read immutable member ledger history with cursor pagination. | `lip.ledger.list` |
| Members | `POST` | `/lip/v1/members/lookup` | Resolve a member identity. | `lip.members.lookup` |
| Members | `POST` | `/lip/v1/members/enroll` | Enroll or return a member. | `lip.members.enroll` |
| Orders | `POST` | `/lip/v1/orders/evaluate` | Estimate accrual and available rewards for an order. | `lip.orders.evaluate` |
| Accruals | `POST` | `/lip/v1/accruals` | Post accrual after a paid order. | `lip.accruals.post` |
| Redemptions | `POST` | `/lip/v1/redemptions/reserve` | Reserve a reward for an order. | `lip.redemptions.reserve` |
| Redemptions | `POST` | `/lip/v1/redemptions/capture` | Capture a reserved reward. | `lip.redemptions.capture` |
| Redemptions | `POST` | `/lip/v1/redemptions/reverse` | Release, refund, or reverse a redemption. | `lip.redemptions.reverse` |
| Orders | `POST` | `/lip/v1/orders/adjust` | Adjust accrual after a refund, void, or correction. | `lip.orders.adjust` |

## Enroll a member

The repo includes a runnable enrollment request:

```sh
curl --fail-with-body \
  -X POST http://127.0.0.1:3210/lip/v1/members/enroll \
  -H 'Authorization: Bearer lip-dev-key' \
  -H 'Content-Type: application/json' \
  --data-binary @spec/examples/enroll-request.json
```

The response includes the created or existing member plus the current account
snapshot.

## Evaluate an order

Run the enrollment command above first if `member-001` is not already present in
your local database.

Validate the sample foodservice order first:

```sh
npm run lip -- validate spec/examples/paid-order.json --schema FoodserviceOrder
```

Wrap it in a protocol request:

```sh
node --input-type=module - <<'NODE' >/tmp/lip-evaluate.json
import { readFileSync } from "node:fs";

const order = JSON.parse(readFileSync("spec/examples/paid-order.json", "utf8"));
console.log(JSON.stringify({
  context: {
    protocol_version: "1.0",
    profile: "foodservice/1.0",
    request_id: "req-evaluate-001",
    idempotency_key: "evaluate-order-1001",
    occurred_at: "2026-07-14T10:06:00.000Z",
    source: { system: "ordering", instance: "local" }
  },
  member_id: order.member_id,
  order
}, null, 2));
NODE

curl --fail-with-body \
  -X POST http://127.0.0.1:3210/lip/v1/orders/evaluate \
  -H 'Authorization: Bearer lip-dev-key' \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/lip-evaluate.json
```

For a full lifecycle, prefer the SDK example:

```sh
npm run example:sdk
```

That example enrolls a member, evaluates and accrues a paid order, reserves and
captures a reward, reverses the reward, and posts a refund adjustment.

## Idempotency and retries

Every mutating request contains `context.idempotency_key`. Reuse the same key
when retrying after a lost response. Do not silently retry financial mutations
with a new key.

The OpenAPI document marks safe operations with `x-lip-safe-to-retry`. The SDK
uses bounded retries for reads and discovery, but not for accrual, redemption,
enrollment, or adjustment mutations.

## Errors

Errors use RFC 9457 problem details with `application/problem+json`.

Common statuses:

| Status | Meaning |
| --- | --- |
| `401` | Missing or invalid Bearer token. |
| `404` | Unknown route or resource. |
| `415` | Request body is not `application/json`. |
| `422` | Payload failed schema validation. |
| `500` | Unhandled server error. |

Validation errors include JSON paths:

```json
{
  "type": "https://loyalty-interchange.org/problems/validation_failed",
  "title": "Request validation failed",
  "status": 422,
  "code": "validation_failed",
  "errors": [
    { "path": "/order/totals/total", "message": "Expected required property" }
  ]
}
```

## Admin API boundary

The dashboard uses `/admin/api/v1/*`. Those routes are reference-platform
conveniences and are not part of the LIP protocol contract. POS, ordering,
wallet, and loyalty-provider integrations should target `/lip/v1`.

## Webhooks

The OpenAPI document includes the `loyaltyEvent` webhook message shape. The
normative signing and replay-protection rules live in `spec/webhooks.md`.

The current protocol defines event payloads and verification helpers. It does
not yet define webhook subscription management APIs.
