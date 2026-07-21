import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { locationReport } from "@loyalty-interchange/server";
import {
  makeContext,
  makeEnroll,
  makeOrder,
  makeProgram,
  MutableClock,
  sequentialIds
} from "../fixtures.js";

function engineWithLocationActivity(): LoyaltyEngine {
  const engine = new LoyaltyEngine(makeProgram(), { ids: sequentialIds() });
  engine.enroll(makeEnroll());
  engine.postAccrual({
    context: makeContext("report-accrual-42"),
    member_id: "member-001",
    order: makeOrder()
  });
  const seventySeven = makeOrder({ order_id: "order-2002" });
  seventySeven.scope.location_id = "location-77";
  delete seventySeven.scope.franchisee_id;
  engine.postAccrual({
    context: makeContext("report-accrual-77"),
    member_id: "member-001",
    order: seventySeven
  });
  engine.reserve({
    context: makeContext("report-reserve-42"),
    redemption_id: "redemption-report-001",
    member_id: "member-001",
    reward_id: "one-dollar-off",
    order: makeOrder()
  });
  const reservationId = engine.inspectAdmin().reservations[0]!.reservation_id;
  engine.capture({
    context: makeContext("report-capture-42"),
    reservation_id: reservationId,
    order_id: "order-1001"
  });
  engine.postManualAdjustment({
    context: makeContext("report-manual"),
    member_id: "member-001",
    program_id: "demo-foodservice",
    adjustment_id: "manual-report-001",
    amount: 25,
    classification: "service_recovery",
    reason: "Spilled drink",
    qualifies_for_tier: false
  });
  return engine;
}

