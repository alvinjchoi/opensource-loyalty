import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LedgerListRequestSchema,
  MemberAccountResponseSchema,
  MemberEnrollRequestSchema,
  validate,
  validateFoodserviceOrder,
  validateFundingShares
} from "@loyalty-interchange/protocol";
import { makeOrder } from "../fixtures.js";

describe("protocol validation", () => {
  it("accepts the checked-in enrollment and paid-order examples", () => {
    const root = resolve(import.meta.dirname, "../..");
    const enroll = JSON.parse(readFileSync(resolve(root, "spec/examples/enroll-request.json"), "utf8"));
    const order = JSON.parse(readFileSync(resolve(root, "spec/examples/paid-order.json"), "utf8"));

    expect(validate(MemberEnrollRequestSchema, enroll)).toMatchObject({ ok: true });
    expect(validateFoodserviceOrder(order)).toMatchObject({ ok: true });
  });

  it("reports structural violations with JSON pointer paths", () => {
    const result = validate(MemberEnrollRequestSchema, {
      program_id: "demo-foodservice",
      unexpected: true
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.keyword === "required")).toBe(true);
      expect(result.issues.some((issue) => issue.keyword === "additionalProperties")).toBe(true);
    }
  });

  it("validates account summaries and bounded ledger queries", () => {
    const ledgerQuery = validate(LedgerListRequestSchema, {
      context: {
        protocol_version: "1.0",
        profile: "foodservice/1.0",
        request_id: "request-account-read",
        idempotency_key: "account-read-key",
        occurred_at: "2026-07-14T10:00:00.000Z",
        source: { system: "test" }
      },
      member_id: "member-001",
      program_id: "demo-foodservice",
      operations: ["accrual"],
      limit: 100
    });
    expect(ledgerQuery).toMatchObject({ ok: true });
    expect(validate(LedgerListRequestSchema, {
      ...(ledgerQuery.ok ? ledgerQuery.value : {}),
      limit: 101
    })).toMatchObject({ ok: false });

    expect(validate(MemberAccountResponseSchema, {
      context: {
        protocol_version: "1.0",
        profile: "foodservice/1.0",
        request_id: "request-account-read",
        processed_at: "2026-07-14T10:00:00.000Z"
      },
      member: {
        member_id: "member-001",
        program_id: "demo-foodservice",
        status: "active",
        joined_at: "2026-07-14T10:00:00.000Z",
        tier_id: "starter",
        identities: [{ type: "token", value: "guest-token" }]
      },
      balances: [{
        account_id: "points:member-001",
        member_id: "member-001",
        program_id: "demo-foodservice",
        unit: "points",
        amount: 0,
        reserved: 0,
        available: 0,
        as_of: "2026-07-14T10:00:00.000Z"
      }],
      metrics: [],
      expiring_balances: [],
      tier_progress: {
        current_tier_id: "starter",
        qualification_metric_id: "tier-qualifying",
        current_amount: 0,
        next_tier_id: "regular",
        remaining_to_next: 100,
        progress_bps: 0,
        is_top_tier: false
      }
    })).toMatchObject({ ok: true });
  });

  it("requires a single currency throughout an order", () => {
    const order = makeOrder();
    order.lines[0]!.unit_price.currency = "CAD";
    const result = validateFoodserviceOrder(order);

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: "currency" })])
    });
  });

  it("reconciles order and line totals exactly", () => {
    const order = makeOrder();
    order.totals.total.amount += 1;
    order.lines[0]!.subtotal.amount += 1;
    const result = validateFoodserviceOrder(order);

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "/totals/total/amount" }),
        expect.objectContaining({ path: "/lines/line-1/subtotal/amount" })
      ])
    });
  });

  it("requires nonnegative sale values and line allocations to match check totals", () => {
    const negative = makeOrder();
    negative.lines[0]!.discount.amount = -1;
    expect(validateFoodserviceOrder(negative)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: "minimum" })])
    });

    const unallocated = makeOrder();
    unallocated.totals.discount.amount = 100;
    unallocated.totals.total.amount -= 100;
    unallocated.tenders![0]!.amount.amount -= 100;
    expect(validateFoodserviceOrder(unallocated)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "/totals/discount/amount", keyword: "reconciliation" })
      ])
    });
  });

  it("rejects duplicate, missing, and self-referencing lines", () => {
    const duplicate = makeOrder();
    duplicate.lines[1]!.line_id = "line-1";
    duplicate.lines[1]!.parent_line_id = "line-1";
    const duplicateResult = validateFoodserviceOrder(duplicate);
    expect(duplicateResult).toMatchObject({ ok: false });

    const missing = makeOrder();
    missing.lines[1]!.parent_line_id = "missing-line";
    const missingResult = validateFoodserviceOrder(missing);
    expect(missingResult).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: "reference" })])
    });
  });

  it("requires paid tenders to equal the order total", () => {
    const order = makeOrder();
    order.tenders![0]!.amount.amount -= 1;
    const result = validateFoodserviceOrder(order);
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: "/tenders" })])
    });
  });

  it("requires funding shares to total exactly 100 percent", () => {
    expect(validateFundingShares([
      { party_id: "brand", party_type: "brand", share_bps: 7000 },
      { party_id: "operator", party_type: "franchisee", share_bps: 3000 }
    ])).toMatchObject({ ok: true });

    expect(validateFundingShares([
      { party_id: "brand", party_type: "brand", share_bps: 9999 }
    ])).toMatchObject({ ok: false });
  });
});
