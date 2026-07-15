# Transaction lifecycle

## Recommended order

```text
lookup or enroll
      |
      v
evaluate order -------> show accrual and rewards
      |
      v
reserve reward -------> hold points, return exact effect
      |
      +---- reverse ---> release hold
      |
      v
capture reward --------> debit points exactly once
      |
      v
post paid-order accrual -> credit points exactly once
      |
      v
adjust order ----------> claw back or add accrual after refund/correction
```

Evaluation is advisory and expires. A POS MUST use the effect returned by the
reservation, not recreate the reward from display text. A provider MAY reject a
reservation when order facts changed after evaluation.

The caller assigns a stable `redemption_id` to each intended redemption. Retrying
that business ID MUST return the existing reservation; changing its member,
reward, or order facts MUST return a conflict. A new attempt after expiration
uses a new `redemption_id`.

## Reservation states

- `reserved` holds available balance until capture, reverse, or expiration.
- `captured` has posted the reward cost to the ledger.
- `reversed` is terminal; captured points were returned if necessary.
- `expired` is terminal and did not change posted balance.

Capture and reverse are individually idempotent. Capturing a reversed or expired
reservation is invalid. Reversing an already reversed reservation succeeds
without another ledger entry.

## Accrual and adjustment

Accrual is posted only for a paid order in the foodservice profile. A provider
MUST prevent the same order from earning twice even when retry metadata changes.

Refunds and voids are new adjustments. `eligible_spend_delta` is signed from the
original order's perspective: refunds are negative and post a negative accrual
adjustment. A provider MAY allow a negative points balance; hiding a clawback is
not conformant.

## Manual adjustment

An operator MAY post a classified manual points credit or debit independently
of an order. The request MUST include a stable `adjustment_id`, nonzero signed
`amount`, classification, human-readable reason, and an explicit
`qualifies_for_tier` decision.

Supported classifications are `bonus`, `gift`, `migration`,
`service_recovery`, and `correction`. Positive credits MAY carry an explicit
future `expires_at`; otherwise the program's normal point-expiration policy
applies. Debits MUST NOT include `expires_at`.

Repeating an `adjustment_id` with identical facts returns the original ledger
entry. Reusing it with different facts is a conflict. A provider MUST NOT count
a manual entry toward qualification unless `qualifies_for_tier` is true.

## Issued reward wallet

A provider MAY issue a catalog reward directly to a member. An issued reward
has a stable `issued_reward_id` and moves through `issued`, `redeemed`,
`cancelled`, or `expired`. Optional code and QR-code artifacts MUST be unique
within the provider's program and MUST be treated as bearer credentials.

Supplying `issued_reward_id` while reserving claims that member-specific reward
without spending points. The issued reward, member, and catalog reward MUST
match, and only one active reservation may hold it. Capture marks it redeemed;
reversing a captured reservation restores it to issued. Cancellation is allowed
only before redemption and while no active reservation holds the reward.
