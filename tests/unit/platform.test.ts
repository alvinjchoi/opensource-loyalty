import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoPlatform } from "@loyalty-interchange/server";

describe("seeded reference platform", () => {
  it("creates the restaurant demo once and hydrates it from SQLite on restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-platform-"));
    const databasePath = join(directory, "reference.db");
    try {
      const first = createDemoPlatform({ databasePath, reset: true, seed: true });
      const initial = first.engine.inspectAdmin();
      expect(initial.summary).toEqual({
        active_members: 6,
        points_outstanding: 4_910,
        points_issued: 5_940,
        points_redeemed: 1_000,
        expiring_points: 4_910,
        ledger_entries: 9
      });
      expect(initial.program.tiers.map((tier) => [
        tier.tier_id,
        initial.members.filter((member) => member.member.tier_id === tier.tier_id).length
      ])).toEqual([
        ["starter", 2],
        ["regular", 2],
        ["vip", 2]
      ]);
      first.close();

      const second = createDemoPlatform({ databasePath, seed: false });
      expect(second.engine.inspectAdmin()).toMatchObject({
        summary: initial.summary,
        members: expect.arrayContaining([
          expect.objectContaining({
            member: expect.objectContaining({
              member_id: "demo-member-003",
              tier_id: "vip"
            }),
            balance: expect.objectContaining({ amount: 1_200 })
          })
        ])
      });
      expect(second.engine.getLedger()).toHaveLength(9);
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
