# Changelog

## 0.1.1 - 2026-07-18

- Fix idempotent replay: a retry that reuses the idempotency key with a
  regenerated `request_id`/`occurred_at` now returns the original result
  (echoing the retry's `request_id`) instead of a false `409` or an SDK
  validation error. Entries stored before this release still match a pinned
  replay (dual-check).

## 0.1.0 - 2026-07-18

- Initial LIP core and foodservice profile.
- TypeScript schema package and deterministic reference engine.
- HTTP reference server and conformance suite.
- Program, tier, reward, account-summary, and cursor-based ledger read models.
- Generated and idiomatic TypeScript clients for the account experience operations.
- Configurable earning policies for minimum spend, channels, exclusions, and rounding.
- Annual tier qualification windows, tier multipliers, and original-rate refund attribution.
- Earned-date point lots with FIFO consumption, reversal restoration, expiring
  balance buckets, and source-linked expiration ledger entries.
- Versioned reference-engine snapshots with program-fingerprint validation.
- Pluggable state-store contract and a durable SQLite implementation.
- Seeded foodservice reference platform with restart-safe local and Docker state.
- Authenticated read-only Admin API and responsive Admin application for program,
  member, tier, expiration, ledger, and developer inspection.
