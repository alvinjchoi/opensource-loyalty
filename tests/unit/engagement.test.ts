import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import {
  CampaignService,
  EngagementService,
  engagementAnalytics,
  memberExport,
  type ConnectorDelivery,
  type MessagingConnectorAdapter
} from "@loyalty-interchange/server";
import { makeEnroll, makeProgram } from "../fixtures.js";

class RecordingAdapter implements MessagingConnectorAdapter {
  public readonly type = "recording";
  public readonly deliveries: ConnectorDelivery[] = [];

  public async deliver(input: { delivery: ConnectorDelivery }): Promise<void> {
    this.deliveries.push(structuredClone(input.delivery));
  }
}

describe("engagement integrations", () => {
  it("queues consent-aware segment messages, delivers idempotently, and persists jobs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-engagement-"));
    const path = join(directory, "reference.db");
    const engine = new LoyaltyEngine(makeProgram());
    const consented = makeEnroll("engagement-consented");
    consented.attributes = {
      email: "=formula@example.com",
      marketing_consent: true
    };
    engine.enroll(consented);
    const unconsented = makeEnroll("engagement-unconsented");
    unconsented.member_id = "member-002";
    unconsented.identity.value = "guest-token-002";
    unconsented.attributes = {
      email: "private@example.com",
      marketing_consent: false
    };
    engine.enroll(unconsented);
    const campaigns = new CampaignService({
      path,
      engine,
      persistEngine: () => undefined,
      reset: true
    });
    campaigns.upsertSegment({
      segment_id: "all-members",
      name: "All members",
      member_ids: ["member-001", "member-002"]
    });
    const adapter = new RecordingAdapter();
    let engagement = new EngagementService({
      path,
      engine,
      campaigns,
      reset: true,
      schedulerIntervalMs: false,
      adapters: [adapter]
    });
    try {
      const connector = engagement.upsertConnector({
        connector_id: "crm",
        name: "CRM",
        type: "recording",
        configuration: { audience: "loyalty" },
        secret: "sixteen-byte-secret"
      });
      expect(connector).not.toHaveProperty("secret");
      expect(JSON.stringify(engagement.snapshot())).not.toContain("sixteen-byte-secret");

      const queued = engagement.enqueue({
        idempotency_key: "message-once",
        connector_id: "crm",
        segment_id: "all-members",
        template_id: "points-update",
        content: { text: "You earned points" }
      });
      expect(queued.deliveries).toEqual(expect.arrayContaining([
        expect.objectContaining({ member_id: "member-001", status: "pending" }),
        expect.objectContaining({
          member_id: "member-002",
          status: "skipped",
          error: "marketing_consent_required"
        })
      ]));
      const repeated = engagement.enqueue({
        idempotency_key: "message-once",
        connector_id: "crm",
        segment_id: "all-members",
        template_id: "points-update",
        content: { text: "You earned points" }
      });
      expect(repeated.job_id).toBe(queued.job_id);
      expect(() => engagement.enqueue({
        idempotency_key: "message-once",
        connector_id: "crm",
        segment_id: "all-members",
        template_id: "changed",
        content: { text: "Changed" }
      })).toThrowError(/different facts/);

      const completed = await engagement.runJob(queued.job_id);
      expect(completed.status).toBe("completed");
      expect(adapter.deliveries).toHaveLength(1);
      expect(adapter.deliveries[0]).toMatchObject({
        member: { member_id: "member-001" },
        purpose: "marketing"
      });

      engagement.close();
      engagement = new EngagementService({
        path,
        engine,
        campaigns,
        schedulerIntervalMs: false,
        adapters: [adapter]
      });
      expect(engagement.snapshot().jobs[0]).toMatchObject({
        job_id: queued.job_id,
        status: "completed"
      });
      expect(() => engagement.removeConnector("crm")).not.toThrow();
    } finally {
      engagement.close();
      campaigns.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("aggregates engagement analytics and exports consent-safe CRM rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-engagement-analytics-"));
    const path = join(directory, "reference.db");
    const engine = new LoyaltyEngine(makeProgram());
    const enrollment = makeEnroll("analytics-enroll");
    enrollment.attributes = { email: "+customer@example.com", marketing_consent: true };
    engine.enroll(enrollment);
    const campaigns = new CampaignService({
      path,
      engine,
      persistEngine: () => undefined,
      reset: true
    });
    try {
      const analytics = engagementAnalytics(engine, campaigns);
      expect(analytics.members).toEqual({
        total: 1,
        active: 1,
        marketing_consented: 1
      });
      expect(memberExport(engine, { format: "json", marketingOnly: true })).toEqual([
        expect.objectContaining({ member_id: "member-001", marketing_consent: true })
      ]);
      const csv = memberExport(engine, { format: "csv", marketingOnly: true }) as string;
      expect(csv).toContain("\"'+customer@example.com\"");
    } finally {
      campaigns.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
