import { Type, type Static } from "@sinclair/typebox";
import { RewardEffectSchema } from "./loyalty.js";
import { BalanceSchema, MemberSchema } from "./member.js";
import { OrderChannelSchema } from "./order.js";
import {
  BusinessDateSchema,
  DateTimeSchema,
  FundingShareSchema,
  IdSchema,
  LoyaltyUnitSchema,
  MetadataSchema,
  RequestContextSchema,
  ResponseContextSchema
} from "./primitives.js";

export const EarningExclusionsSchema = Type.Object(
  {
    product_ids: Type.Array(IdSchema, { uniqueItems: true }),
    category_ids: Type.Array(IdSchema, { uniqueItems: true }),
    tags: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { uniqueItems: true }),
    line_kinds: Type.Array(
      Type.Union([Type.Literal("item"), Type.Literal("modifier"), Type.Literal("fee")]),
      { uniqueItems: true }
    )
  },
  { additionalProperties: false }
);

export const EarningPolicySchema = Type.Object(
  {
    rate: Type.Object(
      {
        unit: LoyaltyUnitSchema,
        amount: Type.Integer({ minimum: 0 }),
        spend: Type.Object(
          {
            amount: Type.Integer({ minimum: 1 }),
            currency: Type.String({ pattern: "^[A-Z]{3}$" })
          },
          { additionalProperties: false }
        )
      },
      { additionalProperties: false }
    ),
    minimum_eligible_spend: Type.Object(
      {
        amount: Type.Integer({ minimum: 0 }),
        currency: Type.String({ pattern: "^[A-Z]{3}$" })
      },
      { additionalProperties: false }
    ),
    eligible_channels: Type.Array(OrderChannelSchema, { minItems: 1, uniqueItems: true }),
    rounding: Type.Literal("after_transaction"),
    exclusions: EarningExclusionsSchema
  },
  { additionalProperties: false }
);

export const TierQualificationPolicySchema = Type.Object(
  {
    metric_id: IdSchema,
    period: Type.Object(
      {
        type: Type.Literal("annual"),
        starts_month: Type.Integer({ minimum: 1, maximum: 12 }),
        starts_day: Type.Integer({ minimum: 1, maximum: 31 }),
        time_zone: Type.String({ minLength: 1, maxLength: 255 })
      },
      { additionalProperties: false }
    ),
    effective_from: Type.Optional(BusinessDateSchema)
  },
  { additionalProperties: false }
);

export const PointExpirationPolicySchema = Type.Object(
  {
    type: Type.Literal("after_earned"),
    days: Type.Integer({ minimum: 1, maximum: 36_500 }),
    warning_days: Type.Array(Type.Integer({ minimum: 1, maximum: 36_500 }), {
      uniqueItems: true
    })
  },
  { additionalProperties: false }
);

export const ProgramAccountDefinitionSchema = Type.Object(
  {
    unit: LoyaltyUnitSchema,
    unit_label: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    is_primary: Type.Boolean()
  },
  { additionalProperties: false }
);

export const AccountEarningRuleSchema = Type.Object(
  {
    unit: LoyaltyUnitSchema,
    mode: Type.Union([Type.Literal("spend"), Type.Literal("per_order")]),
    amount: Type.Integer({ minimum: 0 }),
    spend: Type.Optional(Type.Object(
      {
        amount: Type.Integer({ minimum: 1 }),
        currency: Type.String({ pattern: "^[A-Z]{3}$" })
      },
      { additionalProperties: false }
    )),
    multiplier_eligible: Type.Boolean()
  },
  { additionalProperties: false }
);

export const ProgramMetricDefinitionSchema = Type.Object(
  {
    metric_id: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    unit: LoyaltyUnitSchema
  },
  { additionalProperties: false }
);

export const TierBenefitSchema = Type.Object(
  {
    benefit_id: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    metadata: Type.Optional(MetadataSchema)
  },
  { additionalProperties: false }
);

export const TierDefinitionSchema = Type.Object(
  {
    tier_id: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    qualification_metric_id: IdSchema,
    minimum: Type.Integer({ minimum: 0 }),
    earn_multiplier_bps: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
    benefits: Type.Array(TierBenefitSchema)
  },
  { additionalProperties: false }
);

