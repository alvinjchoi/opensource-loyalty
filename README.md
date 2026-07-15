# Loyalty Interchange Protocol (LIP) 👋

![GitHub stars](https://img.shields.io/github/stars/alvinjchoi/opensource-loyalty?style=social)
![GitHub forks](https://img.shields.io/github/forks/alvinjchoi/opensource-loyalty?style=social)
![GitHub repo size](https://img.shields.io/github/repo-size/alvinjchoi/opensource-loyalty)
![GitHub language count](https://img.shields.io/github/languages/count/alvinjchoi/opensource-loyalty)
![GitHub top language](https://img.shields.io/github/languages/top/alvinjchoi/opensource-loyalty)
![GitHub last commit](https://img.shields.io/github/last-commit/alvinjchoi/opensource-loyalty?color=red)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**LIP is an open, vendor-neutral loyalty protocol and reference platform for developers building restaurant, QSR, coffee, convenience, and franchise ordering systems.** It ships everything needed to go from zero to a working loyalty integration: a normative protocol spec, a **deterministic reference engine**, an **HTTP API**, a **TypeScript SDK**, a local **Admin dashboard**, a SQLite sandbox, Docker runtime, runnable examples, and black-box conformance tests.

For more information, be sure to check out the **[LIP Documentation](docs/README.md)**.

## Key Features of LIP ⭐

- 🚀 **Effortless Setup**: One command to a seeded local sandbox (`npm start`), or self-host with Docker Compose. The startup screen prints your Admin URL and API key.

- 🔁 **Complete Loyalty Lifecycle**: Member lookup, enrollment, balances, and ledger history. Evaluate orders before checkout, post accrual after payment, and run redemption reserve, capture, reverse, and refund-safe adjustment flows.

- 🍔 **Foodservice-First Order Model**: Restaurant orders with items, modifiers, discounts, fees, taxes, tips, tenders, and totals. Channel-aware rules for counter, drive-thru, kiosk, web, mobile, pickup, delivery, and catering.

- 🏪 **Franchise-Aware Scope**: Brand, merchant, location, and franchisee identifiers, plus product, category, tag, and line-kind earning exclusions.

- 🎯 **Multiple Program Models**: **Points** (spend-based earn/redeem with expiring lots), **visits and stamps**, **wallet credit**, **paid membership**, and **hybrid rewards**. Points is executable in the reference engine today; the Admin surfaces the others as configuration templates with explicit backend support status.

- 🛡️ **Retry-Safe by Design**: Idempotency keys, request context, RFC 9457 problem details, and partial refund, void, reversal, duplicate-check, and settlement semantics.

- 🧰 **TypeScript SDK**: Idiomatic domain client with request ids, timestamps, idempotency keys, exact-money helpers, a foodservice order builder, and a generated low-level OpenAPI client.

- 🖥️ **Local Admin Dashboard**: Authenticated dashboard at `http://127.0.0.1:3210/admin/` for inspecting members, balances, tiers, rewards, ledger entries, program configuration, and storage status.

- 🗄️ **Durable Sandbox Storage**: SQLite-backed state by default, with a storage adapter boundary ready for production databases such as Postgres.

- 🧪 **Specs and Conformance**: OpenAPI 3.1 contract, JSON Schema Draft 2020-12 payload schemas, normative lifecycle, account, webhook, and foodservice profile documents, and black-box HTTP conformance tests you can run against any implementation.

- 🔧 **Batteries-Included CLI**: Validation, diagnostics (`doctor`), local serving, schema listing, and baseline conformance checks.

Want the full picture? Check out the [developer docs](docs/README.md) for a comprehensive overview.

## How to Install 🚀

### Quick Start with Docker 🐳

Requirements: Git and Docker.

```bash
git clone https://github.com/alvinjchoi/opensource-loyalty.git
cd opensource-loyalty
docker compose up --build
```

The startup log prints the Admin URL and the Admin/API key. With the default Compose environment, the key is:

```text
lip-dev-key
```

Open the Admin dashboard at [http://127.0.0.1:3210/admin/](http://127.0.0.1:3210/admin/) and sign in with that key.

> [!TIP]
> If the terminal is no longer visible, read the same key from Docker logs with `docker compose logs lip`.

Then verify the API in a second terminal:

```bash
curl http://127.0.0.1:3210/health
curl http://127.0.0.1:3210/lip/v1/capabilities \
  -H 'Authorization: Bearer lip-dev-key'
```

### Installation from Source 🛠️

Requirements: Git, Node.js 20.19 or newer, and npm.

> [!NOTE]
> This repo uses npm workspaces with `package-lock.json`. pnpm is not the supported install path. For a clean lockfile-only install, use `npm ci` instead of `npm install`.

```bash
git clone https://github.com/alvinjchoi/opensource-loyalty.git
cd opensource-loyalty
npm install
npm start
```

The CLI prints:

```text
Admin: http://127.0.0.1:3210/admin/
Admin/API key: lip-dev-key
```

In a second terminal, check the server and run the baseline conformance suite:

```bash
npm run lip -- doctor http://127.0.0.1:3210 --api-key lip-dev-key
npm run lip -- test http://127.0.0.1:3210 --api-key lip-dev-key
```

Run the full SDK lifecycle — enroll a member, evaluate an order, post accrual, reserve and capture a reward, reverse it, and adjust a refunded order:

```bash
npm run example:sdk
```

### What You Should See ✅

The local server exposes:

- Admin dashboard: `http://127.0.0.1:3210/admin/`
- Protocol API: `http://127.0.0.1:3210/lip/v1`
- Health: `http://127.0.0.1:3210/health`
- Discovery: `http://127.0.0.1:3210/.well-known/lip`

### Running the API Separately

Use this when you only need the reference API and Admin app:

```bash
npm run lip -- serve
```

Useful options:

```bash
npm run lip -- serve --reset
npm run lip -- serve --reset --no-seed
npm run lip -- serve --database .lip/another.db
npm run lip -- serve --port 4010 --api-key local-dev-key
```

### Self-Hosting Configuration ⚙️

The Compose service runs the reference server and Admin dashboard on port `3210` and stores SQLite state in the named `lip-data` volume. Configure runtime values with environment variables:

```bash
LIP_API_KEY="replace-with-a-long-local-key"
LIP_PORT=3210
LIP_SEED_DEMO=true
docker compose up --build
```

> [!WARNING]
> The container is a single-node reference runtime, not a hosted multi-tenant production deployment. For production, build on the protocol and storage adapter boundary: SQLite sandbox → storage adapter contract → Postgres production adapter → tenant-aware Admin API → scoped users, roles, and audit log.

### Target Install Experience 📦

The verified install paths today are Docker and source. Once packages are published, the intended CLI experience is:

```bash
npx @loyalty-interchange/cli serve
```

An optional thin Python-friendly wrapper may provide `pipx install opensource-loyalty`, but the canonical runtime is the TypeScript server and protocol packages in this repo.

## Project Structure 🗂️

```text
|-- apps/
|   `-- admin/              # Browser Admin dashboard
|-- docs/                   # Developer guides and API documentation
|-- examples/
|   `-- typescript/         # Runnable SDK lifecycle examples
|-- packages/
|   |-- cli/                # CLI: serve, quickstart, validation, doctor, conformance
|   |-- protocol/           # TypeScript types, schemas, validation, protocol contracts
|   |-- reference/          # Deterministic loyalty engine and Admin snapshot model
|   |-- sdk/                # Domain SDK and generated low-level OpenAPI client
|   |-- server/             # Reference HTTP server and non-normative Admin API
|   |-- storage/            # Storage adapter interface
|   `-- storage-sqlite/     # Durable SQLite adapter for local and single-node use
|-- scripts/                # Spec, SDK, examples, and package verification scripts
|-- spec/                   # Normative prose, OpenAPI, generated schemas, and examples
`-- tests/                  # Unit, integration, and black-box conformance tests
```

## Tech Stack 🧱

- **Language:** TypeScript on Node.js 20.19+
- **Frontend:** React, Vite, Tailwind CSS, lucide-react
- **API:** Node HTTP server with OpenAPI 3.1 contract
- **Validation:** JSON Schema Draft 2020-12 via TypeBox
- **SDK:** Handwritten domain client plus generated low-level OpenAPI client
- **Storage:** SQLite by default, adapter boundary for Postgres and other backends
- **Testing:** Vitest and black-box HTTP conformance tests
- **Packaging:** Docker today, npm CLI package planned

## Common Commands 🧑‍💻

```bash
npm start             # Start the local sandbox and Admin dashboard
npm run serve         # Same sandbox path with the public command name
npm run lip -- doctor # Check discovery, health, auth, and capabilities
npm run lip -- test   # Run baseline HTTP conformance checks
npm run lip -- schemas                 # List supported JSON schemas
npm run lip -- validate spec/examples/paid-order.json --schema FoodserviceOrder
npm run example:sdk   # Run the full TypeScript SDK lifecycle
npm run typecheck     # Type-check all packages and Admin app
npm test              # Run the full test suite
npm run build         # Build TypeScript packages and Admin assets
npm run generate      # Regenerate schemas, OpenAPI, and SDK client
npm run verify        # Full local verification pipeline
```

## Documentation 📚

Developer guides:

- [Getting started](docs/getting-started.md) — shortest path from clone to working request
- [Five-minute quickstart](docs/quickstart.md) — validation, Docker, reset, seed, and conformance details
- [API endpoints](docs/api-endpoints.md) — routes, auth, examples, errors, retries, and webhooks
- [TypeScript SDK](docs/typescript-sdk.md) — SDK operations, errors, money helpers, and order builder
- [Reference platform](docs/reference-platform.md) — server, Admin, storage, and implementation boundaries
- [Punchh compatibility](docs/punchh-compatibility.md) — migration coverage and adapter gaps

Normative specification (canonical when docs and generated artifacts disagree):

- [Spec overview](spec/README.md)
- [Core protocol](spec/core.md)
- [Lifecycle rules](spec/lifecycle.md)
- [Account experience](spec/account-experience.md)
- [Foodservice profile](spec/profiles/foodservice.md)
- [Webhooks](spec/webhooks.md)
- [OpenAPI](spec/openapi.yaml)
- [Generated JSON Schemas](spec/schemas)

## What's Next? 🌟

Current priorities are tracked in [PLAN.md](PLAN.md). Near-term focus:

- Minimal developer onboarding
- `serve` CLI alias and public package publishing
- Program-as-code configuration drafts with validation, preview, publish, and rollback
- Reward wallet and reward management APIs
- Webhook subscription management
- Postgres storage adapter
- More SDK examples and machine-readable docs

## Contributing 🤝

Contributions are welcome! Start with [CONTRIBUTING.md](CONTRIBUTING.md), run `npm run verify` before opening a pull request, and keep protocol changes backed by schemas, examples, and conformance tests.

## Security 🛡️

If you believe you've found a security vulnerability, please follow the responsible disclosure process in [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License 📜

This project is licensed under [Apache-2.0](LICENSE).

## Support 💬

If you have any questions, suggestions, or need assistance, please [open an issue](https://github.com/alvinjchoi/opensource-loyalty/issues) — let's build open loyalty infrastructure together! 💪
