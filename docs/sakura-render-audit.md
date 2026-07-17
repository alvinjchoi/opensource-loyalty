# Sakura Render deployment audit

Audit timestamp: 2026-07-17.

## Verdict

The live Sakura loyalty service is built from the current LIP `main` revision,
uses the checked-in Sakura program, and is reached by the BFF with the expected
generated API credential. The deployed BFF uses stable order-derived
idempotency keys, and the pinned LIP engine persists both idempotency responses
and business-identifier indexes.

Webhook configuration is consistent at the Render Blueprint level: both
services receive `LOYALTY_WEBHOOK_SECRET` from the same generated environment
group, and the loyalty entrypoint maps it to `LIP_WEBHOOK_SECRET`. Render masks
secret values, so this audit did not copy or compare plaintext secrets.

## Evidence

The live private service `sakura-asian-grill-loyalty`
(`srv-d9ckeum1a83c7398kaug`) reported:

- live deploy `dep-d9cu1hm1a83c739sosg0`;
- Sakura repository commit `e96c3fb3ca660e94ea7277a4c2c486b78f314a0a`;
- Docker runtime in Oregon with a persistent 1 GB disk mounted at `/data`;
- `server/loyalty.Dockerfile`; and
- private TCP port `3210`.

That Dockerfile pins LIP revision
`14532f6abc9d568948ddf1705d2a01a390519c3f`, which was also `origin/main`
at audit time. It loads `/config/sakura-program.json`, stores state at
`/data/reference.db`, and starts with synthetic seeding disabled.

The live BFF `sakura-asian-grill-bff`
(`srv-d9ckeuu1a83c7398kc50`) reported the same Sakura commit. Its startup log
confirmed:

```text
Loyalty API: http://sakura-asian-grill-loyalty:3210 (program sakura-rewards)
```

Its public `/program` response matched the checked-in Sakura definition:

- program `sakura-rewards`, named `Sakura Rewards`;
- one point per 100 USD minor units;
- reward `five-off`;
- cost 50 points; and
- discount amount 500 USD minor units.

The full checked-in definition additionally configures 365-day point
expiration, mobile/pickup/web/counter earning, and 300-second evaluation and
reservation TTLs. Live loyalty request logs showed successful HTTP 201 accruals
at `2026-07-17T08:22:49Z` and `2026-07-17T08:28:24Z`.

## Idempotency review

The deployed BFF derives financial mutation keys from stable business
identifiers:

- `<order-id>-reserve`;
- `<order-id>-accrue`;
- `<order-id>-capture`;
- `<order-id>-reverse`;
- `<order-id>-refund-reverse`; and
- `<order-id>-refund-adjust`.

Redemption and adjustment bodies also use stable `redemption_id`,
`reservation_id`, `order_id`, and `adjustment_id` values. This matches
`spec/core.md` and `spec/lifecycle.md`.

The pinned engine stores idempotency records in persistent engine state and
stores separate indexes for order accruals, adjustments, and redemptions. A
same-key/same-request retry returns the original response; a changed request
conflicts; and a changed key cannot make the same business identifier post a
second financial effect.

## Webhook review

`render.yaml` defines one generated environment group,
`sakura-loyalty-shared`, containing `LIP_API_KEY` and
`LOYALTY_WEBHOOK_SECRET`. Both services reference that group.

On loyalty startup, `server/start-loyalty.sh`:

1. refuses to start without `LOYALTY_WEBHOOK_SECRET`;
2. builds `LIP_WEBHOOK_URL` from the private BFF host and port; and
3. exports the generated value as `LIP_WEBHOOK_SECRET`.

The BFF verifies the exact raw body with HMAC-SHA256 over
`timestamp + "." + raw_body`, enforces a 300-second tolerance, compares in
constant time, and deduplicates on CloudEvent source plus id. This matches
`spec/webhooks.md`.

Runtime webhook acceptance could not be independently observed from the
available logs because successful BFF webhook receipts are not logged and the
diagnostics endpoint is protected. Before production cutover, send a controlled
event and confirm an HTTP 200 receipt or expose a secret-free webhook delivery
health metric.

## Drift and migration risks

1. Render's private-service `url` field still reports
   `sakura-asian-grill-loyalty:10000`, but the live process binds **3210**
   (`openPorts`, deploy log `Detected service running on port 3210`, and BFF
   `LIP_PORT=3210`). Port `10000` is the BFF public/private port, not LIP.
2. LIP is pinned by commit inside the Sakura Dockerfile. It matches LIP
   `origin/main` (`14532f6`) now, but future LIP `main` changes will not
   deploy until Sakura updates `LOYALTY_REVISION` and rebuilds.
3. At re-check, local `sakura-japan` `master` HEAD (`52cefed`) is two commits
   ahead of the live Render deploy (`e96c3fb`). The live pin and
   `sakura-program.json` are unchanged across that gap; identity/stack work in
   those commits is not yet live.
4. The current BFF has no explicit loyalty-write freeze switch. A zero-loss
   cutover must use maintenance routing or stop/scale the BFF after draining
   in-flight requests.
5. The engine database is persistent; portable full-state export/import is
   provided by `lip state export` / `lip state import` on this branch.
6. Engine migration does not include BFF guest/customer records or webhook
   outbox/configuration. Those remain separate migration workstreams.

No program-definition or idempotency-behavior drift was found between the live
pin and LIP `main` at audit time.
