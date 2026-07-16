import { randomUUID } from "node:crypto";
import {
  EngineError,
  type LoyaltyEngine,
  type LoyaltyEngineState,
  type ReferenceMembership
} from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";

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

interface MembershipAuditState {
  version: 1;
  audit: MembershipAuditEntry[];
}

export class MembershipService {
  private readonly engine: LoyaltyEngine;
  private readonly persistEngine: (state: LoyaltyEngineState) => void;
  private readonly store: SqliteStateStore<MembershipAuditState>;
  private readonly scheduler: NodeJS.Timeout | undefined;
  private state: MembershipAuditState;

  public constructor(options: {
    path: string;
    engine: LoyaltyEngine;
    persistEngine: (state: LoyaltyEngineState) => void;
    reset?: boolean;
    schedulerIntervalMs?: number | false;
  }) {
    this.engine = options.engine;
    this.persistEngine = options.persistEngine;
    this.store = new SqliteStateStore<MembershipAuditState>({
      path: options.path,
      key: `${options.engine.getProgramDefinition().program_id}:memberships`
    });
    if (options.reset) this.store.clear();
    this.state = this.store.load() ?? { version: 1, audit: [] };
    if (this.state.version !== 1) {
      this.store.close();
      throw new Error(`Unsupported membership state version: ${String(this.state.version)}`);
    }
    this.scheduler = options.schedulerIntervalMs
      ? setInterval(() => this.lapseExpired("scheduler"), options.schedulerIntervalMs).unref()
      : undefined;
    this.save();
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

  public grant(input: {
    member_id: string;
    plan_id: string;
    valid_from?: string;
    valid_until: string;
    billing_reference?: string;
  }, actor: string): ReferenceMembership {
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
    this.engine.setMemberMembership(input.member_id, membership);
    this.persistEngine(this.engine.exportState());
    this.audit(input.member_id, membership.plan_id, "membership.granted", actor);
    return structuredClone(membership);
  }

  public changeStatus(
    memberId: string,
    status: "lapsed" | "cancelled",
    actor: string
  ): ReferenceMembership {
    const membership = this.membershipFor(memberId);
    const updated: ReferenceMembership = { ...membership, status };
    this.engine.setMemberMembership(memberId, updated);
    this.persistEngine(this.engine.exportState());
    this.audit(
      memberId,
      updated.plan_id,
      status === "lapsed" ? "membership.lapsed" : "membership.cancelled",
      actor
    );
    return structuredClone(updated);
  }

  public lapseExpired(actor = "scheduler", at = new Date()): number {
    let count = 0;
    for (const { member_id: memberId, membership } of this.snapshot().memberships) {
      if (membership.status === "active" && Date.parse(membership.valid_until) <= at.getTime()) {
        this.changeStatus(memberId, "lapsed", actor);
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

  public close(): void {
    if (this.scheduler) clearInterval(this.scheduler);
    this.store.close();
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

  private audit(
    memberId: string,
    planId: string,
    action: MembershipAuditEntry["action"],
    actor: string
  ): void {
    this.state.audit.unshift({
      audit_id: `membership-audit_${randomUUID()}`,
      member_id: memberId,
      plan_id: planId,
      action,
      actor,
      occurred_at: new Date().toISOString()
    });
    this.state.audit = this.state.audit.slice(0, 200);
    this.save();
  }

  private save(): void {
    this.store.save(this.state);
  }
}
