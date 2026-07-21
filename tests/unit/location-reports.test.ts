import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { locationReport } from "@loyalty-interchange/server";
import { makeContext, makeEnroll, makeOrder, makeProgram, sequentialIds } from "../fixtures.js";

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
  });
});
