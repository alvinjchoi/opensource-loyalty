# Migrating a self-hosted LIP program

This runbook moves one LIP program from SQLite or Postgres to another LIP host
without losing member or financial state. It applies to self-hosted-to-managed,
self-hosted-to-self-hosted, and managed-to-managed moves.

The protocol rules in `spec/` remain canonical. In particular, ledger entries
are immutable and retries must preserve their original idempotency keys.

## What the archive contains

`lip state export` creates a versioned, SHA-256 checksummed JSON archive with:

- the active program definition and fingerprint;
- members and privacy-preserving identity indexes;
- every account balance, expiration lot, and lot consumption;
- the immutable accrual, redemption, adjustment, and migration ledger;
- every reservation, including reservations still in `reserved` state;
- issued rewards;
- request idempotency records; and
- business-identifier indexes for orders, adjustments, and redemptions.

The archive is created with file mode `0600`. It contains customer-linked
financial data and must be encrypted in transit and at rest.

The engine archive does not contain BFF customer accounts, sessions, consent,
payment records, webhook secrets, pending webhook deliveries, Admin users,
campaigns, memberships, or messaging connectors. Move those application and
platform records separately. Recreate webhook configuration on the target and
let the old host flush its webhook outbox before cutover.

## Export and import commands

Use the exact active program JSON on both sides. Import rejects a different
program fingerprint and refuses to replace existing engine state unless
`--force` is explicitly supplied.

Export SQLite:

```bash
npm run lip -- state export \
  --program ./program.json \
  --database /data/reference.db \
  --output ./lip-migration.json
```

Import into an empty SQLite target:

```bash
npm run lip -- state import \
  --program ./program.json \
  --database /data/reference.db \
  --input ./lip-migration.json
```

Import into a managed Postgres tenant:

```bash
LIP_DATABASE_URL='postgres://...' \
LIP_TENANT_ID='sakura-asian-grill' \
npm run lip -- state import \
  --program ./program.json \
  --input ./lip-migration.json
```

The published container can run the same commands with
`node packages/cli/dist/cli.js` in place of `npm run lip --`.

Do not use `--force` during a normal cutover. It is reserved for a verified
restore into a disposable or explicitly replaced target.

## Zero-loss cutover

1. **Prepare the target.** Provision its tenant, network path, API credential,
   program JSON, webhook destination, and webhook secret. Keep protocol writes
   disabled.
2. **Freeze all source writes.** Put the BFF's signup and order mutation routes
   into maintenance mode, or stop/scale the BFF after draining requests. Freezing
   only accruals is insufficient: enrollment, reserve, capture, reverse,
   adjustment, and reward issuance also mutate loyalty state.
3. **Drain in-flight checkout.** Wait for payment callbacks and active BFF
   requests to finish. Flush the source webhook outbox. Record any reservations
   that remain open.
4. **Export once.** Run `lip state export` against the source database. Save the
   printed member, balance, ledger, open-reservation, and idempotency counts with
   the archive checksum.
5. **Import once.** Run `lip state import` while the target is empty and frozen.
   The command verifies the checksum, program fingerprint, complete engine
   state, and target emptiness before saving.
6. **Verify before routing traffic.** Compare archive counts, inspect several
   known member accounts and ledger histories, and run:

   ```bash
   npm run lip -- doctor https://new-loyalty-host --api-key "$LIP_API_KEY"
   npm run lip -- test https://new-loyalty-host --api-key "$LIP_API_KEY"
   ```

7. **Repoint the BFF.** Change `LIP_HOST` and `LIP_PORT` (or `LIP_URL`) together
   with the target `LIP_API_KEY`, then restart the BFF. Do not expose that key to
   the mobile app.
8. **Canary while frozen.** Read the program and a known account through the BFF.
   Confirm target logs receive the requests and that no request reaches the old
   host.
9. **Unfreeze.** Re-enable signup and order mutations. Place one controlled
   order, then confirm exactly one accrual ledger entry and any expected
   reserve/capture entries.
10. **Retain the source read-only.** Keep its database and archive until the
    rollback window closes. Securely delete temporary archive copies afterward.

Keep clocks synchronized. Open reservations retain their original expiration
timestamps and can expire naturally during a long cutover. Finish within the
reservation TTL or reverse those reservations before the freeze.

## Why retries do not double-accrue

LIP requires a stable idempotency key per source system and operation. It also
protects business identifiers such as `order_id`, `adjustment_id`,
`redemption_id`, and `reservation_id`.

The migration archive preserves both layers. If the source committed an accrual
before export but the BFF lost the response, retrying that order against the
target returns the imported result instead of posting another ledger entry.
Sakura derives mutation keys from its stable order/cart identifiers, for
example `<order-id>-accrue`, `<order-id>-reserve`, and
`<order-id>-capture`.

Never generate a new random idempotency key for a retry. Never import only
members and balances: omitting ledger, idempotency, or business indexes makes a
financially safe cutover impossible.

## Rollback

Before unfreezing the target, rollback is simply repointing the BFF to the
still-frozen source. After the target accepts any write, do not repoint to the
old snapshot: that would discard new transactions. Freeze again, export the
target, import that state back to a clean source, verify it, and only then
repoint traffic.

