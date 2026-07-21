import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertStrongApiKey,
  createDemoPlatform,
  createPostgresProtocolPlatform,
  startReferenceServer,
  type AccessControlService,
  type TenantPrincipal
} from "@loyalty-interchange/server";
import { EngineError, type ProgramDefinition } from "@loyalty-interchange/reference";
import type { CloudProvisioner } from "./provisioning.js";
import type {
  CloudEnvironment,
  CloudProvisioningJob,
  CloudProvisioningResult,
  EnvironmentCredentialRotationOptions
} from "./types.js";

export interface LocalDataPlaneProvisionerOptions {
  /**
   * Directory containing one `<program_id>.json` program definition per
   * provisionable program. Provisioning fails when the environment's program
   * has no definition here.
   */
  programDirectory: string;
  /**
   * Directory for per-environment SQLite databases, credential files, and the
   * port registry. Created on demand.
   */
  dataDirectory: string;
  /**
   * Optional Postgres connection string. When set, environments run against
   * tenant-scoped Postgres tables instead of per-environment SQLite files.
   */
  connectionString?: string;
  /** Listen host for provisioned runtimes. Defaults to 127.0.0.1. */
  host?: string;
  /**
   * First port in the stable allocation range. Defaults to 13210. Ports are
   * persisted in `<dataDirectory>/ports.json` so restarts reuse the same URL.
   */
  basePort?: number;
  /** Inclusive port range size starting at basePort. Defaults to 1000. */
  portRange?: number;
  /** Public base URL host used when writing credentials (defaults to host). */
  publicHost?: string;
  /** Called with the generated credential after a runtime starts. */
  onProvisioned?: (runtime: ProvisionedRuntime) => void;
}

export interface ProvisionedRuntime {
  environment_id: string;
  tenant_id: string;
  program_id: string;
  api_url: string;
  admin_url: string;
  /** DEPRECATED root runtime key. Hand out merchant_api_key instead. */
  api_key: string;
  /** Owner-role access-control key — the credential merchants receive. */
  merchant_api_key: string;
  merchant_api_key_id: string;
  credentials_path: string;
  port: number;
}

/**
 * v1 files carry only the root `api_key`; v2 adds the merchant access-control
 * key and marks the root key deprecated. v1 files are accepted on restore and
 * upgraded in place.
 */
interface CredentialFile {
  version?: number;
  environment_id: string;
  tenant_id: string;
  program_id: string;
  api_url: string;
  api_key: string;
  api_key_deprecated?: boolean;
  merchant_api_key?: string;
  merchant_api_key_id?: string;
  port: number;
}

interface RunningRuntime {
  runtime: ProvisionedRuntime;
  access: AccessControlService;
  close: () => Promise<void>;
}

const MERCHANT_KEY_NAME = "cloud-merchant";

function generateApiKey(): string {
  return `lip_sk_${randomBytes(32).toString("base64url")}`;
}

function preferredPort(environmentId: string, basePort: number, portRange: number): number {
  const digest = createHash("sha256").update(environmentId).digest();
  return basePort + (digest.readUInt32BE(0) % portRange);
}

/**
 * Runs LIP data-plane runtimes inside the control-plane process: one HTTP
 * server and one isolated store per environment. Ports and API keys are
 * persisted under the data directory so `restore()` can bring environments
 * back on the same URLs after a control-plane restart.
 */
export class LocalDataPlaneProvisioner implements CloudProvisioner {
  private readonly options: LocalDataPlaneProvisionerOptions;
  private readonly running = new Map<string, RunningRuntime>();
  /** Per-environment rotation mutex: concurrent rotations run one at a time. */
  private readonly rotationQueues = new Map<string, Promise<void>>();
  private readonly portsPath: string;
  private readonly basePort: number;
  private readonly portRange: number;
  private portAssignments = new Map<string, number>();

