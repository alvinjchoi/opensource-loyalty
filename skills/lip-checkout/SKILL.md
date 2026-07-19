---
name: lip-checkout
description: >-
  Implement LIP foodservice checkout lifecycle: orders/evaluate preview,
  redemptions/reserve, accruals, redemptions/capture, reverse on failure,
  orders/adjust on refund. Use when building cart preview, checkout, or refund
  flows for restaurant loyalty.
---

# LIP checkout lifecycle

Read [`spec/lifecycle.md`](../../spec/lifecycle.md) before implementing.

## Happy path

1. **`orders/evaluate`** — preview earn estimate and reward eligibility (before payment)
2. **`redemptions/reserve`** — optional; hold points for a reward
3. **Payment** — your provider (not LIP)
4. **`accruals`** — post earned points
5. **`redemptions/capture`** — finalize redemption if reserved

## Failure after reserve

Call **`redemptions/reverse`** before returning an error to the customer.

## Full refund

1. **`redemptions/reverse`** if a redemption was captured (restores burned points)
2. **`orders/adjust`** with `type: full_refund` and **negative** `eligible_spend_delta`

Use idempotency keys: `${order_id}-reserve`, `${order_id}-accrue`, `${order_id}-capture`,
`${order_id}-refund-adjust`.

## Do not

- Compute points client-side when evaluate is available
- Accrue before payment succeeds
- Capture without a prior reserve

## Reference

- [`examples/typescript/full-lifecycle.ts`](../../examples/typescript/full-lifecycle.ts)
- A companion BFF's server entrypoint is a good real-world reference
