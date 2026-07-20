import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoPlatform } from "@loyalty-interchange/server";
import { makeContext, makeEnroll } from "../fixtures.js";

describe("campaign platform", () => {
  it("persists static segments and idempotently issues rewards to their members", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-campaigns-"));
    const databasePath = join(directory, "reference.db");
    try {
      const first = await createDemoPlatform({ databasePath, reset: true, seed: false });
      first.engine.enroll(makeEnroll("campaign-enroll-1"));
      first.engine.enroll({
        ...makeEnroll("campaign-enroll-2"),
        member_id: "member-002",
        identity: { type: "token", value: "guest-token-002", issuer: "test-identity" }
      });
      const segment = await first.campaigns.upsertSegment({
        name: "Launch guests",
        member_ids: ["member-001", "member-002", "member-002"]
      });
      const campaign = await first.campaigns.upsertCampaign({
        name: "Launch reward",
        reward_id: "five-off",
        segment_id: segment.segment_id,
        issued_reward_ttl_seconds: 3600
      });
      const run = await first.campaigns.runCampaign(campaign.campaign_id, "test-admin");
      expect(run).toMatchObject({ issued: 2, skipped: 0, failed: 0 });
      expect(first.engine.inspectAdmin().issued_rewards).toHaveLength(2);

      const replay = await first.campaigns.runCampaign(campaign.campaign_id, "test-admin");
      expect(replay).toMatchObject({ issued: 0, skipped: 2, failed: 0 });
      const wallet = first.engine.listIssuedRewards({
        context: makeContext("campaign-wallet"),
        member_id: "member-001",
        program_id: "demo-foodservice"
      });
      expect(wallet.issued_rewards[0]).toMatchObject({
        reward_id: "five-off",
        status: "issued"
      });
      await first.close();

      const second = await createDemoPlatform({ databasePath, seed: false });
      expect(second.campaigns.snapshot()).toMatchObject({
        segments: [{ segment_id: segment.segment_id }],
        campaigns: [{ campaign_id: campaign.campaign_id, status: "completed" }],
        runs: [{ skipped: 2 }, { issued: 2 }]
      });
      expect(second.engine.inspectAdmin().issued_rewards).toHaveLength(2);
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates references and prevents deleting an in-use segment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-campaign-validation-"));
    const platform = await createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false
    });
    try {
      await expect(platform.campaigns.upsertSegment({
        name: "Unknown",
        member_ids: ["missing-member"]
      })).rejects.toThrowError(/Unknown/);
      platform.engine.enroll(makeEnroll("campaign-validation-enroll"));
      const segment = await platform.campaigns.upsertSegment({
        name: "Known",
        member_ids: ["member-001"]
      });
      await expect(platform.campaigns.upsertCampaign({
        name: "Unknown reward",
        reward_id: "missing",
        segment_id: segment.segment_id
      })).rejects.toThrowError(/reward/);
      const campaign = await platform.campaigns.upsertCampaign({
        name: "Known reward",
        reward_id: "five-off",
        segment_id: segment.segment_id
      });
      await expect(platform.campaigns.deleteSegment(segment.segment_id))
        .rejects.toThrowError(/used/);
      await platform.campaigns.deleteCampaign(campaign.campaign_id);
      const expired = await platform.campaigns.upsertCampaign({
        name: "Expired",
        reward_id: "free-entree",
        segment_id: segment.segment_id,
        starts_at: "2024-01-01T00:00:00.000Z",
        ends_at: "2024-01-02T00:00:00.000Z"
      });
      await expect(platform.campaigns.runCampaign(expired.campaign_id, "test-admin"))
        .rejects.toThrowError(/ended/);
      await platform.campaigns.deleteCampaign(expired.campaign_id);
      await platform.campaigns.deleteSegment(segment.segment_id);
      const dynamic = await platform.campaigns.upsertSegment({
        name: "Active members",
        rules: { statuses: ["active"], minimum_available_balance: 0 }
      });
      const scheduled = await platform.campaigns.upsertCampaign({
        name: "Scheduled reward",
        reward_id: "free-entree",
        segment_id: dynamic.segment_id,
        starts_at: "2099-01-01T00:00:00.000Z"
      });
      expect(scheduled.status).toBe("scheduled");
      const runs = await platform.campaigns.runDueCampaigns(
        "test-scheduler",
        new Date("2099-01-01T00:00:01.000Z")
      );
      expect(runs).toEqual([expect.objectContaining({ issued: 1, failed: 0 })]);
      expect(platform.campaigns.snapshot().segments).toEqual([
        expect.objectContaining({ mode: "dynamic" })
      ]);
    } finally {
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
