import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
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
   * Directory for per-environment SQLite databases and credential files.
   * Created on demand.
   */
  dataDirectory: string;
  /**
   * Optional Postgres connection string. When set, environments run against
   * tenant-scoped Postgres tables instead of per-environment SQLite files.
   */
  connectionString?: string;
  /** Listen host for provisioned runtimes. Defaults to 127.0.0.1. */
  host?: string;
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
}

interface RunningRuntime {
  runtime: ProvisionedRuntime;
  close: () => Promise<void>;
}

function generateApiKey(): string {
  return `lip_sk_${randomBytes(32).toString("base64url")}`;
}

/**
 * Runs LIP data-plane runtimes inside the control-plane process: one HTTP
 * server and one isolated store per environment. This makes `pending`
 * environments reach `ready` with a real, reachable `api_url` and a generated
 * merchant API key, so the managed path can be exercised end to end.
 *
 * Deliberate spike boundaries: runtimes live and die with this process, ports
 * are ephemeral, and credentials are delivered as 0600 files in the data
 * directory rather than an encrypted credential store.
 */
export class LocalDataPlaneProvisioner implements CloudProvisioner {
  private readonly options: LocalDataPlaneProvisionerOptions;
  private readonly running = new Map<string, RunningRuntime>();

  public constructor(options: LocalDataPlaneProvisionerOptions) {
    if (!options.programDirectory.trim() || !options.dataDirectory.trim()) {
      throw new Error("Program and data directories are required");
    }
    this.options = options;
    mkdirSync(resolve(options.dataDirectory), { recursive: true });
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
    const program = await this.loadProgram(environment.program_id);
    const apiKey = generateApiKey();
    const platform = this.options.connectionString
      ? await createPostgresProtocolPlatform({
          connectionString: this.options.connectionString,
          tenantId: environment.tenant_id,
          program,
          seed: false
        })
      : createDemoPlatform({
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
        host: this.options.host ?? "127.0.0.1",
        port: 0,
        reservationTtlSeconds: program.reservation_ttl_seconds ?? 120,
        ...("executeEngineOperation" in platform
          ? { executeEngineOperation: platform.executeEngineOperation }
          : { persistState: (state) => platform.store.save(state) })
      });
    } catch (error) {
      await Promise.resolve(platform.close());
      throw error;
    }
    const runtime: ProvisionedRuntime = {
      environment_id: environment.environment_id,
      tenant_id: environment.tenant_id,
      program_id: environment.program_id,
      api_url: server.url,
      admin_url: `${server.url}/admin/`,
      api_key: apiKey,
      credentials_path: join(
        resolve(this.options.dataDirectory),
        `${environment.environment_id}.credentials.json`
      )
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
            api_key: runtime.api_key
          },
          undefined,
          2
        )}\n`,
        { mode: 0o600 }
      );
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
