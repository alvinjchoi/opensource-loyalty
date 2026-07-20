import { randomUUID } from "node:crypto";
import {
  EngineError,
  type LoyaltyEngine,
  type LoyaltyEngineState,
  type ReferenceMembership
} from "@loyalty-interchange/reference";
import type { AsyncStateStore } from "@loyalty-interchange/storage";

export interface MembershipAuditEntry {
  audit_id: string;
  member_id: string;
  action: "membership.granted" | "membership.lapsed" | "membership.cancelled";
  actor: string;
  occurred_at: string;
  plan_id: string;
}

export interface MembershipSnapshot {
  memberships: Array<{ member_id: string; membership: ReferenceMembership }>;
  audit: MembershipAuditEntry[];
}

export interface MembershipAuditState {
  version: 1;
  audit: MembershipAuditEntry[];
}

export interface MembershipServiceOptions {
  store: AsyncStateStore<MembershipAuditState>;
  engine: LoyaltyEngine;
  persistEngine: (state: LoyaltyEngineState) => void;
  /**
   * Runs an engine mutation inside an external storage transaction (Postgres
   * mode); defaults to a passthrough for the single-writer SQLite runtime.
   */
  executeEngineOperation?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  reset?: boolean;
  schedulerIntervalMs?: number | false;
}

export class MembershipService {
  private readonly engine: LoyaltyEngine;
  private readonly persistEngine: (state: LoyaltyEngineState) => void;
  private readonly executeEngineOperation: <T>(operation: () => T | Promise<T>) => Promise<T>;
  private readonly store: AsyncStateStore<MembershipAuditState>;
  private readonly scheduler: NodeJS.Timeout | undefined;
  private state: MembershipAuditState;
  private revision: number;

  private constructor(
    options: MembershipServiceOptions,
    state: MembershipAuditState,
    revision: number
  ) {
    this.engine = options.engine;
    this.persistEngine = options.persistEngine;
    this.executeEngineOperation =
      options.executeEngineOperation ?? (async (operation) => operation());
    this.store = options.store;
    this.state = state;
    this.revision = revision;
    this.scheduler = options.schedulerIntervalMs
      ? setInterval(() => {
          this.lapseExpired("scheduler").catch((error: unknown) => {
            console.error(
              `[lip] membership scheduler failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        }, options.schedulerIntervalMs).unref()
      : undefined;
  }

  public static async create(options: MembershipServiceOptions): Promise<MembershipService> {
    if (options.reset) await options.store.clear();
    const loaded = await options.store.load();
    const state = loaded?.state ?? { version: 1 as const, audit: [] };
    if (state.version !== 1) {
      await options.store.close();
      throw new Error(`Unsupported membership state version: ${String(state.version)}`);
    }
    const service = new MembershipService(options, state, loaded?.revision ?? 0);
    await service.save();
    return service;
  }

  public snapshot(): MembershipSnapshot {
    return {
      memberships: this.engine.inspectAdmin().members.flatMap(({ member }) => {
        const value = member.attributes?.["membership"];
        return value && typeof value === "object" && !Array.isArray(value)
          ? [{ member_id: member.member_id, membership: structuredClone(value) as ReferenceMembership }]
          : [];
      }),
      audit: structuredClone(this.state.audit)
    };
  }

  public async grant(input: {
    member_id: string;
    plan_id: string;
    valid_from?: string;
    valid_until: string;
    billing_reference?: string;
  }, actor: string): Promise<ReferenceMembership> {
    const plan = this.engine.getProgramDefinition().membership_policy?.plans.find((candidate) =>
      candidate.plan_id === input.plan_id
    );
    if (!plan) throw new EngineError("not_found", "Membership plan was not found", 404);
    const validFrom = input.valid_from ?? new Date().toISOString();
    if (
      !Number.isFinite(Date.parse(validFrom)) ||
      !Number.isFinite(Date.parse(input.valid_until)) ||
      Date.parse(input.valid_until) <= Date.parse(validFrom)
    ) {
      throw new EngineError("validation_failed", "Membership validity window is invalid", 422);
    }
    const membership: ReferenceMembership = {
      plan_id: input.plan_id,
      status: "active",
      valid_from: new Date(validFrom).toISOString(),
      valid_until: new Date(input.valid_until).toISOString(),
      ...(input.billing_reference ? { billing_reference: input.billing_reference } : {})
    };
    await this.executeEngineOperation(() => {
      this.engine.setMemberMembership(input.member_id, membership);
      this.persistEngine(this.engine.exportState());
    });
    await this.audit(input.member_id, membership.plan_id, "membership.granted", actor);
    return structuredClone(membership);
  }

  public async changeStatus(
    memberId: string,
    status: "lapsed" | "cancelled",
    actor: string
  ): Promise<ReferenceMembership> {
    const membership = this.membershipFor(memberId);
    const updated: ReferenceMembership = { ...membership, status };
    await this.executeEngineOperation(() => {
      this.engine.setMemberMembership(memberId, updated);
      this.persistEngine(this.engine.exportState());
    });
    await this.audit(
      memberId,
      updated.plan_id,
      status === "lapsed" ? "membership.lapsed" : "membership.cancelled",
      actor
    );
    return structuredClone(updated);
  }

  public async lapseExpired(actor = "scheduler", at = new Date()): Promise<number> {
    let count = 0;
    for (const { member_id: memberId, membership } of this.snapshot().memberships) {
      if (membership.status === "active" && Date.parse(membership.valid_until) <= at.getTime()) {
        await this.changeStatus(memberId, "lapsed", actor);
        count += 1;
      }
    }
    return count;
  }

  public assertCompatibleProgram(plans: string[]): void {
    const planIds = new Set(plans);
    const active = this.snapshot().memberships.find(({ membership }) =>
      membership.status === "active" && !planIds.has(membership.plan_id)
    );
    if (active) {
      throw new EngineError(
        "conflict",
        `Membership plan ${active.membership.plan_id} has active members`,
        409
      );
    }
  }

  public async close(): Promise<void> {
    if (this.scheduler) clearInterval(this.scheduler);
    await this.store.close();
  }

  private membershipFor(memberId: string): ReferenceMembership {
    const value = this.engine.inspectAdmin().members.find(({ member }) =>
      member.member_id === memberId
    )?.member.attributes?.["membership"];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new EngineError("not_found", "Member has no membership", 404);
    }
    return structuredClone(value) as ReferenceMembership;
  }

  private async audit(
    memberId: string,
    planId: string,
    action: MembershipAuditEntry["action"],
    actor: string
  ): Promise<void> {
    const entry: MembershipAuditEntry = {
      audit_id: `membership-audit_${randomUUID()}`,
      member_id: memberId,
      plan_id: planId,
      action,
      actor,
      occurred_at: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      audit: [entry, ...this.state.audit].slice(0, 200)
    };
    await this.save();
  }

  private async save(): Promise<void> {
    this.revision = await this.store.save(this.state, this.revision);
  }
}
