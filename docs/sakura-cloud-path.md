# Sakura → Crave Cloud loyalty path

Status: design + spike (not a ship blocker for the sandbox pilot).
Live Render LIP (`sakura-asian-grill-loyalty`) must stay untouched until an
explicit cutover window. Operational freeze/export/import steps live in
[`MIGRATION.md`](../MIGRATION.md). Deploy parity snapshot:
[`sakura-render-audit.md`](sakura-render-audit.md).

## Today vs target

```text
Today (sandbox pilot)
  Sakura iOS → Sakura BFF (Render)
                 ├─ Clerk / demo identity (BFF-owned)
                 ├─ Crave storefront / payments (location-mapped carts)
                 └─ LIP_URL = http://sakura-asian-grill-loyalty:3210
                      └─ self-hosted LIP /lip/v1 (SQLite /data/reference.db)
                         program sakura-rewards, brand-wide wallet

Target (planned follow-up)
  Sakura iOS → Sakura BFF
                 ├─ customer auth still BFF-owned (out of LIP scope)
                 ├─ Crave storefront / payments unchanged
                 └─ LIP_URL = https://<managed-lip-host>
                      └─ same /lip/v1 data plane (Postgres tenant)
                 Cloud control plane (/cloud/v1) is operator-only:
                 org → project → environment → tenant_id + API key
```

**Important:** Cloud does not replace the LIP transaction API with a different
loyalty protocol. The BFF keeps calling `/lip/v1/*`. Cloud replaces *where*
that API runs and *how* the tenant/API key are provisioned.

## What replaces each BFF integration point

| Sakura BFF today | Self-hosted LIP | Crave Cloud target | BFF change |
| --- | --- | --- | --- |
| `LIP_URL` / `LIP_HOST`+`LIP_PORT` | Private Render service `:3210` | Managed LIP base URL for the env | Env-only repoint |
| `LIP_API_KEY` | Shared Render env group | Cloud-issued merchant key for that env | Env-only rotate |
| `members/enroll` on signup | Same operation | Same operation | None if `member_id` + identity mapping preserved |
| `orders/evaluate` (preview) | Same | Same | None |
| `redemptions/reserve` | Same | Same | None |
| `accruals` after paid order | Same | Same | None — keep `${orderId}-accrue` |
| `redemptions/capture` / `reverse` | Same | Same | None — keep `${orderId}-capture` / `-reverse` |
| `accounts/get`, `ledger/list`, `programs/get` | Same | Same | None |
| Webhook `POST /loyalty/webhook` | `LIP_WEBHOOK_URL` → BFF | Same HMAC profile; new host points at same BFF path | Reconfigure secret/URL on target |
| Cloud org/project/env | N/A | `/cloud/v1` control plane | **Not** called from the guest BFF |

Sakura derives financial ids from stable business keys:

- counter/demo orders: `order-{locationId}-{orderKey}` → keys
  `{orderId}-accrue|reserve|capture|reverse|…`
- Crave carts: `orderKey = sanitize(craveCartId)` → same pattern

Those keys and `order_id` / `redemption_id` values must survive cutover
unchanged. Do not mint new random idempotency keys on retry or after migration.

Brand-wide wallet today: one program (`sakura-rewards`), one `member_id` per
guest, order `scope.location_id` varies while `brand_id` / `merchant_id` stay
fixed (`sakura-brand` / `sakura-asian-grill`). Points are not per-location
balances — that behavior is already correct for a franchise demo and must
remain the Cloud default for this program.

## Franchise multi-location gaps (API + MCP)

Already covered by LIP (no Cloud-specific API required for the pilot):

- Foodservice order `scope` with `brand_id`, `merchant_id`, `location_id`
  (and optional `franchisee_id`).
- Single program wallet; earn/redeem at any location under that program.
- Idempotency + business-id indexes so location A retry cannot double-accrue.

Gaps to track before a multi-unit production franchise (not needed for tonight's
sandbox):