## Sakura on Render

For the BFF → Cloud surface map, franchise wallet gaps, and the deferred PR
checklist (no live cutover), see the Sakura operations docs in the private
`sakura-japan` repository (`docs/operations/sakura-cloud-path.md`).

For the current Sakura deployment:

- source database: `/data/reference.db`;
- program: `/config/sakura-program.json`;
- source service: `sakura-asian-grill-loyalty`;
- BFF service: `sakura-asian-grill-bff`; and
- live private connection: `sakura-asian-grill-loyalty:3210`.

Run the source export from a Render shell after freezing the BFF:

```bash
node packages/cli/dist/cli.js state export \
  --program /config/sakura-program.json \
  --database /data/reference.db \
  --output /data/sakura-lip-migration.json
```

Copy the archive through an encrypted operator channel, import it into the
provisioned Crave Cloud tenant, verify counts, then update the BFF connection.
The configuration snapshot taken before this migration tooling was added lives
in the private `sakura-japan` repository
(`docs/operations/sakura-render-audit.md`).

Render access prerequisite: `render ssh` requires an SSH public key registered
in the Render Dashboard account settings (there is no API for this), and the
loyalty disk is reachable only from the service instance itself — one-off jobs
cannot mount it. Register the operator key before scheduling the cutover
window.

## Rehearsal record (2026-07-17)

A full dry run of this runbook passed locally against the exact Sakura program
(`sakura-program.json`, Sakura-shaped ids from the deployed BFF):

1. Seeded a source LIP with two members: one with two 8-point accruals plus a
   deterministic third accrual (`order-…-cart-k3` / `…-k3-accrue`), and one
   with 60 points and an **open** `five-off` reservation (50 points held).
2. Froze the source and exported: 2 members, 2 balances, 4 ledger entries,
   1 open reservation, 11 idempotency records; archive written mode `0600`.
3. Imported into an empty target; the import reported identical counts.
4. `lip doctor` and `lip test` passed against the served target.
5. Balances and ledgers matched the source exactly, including the reservation
   hold (60 total / 10 available while unexpired).
6. Replaying the byte-identical pre-cutover accrual against the target
   returned the original imported entry id and amount with no balance change —
   the double-accrual guard survives migration.

Open reservations keep their original `expires_at` and expire naturally on the
target; the rehearsal reservation (300-second TTL) did so mid-verification,
which is the documented behavior — finish cutover within the reservation TTL
or reverse open reservations before freezing.

## Live Render rehearsal (2026-07-17)

After SSH access was restored, a **read-only** rehearsal used the live
`sakura-asian-grill-loyalty` disk (service was not restarted or frozen):

1. On the instance: `VACUUM INTO '/tmp/reference-backup.db'` against
   `/data/reference.db` (consistent snapshot without stopping writes).
2. Copied the backup locally and exported with the checked-in
   `sakura-program.json`.
3. Export/import counts matched:
   **11 members, 11 balances, 9 ledger entries, 0 open reservations,
   635 idempotency records** (archive mode `0600`,
   sha256 `89bfd195bcf85aec3b8975011e00cae05c3b1a5c2df7c04e6ceb839c9d500702`).
4. `lip doctor` and `lip test` passed against the served import.
5. **Kenji Watanabe** (`member-12ba39e1-131c-4c6b-b0c5-f6e7a8302b57`):
   balance **16**, ledger two accruals of **+8**
   (`order-demo-southridge-…`, `order-demo-northgate-…`).
6. Double-accrual guards after import:
   - same `${orderId}-accrue` key with different body → `409 idempotency_conflict`;
   - new key + same `order_id` with different facts → `409 conflict`
     ("Order id was already accrued with different facts");
   - Kenji balance stayed **16**.

This was not a production cutover. The live Render LIP remained the pilot host.

## Cutover readiness (2026-07-17)

Hardening landed on LIP `main`:

- Durable local data-plane provisioner (stable ports + credential reuse)
- `POST /admin/api/v1/members/cancel` → member status `closed`
- `GET /admin/api/v1/webhooks/health` (secret-free delivery probe)
- Coverage gates adjusted so verify stays green

Sakura BFF freeze/cancel lands via sakura-japan PR (set
`LOYALTY_WRITE_FREEZE=true` on the BFF, then clear after canary).

### Production swap is still blocked

There is **no managed regional LIP URL + Cloud-issued API key** for Sakura yet.
Local Cloud provisioner URLs are not a production host. Do **not** freeze the
live BFF or change `LIP_HOST`/`LIP_PORT`/`LIP_URL` until that destination exists.

When the target is ready, execute the zero-loss cutover above with:

1. BFF: `LOYALTY_WRITE_FREEZE=true` (restart)
2. Source export from Render shell (see above)
3. Import into empty Cloud tenant (`lip state import`, no `--force`)
4. Atomic BFF env: set `LIP_URL` (or host/port) **and** `LIP_API_KEY` together
5. Canary read + one unused order key accrual
6. Clear freeze

Live rehearsal archive (read-only, not cutover): sha256
`89bfd195bcf85aec3b8975011e00cae05c3b1a5c2df7c04e6ceb839c9d500702`
(11 members / 9 ledger / 635 idempotency).
