# LIP Developer Experience Plan

Status: active; local implementation has reached Milestone 2.7; package
publication and listed follow-ups remain pending

## Current implementation focus: minimal developer onboarding

The first-run experience should be small enough that a developer can complete it
without reading protocol prose. The default path is:

```text
npm install
  -> npm start
  -> open /admin with lip-dev-key
  -> curl /health
  -> npm run example:sdk
  -> choose API guide, SDK guide, or reference-platform guide
```

- [x] Add `npm start` as the obvious local sandbox command.
- [x] Add a minimal [Getting started](docs/getting-started.md) guide.
- [x] Link README and docs index to the minimal guide before deeper docs.
- [x] Print concrete next steps after `lip quickstart` starts.
- [x] Add [`llms.txt`](llms.txt), [Using LIP with AI](docs/using-lip-with-ai.md),
  and [AI prompts](docs/ai-prompts.md) for agent-assisted onboarding.
- [ ] Add copy/paste SDK snippets for enroll, evaluate, accrue, and redeem.
- [ ] Add a first-run checklist to the Admin API page.

## Current implementation track: product-grade Admin configuration

This track turns the OpenLoyalty/Open WebUI comparison into implementation
work. The goal is not to clone OpenLoyalty. The goal is to make the reference
platform feel like a real loyalty operations dashboard while keeping the
portable LIP contract focused on interoperability.

### Phase 1: honest program-model configuration

- [x] Add server-owned program model templates for points, visits/stamps,
  wallet credit, paid membership, and hybrid rewards.
- [x] Mark the currently runnable model as active and mark planned models with
  backend blockers instead of presenting them as live features.
- [x] Expose configuration capability metadata in the non-normative Admin
  snapshot outside `/lip/v1`.
- [x] Drive the dashboard Configure view from Admin API state instead of
  hard-coded frontend cards.
- [x] Add a persisted Admin draft model with create/update/discard operations.
- [x] Add program draft validation that returns field-level errors and blocking
  publish requirements.
- [x] Add publish and rollback operations that rebuild the reference engine
  from a versioned program definition.

### Phase 2: platform APIs OpenLoyalty already has

- [x] Persisted static segments and reusable manual campaign runs that issue
  portable reward-wallet entries idempotently.
- [x] Reward-level draft CRUD integrated with validation and publish.
- [x] Dynamic member segments and scheduled campaign activation.
- [ ] Reward categories and category-level merchandising.
- [x] Issued reward wallet with code/QR artifacts, claim through redemption,
  cancellation, expiration, reversal restoration, and restart persistence.
- [ ] Manual point adjustments, bonus/gift/migration classifications, transfer
  rules, and expiration job controls.
- [x] Wallet credit account units, basis-point earning, promotional/stored-value
  classification, liability summaries, FIFO redemption, and expiration.
- [x] Executable visits/stamps accounts with per-order accrual, threshold
  reward issuance, card reset, ledger units, Admin publish, and persistence.
- [x] Paid membership plans with durable member entitlements, validity windows,
  earn multipliers, gated rewards, scheduler-driven lapse, and Admin controls.
- [x] Hybrid programs with independently accrued points, credit, and visit/stamp
  accounts, per-unit reward costs, expiration, reservations, and refund entries.
- [x] Persistent webhook subscription CRUD, event filters, signing-secret
  rotation, delivery visibility, and immediate retry for pending deliveries.
- [x] Persist completed webhook delivery history and support completed-event
  replay.
- [x] Add per-subscription timeout, backoff, and retry policies.
- [x] Scoped Admin users, fixed roles and permissions, tenant-scoped API keys,
  key expiration/revocation, and audit entries for Admin and protocol writes.
- [ ] Location-level scoping and custom role definitions.
- [x] Consent-filtered member CRM exports in JSON and CSV.
- [x] Ledger/member/campaign analytics plus signed, idempotent messaging
  connectors with persisted jobs, retries, and Admin controls.
- [ ] Bulk imports and transaction, reward, and ledger report exports.

### Phase 3: docs portal parity with Open WebUI

- [x] Add a docs entrypoint and API endpoint guide.
- [x] Add an API and documentation gap analysis.
- [ ] Add error catalog with retry and corrective-action guidance.
- [ ] Add guides for checkout integration, refunds/voids, offline queues,
  duplicate checks, program configuration, and webhook operations.
- [ ] Add troubleshooting, security, roadmap, changelog, and machine-readable
  docs files.

## North star

A developer with no prior LIP knowledge can complete an enroll, evaluate, earn,
reserve, capture, reverse, and refund lifecycle in a sandbox without reading the
normative specification.

## Success measures

