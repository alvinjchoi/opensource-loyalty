# Location/franchisee scoping for Admin queries and reporting (PLA-415 phase 2)

Status: implemented on `alvin/pla-415-phase2-location-franchisee-scoping`.

Multi-location brands need per-location reporting, and franchisee operators
need Admin access limited to their own locations. This phase adds three tightly
scoped pieces on top of the phase 1a/1b Admin store architecture.

## Decisions

### 1. Location registry — extension state, no new tables

A per-tenant location registry is a new Admin extension state managed by
`LocationDirectoryService` (`packages/server/src/locations.ts`), persisted via
an injected `AsyncStateStore<LocationDirectoryState>` exactly like the other
Admin services (SQLite demo key `${program_id}:locations`, Postgres tenant row
key `locations` in `lip_platform_state`). Entries are
`{ location_id, name, franchisee_id?, active, created_at, updated_at }` with an
audit trail mirroring `MembershipService`. **No migration 002 is needed**: the
registry rides `lip_platform_state`, and ledger location attribution (below)
rides the existing `lip_engine_ledger.payload` JSONB column.

Admin HTTP surface (same auth/CSRF pattern as segments):

- `GET  /admin/api/v1/locations` — registry snapshot (`admin:read`), filtered
  by the caller's location scope.
- `PUT  /admin/api/v1/locations` — upsert (`admin:write`).
- `POST /admin/api/v1/locations/delete` — remove (`admin:write`); deactivation
  via `active: false` is preferred once a location has history.

### 2. Franchisee-scoped Admin access

`AccessControlService` users **and API keys** gain an optional
`allowed_location_ids?: string[]` (absent = all locations). The phase brief
named users only, but Admin sessions authenticate with API keys (root key or
tenant keys via `/admin/api/v1/session`), so a user-only field would be
unreachable from HTTP; scoping both is the closest workable alternative.
`TenantPrincipal` carries the resolved scope, and
`AccessControlService.locationScopeFor(principal)` returns
`string[] | undefined` (undefined = unrestricted) for reporting and registry
endpoints to enforce. Root principals are never scoped.

### 3. Per-location reporting

`GET /admin/api/v1/reports/locations` (`admin:read`, read-only) aggregates from
`engine.inspectAdmin()` inside `executeEngineOperation` on Postgres.

**Deviation from the brief:** the brief assumed ledger entries already carry
`location_id` via accrual context. They did not — the engine persisted no
location identifier anywhere (`LedgerEntry` had only `order_id`; accrual
records store fingerprints only). The foodservice profile requires providers to
preserve scope identifiers on financial records, so the fix is at the source:
`LedgerEntry` gains an **optional `location_id`** (additive, regenerated JSON
Schemas/OpenAPI/SDK), and `postAccrual` stamps accrual entries with
`order.scope.location_id`. Redemption, reversal, and adjustment entries carry
`order_id`, so the report attributes them through an order → location map built
from accrual entries. Manual adjustments, expirations, and pre-upgrade entries
land in an explicit `unattributed` bucket.

Report shape per location: accrued/redeemed amounts per unit, accrued order
count, ledger entry count, and reservation outcomes (reserved/captured/
reversed), enriched with registry name/franchisee_id; registry locations with
no activity still appear. Callers with a location scope see only their
locations and never the `unattributed` bucket.

## Amendments after review

Code review of the initial implementation produced the following changes, all
shipped on this branch:

1. **Fail-closed admin reads.** `locationScopeFor()` was only consulted by the
   new locations endpoints, so a scoped principal could read the whole tenant
   via `/admin/api/v1/snapshot`, `/analytics`, and `/exports/members`. Any
   admin GET outside a small allowlist of scope-aware paths now returns 403
   `location_scoped_forbidden` for scoped principals; new endpoints are safe
   by default. Location-filtered variants of snapshot/analytics remain
   follow-up work.
2. **Partial updates preserve scope/attribution fields.** Omitting
   `allowed_location_ids` (users) or `franchisee_id` (locations) preserves the
   stored value, mirroring the `active` fallback; explicit `null` clears and
   the clear is audited. Empty arrays still 422. Location audit entries carry
   `active`/`franchisee_id` metadata.
3. **Scope-escape prevention.** A location-scoped principal can only
   create/update users and API keys whose effective scope is a non-empty
   subset of its own, and can only upsert/delete registry locations inside its
   scope (403 otherwise). `allowed_location_ids` arrays containing non-strings
   are rejected with 422 (no silent filtering), and location ids at both
   boundaries are validated against the protocol `Id` schema.
4. **Write-time redemption attribution.** `RedemptionReservation` gains an
   optional `location_id` stamped at reserve from the reserving order's scope;
   capture and reversal ledger entries carry the reservation's location. The
   accrual order→location map survives only as a fallback for pre-upgrade
   entries. *Wire compatibility:* the new optional `location_id` on
   `RedemptionReservation` (and the existing one on `LedgerEntry`) is
   additive, but consumers that validate responses with
   `additionalProperties: false` schemas must regenerate from the updated
   spec.
5. **Report internals.** `locationReport` reads
   `LoyaltyEngine.inspectLedger()` (no per-member metric aggregation),
   reservation outcomes are counted across all four protocol statuses (the
   report and engagement analytics gain `expired`), scoped reports include an
   `unattributed_present` boolean, and the aggregation is written with
   immutable updates.
6. **Wiring.** The CLI mock server and the cloud data-plane provisioner now
   pass the full admin service block (the provisioner previously advertised
   `admin_url` with no admin services at all), and demo seeding registers
   `location-014` in the location directory.
7. **Lock-free report reads (PLA-434).** `GET /admin/api/v1/reports/locations`
   originally ran inside `executeEngineOperation` on Postgres — a full write
   round-trip (advisory lock, state reload, `replaceState()`, full-row
   re-save) for a read-only report, so a polling dashboard periodically
   stalled every tenant write. The Postgres platform now exposes
   `readEngineSnapshot()`: a lock-free `load()` hydrates a throwaway plain
   `LoyaltyEngine` (no emit hook, so reads can never fire webhook events) and
   the report runs against that scratch copy. Nothing is saved and the
   revision does not advance; reads may lag in-flight mutations by one
   revision, and expiry side effects computed during a read stay in the
   scratch copy until the next real write persists them. The demo (SQLite)
   platform keeps reading the live engine directly — it never had the lock
   problem.

## Out of scope (future work)

- **Franchise funding-share math** (spec `foodservice.md` § Franchise funding):
  settlement records splitting reward cost across brand/franchisee/location
  shares are deliberately not attempted here.
- Custom role definitions (PLAN.md keeps that item open).
- Location scoping of protocol (`/lip/v1/*`) writes — protocol callers remain
  tenant-scoped; this phase scopes Admin queries/reporting only.
