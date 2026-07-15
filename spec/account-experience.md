# Program and account read model

Status: working draft `0.1.0`.

LIP separates program configuration, current member state, and immutable ledger
history so clients do not have to reconstruct a loyalty experience from
transaction responses.

## Program catalog

`program.get` returns the portable definitions needed to render a loyalty
experience: account units, named metrics, tier thresholds and benefits, and
reward costs, effects, and funding. Providers MUST return stable identifiers.
Display names and descriptions MAY change without changing those identifiers.

The catalog's `earning` policy declares the base rate, minimum eligible spend,
eligible order channels, rounding point, and line exclusions. Providers MUST
apply exclusions before testing the minimum spend. A line marked
`loyalty_eligible: false` is always excluded. Product, category, tag, and line
kind exclusions are additive: matching any configured exclusion makes the line
ineligible. Orders from other channels earn zero without invalidating the order.

`after_transaction` rounding applies once to total eligible spend after the
tier multiplier. Providers MUST NOT round each line independently.

Each tier belongs to one qualification metric. A tier ladder MUST begin at zero
and its thresholds MUST be unique. When present, `earn_multiplier_bps` uses
10,000 as 1x; providers MUST apply that rate consistently to evaluation,
accrual, and later order adjustments.
Program catalogs describe reward eligibility mechanics, but they do not issue a
member-specific reward or reserve inventory.

When `tier_policy` is present, its qualification metric is evaluated in the
declared annual period and IANA time zone. Entries before `effective_from` do
not qualify. Starting a new period resets that metric and tier progress, but
MUST NOT change posted spendable balances. Refund adjustments MUST use the
earning multiplier recorded for the original accrual, not the member's current
tier multiplier.

When `point_expiration` is present, each positive earning or adjustment creates
a point lot whose `expires_at` is the configured number of calendar days after
the entry occurred. A ledger entry that creates a lot MUST expose that date.
Redemptions and negative adjustments MUST consume the earliest-expiring lots
first. Reversing a redemption MUST restore the exact lots it consumed, including
their original expiration dates.

At or after a lot's expiration instant, a provider MUST post one immutable
`expiration` ledger entry for its unspent remainder. That entry MUST identify
the source earning entry through `related_entry_id`. Spent points MUST NOT be
expired. Restored points whose original expiration has already passed MUST be
expired immediately. `warning_days` declares dates at which an implementation
may notify a member; notification transport and delivery are outside this
version of the protocol.

## Member account

`account.get` returns one consistent snapshot containing the member, posted and
reserved balances, provider-defined metrics, expiring balance buckets, and
tier progress. Metrics are named counters such as lifetime points, qualifying
points, visits, or stamps. Their derivation is owned by the provider and MUST
remain stable for the lifetime of a `metric_id`.

`progress_bps` measures progress from the current tier threshold to the next
tier threshold. It is 10,000 at the top tier. `remaining_to_next` and
`next_tier_id` MUST either both be present or both be absent.

Expiring balances group the unspent point lots by `expires_at`. They are future
deductions already scheduled by provider rules and do not change
`Balance.amount` until an expiration ledger entry is posted.

## Ledger history

`ledger.list` returns immutable entries newest first. `occurred_from` and
`occurred_until` are inclusive. A client MAY filter by account and operation.
The default page size is provider-defined and the HTTP contract caps a requested
page at 100 entries.

`expires_at` describes the point lot created by a positive entry and does not
make the entry temporary. `related_entry_id` links a derived entry such as an
expiration to its source without changing either entry.

`next_cursor` is opaque and bound to the original filters. Clients MUST send it
unchanged and MUST NOT parse, modify, or persist it as an entry identifier. A
provider MUST reject malformed cursors and cursors reused with different
filters.

These read operations are safe to retry. They still carry normal request
context so retries can return one correlated snapshot.
