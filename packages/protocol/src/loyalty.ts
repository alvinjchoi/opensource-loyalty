import { Type, type Static } from "@sinclair/typebox";
import { BalanceSchema } from "./member.js";
import { FoodserviceOrderSchema, OrderAdjustmentSchema } from "./order.js";
import {
  DateTimeSchema,
  FundingShareSchema,
  IdSchema,
  LoyaltyUnitSchema,
  MoneySchema,
  RequestContextSchema,
  ResponseContextSchema
} from "./primitives.js";

export const DiscountAllocationSchema = Type.Object(
  {
    line_id: Type.Optional(IdSchema),
    amount: MoneySchema
  },
  { additionalProperties: false }
);

export const DiscountEffectSchema = Type.Object(
  {
    type: Type.Literal("discount"),
    target: Type.Union([Type.Literal("order"), Type.Literal("line")]),
    amount: MoneySchema,
    allocations: Type.Array(DiscountAllocationSchema, { minItems: 1 })
  },
  { additionalProperties: false }
);

export const FreeItemEffectSchema = Type.Object(
  {
    type: Type.Literal("free_item"),
    product_ids: Type.Optional(Type.Array(IdSchema, { minItems: 1, uniqueItems: true })),
    category_ids: Type.Optional(Type.Array(IdSchema, { minItems: 1, uniqueItems: true })),
    max_quantity: Type.Integer({ minimum: 1 }),
    max_value: MoneySchema
  },
  { additionalProperties: false }
);

export const CustomEffectSchema = Type.Object(
  {
    type: Type.Literal("custom"),
    effect_type: Type.String({ minLength: 1, maxLength: 255 }),
    payload: Type.Unknown()
  },
  { additionalProperties: false }
);

export const RewardEffectSchema = Type.Union([
  DiscountEffectSchema,
  FreeItemEffectSchema,
  CustomEffectSchema
]);

export const RewardCandidateSchema = Type.Object(
  {
    reward_id: IdSchema,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    status: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
    unavailable_reasons: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1 })
    ),
    cost: Type.Object(
      {
        unit: LoyaltyUnitSchema,
        amount: Type.Integer({ minimum: 0 })
      },
      { additionalProperties: false }
    ),
    effect: RewardEffectSchema,
    funding: Type.Array(FundingShareSchema, { minItems: 1 })
  },
  { additionalProperties: false }
);

export const AccrualAmountSchema = Type.Object(
  {
    unit: LoyaltyUnitSchema,
    amount: Type.Integer()
  },
  { additionalProperties: false }
);

export const EvaluationRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    member_id: IdSchema,
    order: FoodserviceOrderSchema
  },
  { additionalProperties: false }
);

export const EvaluationResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    evaluation_id: IdSchema,
    member_id: IdSchema,
    order_id: IdSchema,
    estimated_accrual: AccrualAmountSchema,
    rewards: Type.Array(RewardCandidateSchema),
    balances: Type.Array(BalanceSchema),
    expires_at: DateTimeSchema
  },
  { additionalProperties: false }
);

export const LedgerOperationSchema = Type.Union([
  Type.Literal("accrual"),
  Type.Literal("redemption"),
  Type.Literal("reversal"),
  Type.Literal("adjustment"),
  Type.Literal("expiration"),
  Type.Literal("manual")
]);

export const ManualAdjustmentClassificationSchema = Type.Union([
  Type.Literal("bonus"),
  Type.Literal("gift"),
  Type.Literal("migration"),
  Type.Literal("service_recovery"),
  Type.Literal("correction")
]);

export const LedgerEntrySchema = Type.Object(
  {
    entry_id: IdSchema,
    member_id: IdSchema,
    program_id: IdSchema,
    account_id: IdSchema,
    operation: LedgerOperationSchema,
    unit: LoyaltyUnitSchema,
    amount: Type.Integer(),
    occurred_at: DateTimeSchema,
    expires_at: Type.Optional(DateTimeSchema),
    related_entry_id: Type.Optional(IdSchema),
    order_id: Type.Optional(IdSchema),
    adjustment_id: Type.Optional(IdSchema),
    reservation_id: Type.Optional(IdSchema),
    classification: Type.Optional(ManualAdjustmentClassificationSchema),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    qualifies_for_tier: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
);

export const AccrualPostRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    member_id: IdSchema,
    order: FoodserviceOrderSchema,
    evaluation_id: Type.Optional(IdSchema)
  },
  { additionalProperties: false }
);

