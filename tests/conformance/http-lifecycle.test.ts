import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EvaluationResponseSchema,
  LedgerListResponseSchema,
  LedgerResponseSchema,
  MemberAccountResponseSchema,
  MemberEnrollResponseSchema,
  MemberLookupResponseSchema,
  ProgramGetResponseSchema,
  RedemptionReservationResponseSchema,
  validate
} from "@loyalty-interchange/protocol";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { startReferenceServer, type RunningServer } from "@loyalty-interchange/server";
import {
  MutableClock,
  makeContext,
  makeEnroll,
  makeOrder,
  makeProgram,
  sequentialIds
} from "../fixtures.js";

const API_KEY = "conformance-test-key";

describe("LIP foodservice HTTP conformance", () => {
  let running: RunningServer;

  beforeEach(async () => {
    const engine = new LoyaltyEngine(makeProgram(), {
      clock: new MutableClock(),
      ids: sequentialIds()
    });
    running = await startReferenceServer(engine, { apiKey: API_KEY });
  });

  afterEach(async () => {
    await running.close();
  });

  async function post(path: string, body: unknown, apiKey = API_KEY) {
    const response = await fetch(`${running.url}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    return { response, body: await response.json() as unknown };
  }

  it("executes the full restaurant loyalty transaction lifecycle", async () => {
    const enrollmentRequest = makeEnroll("http-enrollment-key");
    const enrolled = await post("/lip/v1/members/enroll", enrollmentRequest);
    expect(enrolled.response.status).toBe(201);
    expect(validate(MemberEnrollResponseSchema, enrolled.body)).toMatchObject({ ok: true });

    const lookup = await post("/lip/v1/members/lookup", {
      context: makeContext("http-lookup-key"),
      program_id: "demo-foodservice",
      identity: enrollmentRequest.identity
    });
    expect(lookup.response.status).toBe(200);
    expect(validate(MemberLookupResponseSchema, lookup.body)).toMatchObject({ ok: true });
    expect(lookup.body).toMatchObject({ member: { member_id: "member-001" } });

    const program = await post("/lip/v1/programs/get", {
      context: makeContext("http-program-key"),
      program_id: "demo-foodservice"
    });
    expect(validate(ProgramGetResponseSchema, program.body)).toMatchObject({ ok: true });
    expect(program.body).toMatchObject({
      program: {
        tiers: [
          { tier_id: "starter" },
          { tier_id: "regular" },
          { tier_id: "vip" }
        ],
        rewards: [
          { effect: { type: "discount" } },
          { effect: { type: "free_item" } }
        ]
      }
    });

    const order = makeOrder();
    const evaluated = await post("/lip/v1/orders/evaluate", {
      context: makeContext("http-evaluate-key"),
      member_id: "member-001",
      order
    });
    expect(validate(EvaluationResponseSchema, evaluated.body)).toMatchObject({ ok: true });
    expect(evaluated.body).toMatchObject({
      estimated_accrual: { amount: 110 },
      rewards: expect.arrayContaining([expect.objectContaining({ status: "unavailable" })])
    });

    const accrualRequest = {
      context: makeContext("http-accrual-key"),
      member_id: "member-001",
      order
    };
    const accrued = await post("/lip/v1/accruals", accrualRequest);
    expect(accrued.response.status).toBe(201);
    expect(validate(LedgerResponseSchema, accrued.body)).toMatchObject({ ok: true });
    expect(accrued.body).toMatchObject({
      entry: {
        operation: "accrual",
        amount: 110,
        expires_at: "2027-07-14T10:00:00.000Z"
      },
      balances: [{ amount: 110 }]
    });

    const account = await post("/lip/v1/accounts/get", {
      context: makeContext("http-account-key"),
      member_id: "member-001",
      program_id: "demo-foodservice"
    });
    expect(validate(MemberAccountResponseSchema, account.body)).toMatchObject({ ok: true });
    expect(account.body).toMatchObject({
      member: { tier_id: "regular" },
      metrics: [
        { metric_id: "lifetime-earned", amount: 110 },
        { metric_id: "tier-qualifying", amount: 110 }
      ],
      expiring_balances: [{ amount: 110, expires_at: "2027-07-14T10:00:00.000Z" }],
      tier_progress: { current_tier_id: "regular", remaining_to_next: 140 }
    });

    const tierEvaluation = await post("/lip/v1/orders/evaluate", {
      context: makeContext("http-tier-evaluate-key"),
      member_id: "member-001",
      order: makeOrder({ order_id: "order-tier-rate" })
    });
    expect(tierEvaluation.body).toMatchObject({ estimated_accrual: { amount: 132 } });

    const history = await post("/lip/v1/ledger/list", {
      context: makeContext("http-ledger-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      operations: ["accrual"],
      limit: 10
    });
    expect(validate(LedgerListResponseSchema, history.body)).toMatchObject({ ok: true });
    expect(history.body).toMatchObject({
      entries: [{ operation: "accrual", amount: 110 }]
    });

    const replay = await post("/lip/v1/accruals", accrualRequest);
    expect(replay.body).toEqual(accrued.body);

    const reserved = await post("/lip/v1/redemptions/reserve", {
      context: makeContext("http-reserve-key"),
      redemption_id: "redemption-http-001",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: makeOrder({ order_id: "order-redemption" })
    });
    expect(reserved.response.status).toBe(201);
    expect(validate(RedemptionReservationResponseSchema, reserved.body)).toMatchObject({ ok: true });
    expect(reserved.body).toMatchObject({
      reservation: {
        status: "reserved",
        funding: [
          { party_type: "brand", share_bps: 7500, amount: { amount: 75, currency: "USD" } },
          { party_type: "franchisee", share_bps: 2500, amount: { amount: 25, currency: "USD" } }
        ]
      },
      balances: [{ reserved: 100, available: 10 }]
    });
    const reservationId = (reserved.body as { reservation: { reservation_id: string } }).reservation.reservation_id;

    const captured = await post("/lip/v1/redemptions/capture", {
      context: makeContext("http-capture-key"),
      reservation_id: reservationId,
      order_id: "order-redemption"
    });
    expect(captured.body).toMatchObject({
      reservation: { status: "captured" },
      balances: [{ amount: 10, reserved: 0 }]
    });

    const reversed = await post("/lip/v1/redemptions/reverse", {
      context: makeContext("http-reverse-key"),
      reservation_id: reservationId,
      reason: "guest changed order"
    });
    expect(reversed.body).toMatchObject({
      reservation: { status: "reversed" },
      balances: [{ amount: 110 }]
    });

    const adjusted = await post("/lip/v1/orders/adjust", {
      context: makeContext("http-adjust-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      adjustment: {
        adjustment_id: "refund-http-001",
        original_order_id: "order-1001",
        type: "partial_refund",
        reason: "item refund",
        occurred_at: "2026-07-14T11:00:00.000Z",
        order_total_delta: { amount: -550, currency: "USD" },
        eligible_spend_delta: { amount: -500, currency: "USD" }
      }
    });
    expect(adjusted.response.status).toBe(201);
    expect(adjusted.body).toMatchObject({
      entry: { operation: "adjustment", amount: -50 },
      balances: [{ amount: 60 }]
    });
  });

  it("enforces authentication and returns machine-readable validation errors", async () => {
    const health = await fetch(`${running.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: "ok",
      protocol_version: "1.0",
      profile: "foodservice/1.0"
    });

    const unauthorized = await post("/lip/v1/members/enroll", makeEnroll(), "wrong-key");
    expect(unauthorized.response.status).toBe(401);
    expect(unauthorized.response.headers.get("content-type")).toContain("application/problem+json");
    expect(unauthorized.body).toMatchObject({ code: "unauthorized", status: 401 });

    const invalid = await post("/lip/v1/members/enroll", { program_id: "demo-foodservice" });
    expect(invalid.response.status).toBe(422);
    expect(invalid.body).toMatchObject({
      code: "validation_failed",
      errors: expect.arrayContaining([expect.objectContaining({ message: expect.any(String) })])
    });
  });

  it("returns an idempotency conflict instead of repeating a changed request", async () => {
    const first = makeEnroll("http-shared-idempotency");
    expect((await post("/lip/v1/members/enroll", first)).response.status).toBe(201);
    first.identity.value = "changed-token";

    const conflict = await post("/lip/v1/members/enroll", first);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "idempotency_conflict", status: 409 });
  });
});
