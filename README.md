# Loyalty Interchange Protocol - Open Loyalty Infrastructure for Developers

An open, vendor-neutral loyalty protocol and reference platform for restaurants,
QSRs, coffee shops, convenience foodservice, and franchise systems. LIP gives
developers a local sandbox, TypeScript SDK, HTTP API, conformance tests, and
operator dashboard for building portable loyalty integrations without starting
from a proprietary platform.

**[Read LIP Docs](docs/README.md)** - Getting started, API endpoints, SDK guide,
reference platform notes, and protocol specification

## Features

### Loyalty Protocol

- Member lookup and enrollment
- Order evaluation before checkout
- Accrual posting for paid orders
- Redemption reserve, capture, reverse, and refund-safe adjustment flow
- Program catalogs, balances, tiers, expiring lots, and ledger history
- RFC 9457 problem details and idempotency keys for financial operations

### Foodservice Profile

- Restaurant order model with items, modifiers, fees, tenders, taxes, tips, and totals
- Channel-aware rules for counter, drive-thru, kiosk, web, mobile, pickup, delivery, and catering
- Franchise scope with brand, merchant, location, and franchisee identifiers
- Product, category, tag, and line-kind earning exclusions
- Partial refund, void, reversal, duplicate-check, and retry semantics

### Developer Experience

- One-command local sandbox with seeded data: `npm start`
- TypeScript SDK that creates request ids, timestamps, idempotency keys, and protocol context
- Exact-money helpers and foodservice order builder
- CLI for validation, diagnostics, quickstart, and baseline conformance
- Generated OpenAPI client plus handwritten domain SDK
- Runnable full-lifecycle example in `examples/typescript/full-lifecycle.ts`

### Reference Platform

- Authenticated local Admin dashboard at `http://127.0.0.1:3210/admin/`
- SQLite-backed durable sandbox state
- Inspectable members, balances, tiers, ledger entries, rewards, and storage status
- Program model configuration view for points, visits/stamps, wallet credit, paid membership, and hybrid rewards
- Server-owned capability metadata so planned models show real backend blockers
- Storage abstraction ready for production adapters such as Postgres

### Conformance and Specs

- OpenAPI 3.1 HTTP contract
- JSON Schema Draft 2020-12 payload schemas
- Normative lifecycle, account, webhook, and foodservice profile documents
- Black-box HTTP conformance tests
- Checked-in examples used by tests

## Quick Start

1. Install dependencies

```sh
npm install
```

2. Start the local sandbox

```sh
npm start
```

3. Open the dashboard

```text
http://127.0.0.1:3210/admin/
```

Use the development API key:

```text
lip-dev-key
```

4. Check the API

```sh
curl http://127.0.0.1:3210/health
```

5. Run the full SDK lifecycle

```sh
npm run example:sdk
```

That example enrolls a member, evaluates an order, posts accrual, reserves and
captures a reward, reverses the reward, and adjusts a refunded order.

## Project Structure

```text
|-- apps/
|   `-- admin/              # Browser Admin dashboard
|-- docs/                   # Developer guides and API documentation
|-- examples/
|   `-- typescript/         # Runnable SDK lifecycle examples
|-- packages/
|   |-- cli/                # lip CLI: quickstart, validation, doctor, conformance
|   |-- protocol/           # TypeScript types, schemas, validation, protocol contracts
|   |-- reference/          # Deterministic loyalty engine and Admin snapshot model
|   |-- sdk/                # Idiomatic TypeScript SDK and generated OpenAPI client
|   |-- server/             # Reference HTTP server and non-normative Admin API
|   |-- storage/            # Storage adapter interface
|   `-- storage-sqlite/     # Durable SQLite adapter for local and single-node use
|-- scripts/                # Spec, SDK, examples, and package verification scripts
|-- spec/                   # Normative prose, OpenAPI, generated schemas, and examples
`-- tests/                  # Unit, integration, and black-box conformance tests
```

## Tech Stack

