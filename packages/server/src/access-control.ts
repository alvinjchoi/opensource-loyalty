import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { EngineError } from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";

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
  secret_hash: string;
}

export interface TenantPrincipal {
  tenant_id: string;
  actor_id: string;
  actor_type: "root" | "api_key" | "user";
  role: TenantRole;
  permissions: TenantPermission[];
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

interface AccessControlState {
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

export class AccessControlService {
  private readonly store: SqliteStateStore<AccessControlState>;
  private state: AccessControlState;

  public constructor(options: {
    path: string;
    tenantId: string;
    tenantName: string;
    reset?: boolean;
  }) {
    this.store = new SqliteStateStore<AccessControlState>({
      path: options.path,
      key: `${options.tenantId}:access-control`
    });
    if (options.reset) this.store.clear();
    const timestamp = now();
    this.state = this.store.load() ?? {
      version: 1,
      tenant: {
        tenant_id: options.tenantId,
        name: options.tenantName,
        created_at: timestamp
      },
      users: [],
      api_keys: [],
      audit: []
    };
    if (
      this.state.version !== 1 ||
      this.state.tenant.tenant_id !== options.tenantId
    ) {
      this.store.close();
      throw new Error("Access-control state is incompatible with this tenant");
    }
    this.save();
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

  public authenticate(secret: string): TenantPrincipal | undefined {
    const candidateHash = hashSecret(secret);
    const key = this.state.api_keys.find((candidate) =>
      candidate.active &&
      (!candidate.expires_at || Date.parse(candidate.expires_at) > Date.now()) &&
      secretsEqual(candidate.secret_hash, candidateHash)
    );
    if (!key) return undefined;
    key.last_used_at = now();
    this.save();
    return {
      tenant_id: key.tenant_id,
      actor_id: key.key_id,
      actor_type: "api_key",
      role: key.role,
      permissions: [...rolePermissions[key.role]]
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
      permissions: [...rolePermissions[user.role]]
    };
  }

  public upsertUser(input: {
    user_id?: string;
    email: string;
    name?: string;
    role: TenantRole;
    active?: boolean;
  }, principal: TenantPrincipal): TenantUser {
    this.requirePermission(principal, "access:manage");
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) {
      throw new EngineError("validation_failed", "A valid user email is required", 422);
    }
    this.assertRole(input.role);
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
      ...(input.name?.trim() ? { name: input.name.trim() } : {})
    };
    if (existing) Object.assign(existing, user);
    else this.state.users.unshift(user);
    this.recordAudit(principal, "access.user.upserted", "user", userId, {
      role: user.role,
      active: user.active
    });
    return structuredClone(user);
  }

  public createApiKey(input: {
    name: string;
    role: TenantRole;
    expires_at?: string;
  }, principal: TenantPrincipal): {
    api_key: Omit<TenantApiKey, "secret_hash">;
    secret: string;
  } {
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
      secret_hash: hashSecret(secret)
    };
    this.state.api_keys.unshift(key);
    this.recordAudit(principal, "access.api_key.created", "api_key", key.key_id, {
      role: key.role,
      prefix: key.prefix
    });
    const { secret_hash: _secretHash, ...publicKey } = key;
    return { api_key: structuredClone(publicKey), secret };
  }

  public revokeApiKey(keyId: string, principal: TenantPrincipal): void {
    this.requirePermission(principal, "access:manage");
    const key = this.state.api_keys.find((candidate) => candidate.key_id === keyId);
    if (!key) throw new EngineError("not_found", "API key was not found", 404);
    if (!key.active) return;
    key.active = false;
    key.revoked_at = now();
    this.recordAudit(principal, "access.api_key.revoked", "api_key", keyId);
  }

  public recordAudit(
    principal: TenantPrincipal,
    action: string,
    resourceType: string,
    resourceId?: string,
    metadata?: Record<string, unknown>,
    requestId?: string
  ): void {
    this.state.audit.unshift({
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
    });
    this.state.audit = this.state.audit.slice(0, 1_000);
    this.save();
  }

  public close(): void {
    this.store.close();
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

  private save(): void {
    this.store.save(this.state);
  }
}
