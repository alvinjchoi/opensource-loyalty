import { describe, expect, it } from "vitest";
import { LoyaltyEngine, EngineError } from "@loyalty-interchange/reference";
import {
  MutableClock,
  makeContext,
  makeAnnualTierProgram,
  makeEnroll,
  makeOrder,
  makeProgram,
  sequentialIds
} from "../fixtures.js";

function makeAnnualTierOrder(amount: number, orderId: string) {
  const order = makeOrder({
    order_id: orderId,
    member_id: "annual-tier-member",
    channel: "counter",
    scope: {
      ...makeOrder().scope,
      program_id: "annual-tier-foodservice"
    }
  });
  order.lines[0]!.unit_price.amount = amount - 100;
  order.lines[0]!.subtotal.amount = amount - 100;
  order.totals.subtotal.amount = amount;
  order.totals.total.amount = amount + 88;
  order.tenders![0]!.amount.amount = amount + 88;
  return order;
}

function makeEngine(clock = new MutableClock()): LoyaltyEngine {
  return new LoyaltyEngine(makeProgram(), { clock, ids: sequentialIds() });
}

function enrolledEngine(clock = new MutableClock()): LoyaltyEngine {
  const engine = makeEngine(clock);
  engine.enroll(makeEnroll());
  return engine;
}

function accrue(engine: LoyaltyEngine, key = "accrual-key-001") {
  return engine.postAccrual({
    context: makeContext(key),
    member_id: "member-001",
    order: makeOrder()
  });
}

function reserve(engine: LoyaltyEngine, key = "reserve-key-001") {
  return engine.reserve({
    context: makeContext(key),
    redemption_id: "redemption-001",
    member_id: "member-001",
    reward_id: "one-dollar-off",
    order: makeOrder({ order_id: "order-redemption" })
  });
}