- First successful request in less than 5 minutes from a clean machine.
- Complete sandbox lifecycle in less than 30 minutes.
- One command starts a seeded, stateful local environment.
- One command validates a payload and explains every failure with a JSON path.
- One command tests a provider and produces an actionable conformance report.
- Every documented example runs in CI against the current protocol version.
- SDK users never manually create request ids, timestamps, version fields, or
  retry metadata.
- Every stable error code has a searchable explanation and corrective action.

## Current foundation

- [x] Normative core and `foodservice/1.0` profile
- [x] JSON Schema Draft 2020-12 contract
- [x] OpenAPI 3.1 HTTP contract
- [x] TypeScript runtime validation
- [x] Deterministic stateful reference engine
- [x] Authenticated reference HTTP server
- [x] Unit, integration, and black-box conformance tests
- [x] CI and package dry-run verification
- [x] Portable program, tier, reward, account, and ledger read models
- [x] Versioned engine snapshots and durable SQLite state
- [x] Seeded reference platform with an authenticated Admin application

## Milestone 1: five-minute local success

Goal: install one CLI and complete the first transaction without reading the
specification.

- [ ] Publish `@loyalty-interchange/cli` to expose the short `lip` command externally
- [x] `lip quickstart` starts the stateful reference environment
- [x] `lip mock` starts the server with configurable host, port, and API key
- [x] `lip validate <file> --schema <name>` validates local JSON
- [x] `lip doctor <url>` checks discovery, health, authentication, and capabilities
- [x] `lip test <url>` runs baseline HTTP conformance and returns a nonzero exit on failure
- [x] `lip init [directory]` creates a minimal `lip.config.json` without overwriting work
- [x] `/.well-known/lip` advertises protocol discovery
- [x] `/lip/v1/capabilities` advertises negotiated operations and limits
- [x] Dockerfile and Compose quickstart
- [x] Executable five-minute guide using the CLI

Exit criteria: a clean clone passes `npm run verify`; `npm run quickstart` serves
health and discovery; all CLI commands have unit or black-box coverage.

## Milestone 2: first-party SDK

Goal: application developers call domain methods rather than construct protocol
envelopes.

- [ ] Publish the idiomatic TypeScript SDK package
- [x] Add public-package metadata, package dry runs, provenance, and trusted
  GitHub Actions publishing in dependency order
- [x] Automatically add versions, request ids, timestamps, and idempotency keys
- [x] Implement bounded retries for safe operations
- [x] Expose typed problem details and stable error classes
- [x] Add order and modifier builders with exact-money helpers
- [x] Add webhook signature verification
- [x] Add a runnable TypeScript example covering every lifecycle operation
- [x] Generate a low-level client from OpenAPI and wrap it with the hand-written SDK

Exit criteria: the complete lifecycle is fewer than 50 lines of application code
and contains no manually constructed protocol context.

## Milestone 2.5: restaurant account experience

Goal: replace the common vendor-specific reads needed for a restaurant loyalty
home screen without weakening the transaction core.

- [x] Program metadata and account-unit catalog
- [x] Tier ladder, benefits, thresholds, and progress
- [x] Discount and food-item reward catalog with funding attribution
- [x] Member balances, provider-defined metrics, and expiring balance buckets
- [x] Filtered, cursor-based immutable ledger history
- [x] Reference engine, HTTP routes, generated client, idiomatic SDK, and conformance tests
- [x] Punchh compatibility boundary and migration notes
- [x] Issued reward wallet with issue, cancel, and redemption artifacts
- [ ] Referral artifacts and missed-purchase claim workflow
- [ ] Versioned authentication, engagement, and ordering-platform adapter profiles

Exit criteria: one portable response set can render program, tier, balance,
reward, and history views for a multi-tier foodservice program.

## Milestone 2.6: earning and tier policy

Goal: express and execute the earning and qualification rules required by
multi-tier restaurant programs without relying on vendor-specific campaigns.

- [x] Base earn rate and after-transaction rounding
- [x] Minimum eligible spend and eligible order channels
- [x] Product, category, tag, line-kind, and explicit line exclusions
- [x] Annual tier qualification period with IANA time-zone reset
- [x] Qualification reset independent from spendable points
- [x] Tier earning multipliers applied to evaluation and accrual
- [x] Refunds use the multiplier recorded on the original accrual
- [x] Generic annual-tier conformance fixture and HTTP/SDK coverage
- [x] Point lots with earned-date expiration and scheduled expiration entries
- [x] FIFO lot consumption and exact-lot restoration on redemption reversal
- [x] Source-linked expiration ledger entries for only the unspent remainder
- [ ] Expiration warning event and delivery profile
- [x] Classified bonus, gift, migration, service-recovery, and correction entries
- [ ] Tier-achievement reward issuance
- [ ] Reward non-stacking policy and daily redemption caps

