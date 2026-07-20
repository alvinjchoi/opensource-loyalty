import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createDemoPlatform,
  createPostgresProtocolPlatform,
  startReferenceServer
} from "@loyalty-interchange/server";
import type { ProgramDefinition } from "@loyalty-interchange/reference";
import type { CloudProvisioner } from "./provisioning.js";
import type { CloudEnvironment, CloudProvisioningJob, CloudProvisioningResult } from "./types.js";

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
  api_key: string;
  credentials_path: string;
  port: number;
}

interface CredentialFile {
  environment_id: string;
  tenant_id: string;
  program_id: string;
  api_url: string;
  api_key: string;
  port: number;
}

interface RunningRuntime {
  runtime: ProvisionedRuntime;
  close: () => Promise<void>;
}

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
      const raw = await readFile(join(dataDir, name), "utf8");
      const credential = JSON.parse(raw) as CredentialFile;
      if (!credential.environment_id || !credential.tenant_id || !credential.program_id) {
        continue;
      }
      if (this.running.has(credential.environment_id)) continue;
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
      const runtime = await this.startRuntime(environment, {
        apiKey: credential.api_key,
        ...(port ? { port } : {})
      });
      restored.push(runtime);
    }
    return restored;
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
      ...(port ? { port } : {})
    });
    return { api_url: runtime.api_url, admin_url: runtime.admin_url };
  }

  public runtimes(): ProvisionedRuntime[] {
    return [...this.running.values()].map((entry) => ({ ...entry.runtime }));
  }

  public async close(): Promise<void> {
    const entries = [...this.running.values()];
    this.running.clear();
    for (const entry of entries) await entry.close();
  }

  private async startRuntime(
    environment: CloudEnvironment,
    options: { apiKey?: string; port?: number }
  ): Promise<ProvisionedRuntime> {
    const program = await this.loadProgram(environment.program_id);
    const apiKey = options.apiKey?.trim() || generateApiKey();
    const port = await this.allocatePort(environment.environment_id, options.port);
    const host = this.options.host ?? "127.0.0.1";
    const publicHost = this.options.publicHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
    const platform = this.options.connectionString
      ? await createPostgresProtocolPlatform({
          connectionString: this.options.connectionString,
          tenantId: environment.tenant_id,
          program,
          seed: false
        })
      : await createDemoPlatform({
          databasePath: join(
            resolve(this.options.dataDirectory),
            `${environment.tenant_id}.db`
          ),
          program,
          seed: false
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
          : { persistState: (state) => platform.store.save(state) })
      });
    } catch (error) {
      await Promise.resolve(platform.close());
      throw error;
    }
    const apiUrl = `http://${publicHost}:${port}`;
    const runtime: ProvisionedRuntime = {
      environment_id: environment.environment_id,
      tenant_id: environment.tenant_id,
      program_id: environment.program_id,
      api_url: apiUrl,
      admin_url: `${apiUrl}/admin/`,
      api_key: apiKey,
      credentials_path: join(
        resolve(this.options.dataDirectory),
        `${environment.environment_id}.credentials.json`
      ),
      port
    };
    try {
      await writeFile(
        runtime.credentials_path,
        `${JSON.stringify(
          {
            environment_id: runtime.environment_id,
            tenant_id: runtime.tenant_id,
            program_id: runtime.program_id,
            api_url: runtime.api_url,
            api_key: runtime.api_key,
            port: runtime.port
          },
          undefined,
          2
        )}\n`,
        { mode: 0o600 }
      );
      await this.savePortRegistry();
    } catch (error) {
      await server.close();
      await Promise.resolve(platform.close());
      throw error;
    }
    this.running.set(environment.environment_id, {
      runtime,
      close: async () => {
        await server.close();
        await Promise.resolve(platform.close());
      }
    });
    this.options.onProvisioned?.(runtime);
    return runtime;
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
