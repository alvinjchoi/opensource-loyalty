# PostgreSQL production storage

The reference server supports a normalized PostgreSQL engine store in addition
to the default SQLite sandbox.

## Start the Postgres profile

```bash
docker compose --profile postgres up --build
```

The SQLite runtime remains on port `3210`. The Postgres-backed runtime is
available on port `3211` by default. Set `LIP_POSTGRES_PORT` to change it.

To use an existing database:

```bash
LIP_DATABASE_URL=postgres://user:password@host:5432/loyalty \
LIP_TENANT_ID=demo-cafe \
LIP_API_KEY=replace-with-a-secret \
npm run serve
```

Startup applies numbered migrations from
`@loyalty-interchange/storage-postgres`. `LIP_RESET=true` explicitly deletes
the selected tenant/program engine state before seeding.

## Data model

Core engine state is split into tenant-scoped tables for:

- members and identity indexes
- account balances
- redemption reservations
- immutable ledger entries
- expiring balance lots and lot consumption
- idempotency records
- order accrual and adjustment indexes
- issued rewards

Every table includes `tenant_id` and `program_id` in its key. JSONB payloads
preserve forward-compatible protocol fields while indexed columns keep common
operator and reconciliation queries relational.

## Multi-instance behavior

Each protocol request:

1. checks out one database client;
2. starts a transaction;
3. obtains a tenant/program advisory transaction lock;
4. reloads the latest engine revision;
5. performs the operation;
6. replaces all normalized rows atomically and advances the revision;
7. commits before returning the HTTP response.

This prevents lost updates across server instances. Webhook events generated
inside the operation are buffered and released only after commit.

`PostgresEngineRepository.withLease()` exposes session advisory leases for
single-run schedulers and background jobs. `PostgresJsonStateStore` provides
optimistic revisions for tenant-scoped extension state.

The bundled Admin in Postgres mode currently exposes engine snapshots and
runtime webhook controls. Program publishing, campaign scheduling, membership
operations, and access-directory writes remain enabled in the full SQLite
reference runtime until those service stores are moved to asynchronous
Postgres repositories.

## Integration test

The default suite does not require a database. To run the live adapter test:

```bash
LIP_TEST_POSTGRES_URL=postgres://user:password@localhost:5432/loyalty \
npx vitest run tests/unit/postgres-storage.test.ts
```