| Gap | Why it matters | Owner |
| --- | --- | --- |
| Cloud provisioning adapter does not yet stand up a live data-plane URL + key | Environments stay `pending`; no turnkey `LIP_URL` | LIP Cloud (`docs/cloud.md`) |
| No managed “franchise wallet policy” API (earn rules per location vs brand-wide) | Operators need Admin/program JSON, not a franchise MCP | LIP program mgmt / Admin |
| Official LIP MCP is docs/validate only — no live enroll/accrue over MCP | Agents cannot migrate wallets via MCP; use CLI/HTTP | Intentional; keep BFF as write path |
| Craveup MCP has no loyalty member/wallet tools | Franchise ops in Business Manager need a separate surface | Crave platform, not LIP |
| Customer auth / Crave Customer Identity ≠ LIP member | Sakura guests are BFF-local today | Identity bridge + Sakura BFF |
| No BFF write-freeze switch | Cutover needs maintenance mode or scale-down | Sakura BFF |
| Ten demo locations ↔ Crave location map | Cart/payments are per-location; wallet stays brand-wide | Sakura (`CRAVEUP_LOCATION_MAP`) |
| Webhook delivery health metric | Cutover confidence | LIP server + Sakura BFF |

## Cutover that keeps `orderKey` / `craveCartId` idempotency

1. Provision Cloud env (tenant + program JSON matching `sakura-program.json`).
2. Freeze BFF mutations (signup + all order write routes), drain in-flight
   checkout, flush webhook outbox.
3. `lip state export` from `/data/reference.db` (includes ledger, open
   reservations, idempotency records, order/redemption indexes).
4. `lip state import` into empty Cloud tenant (no `--force`).
5. Verify counts + a known member (e.g. Kenji Watanabe balance/ledger).
6. Point BFF `LIP_URL` + `LIP_API_KEY` at Cloud; keep webhook receiver.
7. Canary reads, then one controlled order using an **unused** `orderKey` /
   `craveCartId`.
8. Unfreeze. Retries of pre-cutover carts must reuse the same
   `craveCartId` / `orderKey` so imported idempotency rows win.

Rollback before any Cloud write: repoint BFF to Render. After Cloud writes:
freeze, export Cloud, restore to a clean host — do not dual-write.

**Do not** redeploy or restart the live loyalty service for this design pass.

## Spike already on this branch

- `lip state export` / `lip state import` + unit tests
- [`MIGRATION.md`](../MIGRATION.md) operator runbook
- [`sakura-render-audit.md`](sakura-render-audit.md) live parity notes

No production cutover in this pass.

## Open issues / PR checklist (Sakura executes later)

### LIP / Cloud (this repo)

- [ ] Merge `feat/sakura-cloud-migration` (state export/import + docs) to `main`.
- [ ] Issue: Cloud provisioner adapter returns reachable `LIP_URL` + API key for an environment.
- [ ] Issue: Document credential handoff (secret store) from Cloud → Sakura Render env group.
- [ ] Issue: Optional Admin/ops “write freeze” or maintenance flag on managed LIP (nice-to-have; BFF freeze is sufficient).
- [ ] Issue: Webhook delivery success metric or signed health probe for cutover gates.
- [ ] PR: Conformance run against a provisioned Cloud staging tenant (`lip doctor` / `lip test`).

### Sakura BFF / app (`sakura-japan` — Sakura agent)

- [ ] Issue: BFF maintenance mode that blocks enroll + order mutations but allows wallet reads.
- [ ] Issue: Cutover runbook in Sakura repo linking here; env vars `LIP_URL`, `LIP_API_KEY`, `LOYALTY_WEBHOOK_SECRET`.
- [ ] Issue: After import, regression: same `orderKey` / `craveCartId` retry returns same order id and does not change balance.
- [ ] Issue: Confirm Kenji (and other pilot members) balances match pre/post export counts.
- [ ] PR: Env-only Render Blueprint change to new `LIP_URL` (no Dockerfile pin bump required for cutover).
- [ ] Follow-up (non-blocking): Clerk/customer-identity enrollment path vs demo `email_hash` members.

### Explicitly out of scope for cutover

- Migrating Sakura guests into Crave Customer Identity (auth stays BFF-owned).
- Changing earn rate, rewards, or program id.
- Replacing `/lip/v1` with a Crave-proprietary loyalty API.
- Live MCP tools that post accruals.
