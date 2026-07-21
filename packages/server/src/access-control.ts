import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { EngineError } from "@loyalty-interchange/reference";
import type { AsyncStateStore } from "@loyalty-interchange/storage";

export type TenantRole = "owner" | "admin" | "operator" | "developer" | "viewer" | "integration";
export type TenantPermission =
  | "admin:read"
  | "admin:write"
  | "program:publish"
  | "access:manage"
  | "protocol:read"
  | "protocol:write";

const rolePermissions: Record<TenantRole, TenantPermission[]> = {
  owner: [
    "admin:read", "admin:write", "program:publish", "access:manage",
    "protocol:read", "protocol:write"
  ],
  admin: [
    "admin:read", "admin:write", "program:publish", "access:manage",
    "protocol:read", "protocol:write"
  ],
  operator: ["admin:read", "admin:write", "protocol:read", "protocol:write"],
  developer: ["admin:read", "protocol:read", "protocol:write"],
  viewer: ["admin:read"],
  integration: ["protocol:read", "protocol:write"]
};

export interface Tenant {
  tenant_id: string;
  name: string;
  created_at: string;
}

export interface TenantUser {
  user_id: string;
  tenant_id: string;
  email: string;
  name?: string;
  role: TenantRole;
  active: boolean;
  created_at: string;
  updated_at: string;
  /** Locations this user may see in scoped Admin views. Absent = all locations. */
  allowed_location_ids?: string[];
}

export interface TenantApiKey {
  key_id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  role: TenantRole;
  active: boolean;
  created_at: string;
  expires_at?: string;
  last_used_at?: string;
  revoked_at?: string;
  /** Locations this key may see in scoped Admin views. Absent = all locations. */
  allowed_location_ids?: string[];
  secret_hash: string;
}

export interface TenantPrincipal {
  tenant_id: string;
  actor_id: string;
  actor_type: "root" | "api_key" | "user";
  role: TenantRole;
  permissions: TenantPermission[];
  /** Location scope resolved from the user or API key. Absent = all locations. */
  allowed_location_ids?: string[];
}

export interface TenantAuditEntry {
  audit_id: string;
  tenant_id: string;
  actor_id: string;
  actor_type: TenantPrincipal["actor_type"];
  action: string;
  resource_type: string;
  resource_id?: string;
  request_id?: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

export interface AccessControlState {
  version: 1;
  tenant: Tenant;
  users: TenantUser[];
  api_keys: TenantApiKey[];
  audit: TenantAuditEntry[];
}

export interface AccessControlSnapshot {
  tenant: Tenant;
  users: TenantUser[];
  api_keys: Array<Omit<TenantApiKey, "secret_hash">>;
  audit: TenantAuditEntry[];
  role_permissions: Record<TenantRole, TenantPermission[]>;
}

export interface AccessControlServiceOptions {
  store: AsyncStateStore<AccessControlState>;
  tenantId: string;
  tenantName: string;
  reset?: boolean;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Normalizes an optional allowed-location list: trims entries, removes
 * duplicates, and rejects lists that resolve to nothing (an empty scope would
 * silently lock the principal out of every scoped view).
 */
function normalizeAllowedLocationIds(input: string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  const normalized = [...new Set(input.map((value) => value.trim()).filter((value) => value.length > 0))];
  if (normalized.length === 0) {
    throw new EngineError(
      "validation_failed",
      "allowed_location_ids must contain at least one non-empty location id",
      422
    );
  }
  return normalized;
}

export class AccessControlService {
  private readonly store: AsyncStateStore<AccessControlState>;
  private state: AccessControlState;
  private revision: number;

  private constructor(
    options: AccessControlServiceOptions,
    state: AccessControlState,
    revision: number
  ) {
    this.store = options.store;
    this.state = state;
    this.revision = revision;
  }

  public static async create(options: AccessControlServiceOptions): Promise<AccessControlService> {
    if (options.reset) await options.store.clear();
    const loaded = await options.store.load();
    const state = loaded?.state ?? {
      version: 1 as const,
      tenant: {
        tenant_id: options.tenantId,
        name: options.tenantName,
        created_at: now()
      },
      users: [],
      api_keys: [],
      audit: []
    };
    if (state.version !== 1 || state.tenant.tenant_id !== options.tenantId) {
      await options.store.close();
      throw new Error("Access-control state is incompatible with this tenant");
    }
    const service = new AccessControlService(options, state, loaded?.revision ?? 0);
    await service.save();
    return service;
  }

