export type MemberStatus = "active" | "suspended" | "closed";
export type LedgerOperation = "accrual" | "redemption" | "reversal" | "adjustment" | "expiration" | "manual";
export type ProgramModelId = "points" | "visits" | "wallet_credit" | "paid_membership" | "hybrid";
export type ProgramModelStatus = "active" | "available" | "planned";
export type ProgramModelSupport = "implemented" | "planned";

export interface Balance {
  amount: number;
  reserved: number;
  available: number;
  as_of: string;
}

export interface AccountMetric {
  metric_id: string;
  amount: number;
}

export interface ExpiringBalance {
  amount: number;
  expires_at: string;
}

export interface TierProgress {
  current_tier_id: string;
  qualification_metric_id: string;
  current_amount: number;
  next_tier_id?: string;
  remaining_to_next?: number;
  progress_bps: number;
  is_top_tier: boolean;
}

export interface Member {
  member_id: string;
  status: MemberStatus;
  joined_at: string;
  tier_id?: string;
  attributes?: Record<string, unknown>;
}

export interface AdminMember {
  member: Member;
  balance: Balance;
  metrics: AccountMetric[];
  expiring_balances: ExpiringBalance[];
  tier_progress?: TierProgress;
  last_activity_at?: string;
}

export interface LedgerEntry {
  entry_id: string;
  member_id: string;
  operation: LedgerOperation;
  amount: number;
  occurred_at: string;
  expires_at?: string;
  related_entry_id?: string;
  order_id?: string;
  adjustment_id?: string;
  reservation_id?: string;
}

export interface TierDefinition {
  tier_id: string;
  name: string;
  minimum: number;
  earn_multiplier_bps?: number;
  benefits: Array<{ benefit_id: string; name: string }>;
}

export interface RewardDefinition {
  reward_id: string;
  name: string;
  description?: string;
  cost: { amount: number; unit: string };
  effect: { type: string; [key: string]: unknown };
  funding: Array<{ party_type: string; party_id: string; share_bps: number }>;
}

export interface ProgramCatalog {
  program_id: string;
  name: string;
  description?: string;
  currency: string;
  earning: {
    rate: { amount: number; unit: string; spend: { amount: number; currency: string } };
    minimum_eligible_spend: { amount: number; currency: string };
    eligible_channels: string[];
    rounding: string;
    exclusions: {
      product_ids: string[];
      category_ids: string[];
      tags: string[];
      line_kinds: string[];
    };
  };
  tiers: TierDefinition[];
  rewards: RewardDefinition[];
  point_expiration?: { type: string; days: number; warning_days: number[] };
  tier_policy?: {
    metric_id: string;
    period: { type: string; starts_month: number; starts_day: number; time_zone: string };
  };
}

export interface ProgramModelTemplate {
  model_id: ProgramModelId;
  name: string;
  summary: string;
  best_for: string;
  cadence: string;
  status: ProgramModelStatus;
  engine_support: ProgramModelSupport;
  admin_write_support: ProgramModelSupport;
  supported_features: string[];
  blockers: string[];
  next_steps: string[];
}

export interface ProgramConfiguration {
  current_model_id: ProgramModelId;
  editable: boolean;
  publish_supported: boolean;
  templates: ProgramModelTemplate[];
  next_actions: string[];
}

export interface AdminSnapshot {
  admin_api_version: string;
  generated_at: string;
  platform: {
    protocol_version: string;
    profile: string;
    storage: { driver: string; location: string; persistent: boolean };
  };
  program: ProgramCatalog;
  program_configuration: ProgramConfiguration;
  summary: {
    active_members: number;
    points_outstanding: number;
    points_issued: number;
    points_redeemed: number;
    expiring_points: number;
    ledger_entries: number;
  };
  members: AdminMember[];
  ledger: LedgerEntry[];
}