describe("LoyaltyEngine members and evaluation", () => {
  it("hydrates a complete snapshot without losing idempotency or point-lot state", () => {
    const clock = new MutableClock();
    const engine = enrolledEngine(clock);
    const request = {
      context: makeContext("persistent-accrual-key"),
      member_id: "member-001",
      order: makeOrder({ order_id: "persistent-order" })
    };
    const accrued = engine.postAccrual(request);
    const restored = new LoyaltyEngine(makeProgram(), {
      clock,
      ids: sequentialIds(),
      state: engine.exportState()
    });

    const retried = restored.postAccrual({
      ...request,
      context: { ...request.context, request_id: "persistent-retry-request" }
    });
    expect(retried.entry.entry_id).toBe(accrued.entry.entry_id);
    expect(restored.getAccount({
      context: makeContext("persistent-account-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    })).toMatchObject({
      balances: [{ amount: 110 }],
      expiring_balances: [{ amount: 110, expires_at: accrued.entry.expires_at }]
    });
    expect(restored.getLedger()).toHaveLength(1);
  });

  it("rejects snapshots created for a different program configuration", () => {
    const state = enrolledEngine().exportState();
    const changed = makeProgram();
    changed.earn_rate.points = 11;
    expect(() => new LoyaltyEngine(changed, { state })).toThrowError(/incompatible/);
  });

  it("provides a non-normative operator snapshot", () => {
    const engine = enrolledEngine();
    accrue(engine, "admin-snapshot-accrual-key");
    const snapshot = engine.inspectAdmin();

    expect(snapshot).toMatchObject({
      program: { program_id: "demo-foodservice" },
      program_configuration: {
        current_model_id: "points",
        editable: true,
        publish_supported: true,
        templates: expect.arrayContaining([
          expect.objectContaining({
            model_id: "points",
            status: "active",
            engine_support: "implemented"
          }),
          expect.objectContaining({
            model_id: "wallet_credit",
            status: "planned",
            engine_support: "planned"
          })
        ])
      },
      summary: {
        active_members: 1,
        points_outstanding: 110,
        points_issued: 110,
        points_redeemed: 0,
        expiring_points: 110,
        ledger_entries: 1
      },
      members: [{
        member: { member_id: "member-001", tier_id: "regular" },
        balance: { amount: 110 },
        tier_progress: { current_tier_id: "regular" }
      }],
      ledger: [{ operation: "accrual", amount: 110 }]
    });
  });

  it("serves a portable program catalog and initial account summary", () => {
    const engine = enrolledEngine();
    const catalog = engine.getProgram({
      context: makeContext("program-get-key"),
      program_id: "demo-foodservice"
    });
    const account = engine.getAccount({
      context: makeContext("account-get-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    });

    expect(catalog.program).toMatchObject({
      name: "Demo Foodservice Rewards",
      earning: {
        minimum_eligible_spend: { amount: 100, currency: "USD" },
        eligible_channels: ["counter", "drive_thru", "web", "mobile"],
        rounding: "after_transaction",
        exclusions: {
          category_ids: ["alcohol", "gift-cards"],
          tags: ["service-fee", "merch", "donation", "packaging", "delivery-fee"]
        }
      },
      accounts: [{ unit: "points", is_primary: true }],
      metrics: [
        { metric_id: "lifetime-earned" },
        { metric_id: "tier-qualifying" }
      ],
      tiers: [
        { tier_id: "starter", minimum: 0 },
        { tier_id: "regular", minimum: 100, earn_multiplier_bps: 12_000 },
        { tier_id: "vip", minimum: 250 }
      ],
      tier_policy: {
        metric_id: "tier-qualifying",
        period: { starts_month: 1, starts_day: 1, time_zone: "America/New_York" }
      },
      point_expiration: { type: "after_earned", days: 365, warning_days: [30, 7] },
      rewards: [
        { reward_id: "one-dollar-off", effect: { type: "discount" } },
        { reward_id: "free-entree", effect: { type: "free_item" } }
      ]
    });
    expect(account).toMatchObject({
      member: { tier_id: "starter" },
      balances: [{ amount: 0 }],
      metrics: [
        { metric_id: "lifetime-earned", amount: 0 },
        { metric_id: "tier-qualifying", amount: 0 }
      ],
      expiring_balances: [],
      tier_progress: {
        current_tier_id: "starter",
        next_tier_id: "regular",
        remaining_to_next: 100,
        progress_bps: 0,
        is_top_tier: false
      }
    });
  });

  it("derives tier progress and paginates filtered ledger history", () => {
    const engine = enrolledEngine();
    accrue(engine);
    engine.adjustOrder({
      context: makeContext("history-adjustment-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      adjustment: {
        adjustment_id: "history-refund",
        original_order_id: "order-1001",
        type: "partial_refund",
        reason: "partial refund",
        occurred_at: "2026-07-14T10:30:00.000Z",
        order_total_delta: { amount: -100, currency: "USD" },
        eligible_spend_delta: { amount: -100, currency: "USD" }
      }
    });

    const account = engine.getAccount({
      context: makeContext("account-after-earn-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    });
    expect(account).toMatchObject({
      member: { tier_id: "regular" },
      balances: [{ amount: 100 }],
      metrics: [
        { metric_id: "lifetime-earned", amount: 100 },
        { metric_id: "tier-qualifying", amount: 100 }
      ],
      tier_progress: {
        current_tier_id: "regular",
        next_tier_id: "vip",
        remaining_to_next: 150,
        progress_bps: 0
      }
    });
    const existingEnrollment = engine.enroll(makeEnroll("existing-tier-enrollment-key"));
    expect(existingEnrollment.member.tier_id).toBe("regular");

    const firstPage = engine.listLedger({
      context: makeContext("ledger-page-one-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      limit: 1
    });
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0]).toMatchObject({ operation: "adjustment", amount: -10 });
    expect(firstPage.next_cursor).toEqual(expect.any(String));

    const secondPage = engine.listLedger({
      context: makeContext("ledger-page-two-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      cursor: firstPage.next_cursor!,
      limit: 1
    });
    expect(secondPage.entries).toEqual([
      expect.objectContaining({ operation: "accrual", amount: 110 })
    ]);
    expect(secondPage.next_cursor).toBeUndefined();

    const accruals = engine.listLedger({
      context: makeContext("ledger-filter-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      operations: ["accrual"]
    });
    expect(accruals.entries).toHaveLength(1);
    expect(accruals.entries[0]?.operation).toBe("accrual");

    expect(() => engine.listLedger({
      context: makeContext("ledger-bad-cursor-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      cursor: "not-a-cursor"
    })).toThrowError(/cursor/i);
  });

  it("applies eligible channels, exclusions, and the minimum check value", () => {
    const engine = enrolledEngine();
    const evaluate = (order: ReturnType<typeof makeOrder>, key: string) => engine.evaluate({
      context: makeContext(key),
      member_id: "member-001",
      order
    }).estimated_accrual.amount;

    expect(evaluate(makeOrder({ channel: "third_party" }), "ineligible-channel-key")).toBe(0);

    const excluded = makeOrder({ order_id: "excluded-order" });
    excluded.lines[0]!.category_ids = ["alcohol"];
    excluded.lines[1]!.tags = ["packaging"];
    expect(evaluate(excluded, "excluded-lines-key")).toBe(0);

    const belowMinimum = makeOrder({ order_id: "below-minimum-order" });
    belowMinimum.lines[0]!.loyalty_eligible = false;
    belowMinimum.lines[1]!.unit_price.amount = 99;
    belowMinimum.lines[1]!.subtotal.amount = 99;
    belowMinimum.lines[1]!.tax.amount = 0;
    belowMinimum.totals.subtotal.amount = 1_099;
    belowMinimum.totals.tax.amount = 80;
    belowMinimum.totals.total.amount = 1_179;
    belowMinimum.tenders![0]!.amount.amount = 1_179;
    expect(evaluate(belowMinimum, "minimum-check-key")).toBe(0);
  });

  it("applies the member tier multiplier and preserves it for later refunds", () => {
    const engine = enrolledEngine();
    accrue(engine);

    const secondOrder = makeOrder({ order_id: "tier-multiplier-order" });
    const evaluated = engine.evaluate({
      context: makeContext("tier-multiplier-evaluation-key"),
      member_id: "member-001",
      order: secondOrder
    });
    expect(evaluated.estimated_accrual.amount).toBe(132);

    const accrued = engine.postAccrual({
      context: makeContext("tier-multiplier-accrual-key"),
      member_id: "member-001",
      order: secondOrder
    });
    expect(accrued.entry.amount).toBe(132);

    const adjusted = engine.adjustOrder({
      context: makeContext("tier-multiplier-refund-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      adjustment: {
        adjustment_id: "tier-multiplier-refund",
        original_order_id: "tier-multiplier-order",
        type: "partial_refund",
        reason: "partial refund",
        occurred_at: "2026-07-14T12:00:00.000Z",
        order_total_delta: { amount: -500, currency: "USD" },
        eligible_spend_delta: { amount: -500, currency: "USD" }
      }
    });
    expect(adjusted.entry.amount).toBe(-60);
    expect(adjusted.balances[0]?.amount).toBe(182);
    expect(engine.getAccount({
      context: makeContext("tier-multiplier-expiry-buckets-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    }).expiring_balances.map((bucket) => bucket.amount)).toEqual([182]);
  });

  it("posts only the unspent portion as an immutable expiration entry after 365 days", () => {
    const clock = new MutableClock();
    const engine = enrolledEngine(clock);
    const earned = accrue(engine, "expiring-accrual-key");
    expect(earned.entry.expires_at).toBe("2027-07-14T10:00:00.000Z");

    const before = engine.getAccount({
      context: makeContext("before-expiration-account-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    });
    expect(before.expiring_balances).toEqual([{
      account_id: "points:member-001",
      unit: "points",
      amount: 110,
      expires_at: "2027-07-14T10:00:00.000Z"
    }]);

    engine.adjustOrder({
      context: makeContext("pre-expiration-refund-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      adjustment: {
        adjustment_id: "pre-expiration-refund",
        original_order_id: "order-1001",
        type: "partial_refund",
        reason: "partial refund",
        occurred_at: "2026-07-14T11:00:00.000Z",
        order_total_delta: { amount: -500, currency: "USD" },
        eligible_spend_delta: { amount: -500, currency: "USD" }
      }
    });
    expect(engine.getAccount({
      context: makeContext("after-refund-expiry-bucket-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    }).expiring_balances[0]?.amount).toBe(60);

    clock.advance(365 * 86_400);
    const expired = engine.getAccount({
      context: makeContext("expired-account-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    });
    expect(expired).toMatchObject({ balances: [{ amount: 0 }], expiring_balances: [] });
    const entries = engine.getLedger();
    expect(entries.map((entry) => entry.operation)).toEqual([
      "accrual",
      "adjustment",
      "expiration"
    ]);
    expect(entries[2]).toMatchObject({
      amount: -60,
      related_entry_id: earned.entry.entry_id
    });
  });

  it("consumes earliest-expiring lots first and restores them on redemption reversal", () => {
    const clock = new MutableClock();
    const engine = enrolledEngine(clock);
    accrue(engine, "fifo-first-accrual-key");
    clock.advance(10 * 86_400);
    engine.postAccrual({
      context: makeContext("fifo-second-accrual-key"),
      member_id: "member-001",
      order: makeOrder({ order_id: "fifo-second-order" })
    });
    const held = engine.reserve({
      context: makeContext("fifo-reserve-key"),
      redemption_id: "fifo-redemption",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: makeOrder({ order_id: "fifo-redemption-order" })
    });
    engine.capture({
      context: makeContext("fifo-capture-key"),
      reservation_id: held.reservation.reservation_id,
      order_id: "fifo-redemption-order"
    });
    expect(engine.getAccount({
      context: makeContext("fifo-captured-account-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    }).expiring_balances.map((bucket) => bucket.amount)).toEqual([10, 132]);

    engine.reverse({
      context: makeContext("fifo-reverse-key"),
      reservation_id: held.reservation.reservation_id,
      reason: "order cancelled"
    });
    expect(engine.getAccount({
      context: makeContext("fifo-reversed-account-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    }).expiring_balances.map((bucket) => bucket.amount)).toEqual([110, 132]);
  });

  it("resets annual tier qualification without resetting spendable points", () => {
    const clock = new MutableClock("2026-12-31T17:00:00.000Z");
    const engine = enrolledEngine(clock);
    accrue(engine, "year-end-accrual-key");
    expect(engine.getAccount({
      context: makeContext("year-end-account-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    })).toMatchObject({
      member: { tier_id: "regular" },
      balances: [{ amount: 110 }],
      tier_progress: { current_amount: 110 }
    });

    clock.advance(86_400);
    const reset = engine.getAccount({
      context: makeContext("new-year-account-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    });
    expect(reset).toMatchObject({
      member: { tier_id: "starter" },
      balances: [{ amount: 110 }],
      metrics: [
        { metric_id: "lifetime-earned", amount: 110 },
        { metric_id: "tier-qualifying", amount: 0 }
      ],
      tier_progress: { current_tier_id: "starter", current_amount: 0 }
    });
  });

  it("enrolls, replays idempotently, and resolves an identity", () => {
    const engine = makeEngine();
    const request = makeEnroll();
    const enrolled = engine.enroll(request);
    const replayRequest = structuredClone(request);
    replayRequest.context.request_id = "retry-request-id";
    const replay = engine.enroll(replayRequest);
    const lookup = engine.lookup({
      context: makeContext("lookup-key-001"),
      program_id: "demo-foodservice",
      identity: request.identity
    });

    expect(replay).toEqual(enrolled);
    expect(lookup.member?.member_id).toBe("member-001");
    expect(lookup.balances[0]).toMatchObject({ amount: 0, reserved: 0, available: 0 });
  });

  it("returns null for an unknown identity and rejects an unknown program", () => {
    const engine = makeEngine();
    const lookup = engine.lookup({
      context: makeContext("lookup-key-unknown"),
      program_id: "demo-foodservice",
      identity: { type: "token", value: "unknown" }
    });
    expect(lookup).toMatchObject({ member: null, balances: [] });

    expect(() => engine.lookup({
      context: makeContext("lookup-key-bad-program"),
      program_id: "other-program",
      identity: { type: "token", value: "unknown" }
    })).toThrowError(EngineError);
  });

  it("detects reuse of an idempotency key with changed input", () => {
    const engine = makeEngine();
    engine.enroll(makeEnroll("shared-enrollment-key"));
    const changed = makeEnroll("shared-enrollment-key");
    changed.identity.value = "another-token";

    expect(() => engine.enroll(changed)).toThrowError(/different request/);
  });

  it("evaluates eligible spend and reward availability", () => {
    const engine = enrolledEngine();
    const result = engine.evaluate({
      context: makeContext("evaluation-key-001"),
      member_id: "member-001",
      order: makeOrder()
    });

    expect(result.estimated_accrual).toEqual({ unit: "points", amount: 110 });
    expect(result.rewards[0]).toMatchObject({
      reward_id: "one-dollar-off",
      status: "unavailable",
      unavailable_reasons: ["insufficient_balance"]
    });
    expect(result.expires_at).toBe("2026-07-14T10:05:00.000Z");
  });

  it("allocates odd minor units deterministically across funding parties", () => {
    const program = makeProgram();
    const reward = program.rewards[0]!;
    if (reward.effect.type !== "discount") throw new Error("fixture reward must be a discount");
    reward.effect.amount.amount = 101;
    reward.effect.allocations[0]!.amount.amount = 101;
    reward.funding = [
      { party_id: "brand-z", party_type: "brand", share_bps: 5000 },
      { party_id: "operator-a", party_type: "franchisee", share_bps: 5000 }
    ];
    const engine = new LoyaltyEngine(program, {
      clock: new MutableClock(),
      ids: sequentialIds()
    });
    engine.enroll(makeEnroll("funding-enroll-key"));
    const result = engine.evaluate({
      context: makeContext("funding-evaluation-key"),
      member_id: "member-001",
      order: makeOrder()
    });

    expect(result.rewards[0]?.funding).toEqual([
      {
        party_id: "brand-z",
        party_type: "brand",
        share_bps: 5000,
        amount: { amount: 51, currency: "USD" }
      },
      {
        party_id: "operator-a",
        party_type: "franchisee",
        share_bps: 5000,
        amount: { amount: 50, currency: "USD" }
      }
    ]);
  });
});

describe("LoyaltyEngine financial lifecycle", () => {
  it("posts an order once across exact retries and changed idempotency keys", () => {
    const engine = enrolledEngine();
    const request = {
      context: makeContext("accrual-key-replay"),
      member_id: "member-001" as const,
      order: makeOrder()
    };
    const first = engine.postAccrual(request);
    const retry = engine.postAccrual(structuredClone(request));
    const changedKey = accrue(engine, "different-accrual-key");

    expect(retry).toEqual(first);
    expect(changedKey.entry.entry_id).toBe(first.entry.entry_id);
    expect(changedKey.balances[0]?.amount).toBe(110);
    expect(engine.getLedger()).toHaveLength(1);

    const changedOrder = makeOrder();
    changedOrder.lines[0]!.unit_price.amount += 100;
    changedOrder.lines[0]!.subtotal.amount += 100;
    changedOrder.totals.subtotal.amount += 100;
    changedOrder.totals.total.amount += 100;
    changedOrder.tenders![0]!.amount.amount += 100;
    expect(() => engine.postAccrual({
      context: makeContext("changed-order-accrual-key"),
      member_id: "member-001",
      order: changedOrder
    })).toThrowError(/different facts/);
  });

  it("reserves, captures, and reverses without double spending", () => {
    const engine = enrolledEngine();
    accrue(engine);
    const held = reserve(engine);
    expect(held.balances[0]).toMatchObject({ amount: 110, reserved: 100, available: 10 });
    const heldRetry = reserve(engine, "reserve-key-002");
    expect(heldRetry.reservation.reservation_id).toBe(held.reservation.reservation_id);
    expect(heldRetry.balances[0]).toMatchObject({ reserved: 100, available: 10 });

    const captured = engine.capture({
      context: makeContext("capture-key-001"),
      reservation_id: held.reservation.reservation_id,
      order_id: "order-redemption"
    });
    expect(captured).toMatchObject({
      reservation: { status: "captured" },
      balances: [{ amount: 10, reserved: 0, available: 10 }]
    });

    const capturedAgain = engine.capture({
      context: makeContext("capture-key-002"),
      reservation_id: held.reservation.reservation_id,
      order_id: "order-redemption"
    });
    expect(capturedAgain.balances[0]?.amount).toBe(10);

    const reversed = engine.reverse({
      context: makeContext("reverse-key-001"),
      reservation_id: held.reservation.reservation_id,
      reason: "order voided"
    });
    expect(reversed).toMatchObject({
      reservation: { status: "reversed" },
      balances: [{ amount: 110, reserved: 0, available: 110 }]
    });

    engine.reverse({
      context: makeContext("reverse-key-002"),
      reservation_id: held.reservation.reservation_id,
      reason: "duplicate callback"
    });
    expect(engine.getLedger().map((entry) => entry.operation)).toEqual([
      "accrual",
      "redemption",
      "reversal"
    ]);
  });

  it("expires a hold without changing posted balance", () => {
    const clock = new MutableClock();
    const engine = enrolledEngine(clock);
    accrue(engine);
    const held = reserve(engine);
    clock.advance(121);

    expect(() => engine.capture({
      context: makeContext("capture-expired-key"),
      reservation_id: held.reservation.reservation_id,
      order_id: "order-redemption"
    })).toThrowError(/expired/);

    const evaluation = engine.evaluate({
      context: makeContext("evaluation-after-expiry"),
      member_id: "member-001",
      order: makeOrder({ order_id: "order-next" })
    });
    expect(evaluation.balances[0]).toMatchObject({ amount: 110, reserved: 0, available: 110 });
  });

  it("manages issued coupon rewards through reserve, capture, reversal, and cancellation", () => {
    const engine = enrolledEngine();
    const issued = engine.issueReward({
      context: makeContext("issue-wallet-reward"),
      issued_reward_id: "issued-001",
      member_id: "member-001",
      program_id: "demo-foodservice",
      reward_id: "one-dollar-off",
      artifact: { type: "qr_code", value: "SAKURA-REWARD-001" }
    });
    expect(issued.issued_reward).toMatchObject({
      status: "issued",
      artifact: { type: "qr_code", value: "SAKURA-REWARD-001" }
    });

    const held = engine.reserve({
      context: makeContext("reserve-wallet-reward"),
      redemption_id: "wallet-redemption-001",
      issued_reward_id: "issued-001",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: makeOrder({ order_id: "wallet-order-001" })
    });
    expect(held.reservation.cost.amount).toBe(0);
    const captured = engine.capture({
      context: makeContext("capture-wallet-reward"),
      reservation_id: held.reservation.reservation_id,
      order_id: "wallet-order-001"
    });
    expect(captured.balances[0]?.amount).toBe(0);
    expect(engine.listIssuedRewards({
      context: makeContext("list-redeemed-wallet"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      statuses: ["redeemed"]
    }).issued_rewards).toEqual([
      expect.objectContaining({ issued_reward_id: "issued-001", status: "redeemed" })
    ]);

    engine.reverse({
      context: makeContext("reverse-wallet-reward"),
      reservation_id: held.reservation.reservation_id,
      reason: "Order refunded"
    });
    const cancelled = engine.cancelIssuedReward({
      context: makeContext("cancel-wallet-reward"),
      issued_reward_id: "issued-001",
      reason: "Campaign ended"
    });
    expect(cancelled.issued_reward).toMatchObject({
      status: "cancelled",
      cancellation_reason: "Campaign ended"
    });
    expect(engine.getLedger()).toHaveLength(0);
  });

  it("posts signed refund adjustments once", () => {
    const engine = enrolledEngine();
    accrue(engine);
    const request = {
      context: makeContext("adjustment-key-001"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      adjustment: {
        adjustment_id: "refund-001",
        original_order_id: "order-1001",
        type: "partial_refund" as const,
        reason: "item returned",
        occurred_at: "2026-07-14T11:00:00.000Z",
        order_total_delta: { amount: -550, currency: "USD" },
        eligible_spend_delta: { amount: -500, currency: "USD" }
      }
    };
    const adjusted = engine.adjustOrder(request);
    const repeated = engine.adjustOrder({
      ...request,
      context: makeContext("adjustment-key-002")
    });

    expect(adjusted.entry).toMatchObject({ operation: "adjustment", amount: -50 });
    expect(repeated.entry.entry_id).toBe(adjusted.entry.entry_id);
    expect(repeated.balances[0]?.amount).toBe(60);
    expect(engine.getLedger()).toHaveLength(2);

    const changed = structuredClone(request);
    changed.context = makeContext("adjustment-key-003");
    changed.adjustment.eligible_spend_delta.amount = -400;
    expect(() => engine.adjustOrder(changed)).toThrowError(/different facts/);
  });

  it("posts classified manual credits and debits idempotently", () => {
    const engine = enrolledEngine();
    const credit = {
      context: makeContext("manual-credit-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      adjustment_id: "manual-credit-001",
      amount: 25,
      classification: "service_recovery" as const,
      reason: "Late order apology",
      qualifies_for_tier: false
    };
    const credited = engine.postManualAdjustment(credit);
    const replayed = engine.postManualAdjustment({
      ...credit,
      context: makeContext("manual-credit-replay-key")
    });

    expect(credited.entry).toMatchObject({
      operation: "manual",
      amount: 25,
      adjustment_id: "manual-credit-001",
      classification: "service_recovery",
      reason: "Late order apology",
      qualifies_for_tier: false
    });
    expect(credited.entry.expires_at).toBeDefined();
    expect(replayed.entry.entry_id).toBe(credited.entry.entry_id);
    expect(replayed.balances[0]?.amount).toBe(25);

    const debited = engine.postManualAdjustment({
      context: makeContext("manual-debit-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      adjustment_id: "manual-debit-001",
      amount: -5,
      classification: "correction",
      reason: "Duplicate bonus correction",
      qualifies_for_tier: false
    });
    expect(debited.entry).toMatchObject({ operation: "manual", amount: -5 });
    expect(debited.balances[0]?.amount).toBe(20);

    expect(() => engine.postManualAdjustment({
      ...credit,
      context: makeContext("manual-zero-key"),
      adjustment_id: "manual-zero-001",
      amount: 0
    })).toThrowError(/must not be zero/);
    expect(() => engine.postManualAdjustment({
      ...credit,
      context: makeContext("manual-conflict-key"),
      amount: 30
    })).toThrowError(/different facts/);
  });

  it("rejects invalid orders, unpaid accruals, wrong currencies, and insufficient points", () => {
    const engine = enrolledEngine();
    const openOrder = makeOrder({ status: "open" });
    delete openOrder.tenders;
    expect(() => engine.postAccrual({
      context: makeContext("open-order-key"),
      member_id: "member-001",
      order: openOrder
    })).toThrowError(/paid order/);

    const invalid = makeOrder();
    invalid.totals.total.amount += 1;
    expect(() => engine.evaluate({
      context: makeContext("invalid-order-key"),
      member_id: "member-001",
      order: invalid
    })).toThrowError(/does not reconcile/);

    const foreign = makeOrder();
    for (const line of foreign.lines) {
      for (const money of [line.unit_price, line.subtotal, line.discount, line.tax]) money.currency = "CAD";
    }
    for (const money of Object.values(foreign.totals)) money.currency = "CAD";
    for (const tender of foreign.tenders ?? []) tender.amount.currency = "CAD";
    expect(() => engine.evaluate({
      context: makeContext("foreign-order-key"),
      member_id: "member-001",
      order: foreign
    })).toThrowError(/currency/);

    expect(() => reserve(engine, "reserve-without-points")).toThrowError(/enough available points/);
  });

  it("rejects malformed program configuration", () => {
    const badFunding = makeProgram();
    badFunding.rewards[0]!.funding[0]!.share_bps = 7000;
    expect(() => new LoyaltyEngine(badFunding)).toThrowError(/Funding/);

    const badRate = makeProgram();
    badRate.earn_rate.spend_minor_units = 0;
    expect(() => new LoyaltyEngine(badRate)).toThrowError(/Earn rate/);

    const badReward = makeProgram();
    if (badReward.rewards[0]!.effect.type === "discount") {
      badReward.rewards[0]!.effect.allocations[0]!.amount.amount = 99;
    }
    expect(() => new LoyaltyEngine(badReward)).toThrowError(/allocations/);

    const badTiers = makeProgram();
    badTiers.tiers![0]!.minimum = 1;
    expect(() => new LoyaltyEngine(badTiers)).toThrowError(/start at zero/);

    const invalidTimeZone = makeProgram();
    invalidTimeZone.tier_policy!.period.time_zone = "Not/A-Time-Zone";
    expect(() => new LoyaltyEngine(invalidTimeZone)).toThrowError(/time zone/);

    const missingTierPolicy = makeProgram();
    delete missingTierPolicy.tier_policy;
    expect(() => new LoyaltyEngine(missingTierPolicy)).toThrowError(/tier policy/);

    const invalidCatalog = makeProgram();
    invalidCatalog.name = "";
    expect(() => new LoyaltyEngine(invalidCatalog)).toThrowError(/must NOT have fewer than 1 characters/);

    const invalidWarnings = makeProgram();
    invalidWarnings.point_expiration!.warning_days = [365];
    expect(() => new LoyaltyEngine(invalidWarnings)).toThrowError(/expiration and warnings/);
  });
});

describe("annual restaurant tier earning rules", () => {
  it("earns one point per dollar, unlocks Tier 1 at 500, applies 1.2x, and resets qualification", () => {
    const clock = new MutableClock("2026-12-31T17:00:00.000Z");
    const engine = new LoyaltyEngine(makeAnnualTierProgram(), { clock, ids: sequentialIds() });
    engine.enroll({
      context: makeContext("annual-tier-enrollment-key"),
      program_id: "annual-tier-foodservice",
      member_id: "annual-tier-member",
      identity: { type: "token", value: "annual-tier-guest" }
    });

    const qualifyingOrder = makeAnnualTierOrder(50_000, "annual-tier-qualifying-order");
    expect(engine.postAccrual({
      context: makeContext("annual-tier-accrual-key"),
      member_id: "annual-tier-member",
      order: qualifyingOrder
    }).entry.amount).toBe(500);

    const tierOneOrder = makeAnnualTierOrder(1_100, "annual-tier-premier-order");
    expect(engine.evaluate({
      context: makeContext("annual-tier-evaluation-key"),
      member_id: "annual-tier-member",
      order: tierOneOrder
    }).estimated_accrual.amount).toBe(13);

    expect(engine.getAccount({
      context: makeContext("annual-tier-account-key"),
      member_id: "annual-tier-member",
      program_id: "annual-tier-foodservice"
    })).toMatchObject({
      member: { tier_id: "premier" },
      balances: [{ amount: 500 }],
      tier_progress: { current_tier_id: "premier", current_amount: 500 }
    });

    clock.advance(86_400);
    expect(engine.getAccount({
      context: makeContext("annual-tier-reset-account-key"),
      member_id: "annual-tier-member",
      program_id: "annual-tier-foodservice"
    })).toMatchObject({
      member: { tier_id: "base" },
      balances: [{ amount: 500 }],
      tier_progress: { current_tier_id: "base", current_amount: 0 }
    });
  });
});

describe("reward availability windows", () => {
  function makeWindowedProgram(): ReturnType<typeof makeProgram> {
    const program = makeProgram();
    program.rewards[0]!.available_from = "2026-08-01T00:00:00.000Z";
    program.rewards[0]!.available_until = "2026-09-01T00:00:00.000Z";
    return program;
  }

  function windowedEngine(clock: MutableClock): LoyaltyEngine {
    const engine = new LoyaltyEngine(makeWindowedProgram(), { clock, ids: sequentialIds() });
    engine.enroll(makeEnroll());
    accrue(engine, "window-accrual-key");
    return engine;
  }

  it("marks rewards outside their availability window as unavailable in evaluation", () => {
    const clock = new MutableClock("2026-07-14T10:00:00.000Z");
    const engine = windowedEngine(clock);
    const before = engine.evaluate({
      context: makeContext("window-evaluate-before-key"),
      member_id: "member-001",
      order: makeOrder({ order_id: "window-order-before" })
    });
    expect(before.rewards[0]).toMatchObject({
      reward_id: "one-dollar-off",
      status: "unavailable",
      unavailable_reasons: ["not_yet_available"]
    });

    clock.advance(30 * 86_400);
    const during = engine.evaluate({
      context: makeContext("window-evaluate-during-key"),
      member_id: "member-001",
      order: makeOrder({ order_id: "window-order-during" })
    });
    expect(during.rewards[0]).toMatchObject({
      reward_id: "one-dollar-off",
      status: "available"
    });

    clock.advance(60 * 86_400);
    const after = engine.evaluate({
      context: makeContext("window-evaluate-after-key"),
      member_id: "member-001",
      order: makeOrder({ order_id: "window-order-after" })
    });
    expect(after.rewards[0]).toMatchObject({
      status: "unavailable",
      unavailable_reasons: ["no_longer_available"]
    });
  });

  it("rejects reservations outside the availability window and allows them inside it", () => {
    const clock = new MutableClock("2026-07-14T10:00:00.000Z");
    const engine = windowedEngine(clock);
    expect(() => engine.reserve({
      context: makeContext("window-reserve-early-key"),
      redemption_id: "window-redemption-early",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: makeOrder({ order_id: "window-order-reserve" })
    })).toThrowError(/not available yet/);

    clock.advance(30 * 86_400);
    const held = engine.reserve({
      context: makeContext("window-reserve-open-key"),
      redemption_id: "window-redemption-open",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: makeOrder({ order_id: "window-order-reserve" })
    });
    expect(held.reservation.status).toBe("reserved");

    clock.advance(60 * 86_400);
    expect(() => engine.reserve({
      context: makeContext("window-reserve-late-key"),
      redemption_id: "window-redemption-late",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: makeOrder({ order_id: "window-order-reserve-late" })
    })).toThrowError(/no longer available/);
  });
});
