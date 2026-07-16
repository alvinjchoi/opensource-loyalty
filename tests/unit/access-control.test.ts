import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccessControlService } from "@loyalty-interchange/server";

describe("tenant access control", () => {
  it("persists scoped users, one-time API keys, authorization, and audit", () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-"));
    const databasePath = join(directory, "reference.db");
    try {
      const first = new AccessControlService({
        path: databasePath,
        tenantId: "tenant-sakura",
        tenantName: "Sakura Japan",
        reset: true
      });
      const root = first.rootPrincipal();
      const user = first.upsertUser({
        email: " Operator@Sakura.Example ",
        name: "Store Operator",
        role: "operator"
      }, root);
      expect(user).toMatchObject({
        tenant_id: "tenant-sakura",
        email: "operator@sakura.example",
        role: "operator",
        active: true
      });
      expect(first.principalForUser(user.user_id)).toMatchObject({
        actor_id: user.user_id,
        actor_type: "user",
        role: "operator"
      });
      first.upsertUser({ user_id: user.user_id, email: user.email, role: user.role, active: false }, root);
      expect(first.principalForUser(user.user_id)).toBeUndefined();
      first.upsertUser({ user_id: user.user_id, email: user.email, role: user.role, active: true }, root);
      expect(() => first.upsertUser({
        email: "not-an-email",
        role: "viewer"
      }, root)).toThrowError(/valid user email/);
      expect(() => first.upsertUser({
        email: "invalid-role@sakura.example",
        role: "unknown" as never
      }, root)).toThrowError(/Unknown tenant role/);
      expect(() => first.createApiKey({
        name: "Expired integration",
        role: "integration",
        expires_at: "2020-01-01T00:00:00.000Z"
      }, root)).toThrowError(/expiration must be in the future/);

      const created = first.createApiKey({
        name: "Sakura mobile BFF",
        role: "integration",
        expires_at: "2099-01-01T00:00:00.000Z"
      }, root);
      expect(created.secret).toMatch(/^lip_sk_/);
      expect(JSON.stringify(first.snapshot())).not.toContain(created.secret);
      const integration = first.authenticate(created.secret);
      expect(integration).toMatchObject({
        tenant_id: "tenant-sakura",
        actor_id: created.api_key.key_id,
        role: "integration"
      });
      expect(first.hasPermission(integration!, "protocol:write")).toBe(true);
      expect(first.hasPermission(integration!, "admin:read")).toBe(false);
      expect(() => first.upsertUser({
        email: "forbidden@sakura.example",
        role: "viewer"
      }, integration!)).toThrowError(/access:manage/);
      first.close();

      const second = new AccessControlService({
        path: databasePath,
        tenantId: "tenant-sakura",
        tenantName: "Sakura Japan"
      });
      expect(second.snapshot()).toMatchObject({
        tenant: { tenant_id: "tenant-sakura" },
        users: [{ user_id: user.user_id }],
        api_keys: [{
          key_id: created.api_key.key_id,
          active: true,
          expires_at: "2099-01-01T00:00:00.000Z"
        }]
      });
      expect(second.snapshot().audit.map(({ action }) => action)).toEqual(
        expect.arrayContaining(["access.user.upserted", "access.api_key.created"])
      );
      second.revokeApiKey(created.api_key.key_id, second.rootPrincipal());
      expect(second.authenticate(created.secret)).toBeUndefined();
      expect(second.snapshot().api_keys[0]).toMatchObject({
        active: false,
        revoked_at: expect.any(String)
      });
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not authenticate an API key against another tenant", () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-isolation-"));
    const databasePath = join(directory, "reference.db");
    const sakura = new AccessControlService({
      path: databasePath,
      tenantId: "tenant-sakura",
      tenantName: "Sakura",
      reset: true
    });
    const other = new AccessControlService({
      path: databasePath,
      tenantId: "tenant-other",
      tenantName: "Other",
      reset: true
    });
    try {
      const created = sakura.createApiKey(
        { name: "Sakura integration", role: "integration" },
        sakura.rootPrincipal()
      );
      expect(other.authenticate(created.secret)).toBeUndefined();
    } finally {
      sakura.close();
      other.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
