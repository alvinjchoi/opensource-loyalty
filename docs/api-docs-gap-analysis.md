# API and documentation gap analysis

Compared on July 15, 2026 against:

- OpenLoyalty API docs: `https://apidocs.openloyalty.io/`
- OpenLoyalty API product page:
  `https://www.openloyalty.io/technology/loyalty-program-api`
- Open WebUI docs: `https://docs.openwebui.com/`
- Open WebUI reference docs: `https://docs.openwebui.com/reference/`
- Open WebUI API endpoints guide:
  `https://docs.openwebui.com/reference/api-endpoints/`

## Short answer

We are missing a full product-platform API surface and a real developer portal.
The current LIP repo has a strong transaction protocol, reference server,
conformance path, SDK, foodservice order model, and local dashboard. It does
not yet expose the broad admin, campaign, segmentation, analytics, import,
export, audit, ACL, webhook-subscription, gamification, or program-management
surface that OpenLoyalty documents.

That is not automatically a flaw. OpenLoyalty is a loyalty platform product.
LIP is an interoperability protocol plus a reference platform. We should not
copy every OpenLoyalty category into protocol core. We should add the product
APIs that make the reference dashboard credible, and keep optional loyalty
mechanics in explicit modules or profiles.

## Current API surface

The checked-in LIP OpenAPI document currently exposes 14 operations across 8
tags:

| Tag | Operations |
| --- | ---: |
| Discovery | 3 |
| Programs | 1 |
| Accounts | 1 |
| Ledger | 1 |
| Members | 2 |
| Orders | 2 |
| Accruals | 1 |
| Redemptions | 3 |

OpenLoyalty's public OpenAPI document exposes a much broader platform surface:

| OpenLoyalty tag | Operation count |
| --- | ---: |
| Member | 37 |
| Reward | 21 |
| Tier | 18 |
| Campaign | 16 |
| Admin | 14 |
| Points | 11 |
| Audit | 9 |
| Group Of Values | 9 |
| Language | 9 |
| Segment | 9 |
| Achievement | 8 |
| Badge | 8 |
| Custom Event | 8 |
| ACL | 7 |
| Transactions | 7 |
| Webhook subscription | 7 |
| Analytics | 6 |
| Settings | 6 |
| Wallet | 6 |
| Authorization | 5 |
| Channels | 5 |
| Reward category | 5 |
| Custom Field Schema | 4 |
| Export | 4 |
| Store | 4 |
| Bulk Action | 3 |
| Data Analytics | 3 |
| Import | 3 |
| HealthCheck | 2 |
| Billable Report | 1 |

## What OpenLoyalty has that we do not

| Area | Missing in LIP today | Where it should live |
| --- | --- | --- |
| Program configuration | Create/update programs, earning rules, tier rules, point expiration, reward catalogs, settings, draft/publish workflow. | Reference platform Admin API first; normative protocol only after interoperability requirements are proven. |
| Program types | Points and tiers, visit or stamp cards, wallet credit, paid membership, hybrid programs as first-class configuration templates. | Admin product module plus typed config schemas. |
| Campaigns | Campaign CRUD, eligibility windows, targeting, stacking, caps, triggers, and marketer-controlled rules. | Optional platform module, not LIP core. |
| Segments | Segment CRUD, dynamic audiences, import-backed lists, member targeting. | Optional platform module; protocol may reference segment ids only when needed. |
| Member CRM | Profile updates, deletion, preferences, consents, identifiers, merge/split, status, custom fields. | Platform member API; protocol should keep portable identity resolution narrow. |
| Points operations | Manual adjustments, transfers, expiration jobs, classifications, bonus/gift/migration entries. | Account and ledger module; some entries are already planned in `PLAN.md`. |
| Wallets | Multi-wallet accounts, stored value, unit conversion, wallet credit lifecycle. | Optional account module; wallet credit is important for restaurant commerce. |
| Rewards | Reward CRUD, categories, issued reward wallet, coupons, activation, cancel/reissue, external artifacts. | Platform API and future account-experience expansion. |
| Tiers | Tier CRUD, qualification policies, achievement rewards, downgrade rules, benefit management. | Platform configuration API; protocol reads tier progress today. |
| Referrals | Referral codes, advocates, referee lifecycle, missed purchase claims. | Optional growth module. |
| Gamification | Achievements, badges, challenges, leaderboards, games of chance. | Optional module; avoid making this core protocol. |
| Transactions and events | Generic transaction/event ingestion beyond restaurant orders. | Future profiles or adapter kit. |
| Webhook management | Subscription CRUD, event filters, retry policies, delivery logs, secrets rotation. | Production operations API; protocol already defines payload and signing. |
| Import/export | Bulk member, transaction, reward, and segment import/export; batch file formats. | Platform operations module. |
| Analytics | Loyalty KPIs, cohort reporting, liability reports, campaign reporting, billable reports. | Platform analytics module. |
| Admin, ACL, audit | Admin users, roles, permissions, audit log, authorization endpoints. | Hosted platform requirement before production Admin writes. |
| Localization | Language, translated reward/program content, locale-specific copy. | Platform content module. |
| Stores/channels | Store/location/channel management APIs independent of order payloads. | Platform configuration module. |
| Enterprise operations | Compliance docs, rate limits, retention, monitoring, uptime posture, security certifications. | Docs and production operations; do not claim certifications we do not have. |

