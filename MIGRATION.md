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
checklist (no live cutover), see
[`docs/sakura-cloud-path.md`](docs/sakura-cloud-path.md).

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
See `docs/sakura-render-audit.md` for the configuration snapshot taken before
this migration tooling was added.
