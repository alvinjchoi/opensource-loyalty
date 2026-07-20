import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoPlatform } from "@loyalty-interchange/server";
import {
  makeContext,
  makeEnroll,
  makeMembershipProgram,
  makeOrder
} from "../fixtures.js";

describe("paid membership platform", () => {
  it("persists membership, applies its multiplier, and gates configured rewards", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-memberships-"));
    const databasePath = join(directory, "reference.db");
    try {
      const first = await createDemoPlatform({
        databasePath,
        reset: true,
        seed: false,
        program: makeMembershipProgram()
      });
      first.engine.enroll(makeEnroll("membership-enroll"));
      const before = first.engine.evaluate({
        context: makeContext("membership-before"),
        member_id: "member-001",
        order: makeOrder({ order_id: "membership-order-before" })
      });
      expect(before.rewards.find(({ reward_id }) => reward_id === "one-dollar-off"))
        .toMatchObject({
          status: "unavailable",
          unavailable_reasons: expect.arrayContaining(["membership_required"])
        });

      await first.memberships.grant({
        member_id: "member-001",
        plan_id: "premium",
        valid_until: "2099-01-01T00:00:00.000Z",
        billing_reference: "billing-test-001"
      }, "test-admin");
      first.engine.enroll({
        ...makeEnroll("membership-enroll-2"),
        member_id: "member-002",
        identity: { type: "token", value: "membership-member-002" }
      });
      await expect(first.memberships.grant({
        member_id: "member-002",
        plan_id: "missing-plan",
        valid_until: "2099-01-01T00:00:00.000Z"
      }, "test-admin")).rejects.toThrowError(/plan/);
      await expect(first.memberships.grant({
        member_id: "member-002",
        plan_id: "premium",
        valid_from: "2099-01-02T00:00:00.000Z",
        valid_until: "2099-01-01T00:00:00.000Z"
      }, "test-admin")).rejects.toThrowError(/window/);
      await first.memberships.grant({
        member_id: "member-002",
        plan_id: "premium",
        valid_until: "2099-01-01T00:00:00.000Z"
      }, "test-admin");
      expect((await first.memberships.changeStatus("member-002", "cancelled", "test-admin")).status)
        .toBe("cancelled");
      expect(() => first.memberships.assertCompatibleProgram([])).toThrowError(/active members/);
      const preview = first.engine.evaluate({
        context: makeContext("membership-preview"),
        member_id: "member-001",
        order: makeOrder({ order_id: "membership-order" })
      });
      expect(preview.estimated_accrual.amount).toBe(165);
      first.engine.postAccrual({
        context: makeContext("membership-accrual"),
        member_id: "member-001",
        order: makeOrder({ order_id: "membership-order" })
      });
      expect(first.engine.evaluate({
        context: makeContext("membership-after"),
        member_id: "member-001",
        order: makeOrder({ order_id: "membership-next-order" })
      }).rewards.find(({ reward_id }) => reward_id === "one-dollar-off"))
        .toMatchObject({ status: "available" });
      await first.close();

      const second = await createDemoPlatform({
        databasePath,
        seed: false,
        program: makeMembershipProgram()
      });
      const restored = second.memberships.snapshot();
      expect(restored.memberships).toEqual(expect.arrayContaining([
        expect.objectContaining({
          member_id: "member-001",
          membership: expect.objectContaining({ plan_id: "premium", status: "active" })
        })
      ]));
      expect(restored.audit.map(({ action }) => action)).toContain("membership.granted");
      expect(await second.memberships.lapseExpired(
        "test-scheduler",
        new Date("2100-01-01T00:00:00.000Z")
      )).toBe(1);
      expect(second.memberships.snapshot().memberships.find(({ member_id: memberId }) =>
        memberId === "member-001"
      )?.membership.status).toBe("lapsed");
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