  public constructor(options: LocalDataPlaneProvisionerOptions) {
    if (!options.programDirectory.trim() || !options.dataDirectory.trim()) {
      throw new Error("Program and data directories are required");
    }
    this.options = options;
    this.basePort = options.basePort ?? 13_210;
    this.portRange = options.portRange ?? 1_000;
    if (this.portRange < 1) throw new Error("portRange must be at least 1");
    mkdirSync(resolve(options.dataDirectory), { recursive: true });
    this.portsPath = join(resolve(options.dataDirectory), "ports.json");
  }

  public async restore(): Promise<ProvisionedRuntime[]> {
    await this.loadPortRegistry();
    const restored: ProvisionedRuntime[] = [];
    const dataDir = resolve(this.options.dataDirectory);
    for (const name of readdirSync(dataDir)) {
      if (!name.endsWith(".credentials.json")) continue;
      // One weak, tampered, or unreadable credentials file must never abort
      // the loop and keep every other tenant offline: log it and move on.
      try {
        const runtime = await this.restoreCredentialFile(join(dataDir, name));
        if (runtime) restored.push(runtime);
      } catch (error) {
        console.error(JSON.stringify({
          event: "cloud_environment_restore_failed",
          credentials_file: name,
          environment_id: name.slice(0, -".credentials.json".length),
          message: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    return restored;
  }

  private async restoreCredentialFile(path: string): Promise<ProvisionedRuntime | undefined> {
    const raw = await readFile(path, "utf8");
    const credential = JSON.parse(raw) as CredentialFile;
    if (!credential.environment_id || !credential.tenant_id || !credential.program_id) {
      return undefined;
    }
    if (this.running.has(credential.environment_id)) return undefined;
    const environment: CloudEnvironment = {
      environment_id: credential.environment_id,
      project_id: "restored",
      slug: credential.environment_id,
      name: credential.environment_id,
      kind: "development",
      region: "local",
      tenant_id: credential.tenant_id,
      program_id: credential.program_id,
      status: "ready",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    };
    const port = credential.port || this.portAssignments.get(credential.environment_id);
    return this.startRuntime(environment, {
      apiKey: credential.api_key,
      ...(credential.merchant_api_key && credential.merchant_api_key_id
        ? {
            merchantApiKey: credential.merchant_api_key,
            merchantApiKeyId: credential.merchant_api_key_id
          }
        : {}),
      ...(port ? { port } : {})
    });
  }

  public async provision(input: {
    environment: CloudEnvironment;
    job: CloudProvisioningJob;
  }): Promise<CloudProvisioningResult> {
    const { environment, job } = input;
    if (job.operation !== "create") {
      throw new Error(
        `The local data-plane provisioner only supports create operations (received ${job.operation})`
      );
    }
    const existing = this.running.get(environment.environment_id);
    if (existing) {
      return {
        api_url: existing.runtime.api_url,
        admin_url: existing.runtime.admin_url
      };
    }
    await this.loadPortRegistry();
    const credentialsPath = join(
      resolve(this.options.dataDirectory),
      `${environment.environment_id}.credentials.json`
    );
    let existingCredential: CredentialFile | undefined;
    try {
      existingCredential = JSON.parse(await readFile(credentialsPath, "utf8")) as CredentialFile;
    } catch {
      existingCredential = undefined;
    }
    const port =
      existingCredential?.port ?? this.portAssignments.get(environment.environment_id);
    const runtime = await this.startRuntime(environment, {
      ...(existingCredential?.api_key ? { apiKey: existingCredential.api_key } : {}),
      ...(existingCredential?.merchant_api_key && existingCredential.merchant_api_key_id
        ? {
            merchantApiKey: existingCredential.merchant_api_key,
            merchantApiKeyId: existingCredential.merchant_api_key_id
          }
        : {}),
      ...(port ? { port } : {})
    });
    return { api_url: runtime.api_url, admin_url: runtime.admin_url };
  }

  public runtimes(): ProvisionedRuntime[] {
    return [...this.running.values()].map((entry) => ({ ...entry.runtime }));
  }

  /**
   * Mints a replacement merchant key through the tenant's own access-control
   * service (bounded overlap on the old key, fully audited) and rewrites the
   * credentials file. This is the control-plane rotation surface: operators
   * receive the returned merchant key and never touch the root key.
   *
   * Rotations are serialized per environment (two concurrent calls would
   * otherwise both rotate the same pinned key and mint an orphaned lineage),
   * and a stale pinned key id — the tenant self-rotated, or the key expired —
   * recovers by re-adopting the live `cloud-merchant` lineage instead of
   * failing forever.
   */
  public async rotateCredentials(
    environmentId: string,
    options: EnvironmentCredentialRotationOptions | { subject?: undefined } = {}
  ): Promise<ProvisionedRuntime & { replaced_api_key_expires_at?: string }> {
    const previous = this.rotationQueues.get(environmentId) ?? Promise.resolve();
    const next = previous.then(
      () => this.rotateCredentialsExclusive(environmentId, options),
      () => this.rotateCredentialsExclusive(environmentId, options)
    );
    this.rotationQueues.set(environmentId, next.then(() => undefined, () => undefined));
    return next;
  }

  private async rotateCredentialsExclusive(
    environmentId: string,
    options: EnvironmentCredentialRotationOptions | { subject?: undefined }
  ): Promise<ProvisionedRuntime & { replaced_api_key_expires_at?: string }> {
    const entry = this.running.get(environmentId);
    if (!entry) {
      throw new Error(`No running data-plane runtime exists for ${environmentId}`);
    }
    // Attribute tenant-side audit entries to the acting cloud operator.
    const principal: TenantPrincipal = options.subject
      ? { ...entry.access.rootPrincipal(), actor_id: `cloud:${options.subject}` }
      : entry.access.rootPrincipal();
    const overlap = "overlap_seconds" in options && options.overlap_seconds !== undefined
      ? { overlap_seconds: options.overlap_seconds }
      : {};
    let rotated;
    try {
      rotated = await entry.access.rotateApiKey(
        { key_id: entry.runtime.merchant_api_key_id, ...overlap },
        principal
      );
    } catch (error) {
      // Validation problems (for example a bad overlap) are the caller's to
      // fix; only a dead pinned key falls back to lineage recovery.
      if (error instanceof EngineError && error.code === "validation_failed") throw error;
      rotated = await this.adoptMerchantLineage(entry.access, principal, overlap);
    }
    const runtime: ProvisionedRuntime = {
      ...entry.runtime,
      merchant_api_key: rotated.secret,
      merchant_api_key_id: rotated.api_key.key_id
    };
    await this.writeCredentials(runtime);
    this.running.set(environmentId, { ...entry, runtime });
    return {
      ...runtime,
      ...(rotated.replaced_api_key?.expires_at
        ? { replaced_api_key_expires_at: rotated.replaced_api_key.expires_at }
        : {})
    };
  }

  /**
   * Re-adopts the tenant's live `cloud-merchant` lineage: rotate the standing
   * (no-expiry) key when one exists; otherwise mint a fresh owner key — the
   * recovery path for self-rotated, expired, or lost credentials. Overlap
   * remnants (active but expiry-bounded keys) age out on their own, keeping
   * at most one standing lineage alive.
   */
  private async adoptMerchantLineage(
    access: AccessControlService,
    principal: TenantPrincipal,
    overlap: { overlap_seconds?: number } = {}
  ): Promise<{
    api_key: { key_id: string; expires_at?: string };
    secret: string;
    replaced_api_key?: { expires_at?: string };
  }> {
    const standing = access.snapshot().api_keys.find((key) =>
      key.name === MERCHANT_KEY_NAME && key.active && !key.expires_at
    );
    if (standing) {
      return access.rotateApiKey({ key_id: standing.key_id, ...overlap }, principal);
    }
    const minted = await access.createApiKey(
      { name: MERCHANT_KEY_NAME, role: "owner" },
      principal
    );
    return { api_key: minted.api_key, secret: minted.secret };
  }

  public async close(): Promise<void> {
    const entries = [...this.running.values()];
    this.running.clear();
    for (const entry of entries) await entry.close();
  }

  private async startRuntime(
    environment: CloudEnvironment,
    options: {
      apiKey?: string;
      merchantApiKey?: string;
      merchantApiKeyId?: string;
      port?: number;
    }
  ): Promise<ProvisionedRuntime> {
    const apiKey = options.apiKey?.trim() || generateApiKey();
    // Shared-cluster runtimes must never boot on a weak or default key, even
    // one smuggled in through a tampered or legacy credentials file.
    assertStrongApiKey(apiKey);
    const program = await this.loadProgram(environment.program_id);
    const port = await this.allocatePort(environment.environment_id, options.port);
    const host = this.options.host ?? "127.0.0.1";
    const publicHost = this.options.publicHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
    // webhooks: [] keeps host-level LIP_WEBHOOK_URL/SECRET env config out of
    // tenant runtimes — webhook subscriptions (and their signing secrets) are
    // always tenant-owned, created through each runtime's admin API.
    const platform = this.options.connectionString
      ? await createPostgresProtocolPlatform({
          connectionString: this.options.connectionString,
          tenantId: environment.tenant_id,
          program,
          seed: false,
          webhooks: []
        })
      : await createDemoPlatform({
          databasePath: join(
            resolve(this.options.dataDirectory),
            `${environment.tenant_id}.db`
          ),
          program,
          seed: false,
          webhooks: []
        });
    let server;
    try {
      server = await startReferenceServer(platform.engine, {
        apiKey,
        host,
        port,
        reservationTtlSeconds: program.reservation_ttl_seconds ?? 120,
        ...("executeEngineOperation" in platform
          ? { executeEngineOperation: platform.executeEngineOperation }
          : { persistState: (state) => platform.store.save(state) }),
        // Credentials advertise admin_url, so wire the full Admin service
        // suite the platform constructed (mirrors the server CLI wiring).
        admin: {
          ...(platform.adminAssetRoot ? { assetRoot: platform.adminAssetRoot } : {}),
          storage: platform.store.status,
          programs: platform.programs,
          campaigns: platform.campaigns,
          memberships: platform.memberships,
          access: platform.access,
          engagement: platform.engagement,
          locations: platform.locations,
          webhookManager: platform.webhooks
        }
      });
    } catch (error) {
      await Promise.resolve(platform.close());
      throw error;
    }
    // The merchant key is minted only after the runtime is actually up: a
    // failed server start must never leave an orphaned owner key behind.
    let merchantApiKey = options.merchantApiKey;
    let merchantApiKeyId = options.merchantApiKeyId;
    let adoptedKeyId: string | undefined;
    if (!merchantApiKey || !merchantApiKeyId) {
      try {
        // Re-adopt the persisted lineage (rotate) when one exists — a lost
        // credentials file must not accumulate parallel owner keys.
        const adopted = await this.adoptMerchantLineage(
          platform.access,
          platform.access.rootPrincipal()
        );
        merchantApiKey = adopted.secret;
        merchantApiKeyId = adopted.api_key.key_id;
        adoptedKeyId = adopted.api_key.key_id;
      } catch (error) {
        await server.close();
        await Promise.resolve(platform.close());
        throw error;
      }
    }
    const apiUrl = `http://${publicHost}:${port}`;
    const runtime: ProvisionedRuntime = {
      environment_id: environment.environment_id,
      tenant_id: environment.tenant_id,
      program_id: environment.program_id,
      api_url: apiUrl,
      admin_url: `${apiUrl}/admin/`,
      api_key: apiKey,
      merchant_api_key: merchantApiKey,
      merchant_api_key_id: merchantApiKeyId,
      credentials_path: join(
        resolve(this.options.dataDirectory),
        `${environment.environment_id}.credentials.json`
      ),
      port
    };
    try {
      await this.writeCredentials(runtime);
      await this.savePortRegistry();
    } catch (error) {
      // Compensation: a credential that was never persisted or handed out
      // must not survive as a live orphan key.
      if (adoptedKeyId) {
        try {
          await platform.access.revokeApiKey(adoptedKeyId, platform.access.rootPrincipal());
        } catch (revokeError) {
          console.error(JSON.stringify({
            event: "cloud_merchant_key_revocation_failed",
            environment_id: environment.environment_id,
            key_id: adoptedKeyId,
            message: revokeError instanceof Error ? revokeError.message : String(revokeError)
          }));
        }
      }
      await server.close();
      await Promise.resolve(platform.close());
      throw error;
    }
    this.running.set(environment.environment_id, {
      runtime,
      access: platform.access,
      close: async () => {
        await server.close();
        await Promise.resolve(platform.close());
      }
    });
    this.options.onProvisioned?.(runtime);
    return runtime;
  }

  private async writeCredentials(runtime: ProvisionedRuntime): Promise<void> {
    const credential: Required<Omit<CredentialFile, "version">> & { version: number } = {
      version: 2,
      environment_id: runtime.environment_id,
      tenant_id: runtime.tenant_id,
      program_id: runtime.program_id,
      api_url: runtime.api_url,
      api_key: runtime.api_key,
      api_key_deprecated: true,
      merchant_api_key: runtime.merchant_api_key,
      merchant_api_key_id: runtime.merchant_api_key_id,
      port: runtime.port
    };
    // Atomic replace (temp file + rename): a crash mid-write must never leave
    // a truncated or corrupted credentials file behind.
    const tempPath = `${runtime.credentials_path}.tmp`;
    await writeFile(
      tempPath,
      `${JSON.stringify(credential, undefined, 2)}\n`,
      { mode: 0o600 }
    );
    try {
      await rename(tempPath, runtime.credentials_path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async allocatePort(environmentId: string, preferred?: number): Promise<number> {
    const used = new Set(this.portAssignments.values());
    for (const entry of this.running.values()) used.add(entry.runtime.port);
    const candidates = [
      ...(preferred && preferred >= this.basePort && preferred < this.basePort + this.portRange
        ? [preferred]
        : []),
      preferredPort(environmentId, this.basePort, this.portRange),
      ...Array.from({ length: this.portRange }, (_, index) => this.basePort + index)
    ];
    for (const candidate of candidates) {
      if (this.portAssignments.get(environmentId) === candidate || !used.has(candidate)) {
        this.portAssignments.set(environmentId, candidate);
        return candidate;
      }
    }
    throw new Error(
      `No free data-plane ports remain in ${this.basePort}-${this.basePort + this.portRange - 1}`
    );
  }

  private async loadPortRegistry(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.portsPath, "utf8")) as Record<string, number>;
      this.portAssignments = new Map(
        Object.entries(raw).filter((entry): entry is [string, number] =>
          typeof entry[1] === "number"
        )
      );
    } catch {
      this.portAssignments = new Map();
    }
  }

  private async savePortRegistry(): Promise<void> {
    await writeFile(
      this.portsPath,
      `${JSON.stringify(Object.fromEntries(this.portAssignments), undefined, 2)}\n`,
      { mode: 0o600 }
    );
  }

  private async loadProgram(programId: string): Promise<ProgramDefinition> {
    const path = join(resolve(this.options.programDirectory), `${programId}.json`);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new Error(
        `No program definition exists for ${programId}; add ${path} before provisioning`
      );
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Program file ${path} must contain a JSON object`);
    }
    const program = parsed as ProgramDefinition;
    if (program.program_id !== programId) {
      throw new Error(
        `Program file ${path} defines ${program.program_id}, expected ${programId}`
      );
    }
    return program;
  }
}