describe("per-location reporting", () => {
  it("attributes ledger and reservation activity by order location", () => {
    const engine = engineWithLocationActivity();
    const report = locationReport(engine, {
      locations: [
        {
          location_id: "location-42",
          name: "Downtown Drive-Thru",
          franchisee_id: "franchisee-7",
          active: true,
          created_at: "2026-07-14T10:00:00.000Z",
          updated_at: "2026-07-14T10:00:00.000Z"
        },
        {
          location_id: "location-99",
          name: "Not Yet Open",
          active: false,
          created_at: "2026-07-14T10:00:00.000Z",
          updated_at: "2026-07-14T10:00:00.000Z"
        }
      ]
    });

    expect(report.generated_at).toEqual(expect.any(String));
    expect(report.locations.map(({ location_id }) => location_id)).toEqual([
      "location-42",
      "location-77",
      "location-99"
    ]);
    expect(report.locations[0]).toMatchObject({
      location_id: "location-42",
      registered: true,
      name: "Downtown Drive-Thru",
      franchisee_id: "franchisee-7",
      active: true,
      orders_accrued: 1,
      ledger_entries: 2,
      activity: [{ unit: "points", accrued: 110, redeemed: 100 }],
      reservations: { reserved: 0, captured: 1, reversed: 0 }
    });
    expect(report.locations[1]).toMatchObject({
      location_id: "location-77",
      registered: false,
      orders_accrued: 1,
      ledger_entries: 1,
      activity: [{ unit: "points", accrued: 132, redeemed: 0 }],
      reservations: { reserved: 0, captured: 0, reversed: 0 }
    });
    expect(report.locations[1]?.name).toBeUndefined();
    expect(report.locations[2]).toMatchObject({
      location_id: "location-99",
      registered: true,
      active: false,
      orders_accrued: 0,
      ledger_entries: 0,
      activity: [],
      reservations: { reserved: 0, captured: 0, reversed: 0 }
    });
    expect(report.unattributed).toMatchObject({
      ledger_entries: 1,
      activity: [{ unit: "points", manual: 25 }]
    });
  });

  it("filters the report to the caller's location scope and hides the rest", () => {
    const engine = engineWithLocationActivity();
    const report = locationReport(engine, { scope: ["location-77"] });
    expect(report.locations.map(({ location_id }) => location_id)).toEqual(["location-77"]);
    expect(report.unattributed).toBeUndefined();
    // Scoped callers still learn that data exists outside their view (the
    // manual adjustment), without seeing any amounts.
    expect(report.unattributed_present).toBe(true);
  });

  it("reports unattributed_present false for scoped callers when everything is attributed", () => {
    const engine = new LoyaltyEngine(makeProgram(), { ids: sequentialIds() });
    engine.enroll(makeEnroll());
    engine.postAccrual({
      context: makeContext("clean-accrual"),
      member_id: "member-001",
      order: makeOrder()
    });
    const report = locationReport(engine, { scope: ["location-42"] });
    expect(report.unattributed_present).toBe(false);
    // Unscoped callers keep the full bucket and no presence flag.
    const full = locationReport(engine);
    expect(full.unattributed_present).toBeUndefined();
    expect(full.unattributed).toBeDefined();
  });

  it("counts expired reservations by status", () => {
    const clock = new MutableClock();
    const engine = new LoyaltyEngine(makeProgram(), { ids: sequentialIds(), clock });
    engine.enroll(makeEnroll());
    engine.postAccrual({
      context: makeContext("expired-accrual"),
      member_id: "member-001",
      order: makeOrder()
    });
    engine.reserve({
      context: makeContext("expired-reserve"),
      redemption_id: "redemption-expired-001",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: makeOrder()
    });
    clock.advance(300);
    const report = locationReport(engine);
    const row = report.locations.find(({ location_id }) => location_id === "location-42");
    expect(row?.reservations).toEqual({
      reserved: 0,
      captured: 0,
      reversed: 0,
      expired: 1
    });
  });

  it("attributes redemptions and reversals to the reserving order's own location", () => {
    const engine = new LoyaltyEngine(makeProgram(), { ids: sequentialIds() });
    engine.enroll(makeEnroll());
    // Balance is earned online; the guest redeems in store at location-42 on
    // an order that never accrued anything.
    const onlineOrder = makeOrder({ order_id: "order-online-1" });
    onlineOrder.scope.location_id = "location-online";
    engine.postAccrual({
      context: makeContext("xloc-accrual"),
      member_id: "member-001",
      order: onlineOrder
    });
    const inStoreOrder = makeOrder({ order_id: "order-instore-1" });
    const reserved = engine.reserve({
      context: makeContext("xloc-reserve"),
      redemption_id: "redemption-xloc",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: inStoreOrder
    });
    expect(reserved.reservation.location_id).toBe("location-42");
    engine.capture({
      context: makeContext("xloc-capture"),
      reservation_id: reserved.reservation.reservation_id,
      order_id: "order-instore-1"
    });

    const captured = locationReport(engine);
    const inStore = captured.locations.find(({ location_id }) => location_id === "location-42");
    expect(inStore).toMatchObject({
      orders_accrued: 0,
      ledger_entries: 1,
      activity: [{ unit: "points", accrued: 0, redeemed: 100 }],
      reservations: { reserved: 0, captured: 1, reversed: 0 }
    });
    const online = captured.locations.find(({ location_id }) => location_id === "location-online");
    expect(online?.activity[0]).toMatchObject({ redeemed: 0 });
    expect(captured.unattributed).toMatchObject({ ledger_entries: 0 });

    engine.reverse({
      context: makeContext("xloc-reverse"),
      reservation_id: reserved.reservation.reservation_id,
      reason: "Guest cancelled at the counter"
    });
    const reversedReport = locationReport(engine);
    const reversedRow = reversedReport.locations
      .find(({ location_id }) => location_id === "location-42");
    expect(reversedRow).toMatchObject({
      ledger_entries: 2,
      activity: [{ unit: "points", redeemed: 100, reversed: 100 }],
      reservations: { reserved: 0, captured: 0, reversed: 1 }
    });
  });

  it("falls back to the accrual order map for pre-upgrade entries without a stamped location", () => {
    const engine = engineWithLocationActivity();
    // Simulate state written before location stamping existed.
    const state = engine.exportState();
    const legacy = structuredClone(state);
    for (const [, entry] of legacy.ledger) {
      if (entry.operation === "redemption" || entry.operation === "reversal") {
        delete entry.location_id;
      }
    }
    for (const [, reservation] of legacy.reservations) {
      delete reservation.location_id;
    }
    const restored = new LoyaltyEngine(makeProgram(), { state: legacy });
    const report = locationReport(restored);
    const row = report.locations.find(({ location_id }) => location_id === "location-42");
    // The redemption on order-1001 still books to location-42 via the map.
    expect(row?.activity[0]).toMatchObject({ redeemed: 100 });
    expect(row?.reservations).toMatchObject({ captured: 1 });
  });
});
