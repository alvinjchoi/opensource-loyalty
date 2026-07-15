---
name: lip-bff
description: >-
  Build a backend-for-frontend for LIP-powered mobile or web apps. Use when the
  app must not hold the merchant API key, mapping app users to member_id,
  server-side order pricing, engine-backed cart preview, or Sakura-style stacks.
---

# LIP BFF pattern

Customer apps **must not** hold `LIP_API_KEY`. Add a thin backend that:

| Concern | Owner |
| --- | --- |
| Sign-in, sessions, profile | BFF (not LIP today) |
| Merchant API key | BFF only |
| `member_id` mapping | BFF store |
| Order pricing (minor units) | BFF |
| `orders/evaluate` preview | BFF → LIP |
| Checkout lifecycle | BFF orchestrates LIP |

## Signup

On account creation, call `members/enroll` with a stable identity (`email_hash`,
`token`, etc.) and store `member_id` on the user record.

## Cart preview

`POST /orders/preview` → price draft order → `orders/evaluate` → return
`estimated_accrual` and `rewards[].status` to the app.

## Place order

Accept a client **`orderKey`** (stable per checkout attempt). On retry, return
the stored order — do not double-accrue. Lifecycle:

`reserve` → pay → `accrue` → `capture`, with `reverse` on failure.

## Reference implementation

Sakura Japan (`sakura-japan` repo): Expo app → `server/index.mjs` → LIP server.
E2E template: `sakura-japan/server/e2e.test.mjs`.

## Reference

- [Using LIP with AI](../../docs/using-lip-with-ai.md)
- [Punchh compatibility](../../docs/punchh-compatibility.md)
