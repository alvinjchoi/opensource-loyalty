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

  it("scopes users and API keys to allowed locations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-locations-"));
    const databasePath = join(directory, "reference.db");
    const service = await AccessControlService.create({
      store: makeStore(databasePath, "tenant-acme"),
      tenantId: "tenant-acme",
      tenantName: "Acme",
      reset: true
    });
    try {
      const root = service.rootPrincipal();
      expect(service.locationScopeFor(root)).toBeUndefined();

      const user = await service.upsertUser({
        email: "franchisee@acme.example",
        role: "operator",
        allowed_location_ids: [" location-42 ", "location-42", "location-77"]
      }, root);
      expect(user.allowed_location_ids).toEqual(["location-42", "location-77"]);
      const principal = service.principalForUser(user.user_id);
      expect(principal?.allowed_location_ids).toEqual(["location-42", "location-77"]);
      expect(service.locationScopeFor(principal!)).toEqual(["location-42", "location-77"]);

      const unscoped = await service.upsertUser({
        email: "hq@acme.example",
        role: "admin"
      }, root);
      expect(unscoped.allowed_location_ids).toBeUndefined();
      expect(service.locationScopeFor(service.principalForUser(unscoped.user_id)!))
        .toBeUndefined();

      await expect(service.upsertUser({
        email: "empty-scope@acme.example",
        role: "viewer",
        allowed_location_ids: ["   "]
      }, root)).rejects.toThrowError(/allowed_location_ids/);
      await expect(service.upsertUser({
        email: "no-scope@acme.example",
        role: "viewer",
        allowed_location_ids: []
      }, root)).rejects.toThrowError(/allowed_location_ids/);

      const scopedKey = await service.createApiKey({
        name: "Franchisee dashboard",
        role: "viewer",
        allowed_location_ids: ["location-42"]
      }, root);
      expect(scopedKey.api_key.allowed_location_ids).toEqual(["location-42"]);
      const keyPrincipal = await service.authenticate(scopedKey.secret);
      expect(keyPrincipal?.allowed_location_ids).toEqual(["location-42"]);
      expect(service.locationScopeFor(keyPrincipal!)).toEqual(["location-42"]);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves an omitted location scope on update and clears it only on explicit null", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-preserve-"));
    const databasePath = join(directory, "reference.db");
    const service = await AccessControlService.create({
      store: makeStore(databasePath, "tenant-acme"),
      tenantId: "tenant-acme",
      tenantName: "Acme",
      reset: true
    });
    try {
      const root = service.rootPrincipal();
      const user = await service.upsertUser({
        email: "franchisee@acme.example",
        role: "operator",
        allowed_location_ids: ["location-42", "location-77"]
      }, root);

      // Omitted scope on a partial update must not drop the stored scope.
      const renamed = await service.upsertUser({
        user_id: user.user_id,
        email: user.email,
        name: "Renamed Operator",
        role: "operator"
      }, root);
      expect(renamed.allowed_location_ids).toEqual(["location-42", "location-77"]);

      // Explicit null clears the scope and the audit trail records the clear.
      const cleared = await service.upsertUser({
        user_id: user.user_id,
        email: user.email,
        role: "operator",
        allowed_location_ids: null
      }, root);
      expect(cleared.allowed_location_ids).toBeUndefined();
      const clearAudit = service.snapshot().audit
        .find((entry) => entry.action === "access.user.upserted");
      expect(clearAudit?.metadata).toMatchObject({ allowed_location_ids: null });

      // Empty arrays are still rejected rather than treated as a clear.
      await expect(service.upsertUser({
        user_id: user.user_id,
        email: user.email,
        role: "operator",
        allowed_location_ids: []
      }, root)).rejects.toThrowError(/allowed_location_ids/);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects allowed location ids that violate the protocol id constraints", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-idcheck-"));
    const databasePath = join(directory, "reference.db");
    const service = await AccessControlService.create({
      store: makeStore(databasePath, "tenant-acme"),
      tenantId: "tenant-acme",
      tenantName: "Acme",
      reset: true
    });
    try {
      const root = service.rootPrincipal();
      for (const invalid of ["-leading-dash", "spaced id", "bang!", `x${"y".repeat(128)}`]) {
        await expect(service.upsertUser({
          email: "invalid-location@acme.example",
          role: "viewer",
          allowed_location_ids: [invalid]
        }, root), invalid).rejects.toThrowError(/allowed_location_ids/);
        await expect(service.createApiKey({
          name: "Invalid location key",
          role: "viewer",
          allowed_location_ids: [invalid]
        }, root), invalid).rejects.toThrowError(/allowed_location_ids/);
      }
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prevents location-scoped principals from escalating beyond their own scope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-escape-"));
    const databasePath = join(directory, "reference.db");
    const service = await AccessControlService.create({
      store: makeStore(databasePath, "tenant-acme"),
      tenantId: "tenant-acme",
      tenantName: "Acme",
      reset: true
    });
    try {
      const root = service.rootPrincipal();
      const franchisee = await service.createApiKey({
        name: "Franchisee admin",
        role: "admin",
        allowed_location_ids: ["location-42", "location-77"]
      }, root);
      const scoped = (await service.authenticate(franchisee.secret))!;

      // Subset grants are allowed.
      const staff = await service.upsertUser({
        email: "staff@acme.example",
        role: "viewer",
        allowed_location_ids: ["location-42"]
      }, scoped);
      expect(staff.allowed_location_ids).toEqual(["location-42"]);
      const subsetKey = await service.createApiKey({
        name: "Location 77 kiosk",
        role: "viewer",
        allowed_location_ids: ["location-77"]
      }, scoped);
      expect(subsetKey.api_key.allowed_location_ids).toEqual(["location-77"]);

      // Escaping to other locations, unscoped grants, and scope clears are not.
      await expect(service.upsertUser({
        email: "escape@acme.example",
        role: "viewer",
        allowed_location_ids: ["location-42", "location-99"]
      }, scoped)).rejects.toThrowError(/scope/);
      await expect(service.upsertUser({
        email: "unscoped@acme.example",
        role: "viewer"
      }, scoped)).rejects.toThrowError(/scope/);
      await expect(service.createApiKey({
        name: "Unscoped key",
        role: "viewer"
      }, scoped)).rejects.toThrowError(/scope/);
      await expect(service.upsertUser({
        user_id: staff.user_id,
        email: staff.email,
        role: "viewer",
        allowed_location_ids: null
      }, scoped)).rejects.toThrowError(/scope/);

      // A preserved wider scope on partial update is also an escape.
      const wide = await service.upsertUser({
        email: "wide@acme.example",
        role: "viewer",
        allowed_location_ids: ["location-42", "location-99"]
      }, root);
      await expect(service.upsertUser({
        user_id: wide.user_id,
        email: wide.email,
        role: "viewer"
      }, scoped)).rejects.toThrowError(/scope/);

      // Unscoped creators remain unrestricted.
      const hq = await service.upsertUser({
        email: "hq2@acme.example",
        role: "admin"
      }, root);
      expect(hq.allowed_location_ids).toBeUndefined();
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rotates an API key with a bounded overlap window", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-rotate-"));
    const databasePath = join(directory, "reference.db");
    const service = await AccessControlService.create({
      store: makeStore(databasePath, "tenant-acme"),
      tenantId: "tenant-acme",
      tenantName: "Acme",
      reset: true
    });
    try {
      const root = service.rootPrincipal();
      const created = await service.createApiKey({
        name: "Acme mobile BFF",
        role: "integration",
        allowed_location_ids: ["location-42"]
      }, root);

      const rotated = await service.rotateApiKey({
        key_id: created.api_key.key_id,
        overlap_seconds: 3_600
      }, root);

      // Replacement inherits name, role, and location scope with a new secret.
      expect(rotated.secret).toMatch(/^lip_sk_/);
      expect(rotated.secret).not.toBe(created.secret);
      expect(rotated.api_key).toMatchObject({
        name: "Acme mobile BFF",
        role: "integration",
        allowed_location_ids: ["location-42"],
        active: true
      });
      expect(rotated.api_key.key_id).not.toBe(created.api_key.key_id);

      // Old key stays valid during the overlap window and its expiry is set.
      const overlapExpiry = Date.parse(rotated.replaced_api_key.expires_at!);
      expect(overlapExpiry).toBeGreaterThan(Date.now());
      expect(overlapExpiry).toBeLessThanOrEqual(Date.now() + 3_600_000 + 5_000);
      expect(await service.authenticate(created.secret)).toMatchObject({
        actor_id: created.api_key.key_id
      });
      expect(await service.authenticate(rotated.secret)).toMatchObject({
        actor_id: rotated.api_key.key_id
      });

      // Every step is audited.
      const audit = service.snapshot().audit;
      expect(audit.find((entry) => entry.action === "access.api_key.rotated")).toMatchObject({
        resource_id: created.api_key.key_id,
        metadata: expect.objectContaining({
          replacement_key_id: rotated.api_key.key_id
        })
      });
      expect(audit.find((entry) =>
        entry.action === "access.api_key.created" &&
        entry.resource_id === rotated.api_key.key_id
      )?.metadata).toMatchObject({ rotated_from: created.api_key.key_id });
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("supports immediate cutover and never widens an existing expiry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-rotate-edge-"));
    const databasePath = join(directory, "reference.db");
    const service = await AccessControlService.create({
      store: makeStore(databasePath, "tenant-acme"),
      tenantId: "tenant-acme",
      tenantName: "Acme",
      reset: true
    });
    try {
      const root = service.rootPrincipal();

      // overlap_seconds: 0 expires the old key immediately.
      const immediate = await service.createApiKey({ name: "Immediate", role: "integration" }, root);
      const cutover = await service.rotateApiKey({
        key_id: immediate.api_key.key_id,
        overlap_seconds: 0
      }, root);
      expect(await service.authenticate(immediate.secret)).toBeUndefined();
      expect(await service.authenticate(cutover.secret)).toBeDefined();

      // A sooner existing expiry wins over the requested overlap.
      const soon = new Date(Date.now() + 60_000).toISOString();
      const expiring = await service.createApiKey({
        name: "Expiring",
        role: "integration",
        expires_at: soon
      }, root);
      const kept = await service.rotateApiKey({
        key_id: expiring.api_key.key_id,
        overlap_seconds: 86_400
      }, root);
      expect(kept.replaced_api_key.expires_at).toBe(soon);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid rotations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-access-rotate-invalid-"));
    const databasePath = join(directory, "reference.db");
    const service = await AccessControlService.create({
      store: makeStore(databasePath, "tenant-acme"),
      tenantId: "tenant-acme",
      tenantName: "Acme",
      reset: true
    });
    try {
      const root = service.rootPrincipal();
      const created = await service.createApiKey({ name: "Target", role: "integration" }, root);

      await expect(service.rotateApiKey({ key_id: "key_missing" }, root))
        .rejects.toThrowError(/not found/i);
      await expect(service.rotateApiKey({
        key_id: created.api_key.key_id,
        overlap_seconds: -1
      }, root)).rejects.toThrowError(/overlap_seconds/);
      await expect(service.rotateApiKey({
        key_id: created.api_key.key_id,
        overlap_seconds: 700_000
      }, root)).rejects.toThrowError(/overlap_seconds/);

      // Rotation requires access:manage.
      const integration = await service.authenticate(created.secret);
      await expect(service.rotateApiKey({
        key_id: created.api_key.key_id
      }, integration!)).rejects.toThrowError(/access:manage/);

      // A revoked key cannot be rotated back to life.
      await service.revokeApiKey(created.api_key.key_id, root);
      await expect(service.rotateApiKey({ key_id: created.api_key.key_id }, root))
        .rejects.toThrowError(/not active/i);

      // A location-scoped principal cannot rotate a wider-scoped key.
      const scopedGrant = await service.createApiKey({
        name: "Scoped admin",
        role: "admin",
        allowed_location_ids: ["location-1"]
      }, root);
      const wide = await service.createApiKey({ name: "Wide", role: "integration" }, root);
      const scopedPrincipal = await service.authenticate(scopedGrant.secret);
      await expect(service.rotateApiKey({
        key_id: wide.api_key.key_id
      }, scopedPrincipal!)).rejects.toThrowError(/scope/);
    } finally {
      await service.close();
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