Exit criteria: a restaurant can configure minimum checks, exclusions, annual
tiers, multiplier-safe refunds, and earned-date point expiration and prove them
with conformance tests.

## Milestone 2.7: reference platform and Admin

Goal: make the protocol tangible as a durable, inspectable local product without
turning implementation-specific operations into normative LIP requirements.

- [x] Versioned engine snapshots protected by a program fingerprint
- [x] Storage contract separated from the reference engine
- [x] SQLite adapter with atomic replacement and WAL mode
- [x] Seeded QSR member, tier, accrual, redemption, and adjustment activity
- [x] Authenticated Admin API outside `/lip/v1`, including CSRF-protected
  program draft, publish, and rollback writes
- [x] Responsive Admin views for health, members, ledger, program, and developer status
- [x] One-command startup with durable state, reset, and seed controls
- [x] Docker volume persistence and package-level storage verification
- [x] Tenant-aware normalized Postgres engine adapter, numbered migrations,
  optimistic revisions, advisory transaction locks, and scheduler leases
- [ ] Move program, campaign, membership, access, and webhook extension stores
  to the asynchronous Postgres state contract
- [x] Scoped Admin users, roles, tenant API keys, and audit log
- [x] Program configuration editor with validation and publish workflow
- [ ] Extension API for adapters, workflows, and custom Admin modules

Exit criteria: `npm run quickstart` starts a seeded, persistent loyalty engine and
Admin application; restart preserves activity; reset is explicit; and all
implementation-specific surfaces remain outside the normative protocol routes.

## Milestone 3: hosted documentation and sandbox

Goal: evaluation requires no local repository setup.

- [ ] Public documentation site with interactive API reference
- [ ] Persistent sandbox credentials and isolated test tenants
- [ ] Browser-based request inspector and ledger viewer
- [ ] Runnable examples in TypeScript, Java, C#, Python, Go, and HTTP
- [ ] Error catalog with causes, retry guidance, and corrective actions
- [ ] Guides for refunds, offline queues, duplicate checks, and franchise funding
- [ ] Public changelog, support policy, and version matrix

Exit criteria: a developer can finish the complete lifecycle from the hosted
guide in less than 30 minutes.

## Milestone 4: restaurant adapter kit

Goal: POS and ordering mappings are repeatable instead of bespoke.

- [ ] Stable adapter interface and mapping-test harness
- [ ] Fixtures for modifiers, combos, split tenders, comps, discounts, taxes, tips,
  offline accrual, duplicate delivery, voids, and partial refunds
- [ ] Mapping guides for Toast, Square, Olo, PAR Brink, NCR Aloha, and Oracle Simphony
- [ ] Migration guidance for Punchh and Paytronix-style programs
- [ ] Adapter certification report generated by `lip test`

Exit criteria: a new adapter proves all required foodservice behavior using the
shared fixture corpus without changing the protocol core.

## Milestone 5: events, security, and production operations

Goal: providers can operate LIP safely at production scale.

- [ ] AsyncAPI contract for all lifecycle events
- [ ] OAuth 2.0 client-credentials profile and operation scopes
- [x] Reference webhook signing, bounded retry, and SQLite outbox restart recovery
- [ ] Normative replay protection, ordering, dead-letter, and operator replay rules
- [ ] Capability and version negotiation policy
- [ ] Rate-limit and retention declarations
- [ ] Trace correlation and observability guidance
- [ ] Automated OpenAPI property and stateful testing
- [ ] Compatibility checks and migration guides on every release

Exit criteria: production implementers have normative security, event delivery,
operational, and upgrade behavior with automated certification.

## Milestone 6: ecosystem and governance

Goal: LIP evolves through interoperable implementations rather than one vendor.

- [ ] Java/Kotlin and C# first-party SDKs
- [ ] Python and Go first-party SDKs
- [ ] Public proposal and compatibility review process
- [ ] Conformance badge and implementation registry
- [ ] Independent provider and adapter implementations
- [ ] Stable `1.0.0` release criteria and long-term support policy

## Product constraints

- Do not add loyalty concepts until an existing implementer demonstrates the need.
- Do not call generated clients first-party SDKs without an idiomatic wrapper.
- Do not require developers to read normative prose for the happy path.
- Do not hide financial mutations behind silent retries.
- Do not claim conformance without a reproducible report.
- Keep the formal name `Loyalty Interchange Protocol`; use `lip` for commands,
  package entry points, configuration, and discovery.
