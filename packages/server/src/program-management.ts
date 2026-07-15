import {
  EngineError,
  LoyaltyEngine,
  assertCompatibleProgramUpdate,
  programDefinitionFingerprint,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";

export interface ProgramValidationIssue {
  path: string;
  message: string;
}

export interface ProgramValidationResult {
  ok: boolean;
  issues: ProgramValidationIssue[];
}

export interface ProgramDraft {
  version: number;
  updated_at: string;
  updated_by: string;
  program: unknown;
  validation: ProgramValidationResult;
}

export interface ProgramRevision {
  revision: number;
  published_at: string;
  published_by: string;
  program: ProgramDefinition;
}

export interface ProgramAuditEntry {
  audit_id: string;
  action: "draft.saved" | "draft.discarded" | "program.published" | "program.rolled_back";
  actor: string;
  occurred_at: string;
  revision?: number;
  draft_version?: number;
}

export interface ProgramManagementSnapshot {
  active_revision: number;
  active_published_at: string;
  active_published_by: string;
  active_program: ProgramDefinition;
  draft?: ProgramDraft;
  history: ProgramRevision[];
  audit: ProgramAuditEntry[];
}

interface ProgramManagementState extends ProgramManagementSnapshot {
  version: 1;
}

const allowedProgramFields = new Set([
  "program_id",
  "name",
  "description",
  "currency",
  "accounts",
  "metrics",
  "tiers",
  "tier_policy",
  "point_expiration",
  "earning_policy",
  "earn_rate",
  "evaluation_ttl_seconds",
  "reservation_ttl_seconds",
  "rewards",
  "metadata"
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now(): string {
  return new Date().toISOString();
}

function validationIssue(error: unknown): ProgramValidationIssue {
  const message = error instanceof Error ? error.message : "Program definition is invalid";
  const path = message.includes("currency") || message.includes("Program id")
    ? "/program_id"
    : message.includes("Earn rate")
      ? "/earn_rate"
      : message.includes("TTL")
        ? "/evaluation_ttl_seconds"
        : message.includes("Minimum eligible")
          ? "/earning_policy/minimum_eligible_spend_minor_units"
          : message.includes("Eligible channels")
            ? "/earning_policy/eligible_channels"
            : message.includes("expiration")
              ? "/point_expiration"
              : message.includes("account")
                ? "/accounts"
                : message.includes("Metric")
                  ? "/metrics"
                  : message.includes("Tier")
                    ? "/tiers"
                    : message.includes("Reward") || message.includes("Funding")
                      ? "/rewards"
                      : "/";
  return {
    path,
    message
  };
}

export function validateProgramDefinition(program: unknown): ProgramValidationResult {
  if (!program || typeof program !== "object" || Array.isArray(program)) {
    return { ok: false, issues: [{ path: "/", message: "Program definition must be an object" }] };
  }
  const unknownFields = Object.keys(program).filter((field) => !allowedProgramFields.has(field));
  if (unknownFields.length > 0) {
    return {
      ok: false,
      issues: unknownFields.map((field) => ({
        path: `/${field}`,
        message: "Unknown program field"
      }))
    };
  }
  const values = program as Record<string, unknown>;
  const identityIssues: ProgramValidationIssue[] = [];
  if (typeof values["program_id"] !== "string" || values["program_id"].length === 0) {
    identityIssues.push({ path: "/program_id", message: "Program id is required" });
  }
  if (typeof values["currency"] !== "string" || !/^[A-Z]{3}$/.test(values["currency"])) {
    identityIssues.push({ path: "/currency", message: "Currency must be a three-letter ISO code" });
  }
  if (identityIssues.length > 0) return { ok: false, issues: identityIssues };
  try {
    new LoyaltyEngine(program as ProgramDefinition);
    return { ok: true, issues: [] };
  } catch (error) {
    return { ok: false, issues: [validationIssue(error)] };
  }
}

export class ProgramManagementService {
  private readonly store: SqliteStateStore<ProgramManagementState>;
  private state: ProgramManagementState;
  private applyProgram?: (program: ProgramDefinition) => void;

  public constructor(options: {
    path: string;
    initialProgram: ProgramDefinition;
    reset?: boolean;
  }) {
    this.store = new SqliteStateStore<ProgramManagementState>({
      path: options.path,
      key: "reference:program-management"
    });
    if (options.reset) this.store.clear();
    const stored = this.store.load();
    if (stored && stored.version !== 1) {
      this.store.close();
      throw new Error(`Unsupported program-management state version: ${String(stored.version)}`);
    }
    this.state = stored ?? (() => {
      const timestamp = now();
      return {
        version: 1 as const,
        active_revision: 1,
        active_published_at: timestamp,
        active_published_by: "bootstrap",
        active_program: clone(options.initialProgram),
        history: [],
        audit: []
      };
    })();
    const validation = validateProgramDefinition(this.state.active_program);
    if (!validation.ok) {
      this.store.close();
      throw new EngineError(
        "invalid_program",
        `Published program is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`,
        500
      );
    }
    this.save();
  }

  public snapshot(): ProgramManagementSnapshot {
    const { version: _version, ...snapshot } = this.state;
    return clone(snapshot);
  }

  public activeProgram(): ProgramDefinition {
    return clone(this.state.active_program);
  }

  public programForFingerprint(value: string): ProgramDefinition | undefined {
    const candidates = [
      this.state.active_program,
      ...this.state.history.map((revision) => revision.program)
    ];
    const match = candidates.find((program) => programDefinitionFingerprint(program) === value);
    return match ? clone(match) : undefined;
  }

  public saveDraft(program: unknown, actor: string): ProgramManagementSnapshot {
    const timestamp = now();
    const draftVersion = (this.state.draft?.version ?? this.state.active_revision) + 1;
    this.state.draft = {
      version: draftVersion,
      updated_at: timestamp,
      updated_by: actor,
      program: clone(program),
      validation: validateProgramDefinition(program)
    };
    this.recordAudit({
      audit_id: `audit_${crypto.randomUUID()}`,
      action: "draft.saved",
      actor,
      occurred_at: timestamp,
      draft_version: draftVersion
    });
    this.save();
    return this.snapshot();
  }

  public validateDraft(): ProgramValidationResult {
    const draft = this.state.draft;
    if (!draft) {
      return { ok: false, issues: [{ path: "/", message: "No program draft exists" }] };
    }
    draft.validation = validateProgramDefinition(draft.program);
    this.save();
    return clone(draft.validation);
  }

  public discardDraft(actor: string): ProgramManagementSnapshot {
    if (!this.state.draft) throw new EngineError("not_found", "No program draft exists", 404);
    const draftVersion = this.state.draft.version;
    delete this.state.draft;
    this.recordAudit({
      audit_id: `audit_${crypto.randomUUID()}`,
      action: "draft.discarded",
      actor,
      occurred_at: now(),
      draft_version: draftVersion
    });
    this.save();
    return this.snapshot();
  }

  public bindPublisher(apply: (program: ProgramDefinition) => void): void {
    this.applyProgram = apply;
  }

  public publish(
    expectedDraftVersion: number,
    actor: string
  ): ProgramManagementSnapshot {
    const draft = this.state.draft;
    if (!draft) throw new EngineError("not_found", "No program draft exists", 404);
    if (draft.version !== expectedDraftVersion) {
      throw new EngineError("conflict", "Program draft changed; refresh before publishing", 409);
    }
    const validation = validateProgramDefinition(draft.program);
    if (!validation.ok) {
      draft.validation = validation;
      this.save();
      throw new EngineError(
        "invalid_program",
        validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
        422
      );
    }
    const nextProgram = clone(draft.program as ProgramDefinition);
    assertCompatibleProgramUpdate(this.state.active_program, nextProgram);
    return this.applyPublishedProgram(nextProgram, actor, "program.published");
  }

  public rollback(
    revision: number,
    actor: string
  ): ProgramManagementSnapshot {
    const target = this.state.history.find((candidate) => candidate.revision === revision);
    if (!target) throw new EngineError("not_found", `Program revision ${revision} was not found`, 404);
    assertCompatibleProgramUpdate(this.state.active_program, target.program);
    return this.applyPublishedProgram(target.program, actor, "program.rolled_back");
  }

  public close(): void {
    this.store.close();
  }

  private applyPublishedProgram(
    program: ProgramDefinition,
    actor: string,
    action: "program.published" | "program.rolled_back"
  ): ProgramManagementSnapshot {
    const apply = this.applyProgram;
    if (!apply) throw new Error("Program publisher is not bound");
    const previous = clone(this.state);
    const timestamp = now();
    const revision = this.state.active_revision + 1;
    this.state.history.unshift({
      revision: this.state.active_revision,
      published_at: this.state.active_published_at,
      published_by: this.state.active_published_by,
      program: clone(this.state.active_program)
    });
    this.state.history = this.state.history.slice(0, 20);
    this.state.active_revision = revision;
    this.state.active_published_at = timestamp;
    this.state.active_published_by = actor;
    this.state.active_program = clone(program);
    delete this.state.draft;
    this.recordAudit({
      audit_id: `audit_${crypto.randomUUID()}`,
      action,
      actor,
      occurred_at: timestamp,
      revision
    });
    // Persist intent first. Startup can safely retarget the previous engine
    // snapshot to this compatible published definition after an interrupted write.
    this.save();
    try {
      apply(clone(program));
    } catch (error) {
      this.state = previous;
      this.save();
      throw error;
    }
    return this.snapshot();
  }

  private recordAudit(entry: ProgramAuditEntry): void {
    this.state.audit.unshift(entry);
    this.state.audit = this.state.audit.slice(0, 100);
  }

  private save(): void {
    this.store.save(this.state);
  }
}
