import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { createReferenceServer, startReferenceServer } from "@loyalty-interchange/server";
import { makeEnroll, makeProgram } from "../fixtures.js";

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
          "ledger.list"
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

  it("serves an authenticated, non-normative Admin snapshot and persists operations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-admin-assets-"));
    writeFileSync(join(directory, "index.html"), "<!doctype html><title>LIP Admin</title>");
    const persisted: unknown[] = [];
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "admin-test-key",
      persistState: (state) => persisted.push(state),
      admin: {
        assetRoot: directory,
        storage: { driver: "sqlite", location: "/tmp/reference.db", persistent: true }
      }
    });
    try {
      const redirect = await fetch(`${running.url}/admin`, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/admin/");

      const admin = await fetch(`${running.url}/admin/`);
      expect(admin.status).toBe(200);
      expect(await admin.text()).toContain("LIP Admin");

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

      const enrollment = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-test-key",
          "content-type": "application/json"
        },
        body: JSON.stringify(makeEnroll("admin-server-enroll-key"))
      });
      expect(enrollment.status).toBe(201);

      const snapshot = await fetch(`${running.url}/admin/api/v1/snapshot`, {
        headers: { cookie: cookie! }
      });
      expect(snapshot.status).toBe(200);
      expect(await snapshot.json()).toMatchObject({
        admin_api_version: "0.1",
        platform: { storage: { driver: "sqlite", persistent: true } },
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
      expect(persisted).toHaveLength(2);
    } finally {
      await running.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