export const CatalogRewardDefinitionSchema = Type.Object(
  {
    reward_id: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    image_url: Type.Optional(Type.String({ format: "uri-reference", maxLength: 2_048 })),
    cost: Type.Object(
      {
        unit: LoyaltyUnitSchema,
        amount: Type.Integer({ minimum: 0 })
      },
      { additionalProperties: false }
    ),
    effect: RewardEffectSchema,
    funding: Type.Array(FundingShareSchema, { minItems: 1 }),
    available_from: Type.Optional(DateTimeSchema),
    available_until: Type.Optional(DateTimeSchema),
    metadata: Type.Optional(MetadataSchema)
  },
  { additionalProperties: false }
);

export const ProgramCatalogSchema = Type.Object(
  {
    program_id: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    earning: EarningPolicySchema,
    account_earning: Type.Optional(Type.Array(AccountEarningRuleSchema, { minItems: 1 })),
    accounts: Type.Array(ProgramAccountDefinitionSchema, { minItems: 1 }),
    metrics: Type.Array(ProgramMetricDefinitionSchema),
    tiers: Type.Array(TierDefinitionSchema),
    tier_policy: Type.Optional(TierQualificationPolicySchema),
    point_expiration: Type.Optional(PointExpirationPolicySchema),
    rewards: Type.Array(CatalogRewardDefinitionSchema),
    metadata: Type.Optional(MetadataSchema)
  },
  { additionalProperties: false }
);

export const ProgramGetRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    program_id: IdSchema
  },
  { additionalProperties: false }
);

export const ProgramGetResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    program: ProgramCatalogSchema
  },
  { additionalProperties: false }
);

export const AccountMetricSchema = Type.Object(
  {
    metric_id: IdSchema,
    unit: LoyaltyUnitSchema,
    amount: Type.Integer(),
    as_of: DateTimeSchema
  },
  { additionalProperties: false }
);

export const ExpiringBalanceSchema = Type.Object(
  {
    account_id: IdSchema,
    unit: LoyaltyUnitSchema,
    amount: Type.Integer({ minimum: 1 }),
    expires_at: DateTimeSchema
  },
  { additionalProperties: false }
);

export const TierProgressSchema = Type.Object(
  {
    current_tier_id: IdSchema,
    qualification_metric_id: IdSchema,
    current_amount: Type.Integer({ minimum: 0 }),
    next_tier_id: Type.Optional(IdSchema),
    remaining_to_next: Type.Optional(Type.Integer({ minimum: 0 })),
    progress_bps: Type.Integer({ minimum: 0, maximum: 10_000 }),
    is_top_tier: Type.Boolean()
  },
  { additionalProperties: false }
);

export const MemberAccountRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    member_id: IdSchema,
    program_id: IdSchema
  },
  { additionalProperties: false }
);

export const MemberAccountResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    member: MemberSchema,
    balances: Type.Array(BalanceSchema, { minItems: 1 }),
    metrics: Type.Array(AccountMetricSchema),
    expiring_balances: Type.Array(ExpiringBalanceSchema),
    tier_progress: Type.Optional(TierProgressSchema)
  },
  { additionalProperties: false }
);

export type ProgramAccountDefinition = Static<typeof ProgramAccountDefinitionSchema>;
export type AccountEarningRule = Static<typeof AccountEarningRuleSchema>;
export type EarningExclusions = Static<typeof EarningExclusionsSchema>;
export type EarningPolicy = Static<typeof EarningPolicySchema>;
export type TierQualificationPolicy = Static<typeof TierQualificationPolicySchema>;
export type PointExpirationPolicy = Static<typeof PointExpirationPolicySchema>;
export type ProgramMetricDefinition = Static<typeof ProgramMetricDefinitionSchema>;
export type TierBenefit = Static<typeof TierBenefitSchema>;
export type TierDefinition = Static<typeof TierDefinitionSchema>;
export type CatalogRewardDefinition = Static<typeof CatalogRewardDefinitionSchema>;
export type ProgramCatalog = Static<typeof ProgramCatalogSchema>;
export type ProgramGetRequest = Static<typeof ProgramGetRequestSchema>;
export type ProgramGetResponse = Static<typeof ProgramGetResponseSchema>;
export type AccountMetric = Static<typeof AccountMetricSchema>;
export type ExpiringBalance = Static<typeof ExpiringBalanceSchema>;
export type TierProgress = Static<typeof TierProgressSchema>;
export type MemberAccountRequest = Static<typeof MemberAccountRequestSchema>;
export type MemberAccountResponse = Static<typeof MemberAccountResponseSchema>;
