---
name: lip
description: >-
  Loyalty Interchange Protocol (LIP) router. Use when integrating restaurant
  loyalty, earning or redeeming points, checkout lifecycle, webhook receivers,
  the lip CLI, TypeScript SDK, BFF patterns, refunds, program definitions,
  or conformance testing. Routes to the right LIP skill for the task.
---

# LIP Skills Router

LIP is a **transaction protocol**, not a customer auth platform. Apps use a
backend-for-frontend (BFF) that holds the merchant API key; LIP holds the ledger.

Read [`llms.txt`](../../llms.txt) first. When docs and `spec/` disagree, `spec/` wins.

## By task

| Task | Skill |
| --- | --- |
| CLI: serve, doctor, test, validate | `lip-cli` |
| TypeScript SDK, LipClient, idempotency | `lip-sdk` |
| Checkout: evaluate, reserve, accrue, capture, refund | `lip-checkout` |
| Webhook delivery and verification | `lip-webhooks` |
| Mobile/web app + BFF integration | `lip-bff` |
| Conformance, schema validation, testing | `lip-conformance` |

## Quick navigation

- `/lip-cli` — terminal workflows
- `/lip-sdk` — application client
- `/lip-checkout` — earn and redeem lifecycle
- `/lip-webhooks` — signed CloudEvents
- `/lip-bff` — customer app pattern (Sakura reference)
- `/lip-conformance` — doctor, test, validate

## Pitfalls (do not implement against LIP directly)

- Customer OTP, social login, or sessions
- Campaigns, segments, push, CRM
- Runtime program editing (boot-time `--program` only today)
- Client-side points math when `orders/evaluate` is available
