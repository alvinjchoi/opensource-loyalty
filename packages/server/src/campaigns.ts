import { randomUUID } from "node:crypto";
import {
  EngineError,
  type LoyaltyEngine,
  type LoyaltyEngineState,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import type { AsyncStateStore } from "@loyalty-interchange/storage";

export interface StaticSegment {
  segment_id: string;
  name: string;
  mode: "static" | "dynamic";
  member_ids: string[];
  rules?: {
    statuses?: Array<"active" | "suspended" | "closed">;
    tier_ids?: string[];
    minimum_available_balance?: number;
    attributes?: Record<string, unknown>;
  };
  created_at: string;
  updated_at: string;
}

export interface RewardCampaign {
  campaign_id: string;
  name: string;
  reward_id: string;
  segment_id: string;
  status: "draft" | "scheduled" | "completed" | "expired";
  issued_reward_ttl_seconds?: number;
  starts_at?: string;
  ends_at?: string;
  created_at: string;
  updated_at: string;
  last_run_at?: string;
}

export interface CampaignRun {
  run_id: string;
  campaign_id: string;
  actor: string;
  started_at: string;
  completed_at: string;
  issued: number;
  skipped: number;
  failed: number;
  outcomes: Array<{
    member_id: string;
    issued_reward_id: string;
    status: "issued" | "skipped" | "failed";
    error?: string;
  }>;
}

export interface CampaignSnapshot {
  segments: StaticSegment[];
  campaigns: RewardCampaign[];
  runs: CampaignRun[];
}

export interface CampaignState extends CampaignSnapshot {
  version: 1;
}

export interface CampaignServiceOptions {
  store: AsyncStateStore<CampaignState>;
  engine: LoyaltyEngine;
  persistEngine: (state: LoyaltyEngineState) => void;
  reset?: boolean;
  schedulerIntervalMs?: number | false;
}

function timestamp(): string {
  return new Date().toISOString();
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new EngineError("validation_failed", `${name} is required`, 422);
  return normalized;
}

export class CampaignService {
  private readonly store: AsyncStateStore<CampaignState>;
  private readonly engine: LoyaltyEngine;
  private readonly persistEngine: (state: LoyaltyEngineState) => void;
  private readonly scheduler: NodeJS.Timeout | undefined;
  private state: CampaignState;
  private revision: number;

  private constructor(
    options: CampaignServiceOptions,
    state: CampaignState,
    revision: number
  ) {
    this.store = options.store;
    this.engine = options.engine;
    this.persistEngine = options.persistEngine;
    this.state = state;
    this.revision = revision;
    this.scheduler = options.schedulerIntervalMs
      ? setInterval(() => {
          this.runDueCampaigns("scheduler").catch((error: unknown) => {
            // Individual campaign/member failures are retained in run outcomes.
            console.error(
              `[lip] campaign scheduler failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        }, options.schedulerIntervalMs).unref()
      : undefined;
  }

  public static async create(options: CampaignServiceOptions): Promise<CampaignService> {
    if (options.reset) await options.store.clear();
    const loaded = await options.store.load();
    const stored = loaded?.state ?? {
      version: 1 as const,
      segments: [],
      campaigns: [],
      runs: []
    };
    if (stored.version !== 1) {
      await options.store.close();
      throw new Error(`Unsupported campaign state version: ${String(stored.version)}`);
    }
    const state: CampaignState = {
      ...stored,
      segments: stored.segments.map((segment) => ({
        ...segment,
        mode: segment.mode ?? (segment.rules ? "dynamic" : "static")
      }))
    };
    const service = new CampaignService(options, state, loaded?.revision ?? 0);
    await service.save();
    return service;
  }

  public snapshot(): CampaignSnapshot {
    return structuredClone({
      segments: this.state.segments,
      campaigns: this.state.campaigns,
      runs: this.state.runs
    });
  }

  public membersForSegment(segmentId: string): string[] {
    const segment = this.state.segments.find((candidate) => candidate.segment_id === segmentId);
    if (!segment) {
      throw new EngineError("not_found", `Segment ${segmentId} was not found`, 404);
    }
    return this.resolveSegmentMembers(segment);
  }

  public async upsertSegment(input: {
    segment_id?: string;
    name: string;
    member_ids?: string[];
    rules?: StaticSegment["rules"];
  }): Promise<StaticSegment> {
    const now = timestamp();
    const segmentId = input.segment_id ?? `segment_${randomUUID()}`;
    const memberIds = [...new Set(
      (input.member_ids ?? []).map((value) => value.trim()).filter(Boolean)
    )];
    const mode = input.rules ? "dynamic" : "static";
    if (mode === "static") {
      if (memberIds.length === 0) {
        throw new EngineError("validation_failed", "A static segment requires at least one member", 422);
      }
      const knownMembers = new Set(
        this.engine.inspectAdmin().members.map(({ member }) => member.member_id)
      );
      const unknown = memberIds.filter((memberId) => !knownMembers.has(memberId));
      if (unknown.length > 0) {
        throw new EngineError("not_found", `Unknown segment members: ${unknown.join(", ")}`, 404);
      }
    } else if (!input.rules || Object.keys(input.rules).length === 0) {
      throw new EngineError("validation_failed", "A dynamic segment requires at least one rule", 422);
    }
    const existing = this.state.segments.find((segment) => segment.segment_id === segmentId);
    const segment: StaticSegment = {
      segment_id: segmentId,
      name: required(input.name, "Segment name"),
      mode,
      member_ids: memberIds,
      ...(input.rules ? { rules: structuredClone(input.rules) } : {}),
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    this.state = {
      ...this.state,
      segments: existing
        ? this.state.segments.map((candidate) =>
            candidate.segment_id === segmentId ? segment : candidate
          )
        : [segment, ...this.state.segments]
    };
    await this.save();
    return structuredClone(segment);
  }

  public async deleteSegment(segmentId: string): Promise<void> {
    if (this.state.campaigns.some((campaign) => campaign.segment_id === segmentId)) {
      throw new EngineError("conflict", "Segment is used by a campaign", 409);
    }
    const segments = this.state.segments.filter((segment) => segment.segment_id !== segmentId);
    if (segments.length === this.state.segments.length) {
      throw new EngineError("not_found", "Segment was not found", 404);
    }
    this.state = { ...this.state, segments };
    await this.save();
  }

  public async upsertCampaign(input: {
    campaign_id?: string;
    name: string;
    reward_id: string;
    segment_id: string;
    issued_reward_ttl_seconds?: number;
    starts_at?: string;
    ends_at?: string;
  }): Promise<RewardCampaign> {
    if (!this.state.segments.some((segment) => segment.segment_id === input.segment_id)) {
      throw new EngineError("not_found", "Campaign segment was not found", 404);
    }
    if (!this.engine.getProgramDefinition().rewards.some((reward) =>
      reward.reward_id === input.reward_id
    )) {
      throw new EngineError("not_found", "Campaign reward was not found", 404);
    }
    if (
      input.issued_reward_ttl_seconds !== undefined &&
      (!Number.isInteger(input.issued_reward_ttl_seconds) ||
        input.issued_reward_ttl_seconds < 60)
    ) {
      throw new EngineError(
        "validation_failed",
        "Issued reward TTL must be an integer of at least 60 seconds",
        422
      );
    }
    const startsAt = input.starts_at ? Date.parse(input.starts_at) : undefined;
    const endsAt = input.ends_at ? Date.parse(input.ends_at) : undefined;
    if (
      (startsAt !== undefined && !Number.isFinite(startsAt)) ||
      (endsAt !== undefined && !Number.isFinite(endsAt)) ||
      (startsAt !== undefined && endsAt !== undefined && endsAt <= startsAt)
    ) {
      throw new EngineError("validation_failed", "Campaign schedule is invalid", 422);
    }
    const now = timestamp();
    const campaignId = input.campaign_id ?? `campaign_${randomUUID()}`;
    const existing = this.state.campaigns.find((campaign) =>
      campaign.campaign_id === campaignId
    );
    const campaign: RewardCampaign = {
      campaign_id: campaignId,
      name: required(input.name, "Campaign name"),
      reward_id: input.reward_id,
      segment_id: input.segment_id,
      status: startsAt !== undefined && startsAt > Date.now()
        ? "scheduled"
        : existing?.status ?? "draft",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...(input.issued_reward_ttl_seconds
        ? { issued_reward_ttl_seconds: input.issued_reward_ttl_seconds }
        : {}),
      ...(input.starts_at ? { starts_at: new Date(startsAt!).toISOString() } : {}),
      ...(input.ends_at ? { ends_at: new Date(endsAt!).toISOString() } : {})
    };
    this.state = {
      ...this.state,
      campaigns: existing
        ? this.state.campaigns.map((candidate) =>
            candidate.campaign_id === campaignId ? campaign : candidate
          )
        : [campaign, ...this.state.campaigns]
    };
    await this.save();
    return structuredClone(campaign);
  }

  public async deleteCampaign(campaignId: string): Promise<void> {
    const campaigns = this.state.campaigns.filter((campaign) =>
      campaign.campaign_id !== campaignId
    );
    if (campaigns.length === this.state.campaigns.length) {
      throw new EngineError("not_found", "Campaign was not found", 404);
    }
    this.state = { ...this.state, campaigns };
    await this.save();
  }

  public async runCampaign(campaignId: string, actor: string): Promise<CampaignRun> {
    const campaign = this.state.campaigns.find((candidate) =>
      candidate.campaign_id === campaignId
    );
    if (!campaign) throw new EngineError("not_found", "Campaign was not found", 404);
    if (campaign.ends_at && Date.parse(campaign.ends_at) <= Date.now()) {
      this.replaceCampaign({ ...campaign, status: "expired", updated_at: timestamp() });
      await this.save();
      throw new EngineError("expired", "Campaign has ended", 409);
    }
    const segment = this.state.segments.find((candidate) =>
      candidate.segment_id === campaign.segment_id
    );
    if (!segment) throw new EngineError("not_found", "Campaign segment was not found", 404);
    const startedAt = timestamp();
    const runId = `run_${randomUUID()}`;
    const outcomes: CampaignRun["outcomes"] = [];
    for (const memberId of this.resolveSegmentMembers(segment)) {
      const issuedRewardId = `${campaign.campaign_id}:${memberId}`;
      try {
        const existing = this.engine.inspectAdmin().issued_rewards.find((reward) =>
          reward.issued_reward_id === issuedRewardId
        );
        if (existing) {
          outcomes.push({ member_id: memberId, issued_reward_id: issuedRewardId, status: "skipped" });
          continue;
        }
        const occurredAt = timestamp();
        this.engine.issueReward({
          context: {
            protocol_version: "1.0",
            profile: "foodservice/1.0",
            request_id: `${runId}:${memberId}`,
            idempotency_key: issuedRewardId,
            occurred_at: occurredAt,
            source: { system: "reference-campaigns", instance: actor }
          },
          issued_reward_id: issuedRewardId,
          member_id: memberId,
          program_id: this.engine.getProgramDefinition().program_id,
          reward_id: campaign.reward_id,
          ...(campaign.issued_reward_ttl_seconds
            ? {
                expires_at: new Date(
                  Date.parse(occurredAt) + campaign.issued_reward_ttl_seconds * 1000
                ).toISOString()
              }
            : {})
        });
        outcomes.push({ member_id: memberId, issued_reward_id: issuedRewardId, status: "issued" });
      } catch (error) {
        outcomes.push({
          member_id: memberId,
          issued_reward_id: issuedRewardId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    this.persistEngine(this.engine.exportState());
    const completedAt = timestamp();
    const run: CampaignRun = {
      run_id: runId,
      campaign_id: campaignId,
      actor,
      started_at: startedAt,
      completed_at: completedAt,
      issued: outcomes.filter(({ status }) => status === "issued").length,
      skipped: outcomes.filter(({ status }) => status === "skipped").length,
      failed: outcomes.filter(({ status }) => status === "failed").length,
      outcomes
    };
    this.state = {
      ...this.state,
      campaigns: this.state.campaigns.map((candidate) =>
        candidate.campaign_id === campaignId
          ? {
              ...candidate,
              status: "completed" as const,
              last_run_at: completedAt,
              updated_at: completedAt
            }
          : candidate
      ),
      runs: [run, ...this.state.runs].slice(0, 100)
    };
    await this.save();
    return structuredClone(run);
  }

  public async runDueCampaigns(actor = "scheduler", at = new Date()): Promise<CampaignRun[]> {
    const nowMs = at.getTime();
    const runs: CampaignRun[] = [];
    const scheduledIds = this.state.campaigns
      .filter((campaign) => campaign.status === "scheduled")
      .map((campaign) => campaign.campaign_id);
    for (const campaignId of scheduledIds) {
      const campaign = this.state.campaigns.find((candidate) =>
        candidate.campaign_id === campaignId
      );
      if (!campaign || campaign.status !== "scheduled") continue;
      if (campaign.ends_at && Date.parse(campaign.ends_at) <= nowMs) {
        this.replaceCampaign({ ...campaign, status: "expired", updated_at: at.toISOString() });
        continue;
      }
      if (!campaign.starts_at || Date.parse(campaign.starts_at) <= nowMs) {
        runs.push(await this.runCampaign(campaign.campaign_id, actor));
      }
    }
    await this.save();
    return runs;
  }

  public assertCompatibleProgram(program: ProgramDefinition): void {
    const rewardIds = new Set(program.rewards.map((reward) => reward.reward_id));
    const incompatible = this.state.campaigns.find((campaign) =>
      !rewardIds.has(campaign.reward_id)
    );
    if (incompatible) {
      throw new EngineError(
        "conflict",
        `Reward ${incompatible.reward_id} is used by campaign ${incompatible.campaign_id}`,
        409
      );
    }
  }

  public async close(): Promise<void> {
    if (this.scheduler) clearInterval(this.scheduler);
    await this.store.close();
  }

  private replaceCampaign(campaign: RewardCampaign): void {
    this.state = {
      ...this.state,
      campaigns: this.state.campaigns.map((candidate) =>
        candidate.campaign_id === campaign.campaign_id ? campaign : candidate
      )
    };
  }

  private async save(): Promise<void> {
    this.revision = await this.store.save(this.state, this.revision);
  }

  private resolveSegmentMembers(segment: StaticSegment): string[] {
    if (segment.mode === "static") return [...segment.member_ids];
    const rules = segment.rules ?? {};
    return this.engine.inspectAdmin().members
      .filter(({ member, balance }) => {
        if (rules.statuses && !rules.statuses.includes(member.status)) return false;
        if (rules.tier_ids && (!member.tier_id || !rules.tier_ids.includes(member.tier_id))) {
          return false;
        }
        if (
          rules.minimum_available_balance !== undefined &&
          balance.available < rules.minimum_available_balance
        ) {
          return false;
        }
        if (rules.attributes && Object.entries(rules.attributes).some(
          ([key, value]) => JSON.stringify(member.attributes?.[key]) !== JSON.stringify(value)
        )) {
          return false;
        }
        return true;
      })
      .map(({ member }) => member.member_id);
  }
}