- **Language:** TypeScript
- **Runtime:** Node.js 20.19+
- **Frontend:** React, Vite, Tailwind CSS, lucide-react
- **API:** Node HTTP server with OpenAPI 3.1 contract
- **Validation:** JSON Schema Draft 2020-12 via TypeBox
- **SDK:** Handwritten domain client plus generated low-level OpenAPI client
- **Storage:** SQLite by default, storage adapter boundary for Postgres and other backends
- **Testing:** Vitest, black-box HTTP conformance tests
- **Packaging:** npm workspaces
- **License:** Apache-2.0

## Scripts

```sh
npm start             # Start the local sandbox and Admin dashboard
npm run quickstart    # Same sandbox path, explicit command name
npm run lip -- doctor # Check discovery, health, auth, and capabilities
npm run lip -- test   # Run baseline HTTP conformance checks
npm run example:sdk   # Run the full TypeScript SDK lifecycle
npm run typecheck     # Type-check all packages and Admin app
npm test              # Run the full test suite
npm run build         # Build TypeScript packages and Admin assets
npm run generate      # Regenerate schemas, OpenAPI, and SDK client
npm run verify        # Full local verification pipeline
```

## Running the API Separately

Use this when you only need the reference API and Admin app:

```sh
npm run lip -- quickstart
```

Useful options:

```sh
npm run lip -- quickstart --reset
npm run lip -- quickstart --reset --no-seed
npm run lip -- quickstart --database .lip/another.db
npm run lip -- quickstart --port 4010 --api-key local-dev-key
```

The server exposes:

- Protocol API: `http://127.0.0.1:3210/lip/v1`
- Discovery: `http://127.0.0.1:3210/.well-known/lip`
- Health: `http://127.0.0.1:3210/health`
- Admin dashboard: `http://127.0.0.1:3210/admin/`

## Developer Guides

- [Getting started](docs/getting-started.md) - shortest path from clone to working request
- [API endpoints](docs/api-endpoints.md) - routes, auth, examples, errors, retries, and webhooks
- [TypeScript SDK](docs/typescript-sdk.md) - SDK client, operation methods, errors, money, and order builder
- [Reference platform](docs/reference-platform.md) - server, Admin, storage, and implementation boundaries
- [Five-minute quickstart](docs/quickstart.md) - validation, Docker, reset, seed, and conformance details
- [Punchh compatibility](docs/punchh-compatibility.md) - migration coverage and adapter gaps

## Specification

The public protocol contract lives in `spec/`:

- [Spec overview](spec/README.md)
- [Core protocol](spec/core.md)
- [Lifecycle rules](spec/lifecycle.md)
- [Account experience](spec/account-experience.md)
- [Foodservice profile](spec/profiles/foodservice.md)
- [Webhooks](spec/webhooks.md)
- [OpenAPI](spec/openapi.yaml)
- [Generated JSON Schemas](spec/schemas)

When docs and generated artifacts disagree, treat the normative prose and
generated schemas in `spec/` as canonical.

## Storage and Production Path

SQLite is the default because it makes the repo easy to clone, run, inspect, and
test without infrastructure. It is the right choice for local development,
single-node demos, conformance tests, and self-hosted evaluation.

For hosted multi-tenant production, the intended path is:

```text
SQLite sandbox
  -> storage adapter contract
  -> Postgres production adapter
  -> tenant-aware Admin API
  -> scoped users, roles, and audit log
```

The protocol API under `/lip/v1` is separate from the reference Admin API under
`/admin/api/v1`. Product features can grow in the reference platform without
accidentally becoming protocol requirements.

## Roadmap

Current priorities are tracked in [PLAN.md](PLAN.md).

Near-term focus:

- Minimal developer onboarding
- Program-as-code configuration drafts
- Program validation, preview, publish, and rollback
- Reward wallet and reward management APIs
- Webhook subscription management
- Postgres storage adapter
- More SDK examples and machine-readable docs

## License

Apache-2.0 - See [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), run
`npm run verify` before opening a pull request, and keep protocol changes backed
by schemas, examples, and conformance tests.
