# Foodservice profile 1.0

The foodservice profile targets QSR, fast casual, coffee, restaurant, ghost
kitchen, convenience foodservice, and franchise operations.

## Scope and ownership

Every order MUST carry `program_id`, `brand_id`, `merchant_id`, and `location_id`.
Franchised locations MUST also carry `franchisee_id`. These are separate because
the guest-facing brand, merchant of record, operating location, franchise owner,
and loyalty program owner are frequently different legal or technical parties.

Providers MUST preserve these identifiers on financial and settlement records.

## Lines and modifiers

Each sellable item, modifier, or fee has a stable `line_id`. A modifier SHOULD
reference its parent item with `parent_line_id`; it remains a separate line so
eligibility and discount allocation are unambiguous.

For every line, `subtotal.amount` MUST equal `unit_price.amount * quantity`.
Discount and tax are represented separately. All `line_id` values within an
order MUST be unique, and a parent reference MUST resolve to another line.
Sale prices, subtotals, discounts, taxes, tips, service charges, totals, and
tenders MUST NOT be negative. Signed values belong in order adjustments.

## Order totals

The order MUST reconcile exactly:

```text
subtotal - discount + tax + tip + service_charge = total
```

For a paid order with tenders, tender amounts MUST sum to `total`. Loyalty reward
discounts reduce the order discount or line discount; points are not money and
MUST NOT appear as a monetary tender unless the program explicitly represents a
stored-value credit.

Line subtotal, discount, and tax allocations MUST sum to their corresponding
order totals. This makes item-level refunds and franchise settlement reproducible.

## Eligible spend

The reference profile excludes lines where `loyalty_eligible` is `false` and
uses line subtotal less line discount. Taxes, tips, and service charges do not
earn by default. Programs MAY use different rules, but evaluation and posting
MUST produce the same result for unchanged order facts.

## Offline and retries

Restaurant networks are intermittently connected. A POS MAY queue accrual and
adjustment requests, retaining the original `occurred_at`, business date,
business identifier, and idempotency key. Implementations SHOULD accept delayed
requests within a declared retention window and MUST process out-of-order
reversal or adjustment attempts deterministically.

## Franchise funding

A reward's funding shares MUST state whether the brand, franchisee, location,
merchant, or partner bears the cost. A provider SHOULD emit settlement records
that retain the reservation, order, location, franchisee, amount, currency, and
share basis points used at transaction time.

Changing funding configuration later MUST NOT rewrite historical reservations.

## Minimum conformance

A conformant foodservice provider MUST support member lookup, member enrollment,
order evaluation, accrual posting, redemption reserve/capture/reverse, order
adjustment, idempotency conflict detection, exact money reconciliation, and
franchise funding shares. Optional custom reward effects require bilateral
negotiation.
