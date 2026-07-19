# Idempotent replay: design (issue #9)

Target release: **0.1.1** (patch).

## Problem

Repeating an idempotency key on a retry breaks two ways in the reference
implementation, even though `spec/core.md` promises "repeating the same
idempotency key with the same logical request MUST return the original result."

1. **False conflict from `occurred_at`.** `idempotencyFingerprint`
   ([`packages/reference/src/engine.ts:191`](../../../packages/reference/src/engine.ts))
   strips only `context.request_id` from the request before hashing, so
   `context.occurred_at` (and the rest of the envelope) is part of the
   idempotency fingerprint. The SDK regenerates `occurred_at` on every call
   (`context()` runs `clock()` per call,
   [`packages/sdk/src/client.ts:349`](../../../packages/sdk/src/client.ts)), so a
   caller-level retry with the same idempotency key but a fresh `occurred_at`
   produces a different fingerprint and gets `409 idempotency_conflict` instead
   of the replayed result.

2. **Replay returns the original `request_id`.** When the fingerprint does
   match, `once()` replays the stored response verbatim, whose
   `context.request_id` is the original request's id. The SDK then asserts the
   response `request_id` equals the current request's id
   ([`packages/sdk/src/client.ts:331`](../../../packages/sdk/src/client.ts)) and
   throws `LipValidationError: response request_id does not match the request`.

Root cause is an **underspecified idempotency rule**: `spec/core.md` never
defines which fields make up "the same logical request", and
`ResponseContext.request_id` is described only as an "opaque, stable identifier
within the owning system" with no statement about replay.

## Decisions

1. **Scope: spec + reference impl + SDK.** Clarify the rule normatively, then
   align the engine and SDK. Other implementers get the rule too.
2. **Replay `request_id`: echo the current request.** On idempotent replay the
   provider returns the original result but sets the response
   `context.request_id` to the *replaying* request's id. Replay is transparent
   to any client that correlates response→request, and the SDK's echo check
   stays a real guard (no relaxation).
3. **Migration: dual-check (v1 + v2 fingerprint).** New entries store the
   payload-only fingerprint (v2); lookups match against v2 **or** the legacy v1
   algorithm. Existing entries (e.g. the pilot's stored idempotency rows) keep
   working under their original pinned-replay behavior; no schema or archive
   format change.

## Design

### 1. Engine — `packages/reference/src/engine.ts`

**Fingerprint versions.** Keep the current function as v1 and add v2:

- `idempotencyFingerprintV1(request)` — unchanged current behavior: strip only
  `context.request_id`, hash the rest.
- `idempotencyFingerprintV2(request)` — strip the **entire `context`** envelope
  and hash the remaining business payload. This is the identity of "the same
  logical request": operation + idempotency key (already in the map key) +
  business fields, independent of envelope metadata (`request_id`,
  `occurred_at`, `source.instance`, protocol/profile versions).

**`once()` store.** New entries are stored with the v2 fingerprint.

**`once()` lookup (dual-check).** A prior entry is "the same request" when:

```
prior.fingerprint === idempotencyFingerprintV2(request)
  || prior.fingerprint === idempotencyFingerprintV1(request)
```

Otherwise it is a conflict. This makes new (v2-stored) entries tolerant of a
regenerated envelope, while old (v1-stored) entries still match a pinned replay
(the v1 branch), so upgrading does not break replays of pre-existing rows.

Note: a v1-stored entry can only be matched by a retry that pins `occurred_at`,
because the original `occurred_at` is baked into its stored hash. That is the
existing behavior and is preserved deliberately; only new (v2) entries gain
envelope tolerance.

**Replay `request_id` echo.** On a matching replay, clone the stored response
and overwrite `response.context.request_id` with the current request's
`request_id`; leave `processed_at` as stored (it reflects the original
processing). A small helper applies this to any response carrying a
`context` object. `once()` already receives the current `RequestContext`, so
the current `request_id` is in hand.

### 2. SDK — `packages/sdk/`

**No code change to the core path.** The engine now echoes the current
`request_id`, so the response echo check
([`client.ts:331`](../../../packages/sdk/src/client.ts)) passes, and callers can
already supply a stable `idempotency_key` per logical request.

**Docs.** Add an "idempotent retries" note to the TypeScript SDK guide: reuse
the same `idempotency_key` across attempts; `request_id` and `occurred_at` may
be regenerated freely, and the provider returns the original result. A
first-class replay helper is **out of scope** (YAGNI — the existing
key-reuse pattern already works).

### 3. Spec — `spec/core.md` and OpenAPI `ResponseContext`

Add normative text:

- **Same logical request.** Providers MUST compare requests for idempotency by
  their business payload, excluding the `context` envelope. Envelope fields
  (`request_id`, `occurred_at`, `source`, protocol/profile versions) MUST NOT
  by themselves cause a conflict. Business identifiers (`order_id`,
  `adjustment_id`, `redemption_id`, `reservation_id`) remain separately
  protected.
- **Replay response.** On idempotent replay the provider MUST return the
  original result. The response `context.request_id` MUST reflect the replaying
  request (echo the current `request_id`); `processed_at` reflects the original
  processing.

Update the `ResponseContext.request_id` description in `spec/openapi.yaml`
accordingly (regenerated into the docs-site copy via `npm run generate`).

## Testing

- **Engine** (`tests/unit/engine.test.ts` or nearest):
  - Retry with a fresh `request_id` and `occurred_at`, same idempotency key and
    business payload → returns the original result, no conflict, response
    `request_id` equals the retry's id.
  - Same key, different business payload → `409 idempotency_conflict`.
  - A v1-stored entry replayed with a pinned envelope → still matches
    (dual-check regression guard).
- **SDK** (`tests/unit/sdk.test.ts`): a caller-level retry that reuses the
  idempotency key with a regenerated context → succeeds (echo check passes).
- **Conformance** (optional): a non-destructive idempotent-replay assertion in
  the baseline suite if it fits without new side effects.

## Acceptance criteria

- A retry that reuses the idempotency key but regenerates `request_id` /
  `occurred_at` returns the original result with the retry's `request_id`, on
  both the engine and through the SDK.
- A different business payload under the same key still returns a conflict.
- Pre-existing (v1) idempotency entries still replay under a pinned envelope
  after upgrade.
- `npm run verify` green; spec and docs-site OpenAPI regenerated and in sync.

## Out of scope

- A first-class SDK "replay stored request" helper.
- A `fingerprint_version` field on persisted state / the export archive.
- Changing `processed_at` semantics on replay.

## Release

Ship as **0.1.1**: bump the ten package versions, add a `CHANGELOG.md` entry
and a `docs-site/changelog.mdx` `<Update>` block, and publish through the
existing provenance release workflow.
