import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import {
  createReferenceServer,
  createDemoPlatform,
  startReferenceServer,
  type StructuredRequestLog
} from "@loyalty-interchange/server";
import { makeContext, makeEnroll, makeProgram } from "../fixtures.js";

describe("reference HTTP server", () => {
  it("requires a nontrivial API key", () => {
    expect(() => createReferenceServer(new LoyaltyEngine(makeProgram()), { apiKey: "short" }))
      .toThrowError(/at least 8/);
  });

  it("commits protocol operations through an external transaction hook", async () => {
    const engine = new LoyaltyEngine(makeProgram());
    let executions = 0;
    let directPersists = 0;
    const running = await startReferenceServer(engine, {
      apiKey: "transaction-test-key",
      executeEngineOperation: async (operation) => {
        executions += 1;
        return operation();
      },
      persistState: () => {
        directPersists += 1;
      }
    });
    try {
      const response = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: {
          authorization: "Bearer transaction-test-key",
          "content-type": "application/json"
        },
        body: JSON.stringify(makeEnroll("transaction-hook-enroll"))
      });
      expect(response.status).toBe(201);
      expect(executions).toBe(1);
      expect(directPersists).toBe(0);
    } finally {
      await running.close();
    }
  });

  it("freezes protocol writes at startup while allowing reads and health", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "freeze-test-key",
      writeFrozen: true
    });
    try {
      // a write is rejected with a stable 503 problem + Retry-After
      const enroll = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer freeze-test-key", "content-type": "application/json" },
        body: JSON.stringify(makeEnroll("freeze-write-key"))
      });
      expect(enroll.status).toBe(503);
      expect(enroll.headers.get("content-type")).toContain("application/problem+json");
      expect(enroll.headers.get("retry-after")).toBeTruthy();
      expect((await enroll.json()).code).toBe("write_frozen");

      // a read still works
      const program = await fetch(`${running.url}/lip/v1/programs/get`, {
        method: "POST",
        headers: { authorization: "Bearer freeze-test-key", "content-type": "application/json" },
        body: JSON.stringify({ context: makeContext("freeze-read-key"), program_id: "demo-foodservice" })
      });
      expect(program.status).toBe(200);

      // health reflects the freeze
      const health = await (await fetch(`${running.url}/health`)).json();
      expect(health).toMatchObject({ status: "ok", write_frozen: true });
    } finally {
      await running.close();
    }
  });

  it("defaults to unfrozen (writes allowed, health write_frozen false)", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), { apiKey: "unfrozen-key" });
    try {
      const health = await (await fetch(`${running.url}/health`)).json();
      expect(health.write_frozen).toBe(false);
      const enroll = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer unfrozen-key", "content-type": "application/json" },
        body: JSON.stringify(makeEnroll("unfrozen-write-key"))
      });
      expect(enroll.status).toBe(201);
    } finally {
      await running.close();
    }
  });

  it("returns problem details for routes, methods, media types, JSON, and body limits", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "server-test-key"
    });
    try {
      const missing = await fetch(`${running.url}/missing`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "not_found" });

      const wrongMethod = await fetch(`${running.url}/lip/v1/members/enroll`, {
        headers: { authorization: "Bearer server-test-key" }
      });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("POST");
      expect(await wrongMethod.json()).toMatchObject({ code: "method_not_allowed" });

      const postToGetRoute = await fetch(`${running.url}/health`, { method: "POST" });
      expect(postToGetRoute.status).toBe(405);
      expect(postToGetRoute.headers.get("allow")).toBe("GET");

      const discovery = await fetch(`${running.url}/.well-known/lip`);
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({
        protocol: "LIP",
        endpoints: { capabilities: "/lip/v1/capabilities" }
      });

      const capabilities = await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: "Bearer server-test-key" }
      });
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({
        protocol_version: "1.0",
        operations: expect.arrayContaining([
          "order.evaluate",
          "redemption.reserve",
          "program.get",
          "account.get",
          "ledger.list",
          "ledger.manual_adjustment"
        ])
      });

      const wrongType = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer server-test-key", "content-type": "text/plain" },
        body: "{}"
      });
      expect(wrongType.status).toBe(415);
      expect(await wrongType.json()).toMatchObject({ code: "unsupported_media_type" });

      const malformed = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer server-test-key", "content-type": "application/json" },
        body: "{not-json"
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ code: "invalid_json" });

      const tooLarge = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer server-test-key", "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(1_048_576) })
      });
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({ code: "payload_too_large" });
    } finally {
      await running.close();
    }
  });

  it("rate limits authenticated clients and emits structured request logs", async () => {
    const logs: StructuredRequestLog[] = [];
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "rate-test-key",
      rateLimit: { maxRequests: 2, windowMs: 60_000 },
      requestLogger: (entry) => logs.push(entry)
    });
    try {
      for (const requestId of ["request-one", "request-two"]) {
        const response = await fetch(`${running.url}/lip/v1/capabilities`, {
          headers: {
            authorization: "Bearer rate-test-key",
            "x-request-id": requestId
          }
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toBe(requestId);
        expect(response.headers.get("ratelimit-limit")).toBe("2");
        await response.json();
      }

      const limited = await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: "Bearer rate-test-key" }
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect(limited.headers.get("ratelimit-remaining")).toBe("0");
      expect(await limited.json()).toMatchObject({ code: "rate_limit_exceeded" });

      expect(logs).toHaveLength(3);
      expect(logs.map((entry) => entry.status)).toEqual([200, 200, 429]);
      expect(logs[0]).toMatchObject({
        request_id: "request-one",
        method: "GET",
        path: "/lip/v1/capabilities",
        status: 200
      });
      expect(logs[0]?.duration_ms).toBeGreaterThanOrEqual(0);

      const metrics = await fetch(`${running.url}/metrics`, {
        headers: { authorization: "Bearer rate-test-key" }
      });
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      const metricsBody = await metrics.text();
      expect(metricsBody).toContain(
        'lip_http_requests_total{method="GET",path="/lip/v1/capabilities",status="200"} 2'
      );
      expect(metricsBody).toContain(
        'lip_http_requests_total{method="GET",path="/lip/v1/capabilities",status="429"} 1'
      );
    } finally {
      await running.close();
    }
  });

  it("serves an authenticated, non-normative Admin snapshot and persists operations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-admin-assets-"));
    writeFileSync(join(directory, "index.html"), "<!doctype html><title>LIP Admin</title>");
    const persisted: unknown[] = [];
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "admin-test-key",
      persistState: (state) => persisted.push(state),
      admin: {
        assetRoot: directory,
        storage: { driver: "sqlite", location: "/tmp/reference.db", persistent: true },
        webhooks: () => ({
          enabled: true,
          pending: [{
            delivery_id: "delivery-001",
            event_id: "event-001",
            event_type: "org.loyalty-interchange.order.accrued.v1",
            url: "https://receiver.example/hooks",
            attempts: 2,
            created_at: "2026-07-15T00:00:00.000Z",
            updated_at: "2026-07-15T00:01:00.000Z",
            last_error: "receiver responded with HTTP 503"
          }],
          recent: []
        })
      }
    });
    try {
      const redirect = await fetch(`${running.url}/admin`, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/admin/");

      const admin = await fetch(`${running.url}/admin/`);
      expect(admin.status).toBe(200);
      expect(await admin.text()).toContain("LIP Admin");

      const bootstrap = await fetch(`${running.url}/admin/api/v1/bootstrap`);
      expect(bootstrap.status).toBe(200);
      const bootstrapBody = await bootstrap.text();
      expect(bootstrapBody).not.toContain("admin-test-key");
      expect(JSON.parse(bootstrapBody)).toMatchObject({
        admin_api_version: "0.4",
        auth: {
          mode: "api_key",
          requires_login: true,
          default_local_key: false,
          credential_hint: "Copy the Admin/API key from the terminal that started this server. Docker users can run docker compose logs lip."
        },
        session: { authenticated: false },
        platform: {
          protocol_version: "1.0",
          profile: "foodservice/1.0",
          storage: { driver: "sqlite", persistent: true }
        },
        onboarding: {
          steps: expect.arrayContaining([
            expect.objectContaining({ id: "signin", status: "next" }),
            expect.objectContaining({ id: "configure-program", status: "ready" })
          ])
        },
        links: { admin: "/admin/", api: "/lip/v1" }
      });

      const unauthorized = await fetch(`${running.url}/admin/api/v1/snapshot`);
      expect(unauthorized.status).toBe(401);

      const rejected = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "incorrect-key" })
      });
      expect(rejected.status).toBe(401);

      const login = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "admin-test-key" })
      });
      expect(login.status).toBe(204);
      const cookie = login.headers.get("set-cookie");
      expect(cookie).toContain("lip_admin_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      // Plain-HTTP request (no TLS, no forwarded proto): Secure would make the
      // cookie undeliverable, so it must be omitted for local development.
      expect(cookie).not.toContain("Secure");

      const authenticatedBootstrap = await fetch(`${running.url}/admin/api/v1/bootstrap`, {
        headers: { cookie: cookie! }
      });
      expect(authenticatedBootstrap.status).toBe(200);
      expect(await authenticatedBootstrap.json()).toMatchObject({
        session: { authenticated: true }
      });

      const enrollment = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-test-key",
          "content-type": "application/json"
        },
        body: JSON.stringify(makeEnroll("admin-server-enroll-key"))
      });
      expect(enrollment.status).toBe(201);

      const manual = await fetch(`${running.url}/lip/v1/ledger/manual-adjustments`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-test-key",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          context: makeContext("admin-manual-adjustment-key"),
          member_id: "member-001",
          program_id: "demo-foodservice",
          adjustment_id: "manual-admin-001",
          amount: 40,
          classification: "service_recovery",
          reason: "Guest support credit",
          qualifies_for_tier: false
        })
      });
      expect(manual.status).toBe(201);
      expect(await manual.json()).toMatchObject({
        entry: {
          operation: "manual",
          amount: 40,
          classification: "service_recovery"
        },
        balances: [{ amount: 40 }]
      });

      const snapshot = await fetch(`${running.url}/admin/api/v1/snapshot`, {
        headers: { cookie: cookie! }
      });
      expect(snapshot.status).toBe(200);
      expect(await snapshot.json()).toMatchObject({
        admin_api_version: "0.4",
        platform: { storage: { driver: "sqlite", persistent: true } },
        webhooks: {
          enabled: true,
          pending: [{
            delivery_id: "delivery-001",
            attempts: 2,
            last_error: "receiver responded with HTTP 503"
          }],
          recent: []
        },
        program_configuration: {
          current_model_id: "points",
          templates: expect.arrayContaining([
            expect.objectContaining({ model_id: "points", status: "active" }),
            expect.objectContaining({ model_id: "visits", status: "available" }),
            expect.objectContaining({ model_id: "wallet_credit", status: "available" })
          ])
        },
        summary: { active_members: 1 },
        members: [{ member: { member_id: "member-001" } }]
      });
      expect(persisted).toHaveLength(3);
    } finally {
      await running.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("marks admin cookies Secure when the edge terminates TLS", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "admin-test-key",
      admin: { storage: { driver: "sqlite", location: ":memory:", persistent: false } }
    });
    try {
      const login = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https"
        },
        body: JSON.stringify({ api_key: "admin-test-key" })
      });
      expect(login.status).toBe(204);
      const cookie = login.headers.get("set-cookie");
      expect(cookie).toContain("lip_admin_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Secure");

      const logout = await fetch(`${running.url}/admin/api/v1/logout`, {
        method: "POST",
        headers: { "x-forwarded-proto": "https, http" }
      });
      expect(logout.status).toBe(204);
      // Deletion cookie must carry matching attributes so the browser evicts it.
      expect(logout.headers.get("set-cookie")).toContain("Secure");
    } finally {
      await running.close();
    }
  });

  it("protects live program draft, publish, and rollback writes with CSRF", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-program-admin-"));
    const databasePath = join(directory, "reference.db");
    const platform = createDemoPlatform({
      databasePath,
      reset: true,
      seed: false,
      program: makeProgram()
    });
    platform.engine.enroll(makeEnroll("campaign-admin-enroll"));
    const running = await startReferenceServer(platform.engine, {
      apiKey: "program-admin-key",
      persistState: (state) => platform.store.save(state),
      admin: {
        programs: platform.programs,
        campaigns: platform.campaigns,
        webhookManager: platform.webhooks,
        access: platform.access,
        engagement: platform.engagement,
        storage: platform.store.status
      }
    });
    try {
      const login = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "program-admin-key" })
      });
      expect(login.status).toBe(204);
      const setCookies = login.headers.getSetCookie();
      const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
      const csrf = decodeURIComponent(
        setCookies
          .find((value) => value.startsWith("lip_admin_csrf="))!
          .split(";", 1)[0]!
          .slice("lip_admin_csrf=".length)
      );
      const changed = {
        ...makeProgram(),
        name: "Admin-published program",
        earn_rate: { points: 4, spend_minor_units: 100 }
      };

      const webhook = await fetch(`${running.url}/admin/api/v1/webhooks/subscription`, {
        method: "PUT",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({
          url: "https://receiver.example/hooks",
          secret: "server-test-secret-value"
        })
      });
      expect(webhook.status).toBe(200);
      const webhookBody = await webhook.json() as { subscription_id: string };
      expect(platform.webhooks.listSubscriptions()).toEqual([
        expect.objectContaining({ subscription_id: webhookBody.subscription_id })
      ]);

      const apiKeyResponse = await fetch(`${running.url}/admin/api/v1/access/api-keys`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({ name: "Test integration", role: "integration" })
      });
      expect(apiKeyResponse.status).toBe(201);
      const createdKey = await apiKeyResponse.json() as {
        secret: string;
        api_key: { key_id: string };
      };
      expect(createdKey.secret).toMatch(/^lip_sk_/);
      const scopedCapabilities = await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: `Bearer ${createdKey.secret}` }
      });
      expect(scopedCapabilities.status).toBe(200);
      const rejectedAdmin = await fetch(`${running.url}/admin/api/v1/snapshot`, {
        headers: { authorization: `Bearer ${createdKey.secret}` }
      });
      expect(rejectedAdmin.status).toBe(401);

      const segmentResponse = await fetch(`${running.url}/admin/api/v1/segments`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({ name: "Admin segment", member_ids: ["member-001"] })
      });
      expect(segmentResponse.status).toBe(200);
      const segment = await segmentResponse.json() as { segment_id: string };
      const connectorResponse = await fetch(
        `${running.url}/admin/api/v1/engagement/connectors`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
          body: JSON.stringify({
            name: "CRM",
            type: "webhook",
            configuration: { url: "https://crm.example/messages" },
            secret: "engagement-test-secret"
          })
        }
      );
      expect(connectorResponse.status).toBe(200);
      const connector = await connectorResponse.json() as { connector_id: string };
      const messageResponse = await fetch(`${running.url}/admin/api/v1/engagement/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({
          idempotency_key: "admin-message-001",
          connector_id: connector.connector_id,
          segment_id: segment.segment_id,
          template_id: "receipt-follow-up",
          content: { text: "Thanks for visiting" },
          purpose: "transactional"
        })
      });
      expect(messageResponse.status).toBe(201);
      expect(await messageResponse.json()).toMatchObject({
        status: "queued",
        deliveries: [expect.objectContaining({ member_id: "member-001", status: "pending" })]
      });
      const analyticsResponse = await fetch(`${running.url}/admin/api/v1/analytics`, {
        headers: { cookie }
      });
      expect(analyticsResponse.status).toBe(200);
      expect(await analyticsResponse.json()).toMatchObject({
        members: { total: 1, active: 1 }
      });
      const exportResponse = await fetch(
        `${running.url}/admin/api/v1/exports/members?format=json&include_unconsented=true`,
        { headers: { cookie } }
      );
      expect(exportResponse.status).toBe(200);
      expect(await exportResponse.json()).toMatchObject({
        members: [expect.objectContaining({ member_id: "member-001" })]
      });
      const campaignResponse = await fetch(`${running.url}/admin/api/v1/campaigns`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({
          name: "Admin campaign",
          reward_id: "one-dollar-off",
          segment_id: segment.segment_id
        })
      });
      expect(campaignResponse.status).toBe(200);
      const campaign = await campaignResponse.json() as { campaign_id: string };
      const runCampaign = await fetch(`${running.url}/admin/api/v1/campaigns/run`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({ campaign_id: campaign.campaign_id })
      });
      expect(runCampaign.status).toBe(200);
      expect(await runCampaign.json()).toMatchObject({ issued: 1, failed: 0 });

      const rewardDraft = await fetch(`${running.url}/admin/api/v1/program/rewards`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({
          reward: {
            ...makeProgram().rewards[0],
            reward_id: "admin-created-reward",
            name: "Admin created reward"
          }
        })
      });
      expect(rewardDraft.status).toBe(200);
      expect(await rewardDraft.json()).toMatchObject({
        draft: { validation: { ok: true } }
      });

      const rejected = await fetch(`${running.url}/admin/api/v1/program/draft`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ program: changed })
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ code: "csrf_failed" });

      const draft = await fetch(`${running.url}/admin/api/v1/program/draft`, {
        method: "PUT",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({ program: changed })
      });
      expect(draft.status).toBe(200);
      const draftBody = await draft.json() as {
        draft: { version: number; validation: { ok: boolean } };
      };
      expect(draftBody.draft.validation.ok).toBe(true);

      const published = await fetch(`${running.url}/admin/api/v1/program/publish`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({ expected_draft_version: draftBody.draft.version })
      });
      expect(published.status).toBe(200);
      expect(await published.json()).toMatchObject({
        active_revision: 2,
        active_program: { name: "Admin-published program" }
      });
      expect(platform.engine.inspectAdmin().program.earning.rate.amount).toBe(4);

      const rolledBack = await fetch(`${running.url}/admin/api/v1/program/rollback`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({ revision: 1 })
      });
      expect(rolledBack.status).toBe(200);
      expect(platform.engine.inspectAdmin().program.earning.rate.amount).toBe(
        makeProgram().earn_rate.points
      );

      const revokedKey = await fetch(
        `${running.url}/admin/api/v1/access/api-keys/revoke`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
          body: JSON.stringify({ key_id: createdKey.api_key.key_id })
        }
      );
      expect(revokedKey.status).toBe(200);
      expect(await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: `Bearer ${createdKey.secret}` }
      })).toHaveProperty("status", 401);
      expect(platform.access.snapshot().audit.map(({ action }) => action)).toContain(
        "access.api_key.revoked"
      );

      const deletedWebhook = await fetch(
        `${running.url}/admin/api/v1/webhooks/subscription/delete`,
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "x-lip-csrf": csrf
          },
          body: JSON.stringify({ subscription_id: webhookBody.subscription_id })
        }
      );
      expect(deletedWebhook.status).toBe(200);
      expect(platform.webhooks.listSubscriptions()).toEqual([]);

      const webhookHealth = await fetch(`${running.url}/admin/api/v1/webhooks/health`, {
        headers: { cookie }
      });
      expect(webhookHealth.status).toBe(200);
      expect(await webhookHealth.json()).toMatchObject({
        enabled: false,
        pending_count: 0,
        healthy: false
      });

      const cancelMember = await fetch(`${running.url}/admin/api/v1/members/cancel`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({ member_id: "member-001" })
      });
      expect(cancelMember.status).toBe(200);
      expect(await cancelMember.json()).toMatchObject({
        member: { member_id: "member-001", status: "closed" }
      });
    } finally {
      await running.close();
      platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
