# LIP Core 1.0

Status: working draft `0.1.0`.

## Scope

LIP standardizes the loyalty transaction boundary. An order-owning system sends
portable facts; a loyalty-owning system returns decisions and records changes.
The protocol does not standardize campaign authoring, customer segmentation,
message delivery, or the internal representation of loyalty rules.

## Requests

Every request MUST include a `context` containing protocol and profile versions,
a request identifier, an idempotency key, event time, and source system.

For one source system and operation, repeating the same idempotency key with the
same logical request MUST return the original result and MUST NOT repeat side
effects. Reusing that key with a different request MUST return a conflict. A
provider MUST also protect business identifiers such as `order_id`,
`adjustment_id`, `redemption_id`, and `reservation_id` from duplicate financial effects when a
caller mistakenly changes the idempotency key.

Consumers MUST treat identifiers as opaque case-sensitive strings.

## Discovery and capabilities

A provider MUST expose `GET /.well-known/lip` without authentication. The
document identifies the supported protocol/profile versions, API base path,
capabilities path, health path, and authentication scheme.

A provider MUST expose authenticated `GET /lip/v1/capabilities`. Clients SHOULD
use it to verify supported operations, reward effects, event types, payload
limits, and reservation lifetime instead of relying on out-of-band assumptions.

## Money and quantities

`Money.amount` is a signed integer in the ISO 4217 currency's minor unit. For
example, USD 12.34 is `{ "amount": 1234, "currency": "USD" }`. Binary floating
point MUST NOT be used on the wire. All monetary values in one order MUST use the
same currency.

Foodservice line quantity is a positive integer. A weighted-item extension may
be added by a future profile without changing money semantics.

## Identity and privacy

The transaction API uses `member_id` and privacy-preserving identity references.
Raw email addresses and phone numbers SHOULD NOT cross the loyalty transaction
boundary. Hash identifiers only when the parties share a documented
normalization and keyed-hash procedure; an opaque token is preferred.

Identity references MUST NOT be placed in logs, URLs, or idempotency keys.

## Balances and ledger

`Balance.amount` is the posted balance. `reserved` is the amount held by active
reservations, and `available` is `amount - reserved`. A reservation does not
change the posted balance. Capture posts a negative redemption ledger entry;
reversing a captured redemption posts an equal positive entry.

Ledger entries are immutable. Corrections MUST be represented as additional
entries rather than mutation or deletion.

Program catalogs, account snapshots, tier progress, and ledger query semantics
are defined in `account-experience.md`.

## Funding

Every reward candidate and reservation MUST identify funding shares. Shares are
integer basis points and MUST total exactly 10,000. The shares assign economic
responsibility; they do not imply that settlement happened synchronously.

When a reward has a monetary value, each reservation SHOULD include exact funded
`amount` values. Implementations allocate minor units with the largest-remainder
method. Remaining units go to the largest fractional remainders; ties sort by
`party_type`, then `party_id`. Exact funding amounts MUST sum to the reward value.

## Errors

The HTTP binding uses `application/problem+json` as defined by RFC 9457. Clients
MUST branch on HTTP status and stable `code`; they MUST NOT parse human-readable
`detail` strings.

Transport failures use dedicated codes distinct from domain codes:
`invalid_json` (400), `unauthorized` (401), `not_found` (404),
`method_not_allowed` (405), `payload_too_large` (413), and
`unsupported_media_type` (415). Servers MUST respond `405` with an `Allow`
header when a known path receives an unsupported HTTP method.

## Events

Lifecycle events use the CloudEvents 1.0 structured JSON format. Event consumers
MUST deduplicate on CloudEvent `source` plus `id` and MUST ignore unknown event
types they have not negotiated.

## Compatibility

Additive optional fields and new operations may be introduced in minor releases.
Payloads are strict within a negotiated schema version; private extensions belong
in `metadata`, not as unknown object properties. Required-field or semantic
changes require a new major protocol or profile version.
