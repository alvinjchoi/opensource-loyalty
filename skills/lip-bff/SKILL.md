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
| Sign-in, sessions, recovery | Clerk/Auth0/OIDC provider |
| Token validation + customer mapping | BFF |
| Merchant API key | BFF only |
| `member_id` mapping | BFF store |
| Order pricing (minor units) | BFF |
| `orders/evaluate` preview | BFF → LIP |
| Checkout lifecycle | BFF orchestrates LIP |

## Identity and enrollment

Use the provider's native SDK for sign-up and sign-in. The BFF validates the
provider access token and maps `{tenant_id, issuer, subject}` to a stable
internal customer id. Enroll that customer id as an opaque `external` LIP
identity and store the returned `member_id`. Do not send raw JWTs, email
addresses, phone numbers, or provider subjects to `/lip/v1`.

`@loyalty-interchange/identity` supplies the OIDC verifier, mapping contract,
and resolver. It intentionally does not wrap provider authentication APIs.

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