export const LedgerResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    entry: LedgerEntrySchema,
    balances: Type.Array(BalanceSchema)
  },
  { additionalProperties: false }
);

export const LedgerListRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    member_id: IdSchema,
    program_id: IdSchema,
    account_id: Type.Optional(IdSchema),
    operations: Type.Optional(Type.Array(LedgerOperationSchema, { minItems: 1, uniqueItems: true })),
    occurred_from: Type.Optional(DateTimeSchema),
    occurred_until: Type.Optional(DateTimeSchema),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  },
  { additionalProperties: false }
);

export const LedgerListResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    entries: Type.Array(LedgerEntrySchema),
    next_cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 }))
  },
  { additionalProperties: false }
);

export const RedemptionReservationSchema = Type.Object(
  {
    reservation_id: IdSchema,
    redemption_id: IdSchema,
    member_id: IdSchema,
    reward_id: IdSchema,
    issued_reward_id: Type.Optional(IdSchema),
    order_id: IdSchema,
    status: Type.Union([
      Type.Literal("reserved"),
      Type.Literal("captured"),
      Type.Literal("reversed"),
      Type.Literal("expired")
    ]),
    cost: AccrualAmountSchema,
    effect: RewardEffectSchema,
    funding: Type.Array(FundingShareSchema, { minItems: 1 }),
    created_at: DateTimeSchema,
    expires_at: DateTimeSchema,
    captured_at: Type.Optional(DateTimeSchema),
    reversed_at: Type.Optional(DateTimeSchema)
  },
  { additionalProperties: false }
);

export const RedemptionReserveRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    redemption_id: IdSchema,
    member_id: IdSchema,
    reward_id: IdSchema,
    issued_reward_id: Type.Optional(IdSchema),
    order: FoodserviceOrderSchema,
    evaluation_id: Type.Optional(IdSchema)
  },
  { additionalProperties: false }
);

export const IssuedRewardStatusSchema = Type.Union([
  Type.Literal("issued"),
  Type.Literal("redeemed"),
  Type.Literal("cancelled"),
  Type.Literal("expired")
]);

export const IssuedRewardArtifactSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("code"), Type.Literal("qr_code")]),
    value: Type.String({ minLength: 1, maxLength: 512 })
  },
  { additionalProperties: false }
);

export const IssuedRewardSchema = Type.Object(
  {
    issued_reward_id: IdSchema,
    member_id: IdSchema,
    program_id: IdSchema,
    reward_id: IdSchema,
    status: IssuedRewardStatusSchema,
    issued_at: DateTimeSchema,
    expires_at: Type.Optional(DateTimeSchema),
    redeemed_at: Type.Optional(DateTimeSchema),
    cancelled_at: Type.Optional(DateTimeSchema),
    cancellation_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    artifact: Type.Optional(IssuedRewardArtifactSchema)
  },
  { additionalProperties: false }
);

export const IssuedRewardIssueRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    issued_reward_id: IdSchema,
    member_id: IdSchema,
    program_id: IdSchema,
    reward_id: IdSchema,
    expires_at: Type.Optional(DateTimeSchema),
    artifact: Type.Optional(IssuedRewardArtifactSchema)
  },
  { additionalProperties: false }
);

export const IssuedRewardListRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    member_id: IdSchema,
    program_id: IdSchema,
    statuses: Type.Optional(Type.Array(IssuedRewardStatusSchema, { minItems: 1, uniqueItems: true }))
  },
  { additionalProperties: false }
);

export const IssuedRewardCancelRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    issued_reward_id: IdSchema,
    reason: Type.String({ minLength: 1, maxLength: 255 })
  },
  { additionalProperties: false }
);