## What LIP already does well

- Foodservice-specific order semantics: modifiers, channels, tenders, totals,
  franchise scope, business date, paid/open/refund states.
- Transaction safety: idempotency keys, explicit reserve/capture/reverse
  lifecycle, refund adjustments, and retry metadata.
- Portable account reads: balances, tier progress, expiring lots, program
  catalog, reward candidates, and ledger history.
- Local developer experience: one-command quickstart, seeded SQLite state,
  Admin dashboard, CLI doctor/test/validate commands, and conformance tests.
- SDK ergonomics: request context creation, schema validation, safe retries for
  reads, typed errors, exact-money helpers, order builder, and webhook
  verification.

## Open WebUI docs patterns to copy

Open WebUI's docs work because they are organized as a product portal, not only
an API reference. The patterns worth copying are:

- A home page with the product promise, quick start commands, and "running,
  read this next" links.
- A Getting Started path that tells a new user exactly what to do after first
  startup.
- A Reference section that acts as the canonical technical map for configuration,
  API endpoints, API keys, reverse proxy setup, monitoring, network diagrams,
  database schema, and production operation.
- An API endpoints guide with authentication, Swagger docs location, notable
  endpoints, curl examples, SDK-compatible flows, and caveats.
- Clear docs buckets for Features, Ecosystem, Troubleshooting, Enterprise,
  Tutorials, FAQ, Roadmap, Security, Contributing, License, Mission, and Team.
- Machine-readable docs support such as `llms.txt`, `llms-full.txt`,
  `agents.txt`, and search endpoints.

## Docs we should write next

| Priority | Doc | Why |
| --- | --- | --- |
| P0 | Docs home | Gives the repo one canonical starting point. Added in this pass. |
| P0 | API endpoints | Makes the current OpenAPI consumable without opening raw YAML. Added in this pass. |
| P0 | Error catalog | Developers need stable error codes, causes, retry guidance, and fixes. |
| P0 | Add loyalty to a checkout | The core product flow should be a narrative guide, not only SDK code. |
| P0 | Program configuration | The dashboard now needs to explain points, visits, wallet credit, paid membership, and hybrid programs. |
| P1 | Admin API boundary | Separate protocol API, reference Admin API, and future hosted platform API. |
| P1 | Webhook operations | Subscription management, retries, delivery logs, secret rotation, and dead-letter handling. |
| P1 | Security and production | Auth profile, scopes, rate limits, retention, audit, tenant isolation, and deployment model. |
| P1 | Troubleshooting | Common setup, auth, validation, SQLite, port, and browser issues. |
| P1 | Roadmap | Publicly explain what belongs in LIP core vs optional modules. |
| P2 | Import/export | Batch member and transaction movement. |
| P2 | Analytics | Liability, activity, cohort, campaign, and program-health reports. |
| P2 | Adapter guides | Toast, Square, Olo, PAR Brink, NCR Aloha, Oracle Simphony, Punchh, Paytronix. |
| P2 | Machine-readable docs | `llms.txt`, `llms-full.txt`, `agents.txt`, and generated endpoint index. |

## Product backlog implied by the comparison

The dashboard should feel like a real operator surface. The next API work should
support that directly:

1. Program configuration model
   - Templates for points and tiers, visits/stamps, wallet credit, paid
     membership, and hybrid programs.
   - Versioned draft, validate, preview, publish, and rollback operations.
   - Explicit policy schemas for earning, expiration, tier qualification,
     redemption caps, reward stacking, and funding.

2. Reward and wallet management
   - Reward CRUD, categories, issued reward wallet, cancel/reissue, coupon or
     external-artifact metadata.
   - Wallet credit units, liability classification, expiration, and adjustment
     reasons.

3. Operator administration
   - Scoped users, roles, permissions, audit log, tenant/location scoping, and
     CSRF-safe write endpoints.
   - Real dashboard data instead of seeded demo labels.

4. Webhook subscriptions and delivery logs
   - Subscription CRUD, event filters, signing-secret rotation, retry policy,
     delivery status, and replay tooling.

5. Analytics and exports
   - Program health, member activity, liability, redemption rate, tier movement,
     and CSV/S3 export contracts.

## Decision guardrails

- Do not make LIP an OpenLoyalty clone. Keep the protocol boundary focused on
  portable loyalty interoperability.
- Do not document program writes as available until the server has real
  validation and persistence for them.
- Do not put campaign builder, gamification, ACL, analytics, or localization
  into core unless multiple implementers need interoperable behavior.
- Do make the reference platform credible: program configuration, Admin writes,
  audit logs, and production boundaries need to exist outside `/lip/v1`.
- Do make the docs portal product-grade before public evaluation: quickstart,
  endpoint guide, lifecycle guide, error catalog, security, troubleshooting,
  roadmap, changelog, and machine-readable docs.
