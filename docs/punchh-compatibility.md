# Punchh compatibility notes

This document tracks capabilities observed in a restaurant ordering integration
and maps them to vendor-neutral LIP contracts. It is an implementation guide,
not a claim that Punchh implements or endorses LIP.

## Covered by the current protocol

| Restaurant loyalty need | LIP operation |
| --- | --- |
| Program name, currency, tiers, benefits, and reward catalog | `program.get` |
| Base rate, minimum check, eligible channels, exclusions, and after-check rounding | `program.get` earning policy |
| Posted, reserved, and available points | `account.get` |
| Lifetime and tier-qualifying counters | `account.get` metrics |
| Current tier, next tier, and progress | `account.get` tier progress |
| Annual qualification windows, time-zone reset, and tier earn multipliers | Tier policy and reference engine |
| Earned-date point expiration, FIFO consumption, and linked expiration entries | Point-expiration policy and reference engine |
| Accrual, redemption, reversal, adjustment, and expiry history | `ledger.list` |
| Order qualification and available rewards | `order.evaluate` |
| Earn, reserve, capture, reverse, and refund | Existing transaction operations |
| Brand and franchisee reward funding | Reward and reservation funding shares |

The catalog supports both amount discounts and foodservice item/category
rewards. The reference fixture exercises a three-tier ladder, discount and free
item rewards, qualification counters, and cursor-based history.
The reference engine also enforces earning policies, calculates tier multipliers
after total eligible spend, preserves the original multiplier for refunds, and
resets annual qualification independently from spendable points. It maintains
earned-date point lots, consumes the earliest-expiring lots first, restores the
same lots on redemption reversal, and expires only each lot's unspent remainder.

## Still requiring profiles or adapters

- Member authentication and profile lifecycle: OTP, social sign-in, refresh,
  logout, device limits, profile update, and deletion.
- Engagement: push-token sync and marketing consent delivery.
- Issued reward wallets, coupon codes, member QR/barcodes, referrals, and missed
  purchase claims.
- Expiration warning delivery, non-stacking enforcement, daily redemption caps,
  and manual bonus/gift classifications.
- Olo SSO token exchange and Olo-owned basket qualification, apply, and remove
  behavior.

These concerns should not be folded into the financial transaction core without
a demonstrated cross-provider contract. Wallet and claim workflows are the next
loyalty-specific candidates; authentication, engagement, and ordering-platform
behavior should remain versioned profiles or adapters.