export const IssuedRewardResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    issued_reward: IssuedRewardSchema
  },
  { additionalProperties: false }
);

export const IssuedRewardListResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    issued_rewards: Type.Array(IssuedRewardSchema)
  },
  { additionalProperties: false }
);

export const RedemptionReservationResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    reservation: RedemptionReservationSchema,
    balances: Type.Array(BalanceSchema)
  },
  { additionalProperties: false }
);

export const RedemptionCaptureRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    reservation_id: IdSchema,
    order_id: IdSchema
  },
  { additionalProperties: false }
);

export const RedemptionReverseRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    reservation_id: IdSchema,
    reason: Type.String({ minLength: 1, maxLength: 255 })
  },
  { additionalProperties: false }
);

export const OrderAdjustmentRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    member_id: IdSchema,
    program_id: IdSchema,
    adjustment: OrderAdjustmentSchema
  },
  { additionalProperties: false }
);

export const ManualAdjustmentRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    member_id: IdSchema,
    program_id: IdSchema,
    adjustment_id: IdSchema,
    amount: Type.Union([
      Type.Integer({ maximum: -1 }),
      Type.Integer({ minimum: 1 })
    ]),
    classification: ManualAdjustmentClassificationSchema,
    reason: Type.String({ minLength: 1, maxLength: 255 }),
    qualifies_for_tier: Type.Boolean(),
    expires_at: Type.Optional(DateTimeSchema)
  },
  { additionalProperties: false }
);

export const ProblemDetailsSchema = Type.Object(
  {
    type: Type.String({ format: "uri-reference" }),
    title: Type.String({ minLength: 1 }),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String({ format: "uri-reference" })),
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    errors: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String(),
            message: Type.String()
          },
          { additionalProperties: false }
        )
      )
    )
  },
  { additionalProperties: true }
);

export type RewardEffect = Static<typeof RewardEffectSchema>;
export type RewardCandidate = Static<typeof RewardCandidateSchema>;
export type EvaluationRequest = Static<typeof EvaluationRequestSchema>;
export type EvaluationResponse = Static<typeof EvaluationResponseSchema>;
export type LedgerEntry = Static<typeof LedgerEntrySchema>;
export type LedgerOperation = Static<typeof LedgerOperationSchema>;
export type ManualAdjustmentClassification = Static<typeof ManualAdjustmentClassificationSchema>;
export type AccrualPostRequest = Static<typeof AccrualPostRequestSchema>;
export type LedgerResponse = Static<typeof LedgerResponseSchema>;
export type LedgerListRequest = Static<typeof LedgerListRequestSchema>;
export type LedgerListResponse = Static<typeof LedgerListResponseSchema>;
export type RedemptionReservation = Static<typeof RedemptionReservationSchema>;
export type RedemptionReserveRequest = Static<typeof RedemptionReserveRequestSchema>;
export type RedemptionCaptureRequest = Static<typeof RedemptionCaptureRequestSchema>;
export type RedemptionReverseRequest = Static<typeof RedemptionReverseRequestSchema>;
export type RedemptionReservationResponse = Static<typeof RedemptionReservationResponseSchema>;
export type IssuedReward = Static<typeof IssuedRewardSchema>;
export type IssuedRewardStatus = Static<typeof IssuedRewardStatusSchema>;
export type IssuedRewardIssueRequest = Static<typeof IssuedRewardIssueRequestSchema>;
export type IssuedRewardListRequest = Static<typeof IssuedRewardListRequestSchema>;
export type IssuedRewardCancelRequest = Static<typeof IssuedRewardCancelRequestSchema>;
export type IssuedRewardResponse = Static<typeof IssuedRewardResponseSchema>;
export type IssuedRewardListResponse = Static<typeof IssuedRewardListResponseSchema>;
export type OrderAdjustmentRequest = Static<typeof OrderAdjustmentRequestSchema>;
export type ManualAdjustmentRequest = Static<typeof ManualAdjustmentRequestSchema>;
export type ProblemDetails = Static<typeof ProblemDetailsSchema>;
