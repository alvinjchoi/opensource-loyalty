import type {
  FundingShare,
  OrderChannel,
  PointExpirationPolicy,
  ProgramAccountDefinition,
  ProgramMetricDefinition,
  RewardEffect,
  TierDefinition,
  TierQualificationPolicy
} from "@loyalty-interchange/protocol";

export interface EarnRate {
  points: number;
  spend_minor_units: number;
}

export interface RewardDefinition {
  reward_id: string;
  name?: string;
  description?: string;
  image_url?: string;
  points_cost: number;
  cost?: {
    unit: "points" | "visits" | "stamps" | "credits";
    amount: number;
  };
  effect: RewardEffect;
  funding: FundingShare[];
  available_from?: string;
  available_until?: string;
  metadata?: Record<string, unknown>;
}

export interface MetricDefinition extends ProgramMetricDefinition {
  source: "current_balance" | "lifetime_earned" | "qualification_earned";
}

export interface EarningPolicyDefinition {
  minimum_eligible_spend_minor_units?: number;
  eligible_channels?: OrderChannel[];
  excluded_product_ids?: string[];
  excluded_category_ids?: string[];
  excluded_tags?: string[];
  excluded_line_kinds?: Array<"item" | "modifier" | "fee">;
}

export interface VisitStampPolicy {
  unit: "visits" | "stamps";
  amount_per_order: number;
  threshold: number;
  reset_on_issue: boolean;
  issue_reward_id: string;
  issued_reward_ttl_seconds?: number;
}

export interface WalletCreditPolicy {
  earn_bps: number;
  liability_classification: "promotional" | "stored_value";
}

export interface MembershipPlanDefinition {
  plan_id: string;
  name: string;
  earn_multiplier_bps?: number;
}

export interface MembershipPolicy {
  plans: MembershipPlanDefinition[];
}

export interface ProgramDefinition {
  program_id: string;
  name?: string;
  description?: string;
  currency: string;
  accounts?: ProgramAccountDefinition[];
  metrics?: MetricDefinition[];
  tiers?: TierDefinition[];
  tier_policy?: TierQualificationPolicy;
  point_expiration?: PointExpirationPolicy;
  balance_expiration?: PointExpirationPolicy;
  earning_policy?: EarningPolicyDefinition;
  visit_stamp_policy?: VisitStampPolicy;
  wallet_credit_policy?: WalletCreditPolicy;
  membership_policy?: MembershipPolicy;
  earn_rate: EarnRate;
  evaluation_ttl_seconds: number;
  reservation_ttl_seconds: number;
  rewards: RewardDefinition[];
  metadata?: Record<string, unknown>;
}

export interface Clock {
  now(): Date;
}

export type IdGenerator = (prefix: string) => string;