  public rootPrincipal(): TenantPrincipal {
    return {
      tenant_id: this.state.tenant.tenant_id,
      actor_id: "root",
      actor_type: "root",
      role: "owner",
      permissions: [...rolePermissions.owner]
    };
  }

  public async authenticate(secret: string): Promise<TenantPrincipal | undefined> {
    const candidateHash = hashSecret(secret);
    const key = this.state.api_keys.find((candidate) =>
      candidate.active &&
      (!candidate.expires_at || Date.parse(candidate.expires_at) > Date.now()) &&
      secretsEqual(candidate.secret_hash, candidateHash)
    );
    if (!key) return undefined;
    const used: TenantApiKey = { ...key, last_used_at: now() };
    this.state = {
      ...this.state,
      api_keys: this.state.api_keys.map((candidate) =>
        candidate.key_id === used.key_id ? used : candidate
      )
    };
    await this.save();
    return {
      tenant_id: used.tenant_id,
      actor_id: used.key_id,
      actor_type: "api_key",
      role: used.role,
      permissions: [...rolePermissions[used.role]],
      ...(used.allowed_location_ids
        ? { allowed_location_ids: [...used.allowed_location_ids] }
        : {})
    };
  }

  public hasPermission(
    principal: TenantPrincipal,
    permission: TenantPermission
  ): boolean {
    return principal.tenant_id === this.state.tenant.tenant_id &&
      principal.permissions.includes(permission);
  }

  public snapshot(): AccessControlSnapshot {
    return structuredClone({
      tenant: this.state.tenant,
      users: this.state.users,
      api_keys: this.state.api_keys.map(({ secret_hash: _secretHash, ...key }) => key),
      audit: this.state.audit,
      role_permissions: rolePermissions
    });
  }

  public principalForUser(userId: string): TenantPrincipal | undefined {
    const user = this.state.users.find((candidate) =>
      candidate.user_id === userId && candidate.active
    );
    if (!user) return undefined;
    return {
      tenant_id: user.tenant_id,
      actor_id: user.user_id,
      actor_type: "user",
      role: user.role,
      permissions: [...rolePermissions[user.role]],
      ...(user.allowed_location_ids
        ? { allowed_location_ids: [...user.allowed_location_ids] }
        : {})
    };
  }

  /**
   * Location scope for Admin queries and reporting: undefined means the
   * principal may see every location; otherwise only the returned location
   * ids. Root principals and principals from another tenant are never scoped
   * down here — cross-tenant callers are rejected by permission checks.
   */
  public locationScopeFor(principal: TenantPrincipal): string[] | undefined {
    if (principal.actor_type === "root") return undefined;
    return principal.allowed_location_ids
      ? [...principal.allowed_location_ids]
      : undefined;
  }

  public async upsertUser(input: {
    user_id?: string;
    email: string;
    name?: string;
    role: TenantRole;
    active?: boolean;
    allowed_location_ids?: string[];
  }, principal: TenantPrincipal): Promise<TenantUser> {
    this.requirePermission(principal, "access:manage");
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) {
      throw new EngineError("validation_failed", "A valid user email is required", 422);
    }
    this.assertRole(input.role);
    const allowedLocationIds = normalizeAllowedLocationIds(input.allowed_location_ids);
    const timestamp = now();
    const userId = input.user_id ?? `user_${randomUUID()}`;
    const existing = this.state.users.find((user) => user.user_id === userId);
    const duplicate = this.state.users.find((user) =>
      user.user_id !== userId && user.email === email
    );
    if (duplicate) throw new EngineError("conflict", "User email already exists", 409);
    const user: TenantUser = {
      user_id: userId,
      tenant_id: this.state.tenant.tenant_id,
      email,
      role: input.role,
      active: input.active ?? existing?.active ?? true,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(allowedLocationIds ? { allowed_location_ids: allowedLocationIds } : {})
    };
    this.state = {
      ...this.state,
      users: existing
        ? this.state.users.map((candidate) =>
            candidate.user_id === userId ? user : candidate
          )
        : [user, ...this.state.users]
    };
    await this.recordAudit(principal, "access.user.upserted", "user", userId, {
      role: user.role,
      active: user.active,
      ...(user.allowed_location_ids
        ? { allowed_location_ids: user.allowed_location_ids }
        : {})
    });
    return structuredClone(user);
  }

