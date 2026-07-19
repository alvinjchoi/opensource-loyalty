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
                 /       \
packages/storage-sqlite  packages/storage-postgres
```

- `packages/reference` owns deterministic loyalty behavior and exports a
  versioned state snapshot.
- `packages/storage` defines the small state-store contract without choosing a
  database.
- `packages/storage-sqlite` stores one current snapshot per key using SQLite,
  WAL mode, and an upsert transaction.
- `packages/storage-postgres` stores core engine entities in normalized,
  tenant-scoped tables and coordinates instances with advisory locks.
- `packages/server` exposes the normative HTTP binding and a separate,
  authenticated Admin API.
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
program. Published program definitions, drafts, retained revisions, and a local
write audit trail are stored under a separate SQLite key. Startup reconciles a
compatible interrupted publish and rejects unknown or incompatible state
instead of silently applying the wrong earning or tier policy.

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

Open `http://127.0.0.1:3210/admin/` and sign in with the configured Admin/API
key printed by `npm start`, `npm run lip -- serve`, or `docker compose logs lip`.
The same secret is used as the Bearer token for protocol API requests. The
server exchanges it for an eight-hour, HttpOnly,
`SameSite=Strict` session cookie. Admin data is served from
`/admin/api/v1/snapshot`; protocol clients do not need or use this route.

The Configure view supports versioned points-program drafts, validation,
optimistic publish, retained revision history, and rollback. Compatible changes
to earn rates, tiers, expiration, eligibility, and rewards take effect live
without replacing member balances or immutable ledger history. Program ids and
currencies cannot change after publication. Writes use a double-submit CSRF
token tied to the local Admin session; Bearer-authenticated automation is also
supported.

The same view reads program-model capability metadata from the Admin snapshot
so operators can compare points, visits, wallet credit, paid membership, and
hybrid structures. All five models are runnable in the reference engine.
Hybrid programs accrue each configured unit independently, expose every member
balance, and reserve rewards against the reward's configured cost unit. The
Admin supports:

- Program health, issued and outstanding liability, and tier distribution
- Member search, balances, tier progress, and expiration buckets
- Immutable ledger search and operation filtering
- Earning policy, tier ladder, and reward-catalog inspection
- Program draft, validate, publish, discard, and rollback operations
- Local audit records for program writes
- Tenant-scoped users with fixed roles and permissions
- One-time API key issuance, expiration, revocation, and access audit history
- Program model planning for future configuration work
- Protocol, storage, and endpoint diagnostics

The shared development token is suitable for bootstrapping a local reference
environment. The runtime also supports persisted tenant-scoped users and hashed
API keys with role-based authorization, expiration, revocation, CSRF-protected
Admin writes, and audit records. The Postgres protocol runtime coordinates
engine writes across instances; hosted production still requires location
scoping and asynchronous Postgres repositories for the remaining Admin
extension services.

## Operational guards

The reference HTTP server enables a fixed-window, per-remote-client limit of
120 authenticated protocol requests per minute. CLI flags and container
environment variables can change the request count and window. Every limited
response carries `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset`; exhausted clients receive HTTP 429 and `Retry-After`.

The CLI and container also emit structured JSON request records with timestamp,
request id, method, normalized path, response status, duration, and response
size. API keys, authorization headers, and bodies are deliberately excluded.
Applications embedding `createReferenceServer` can provide a custom
`requestLogger` or disable rate limiting explicitly.

An authenticated `GET /metrics` endpoint exports low-cardinality request
counters and duration sums/counts in Prometheus text format. Unknown URLs and
Admin assets are normalized to bounded labels to avoid cardinality growth.

## Maintenance / write-freeze

The reference server can refuse `/lip/v1` writes while keeping reads and
`/health` available, for planned maintenance windows or coordinated
migrations. The flag is in-memory only; it is not persisted and resets to
unfrozen on restart unless set again at startup.

Start frozen from the CLI or container:

```sh
npm run lip -- serve --write-freeze
LIP_WRITE_FREEZE=true npm run lip -- serve
```

`--write-freeze` and `LIP_WRITE_FREEZE=true` (or `1`) are equivalent; either
is enough to start frozen.

Once running, an authenticated operator can toggle the flag at runtime
through the Admin API:

```sh
curl -X POST http://127.0.0.1:3210/admin/api/v1/maintenance \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"write_frozen": true}'

curl http://127.0.0.1:3210/admin/api/v1/maintenance \
  -H "Authorization: Bearer $ADMIN_KEY"
```

The `GET` returns the current `{"write_frozen": boolean}` status. The `POST`
requires an authenticated Admin/API key and, for session-cookie callers, a
valid CSRF token, matching every other Admin write.

While frozen, any `/lip/v1` request classified as a protocol write (including
`evaluate`) receives `503 application/problem+json` with
`{"code": "write_frozen"}` and a `Retry-After` header. Reads stay available,
and `GET /health` reports the current state as `write_frozen` alongside the
existing status fields, so monitoring can detect maintenance windows without
calling the Admin API.

## Segments and reward campaigns

Campaign authoring remains a non-normative platform feature under
`/admin/api/v1`; it does not add campaign concepts to `/lip/v1`. Operators can
persist static member segments, target a catalog reward, run the campaign
manually, and inspect durable run summaries in Admin.

Platform API clients can also define dynamic segments over member status, tier,
available balance, and exact-match attributes. Campaigns with `starts_at` are
picked up by the embedded scheduler; `ends_at` prevents late issuance.

Reward cards can be added, edited, or removed as validated program-draft
changes before they are published. Publishing rejects removal of a reward that
still backs an active issued reward or a saved campaign.

The runner creates deterministic `{campaign_id}:{member_id}` issued reward ids,
so repeated runs skip members already targeted. Customer BFFs consume the
result through the portable issued-reward list and redemption operations.

## Paid membership

Membership plans are program configuration. The non-normative Admin API grants
or ends a member entitlement after an external billing system reports payment
state. Active plans can multiply earning and gate rewards through
`reward.metadata.membership_plan_ids`; expired memberships are lapsed by the
embedded scheduler. Billing and customer authentication remain outside LIP.

## Engagement integrations

The Admin API calculates member, balance, daily ledger, reward, and campaign
aggregates from engine state. CRM member exports are available as JSON or
formula-safe CSV and filter out members without marketing consent by default.

Persisted messaging jobs target existing static or dynamic segments. Marketing
deliveries enforce `member.attributes.marketing_consent`; transactional
deliveries are explicit. The bundled webhook adapter signs each message,
retains delivery attempts and errors, and retries with bounded exponential
backoff. Provider SDKs plug in through `MessagingConnectorAdapter` without
changing protocol routes.

## Extension path

SQLite adapters implement the synchronous `StateStore<T>` contract. PostgreSQL
uses `AsyncStateStore<T>`, normalized engine repositories, optimistic revisions,
transaction advisory locks, and scheduler leases. Neither storage choice
changes the protocol API. POS and ordering integrations should continue to
target `/lip/v1`; vendor-specific mappings belong in adapter packages and
conformance fixtures.

Admin modules and workflows should consume a versioned platform API rather than
engine internals. That keeps operational tooling replaceable and prevents local
product features from becoming accidental protocol requirements.
