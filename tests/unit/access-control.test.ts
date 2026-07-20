import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AsyncSqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { AccessControlService, type AccessControlState } from "@loyalty-interchange/server";

describe("tenant access control", () => {
  const makeStore = (path: string, tenantId: string): AsyncSqliteStateStore<AccessControlState> =>
    new AsyncSqliteStateStore<AccessControlState>({ path, key: `${tenantId}:access-control` });

  it("persists scoped users, one-time API keys, authorization, and audit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-"));
    const databasePath = join(directory, "reference.db");
    try {
      const first = await AccessControlService.create({
        store: makeStore(databasePath, "tenant-acme"),
        tenantId: "tenant-acme",
        tenantName: "Acme Japan",
        reset: true
      });
      const root = first.rootPrincipal();
      const user = await first.upsertUser({
        email: " Operator@Acme.Example ",
        name: "Store Operator",
        role: "operator"
      }, root);
      expect(user).toMatchObject({
        tenant_id: "tenant-acme",
        email: "operator@acme.example",
        role: "operator",
        active: true
      });
      expect(first.principalForUser(user.user_id)).toMatchObject({
        actor_id: user.user_id,
        actor_type: "user",
        role: "operator"
      });
      await first.upsertUser({ user_id: user.user_id, email: user.email, role: user.role, active: false }, root);
      expect(first.principalForUser(user.user_id)).toBeUndefined();
      await first.upsertUser({ user_id: user.user_id, email: user.email, role: user.role, active: true }, root);
      await expect(first.upsertUser({
        email: "not-an-email",
        role: "viewer"
      }, root)).rejects.toThrowError(/valid user email/);
      await expect(first.upsertUser({
        email: "invalid-role@acme.example",
        role: "unknown" as never
      }, root)).rejects.toThrowError(/Unknown tenant role/);
      await expect(first.createApiKey({
        name: "Expired integration",
        role: "integration",
        expires_at: "2020-01-01T00:00:00.000Z"
      }, root)).rejects.toThrowError(/expiration must be in the future/);

      const created = await first.createApiKey({
        name: "Acme mobile BFF",
        role: "integration",
        expires_at: "2099-01-01T00:00:00.000Z"
      }, root);
      expect(created.secret).toMatch(/^lip_sk_/);
      expect(JSON.stringify(first.snapshot())).not.toContain(created.secret);
      const integration = await first.authenticate(created.secret);
      expect(integration).toMatchObject({
        tenant_id: "tenant-acme",
        actor_id: created.api_key.key_id,
        role: "integration"
      });
      expect(first.hasPermission(integration!, "protocol:write")).toBe(true);
      expect(first.hasPermission(integration!, "admin:read")).toBe(false);
      await expect(first.upsertUser({
        email: "forbidden@acme.example",
        role: "viewer"
      }, integration!)).rejects.toThrowError(/access:manage/);
      await first.close();

      const second = await AccessControlService.create({
        store: makeStore(databasePath, "tenant-acme"),
        tenantId: "tenant-acme",
        tenantName: "Acme Japan"
      });
      expect(second.snapshot()).toMatchObject({
        tenant: { tenant_id: "tenant-acme" },
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
      await second.revokeApiKey(created.api_key.key_id, second.rootPrincipal());
      expect(await second.authenticate(created.secret)).toBeUndefined();
      expect(second.snapshot().api_keys[0]).toMatchObject({
        active: false,
        revoked_at: expect.any(String)
      });
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not authenticate an API key against another tenant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-isolation-"));
    const databasePath = join(directory, "reference.db");
    const acme = await AccessControlService.create({
      store: makeStore(databasePath, "tenant-acme"),
      tenantId: "tenant-acme",
      tenantName: "Acme",
      reset: true
    });
    const other = await AccessControlService.create({
      store: makeStore(databasePath, "tenant-other"),
      tenantId: "tenant-other",
      tenantName: "Other",
      reset: true
    });
    try {
      const created = await acme.createApiKey(
        { name: "Acme integration", role: "integration" },
        acme.rootPrincipal()
      );
      expect(await other.authenticate(created.secret)).toBeUndefined();
    } finally {
      await acme.close();
      await other.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