  public async createApiKey(input: {
    name: string;
    role: TenantRole;
    expires_at?: string;
    allowed_location_ids?: string[];
  }, principal: TenantPrincipal): Promise<{
    api_key: Omit<TenantApiKey, "secret_hash">;
    secret: string;
  }> {
    this.requirePermission(principal, "access:manage");
    this.assertRole(input.role);
    if (!input.name.trim()) {
      throw new EngineError("validation_failed", "API key name is required", 422);
    }
    if (
      input.expires_at &&
      (!Number.isFinite(Date.parse(input.expires_at)) ||
        Date.parse(input.expires_at) <= Date.now())
    ) {
      throw new EngineError("validation_failed", "API key expiration must be in the future", 422);
    }
    const allowedLocationIds = normalizeAllowedLocationIds(input.allowed_location_ids);
    const secret = `lip_sk_${randomBytes(32).toString("base64url")}`;
    const timestamp = now();
    const key: TenantApiKey = {
      key_id: `key_${randomUUID()}`,
      tenant_id: this.state.tenant.tenant_id,
      name: input.name.trim(),
      prefix: secret.slice(0, 15),
      role: input.role,
      active: true,
      created_at: timestamp,
      ...(input.expires_at
        ? { expires_at: new Date(input.expires_at).toISOString() }
        : {}),
      ...(allowedLocationIds ? { allowed_location_ids: allowedLocationIds } : {}),
      secret_hash: hashSecret(secret)
    };
    this.state = {
      ...this.state,
      api_keys: [key, ...this.state.api_keys]
    };
    await this.recordAudit(principal, "access.api_key.created", "api_key", key.key_id, {
      role: key.role,
      prefix: key.prefix,
      ...(key.allowed_location_ids
        ? { allowed_location_ids: key.allowed_location_ids }
        : {})
    });
    const { secret_hash: _secretHash, ...publicKey } = key;
    return { api_key: structuredClone(publicKey), secret };
  }

  public async revokeApiKey(keyId: string, principal: TenantPrincipal): Promise<void> {
    this.requirePermission(principal, "access:manage");
    const key = this.state.api_keys.find((candidate) => candidate.key_id === keyId);
    if (!key) throw new EngineError("not_found", "API key was not found", 404);
    if (!key.active) return;
    const revoked: TenantApiKey = { ...key, active: false, revoked_at: now() };
    this.state = {
      ...this.state,
      api_keys: this.state.api_keys.map((candidate) =>
        candidate.key_id === keyId ? revoked : candidate
      )
    };
    await this.recordAudit(principal, "access.api_key.revoked", "api_key", keyId);
  }

  public async recordAudit(
    principal: TenantPrincipal,
    action: string,
    resourceType: string,
    resourceId?: string,
    metadata?: Record<string, unknown>,
    requestId?: string
  ): Promise<void> {
    const entry: TenantAuditEntry = {
      audit_id: `tenant-audit_${randomUUID()}`,
      tenant_id: this.state.tenant.tenant_id,
      actor_id: principal.actor_id,
      actor_type: principal.actor_type,
      action,
      resource_type: resourceType,
      occurred_at: now(),
      ...(resourceId ? { resource_id: resourceId } : {}),
      ...(metadata ? { metadata: structuredClone(metadata) } : {}),
      ...(requestId ? { request_id: requestId } : {})
    };
    this.state = {
      ...this.state,
      audit: [entry, ...this.state.audit].slice(0, 1_000)
    };
    await this.save();
  }

  public async close(): Promise<void> {
    await this.store.close();
  }

  private requirePermission(
    principal: TenantPrincipal,
    permission: TenantPermission
  ): void {
    if (!this.hasPermission(principal, permission)) {
      throw new EngineError("forbidden", `Permission ${permission} is required`, 403);
    }
  }

  private assertRole(role: string): asserts role is TenantRole {
    if (!(role in rolePermissions)) {
      throw new EngineError("validation_failed", `Unknown tenant role: ${role}`, 422);
    }
  }

  private async save(): Promise<void> {
    this.revision = await this.store.save(this.state, this.revision);
  }
}
