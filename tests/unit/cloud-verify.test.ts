import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { startReferenceServer } from "@loyalty-interchange/server";
import { makeProgram } from "../fixtures.js";
import { runCloudVerification } from "@loyalty-interchange/cli";

// Enroll one member with a known balance so the checks have something real to read.
async function seededServer() {
  const engine = new LoyaltyEngine(makeProgram());
  const ctx = (key: string) => ({
    protocol_version: "1.0" as const, profile: "foodservice/1.0" as const,
    request_id: `req-${key}`, idempotency_key: key,
    occurred_at: "2026-07-18T00:00:00.000Z", source: { system: "seed" }
  });
  engine.enroll({ context: ctx("seed-enroll"), program_id: "demo-foodservice",
    identity: { type: "token", value: "known-guest" }, member_id: "member-001" });
  const server = await startReferenceServer(engine, { apiKey: "verify-test-key", port: 0 });
  return { server, apiKey: "verify-test-key" };
}

describe("runCloudVerification", () => {
  it("passes doctor + conformance with no expectations", async () => {
    const { server, apiKey } = await seededServer();
    try {
      const r = await runCloudVerification({ baseUrl: server.url, apiKey });
      expect(r.doctor.ok).toBe(true);
      expect(r.conformance.ok).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.knownMember).toBeUndefined();
    } finally { await server.close(); }
  });

  it("verifies a known member's available balance", async () => {
    const { server, apiKey } = await seededServer();
    try {
      const r = await runCloudVerification({ baseUrl: server.url, apiKey }, {
        programId: "demo-foodservice",
        expectMember: { identity: { type: "token", value: "known-guest" }, available: 0 }
      });
      expect(r.knownMember).toMatchObject({ ok: true, expected: 0, actual: 0 });
      expect(r.ok).toBe(true);
    } finally { await server.close(); }
  });

  it("fails when the known member's balance differs", async () => {
    const { server, apiKey } = await seededServer();
    try {
      const r = await runCloudVerification({ baseUrl: server.url, apiKey }, {
        programId: "demo-foodservice",
        expectMember: { identity: { type: "token", value: "known-guest" }, available: 999 }
      });
      expect(r.knownMember).toMatchObject({ ok: false, expected: 999, actual: 0 });
      expect(r.ok).toBe(false);
    } finally { await server.close(); }
  });

  it("verifies the member count via the admin snapshot", async () => {
    const { server, apiKey } = await seededServer();
    try {
      const r = await runCloudVerification({ baseUrl: server.url, apiKey }, { expectMembers: 1 });
      expect(r.memberCount).toMatchObject({ ok: true, expected: 1, actual: 1 });
      expect(r.ok).toBe(true);
    } finally { await server.close(); }
  });

  it("degrades cleanly when the host is unreachable (no throw)", async () => {
    // A port with nothing listening; fetch should reject → caught → actual null.
    const r = await runCloudVerification(
      { baseUrl: "http://127.0.0.1:1", apiKey: "x" },
      { programId: "demo-foodservice", expectMember: { identity: { type: "token", value: "known-guest" }, available: 0 }, expectMembers: 1 }
    );
    expect(r.ok).toBe(false);
    expect(r.knownMember).toMatchObject({ ok: false, actual: null });
    expect(r.memberCount).toMatchObject({ ok: false, actual: null });
  });
});
