import type {
  FoodserviceOrder,
  MemberEnrollRequest,
  RequestContext
} from "@loyalty-interchange/protocol";
import type { Clock, ProgramDefinition } from "@loyalty-interchange/reference";

let requestSequence = 0;

export class MutableClock implements Clock {
  private current: Date;

  public constructor(value = "2026-07-14T10:00:00.000Z") {
    this.current = new Date(value);
  }

  public now(): Date {
    return new Date(this.current);
  }

  public advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export function sequentialIds(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}-${++sequence}`;
}

export function makeProgram(): ProgramDefinition {
  return {
    program_id: "demo-foodservice",
    name: "Demo Foodservice Rewards",
    description: "A multi-tier restaurant loyalty program used for conformance tests.",
    currency: "USD",
    earning_policy: {
      minimum_eligible_spend_minor_units: 100,
      eligible_channels: ["counter", "drive_thru", "web", "mobile"],
      excluded_category_ids: ["alcohol", "gift-cards"],
      excluded_tags: ["service-fee", "merch", "donation", "packaging", "delivery-fee"]
    },
    accounts: [{ unit: "points", unit_label: "points", is_primary: true }],
    metrics: [
      {
        metric_id: "lifetime-earned",
        name: "Lifetime points",
        unit: "points",
        source: "lifetime_earned"
      },
      {
        metric_id: "tier-qualifying",
        name: "Tier qualifying points",
        unit: "points",
        source: "qualification_earned"
      }
    ],
    tiers: [
      {
        tier_id: "starter",
        name: "Starter",
        qualification_metric_id: "tier-qualifying",
        minimum: 0,
        benefits: []
      },
      {
        tier_id: "regular",
        name: "Regular",
        qualification_metric_id: "tier-qualifying",
        minimum: 100,
        earn_multiplier_bps: 12_000,
        benefits: [{ benefit_id: "birthday-reward", name: "Birthday reward" }]
      },
      {
        tier_id: "vip",
        name: "VIP",
        qualification_metric_id: "tier-qualifying",
        minimum: 250,
        earn_multiplier_bps: 12_000,
        benefits: [{ benefit_id: "early-access", name: "Early access to seasonal items" }]
      }
    ],
    tier_policy: {
      metric_id: "tier-qualifying",
      period: {
        type: "annual",
        starts_month: 1,
        starts_day: 1,
        time_zone: "America/New_York"
      },
      effective_from: "2026-01-01"
    },
    point_expiration: {
      type: "after_earned",
      days: 365,
      warning_days: [30, 7]
    },
    earn_rate: { points: 10, spend_minor_units: 100 },
    evaluation_ttl_seconds: 300,
    reservation_ttl_seconds: 120,
    rewards: [
      {
        reward_id: "one-dollar-off",
        name: "$1 off",
        points_cost: 100,
        effect: {
          type: "discount",
          target: "order",
          amount: { amount: 100, currency: "USD" },
          allocations: [{ amount: { amount: 100, currency: "USD" } }]
        },
        funding: [
          { party_id: "demo-brand", party_type: "brand", share_bps: 7500 },
          { party_id: "franchisee-7", party_type: "franchisee", share_bps: 2500 }
        ]
      },
      {
        reward_id: "free-entree",
        name: "Free entree",
        description: "One eligible entree up to $12.",
        points_cost: 250,
        effect: {
          type: "free_item",
          category_ids: ["entrees"],
          max_quantity: 1,
          max_value: { amount: 1_200, currency: "USD" }
        },
        funding: [
          { party_id: "demo-brand", party_type: "brand", share_bps: 5_000 },
          { party_id: "franchisee-7", party_type: "franchisee", share_bps: 5_000 }
        ]
      }
    ]
  };
}

export function makeAnnualTierProgram(): ProgramDefinition {
  const program = makeProgram();
  program.program_id = "annual-tier-foodservice";
  program.name = "Annual Tier Rewards";
  program.earn_rate = { points: 1, spend_minor_units: 100 };
  program.tiers = [
    {
      tier_id: "base",
      name: "Base",
      qualification_metric_id: "tier-qualifying",
      minimum: 0,
      benefits: []
    },
    {
      tier_id: "premier",
      name: "Premier",
      qualification_metric_id: "tier-qualifying",
      minimum: 500,
      earn_multiplier_bps: 12_000,
      benefits: [{ benefit_id: "tier-achievement", name: "Tier achievement reward" }]
    }
  ];
  return program;
}

export function makeContext(idempotencyKey: string): RequestContext {
  requestSequence += 1;
  return {
    protocol_version: "1.0",
    profile: "foodservice/1.0",
    request_id: `request-${requestSequence}`,
    idempotency_key: idempotencyKey,
    occurred_at: "2026-07-14T10:00:00.000Z",
    source: { system: "test-pos", instance: "lane-1" }
  };
}

export function makeEnroll(idempotencyKey = "enroll-key-001"): MemberEnrollRequest {
  return {
    context: makeContext(idempotencyKey),
    program_id: "demo-foodservice",
    identity: { type: "token", value: "guest-token-001", issuer: "test-identity" },
    member_id: "member-001"
  };
}

export function makeOrder(overrides: Partial<FoodserviceOrder> = {}): FoodserviceOrder {
  const base: FoodserviceOrder = {
    order_id: "order-1001",
    order_number: "1001",
    scope: {
      program_id: "demo-foodservice",
      brand_id: "demo-brand",
      merchant_id: "merchant-west",
      location_id: "location-42",
      franchisee_id: "franchisee-7"
    },
    member_id: "member-001",
    channel: "drive_thru",
    status: "paid",
    business_date: "2026-07-14",
    placed_at: "2026-07-14T10:05:00.000Z",
    closed_at: "2026-07-14T10:08:00.000Z",
    lines: [
      {
        line_id: "line-1",
        kind: "item",
        product_id: "burger-1",
        quantity: 1,
        unit_price: { amount: 1000, currency: "USD" },
        subtotal: { amount: 1000, currency: "USD" },
        discount: { amount: 0, currency: "USD" },
        tax: { amount: 80, currency: "USD" }
      },
      {
        line_id: "line-2",
        kind: "modifier",
        product_id: "extra-cheese",
        parent_line_id: "line-1",
        quantity: 1,
        unit_price: { amount: 100, currency: "USD" },
        subtotal: { amount: 100, currency: "USD" },
        discount: { amount: 0, currency: "USD" },
        tax: { amount: 8, currency: "USD" }
      }
    ],
    totals: {
      subtotal: { amount: 1100, currency: "USD" },
      discount: { amount: 0, currency: "USD" },
      tax: { amount: 88, currency: "USD" },
      tip: { amount: 0, currency: "USD" },
      service_charge: { amount: 0, currency: "USD" },
      total: { amount: 1188, currency: "USD" }
    },
    tenders: [
      { tender_id: "tender-1", type: "card", amount: { amount: 1188, currency: "USD" } }
    ]
  };
  return { ...base, ...structuredClone(overrides) };
}
