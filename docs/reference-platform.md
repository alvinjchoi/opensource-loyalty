# Reference platform

The LIP reference platform is a runnable implementation for development,
evaluation, and conformance work. It combines the protocol engine, durable local
storage, an HTTP server, seeded foodservice data, and a browser Admin.

It is deliberately not the protocol itself. Portable provider behavior remains
defined by the schemas, OpenAPI document, foodservice profile, and routes under
`/lip/v1`. The Admin API, SQLite layout, snapshots, and user interface are
non-normative implementation choices.

## Architecture

```text
apps/admin                         POS, kiosk, ordering, SDK
    |                                        |
    | /admin/api/v1                         | /lip/v1
    +----------------+-----------------------+
                     |
              packages/server
                     |
              packages/reference
                     |
              packages/storage
                     |
          packages/storage-sqlite
```

- `packages/reference` owns deterministic loyalty behavior and exports a
  versioned state snapshot.
- `packages/storage` defines the small state-store contract without choosing a
  database.
- `packages/storage-sqlite` stores one current snapshot per key using SQLite,
  WAL mode, and an upsert transaction.
- `packages/server` exposes the normative HTTP binding and a separate,
  authenticated read-only Admin API.
- `apps/admin` renders operational state without importing the engine or reading
  SQLite directly.

This separation lets another implementation replace SQLite, the Admin, or the
entire reference engine while continuing to expose the same LIP contract.

## Start and persistence

```sh
npm install
npm run quickstart
```

Quickstart builds the Admin, starts the server on `http://127.0.0.1:3210`, seeds
synthetic restaurant activity on first use, and writes `.lip/reference.db`.
Every successful mutation saves the new engine snapshot before the HTTP response
is returned.

The snapshot includes its format version and a fingerprint of the configured
program. Startup rejects a snapshot created for an incompatible program instead
of silently applying the wrong earning or tier policy.

Useful controls:

```sh
npm run lip -- quickstart --database .lip/another.db
npm run lip -- quickstart --reset
npm run lip -- quickstart --reset --no-seed
```

`--reset` is intentionally explicit. A normal process restart hydrates members,
balances, point lots, reservations, ledger entries, adjustments, and idempotency
records from the existing database.

## Admin boundary

Open `http://127.0.0.1:3210/admin/` and sign in with the configured development
Bearer token. The server exchanges it for an eight-hour, HttpOnly,
`SameSite=Strict` session cookie. Admin data is served from
`/admin/api/v1/snapshot`; protocol clients do not need or use this route.

The current Admin is intentionally read-only for persisted server state. Its
Configure view reads program-model capability metadata from the Admin snapshot
so operators can compare points, visits, wallet credit, paid membership, and
hybrid structures. Only points-and-tiers is currently runnable in the reference
engine; the other models are shown with backend blockers until write and engine
support exists. It supports:

- Program health, issued and outstanding liability, and tier distribution
- Member search, balances, tier progress, and expiration buckets
- Immutable ledger search and operation filtering
- Earning policy, tier ladder, and reward-catalog inspection
- Program model planning for future configuration work
- Protocol, storage, and endpoint diagnostics

The shared development token is suitable for a local reference environment,
not a hosted multi-tenant deployment. Production Admin work requires scoped
users, authorization, tenant isolation, audit logging, CSRF controls for future
writes, secret rotation, and a production database adapter.

## Extension path

Database adapters implement `StateStore<LoyaltyEngineState>`. A future hosted
platform can add Postgres without changing the protocol or engine API. POS and
ordering integrations should continue to target `/lip/v1`; vendor-specific
mappings belong in adapter packages and conformance fixtures.

Admin modules and workflows should consume a versioned platform API rather than
engine internals. That keeps operational tooling replaceable and prevents local
product features from becoming accidental protocol requirements.
