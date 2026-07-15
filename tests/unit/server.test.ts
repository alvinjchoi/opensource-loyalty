import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import {
  createReferenceServer,
  startReferenceServer,
  type StructuredRequestLog
} from "@loyalty-interchange/server";
import { makeContext, makeEnroll, makeProgram } from "../fixtures.js";

describe("reference HTTP server", () => {
  it("requires a nontrivial API key", () => {
    expect(() => createReferenceServer(new LoyaltyEngine(makeProgram()), { apiKey: "short" }))
      .toThrowError(/at least 8/);
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
        admin_api_version: "0.1",
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
        admin_api_version: "0.1",
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
            expect.objectContaining({ model_id: "visits", status: "planned" })
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
});
