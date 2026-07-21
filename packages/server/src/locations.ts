import { randomUUID } from "node:crypto";
import { EngineError } from "@loyalty-interchange/reference";
import type { AsyncStateStore } from "@loyalty-interchange/storage";
import { assertLocationId } from "./location-ids.js";

export interface LocationEntry {
  location_id: string;
  name: string;
  franchisee_id?: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LocationAuditEntry {
  audit_id: string;
  location_id: string;
  action: "location.upserted" | "location.removed";
  actor: string;
  occurred_at: string;
  /** Attribution fields at the time of the change (upserts only). */
  metadata?: Record<string, unknown>;
}

export interface LocationDirectoryState {
  version: 1;
  locations: LocationEntry[];
  audit: LocationAuditEntry[];
}

export interface LocationDirectorySnapshot {
  locations: LocationEntry[];
  audit: LocationAuditEntry[];
}

export interface LocationDirectoryServiceOptions {
  store: AsyncStateStore<LocationDirectoryState>;
  reset?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Per-tenant registry of operating locations and their franchise owners. The
 * registry names locations in per-location reports and resolves franchisee
 * ownership; it rides the shared extension state store, so no dedicated
 * tables or migrations are required.
 */
export class LocationDirectoryService {
  private readonly store: AsyncStateStore<LocationDirectoryState>;
  private state: LocationDirectoryState;
  private revision: number;

  private constructor(
    options: LocationDirectoryServiceOptions,
    state: LocationDirectoryState,
    revision: number
  ) {
    this.store = options.store;
    this.state = state;
    this.revision = revision;
  }

  public static async create(
    options: LocationDirectoryServiceOptions
  ): Promise<LocationDirectoryService> {
    if (options.reset) await options.store.clear();
    const loaded = await options.store.load();
    const state = loaded?.state ?? {
      version: 1 as const,
      locations: [],
      audit: []
    };
    if (state.version !== 1) {
      await options.store.close();
      throw new Error(`Unsupported location directory state version: ${String(state.version)}`);
    }
    const service = new LocationDirectoryService(options, state, loaded?.revision ?? 0);
    await service.save();
    return service;
  }

  public snapshot(): LocationDirectorySnapshot {
    return structuredClone({
      locations: this.state.locations,
      audit: this.state.audit
    });
  }

  public locationById(locationId: string): LocationEntry | undefined {
    const location = this.state.locations.find((candidate) =>
      candidate.location_id === locationId
    );
    return location ? structuredClone(location) : undefined;
  }

  public async upsertLocation(input: {
    location_id: string;
    name: string;
    /** Omit to preserve the stored franchisee; null clears it explicitly. */
    franchisee_id?: string | null;
    active?: boolean;
  }, actor: string): Promise<LocationEntry> {
    const locationId = input.location_id.trim();
    if (!locationId) {
      throw new EngineError("validation_failed", "A non-empty location_id is required", 422);
    }
    assertLocationId(locationId, "location_id");
    const name = input.name.trim();
    if (!name) {
      throw new EngineError("validation_failed", "A non-empty location name is required", 422);
    }
    const timestamp = now();
    const existing = this.state.locations.find((location) =>
      location.location_id === locationId
    );
    const franchiseeId = input.franchisee_id === undefined
      ? existing?.franchisee_id
      : input.franchisee_id === null
        ? undefined
        : input.franchisee_id.trim() || undefined;
    const location: LocationEntry = {
      location_id: locationId,
      name,
      active: input.active ?? existing?.active ?? true,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
      ...(franchiseeId ? { franchisee_id: franchiseeId } : {})
    };
    this.state = {
      ...this.state,
      locations: existing
        ? this.state.locations.map((candidate) =>
            candidate.location_id === locationId ? location : candidate
          )
        : [...this.state.locations, location].sort((left, right) =>
            left.location_id.localeCompare(right.location_id)
          )
    };
    await this.recordAudit("location.upserted", locationId, actor, {
      active: location.active,
      ...(location.franchisee_id
        ? { franchisee_id: location.franchisee_id }
        : input.franchisee_id === null
          ? { franchisee_id: null }
          : {})
    });
    return structuredClone(location);
  }

  public async removeLocation(locationId: string, actor: string): Promise<void> {
    if (!this.state.locations.some((location) => location.location_id === locationId)) {
      throw new EngineError("not_found", "Location was not found", 404);
    }
    this.state = {
      ...this.state,
      locations: this.state.locations.filter((location) =>
        location.location_id !== locationId
      )
    };
    await this.recordAudit("location.removed", locationId, actor);
  }

  public async close(): Promise<void> {
    await this.store.close();
  }

  private async recordAudit(
    action: LocationAuditEntry["action"],
    locationId: string,
    actor: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const entry: LocationAuditEntry = {
      audit_id: `location-audit_${randomUUID()}`,
      location_id: locationId,
      action,
      actor,
      occurred_at: now(),
      ...(metadata ? { metadata: structuredClone(metadata) } : {})
    };
    this.state = {
      ...this.state,
      audit: [entry, ...this.state.audit].slice(0, 1_000)
    };
    await this.save();
  }

  private async save(): Promise<void> {
    this.revision = await this.store.save(this.state, this.revision);
  }
}
