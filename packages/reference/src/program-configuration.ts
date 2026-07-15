import type { ProgramDefinition } from "./config.js";

export type ProgramModelId = "points" | "visits" | "wallet_credit" | "paid_membership" | "hybrid";
export type ProgramModelStatus = "active" | "available" | "planned";
export type ProgramModelSupport = "implemented" | "planned";

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

export interface ReferenceProgramConfiguration {
  current_model_id: ProgramModelId;
  editable: boolean;
  publish_supported: boolean;
  templates: ProgramModelTemplate[];
  next_actions: string[];
}

interface ProgramModelTemplateSeed {
  model_id: ProgramModelId;
  name: string;
  summary: string;
  best_for: string;
  cadence: string;
  engine_support: ProgramModelSupport;
  admin_write_support: ProgramModelSupport;
  supported_features: string[];
  blockers: string[];
  next_steps: string[];
}

const templateSeeds: ProgramModelTemplateSeed[] = [
  {
    model_id: "points",
    name: "Points and tiers",
    summary: "Earn points on eligible spend, qualify into tiers, and redeem catalog rewards.",
    best_for: "QSR, casual dining, coffee chains",
    cadence: "Every transaction",
    engine_support: "implemented",
    admin_write_support: "implemented",
    supported_features: [
      "Spend-based points",
      "Annual tiers",
      "Earned-date expiration",
      "Reward reserve, capture, and reversal",
      "Refund-safe adjustments"
    ],
    blockers: [],
    next_steps: ["Use the Admin draft, validation, publish, and rollback workflow."]
  },
  {
    model_id: "visits",
    name: "Visit or stamp card",
    summary: "Count visits or item purchases toward simple unlocks like buy 9, get 1.",
    best_for: "Coffee, bakery, counter service",
    cadence: "Visit count",
    engine_support: "planned",
    admin_write_support: "planned",
    supported_features: ["Visit metrics", "Stamp thresholds", "Issued reward wallet"],
    blockers: [
      "Reference engine currently requires one primary points account.",
      "Visit and stamp ledger units need posting and adjustment rules."
    ],
    next_steps: ["Add visits/stamps account support and threshold reward issuance."]
  },
  {
    model_id: "wallet_credit",
    name: "Wallet credit",
    summary: "Return a percent of qualifying spend as store credit or house cash.",
    best_for: "High-frequency brands",
    cadence: "Spend-based",
    engine_support: "planned",
    admin_write_support: "planned",
    supported_features: ["Credit units", "Liability reporting", "Expiration and adjustment reasons"],
    blockers: [
      "Reference engine currently posts spendable value only as points.",
      "Credit liability and tender interaction rules are not implemented."
    ],
    next_steps: ["Add credit account lots, ledger classifications, and liability summaries."]
  },
  {
    model_id: "paid_membership",
    name: "Paid membership",
    summary: "Attach perks, multipliers, and exclusive rewards to a subscription or club.",
    best_for: "Premium operators and clubs",
    cadence: "Recurring",
    engine_support: "planned",
    admin_write_support: "planned",
    supported_features: ["Membership status", "Perk eligibility", "Recurring billing hooks"],
    blockers: [
      "Membership lifecycle, billing state, and eligibility windows are not modeled.",
      "Scoped entitlement APIs are not implemented."
    ],
    next_steps: ["Add membership state, entitlement checks, and billing-event adapters."]
  },
  {
    model_id: "hybrid",
    name: "Hybrid rewards",
    summary: "Combine points, tiers, wallet credit, and campaign rewards in one program.",
    best_for: "Multi-location groups",
    cadence: "Rules-based",
    engine_support: "planned",
    admin_write_support: "planned",
    supported_features: ["Multiple account units", "Stacking policy", "Campaign triggers"],
    blockers: [
      "Multiple account units and stacking policy are not implemented.",
      "Campaign and segmentation modules do not exist yet."
    ],
    next_steps: ["Add multi-unit accounts, stacking rules, campaign triggers, and segment targeting."]
  }
];

function metadataModel(program: ProgramDefinition): ProgramModelId | undefined {
  const value = program.metadata?.program_model;
  return typeof value === "string" && ["points", "visits", "wallet_credit", "paid_membership", "hybrid"].includes(value)
    ? value as ProgramModelId
    : undefined;
}

function inferProgramModel(program: ProgramDefinition): ProgramModelId {
  const fromMetadata = metadataModel(program);
  if (fromMetadata) return fromMetadata;

  const units = new Set((program.accounts ?? [{ unit: "points" }]).map((account) => account.unit));
  if (units.size > 1) return "hybrid";
  if (units.has("credits")) return "wallet_credit";
  if (units.has("visits") || units.has("stamps")) return "visits";
  return "points";
}

export function programConfigurationFor(program: ProgramDefinition): ReferenceProgramConfiguration {
  const currentModelId = inferProgramModel(program);
  return {
    current_model_id: currentModelId,
    editable: currentModelId === "points",
    publish_supported: currentModelId === "points",
    templates: templateSeeds.map((template) => ({
      ...template,
      status: template.model_id === currentModelId
        ? "active"
        : template.engine_support === "implemented"
          ? "available"
          : "planned"
    })),
    next_actions: [
      "Edit and validate the points program draft in Admin.",
      "Publish compatible changes without restarting the reference server.",
      "Rollback to one of the 20 retained published revisions.",
      "Replace the shared local Admin identity with scoped production users and roles."
    ]
  };
}
