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

## Out of scope (future work)

- **Franchise funding-share math** (spec `foodservice.md` § Franchise funding):
  settlement records splitting reward cost across brand/franchisee/location
  shares are deliberately not attempted here.
- Custom role definitions (PLAN.md keeps that item open).
- Location scoping of protocol (`/lip/v1/*`) writes — protocol callers remain
  tenant-scoped; this phase scopes Admin queries/reporting only.
