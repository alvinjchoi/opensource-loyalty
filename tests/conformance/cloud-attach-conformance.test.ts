import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoPlatform, startReferenceServer } from "@loyalty-interchange/server";
import { runCloudVerification } from "@loyalty-interchange/cli";
import { MemoryCloudRepository } from "../../apps/cloud/src/memory-repository.js";
import { CloudControlPlane } from "../../apps/cloud/src/service.js";
import { startCloudServer } from "../../apps/cloud/src/server.js";

const fixedNow = new Date("2026-07-15T12:00:00.000Z");

// The apiKey auth mode derives the actor's issuer as the trusted gateway (see
// principal() in apps/cloud/src/server.ts), so the operator's org membership
// must be created under that same issuer for the HTTP attach call below to
// authorize as that operator.
const operator = {
  issuer: "urn:lip:trusted-gateway",
  subject: "conformance-operator-001",
  email: "conformance-operator@example.com"
};

function seedContext(key: string) {
  return {
    protocol_version: "1.0" as const,
    profile: "foodservice/1.0" as const,
    request_id: `req-${key}`,
    idempotency_key: key,
    occurred_at: "2026-07-18T00:00:00.000Z",
    source: { system: "seed" }
  };
}

describe("Cloud attach -> cloud-verify conformance", () => {
  it("creates an environment, attaches a real reference LIP host, and verifies it end to end", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-cloud-verify-conformance-"));
    const databasePath = join(directory, "reference.db");
    const platform = await createDemoPlatform({ databasePath, reset: true, seed: false });
    const lipApiKey = "lip_sk_conformance_0123456789abcdef";

    // Seed a known member so the doctor/conformance/member checks below have
    // something real to read, matching Task 1's seededServer fixture.
    platform.engine.enroll({
      context: seedContext("seed-enroll"),
      program_id: "demo-foodservice",
      identity: { type: "token", value: "known-guest" },
      member_id: "member-001"
    });

    const lipServer = await startReferenceServer(platform.engine, {
      apiKey: lipApiKey,
      port: 0
    });

    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({
      repository,
      now: () => new Date(fixedNow)
    });
    const cloudApiKey = "cloud-verify-conformance-key";
    const running = await startCloudServer(cloud, {
      apiKey: cloudApiKey,
      port: 0
    });
    const operatorHeaders = {
      authorization: `Bearer ${cloudApiKey}`,
      "content-type": "application/json",
      "x-lip-cloud-subject": operator.subject,
      "x-lip-cloud-email": operator.email
    };

    try {
      const dashboard = await cloud.createOrganization(operator, {
        name: "Conformance Restaurants",
        slug: "conformance-restaurants"
      });
      const project = await cloud.createProject(
        operator,
        dashboard.organization.organization_id,
        { name: "Conformance Loyalty", slug: "conformance-loyalty" }
      );
      const environment = await cloud.createEnvironment(operator, project.project_id, {
        name: "Staging",
        slug: "staging",
        kind: "staging",
        region: "us-east-1",
        program_id: platform.engine.getProgramDefinition().program_id
      });

      // The #4 attach flow: bind the environment to a real reference LIP host.
      const attach = await fetch(
        `${running.url}/cloud/v1/environments/${environment.environment_id}/attach`,
        {
          method: "POST",
          headers: operatorHeaders,
          body: JSON.stringify({ endpoint_url: lipServer.url, api_key: lipApiKey })
        }
      );
      expect(attach.status).toBe(200);
      const attachedEnv = (await attach.json() as {
        data: { status: string; api_url: string };
      }).data;
      expect(attachedEnv.status).toBe("ready");

      // The full path: run runCloudVerification against the attached api_url.
      const report = await runCloudVerification(
        { baseUrl: attachedEnv.api_url, apiKey: lipApiKey },
        {
          programId: "demo-foodservice",
          expectMember: { identity: { type: "token", value: "known-guest" }, available: 0 },
          expectMembers: 1
        }
      );

      expect(report.doctor.ok).toBe(true);
      expect(report.conformance.ok).toBe(true);
      expect(report.knownMember).toMatchObject({ ok: true });
      expect(report.memberCount).toMatchObject({ ok: true });
      expect(report.ok).toBe(true);
    } finally {
      await running.close();
      await cloud.close();
      await lipServer.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
