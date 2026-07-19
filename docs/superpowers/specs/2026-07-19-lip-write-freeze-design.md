# LIP-side write-freeze / maintenance flag: design (issue #6)

Nice-to-have from the cutover checklist; the BFF-side freeze remains the
primary mechanism. This adds an independent LIP-server-side switch.

## Problem

During a cutover window an operator must stop loyalty mutations. Today that is
only enforceable at the BFF (or by scaling it down). The LIP server has no
switch to refuse protocol writes while keeping reads available, so a
data-plane-level freeze — independent of BFF behavior — isn't possible.

## Decision

Add an in-memory write-freeze flag on the reference server, settable **both** at
startup (option / `LIP_WRITE_FREEZE` env) and at runtime via an admin-only
endpoint. When frozen, every `/lip/v1` **write** returns a stable RFC 9457
`503` so BFF retries back off; reads stay available for canary verification.

## Design

### 1. Freeze state

An in-memory mutable flag on the running server, initialized from
`ServerOptions.writeFrozen` (default `false`). In-memory only: a restart
re-reads the startup option/env (documented). No new persistence store.

### 2. Freeze guard (`packages/server/src/server.ts`)

In the `/lip/v1` dispatch, immediately after the authorization check
(server.ts:1578-1582) and before reading/validating the body, add:

```ts
if (isWriteFrozen() && protocolPermission(path) === "protocol:write") {
  response.setHeader("retry-after", "30");
  sendJson(
    response,
    503,
    problem(503, "Write operations are temporarily frozen", "write_frozen",
      "The provider is in a maintenance window; retry after it closes"),
    "application/problem+json"
  );
  return;
}
```

- Uses the existing `protocolPermission(path)` split, so it freezes every
  mutating write (enroll, accrual, order adjust, reserve, capture, reverse,
  manual adjustments, issued-reward issue/cancel) **and** `orders/evaluate`
  (classified as a write; it is a non-mutating preview, but freezing it during
  a maintenance window is harmless and keeps the boundary aligned with the
  existing permission classification — a deliberate choice).
- Reads (`accounts/get`, `ledger/list`, `programs/get`, `members/lookup`,
  `issued-rewards/list`, `capabilities`) pass through, as do `/.well-known/lip`
  and `/health` (not under `/lip/v1`).
- `code: "write_frozen"` is the stable problem type; `Retry-After: 30` lets
  clients back off. Placed after auth so only authenticated callers see it.

### 3. Runtime admin toggle

- `POST /admin/api/v1/maintenance` `{ write_frozen: boolean }` — requires
  `admin:write` and CSRF, following the exact pattern of the other admin write
  routes (e.g. `members/cancel`). Sets the flag, records an audit entry
  (`maintenance.write_freeze.changed`), returns `{ write_frozen }`.
- `GET /admin/api/v1/maintenance` — requires `admin:read`; returns
  `{ write_frozen }` for status/canary polling.
- Register both in the admin route table and `allowedMethods`.

### 4. Health reflects the flag

Add `write_frozen: <boolean>` to the `GET /health` response so operators and
canary checks can observe the state without auth-scoped calls. (Health is
outside `/lip/v1` and always available.)

### 5. CLI + config

- `ServerOptions.writeFrozen?: boolean` threaded from the CLI.
- `lip serve --write-freeze` flag and `LIP_WRITE_FREEZE` env (truthy →
  `writeFrozen: true`) in the serve/mock command wiring (`packages/cli/src/mock.ts`
  / `cli.ts`). Mirror how existing boolean env flags are read.

### 6. Docs

`docs/reference-platform.md` (or the operations/webhook-delivery area): document
the maintenance flag — the startup option/env, the admin endpoints, the `503
write_frozen` problem shape + `Retry-After`, that reads stay up, and that health
reflects the state. Vendor-neutral.

## Testing

- Frozen server: `POST /lip/v1/members/enroll` → `503` with
  `application/problem+json`, `code: "write_frozen"`, and a `Retry-After`
  header; `POST /lip/v1/programs/get` (a read) → `200`.
- Startup `writeFrozen: true` freezes from boot; default is unfrozen.
- Runtime toggle: with `write_frozen:false`, an enroll succeeds; `POST
  /admin/api/v1/maintenance {write_frozen:true}` then the same enroll → `503`;
  toggle back to `false` → enroll succeeds again. `GET .../maintenance` reflects
  the current value.
- Auth: `POST .../maintenance` without `admin:write` (a read-only key / no CSRF)
  → `401`/`403`, and does not change the flag.
- `GET /health` includes `write_frozen` matching the current state.

## Acceptance criteria

- An operator can freeze/unfreeze LIP writes at startup and at runtime,
  independent of the BFF.
- Frozen writes return a stable `503 write_frozen` RFC 9457 problem with
  `Retry-After`; reads and health stay available.
- `npm run verify` green with the new tests.

## Out of scope (follow-ups)

- Persisting the flag across restarts in SQLite (in-memory only; env re-asserts).
- Exposing/toggling the flag per-environment through the Cloud control plane.
- Freezing admin/`/cloud` operations (this is scoped to `/lip/v1` protocol writes).
