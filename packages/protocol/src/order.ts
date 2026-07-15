import { Type, type Static } from "@sinclair/typebox";
import {
  BusinessDateSchema,
  DateTimeSchema,
  IdSchema,
  MetadataSchema,
  MoneySchema,
  ProgramScopeSchema
} from "./primitives.js";

export const OrderChannelSchema = Type.Union([
  Type.Literal("counter"),
  Type.Literal("drive_thru"),
  Type.Literal("kiosk"),
  Type.Literal("web"),
  Type.Literal("mobile"),
  Type.Literal("pickup"),
  Type.Literal("delivery"),
  Type.Literal("catering"),
  Type.Literal("third_party"),
  Type.Literal("other")
]);

export const OrderStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("authorized"),
  Type.Literal("paid"),
  Type.Literal("partially_refunded"),
  Type.Literal("refunded"),
  Type.Literal("voided")
]);

export const OrderLineSchema = Type.Object(
  {
    line_id: IdSchema,
    kind: Type.Union([
      Type.Literal("item"),
      Type.Literal("modifier"),
      Type.Literal("fee")
    ]),
    product_id: IdSchema,
    sku: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    parent_line_id: Type.Optional(IdSchema),
    quantity: Type.Integer({ minimum: 1 }),
    unit_price: MoneySchema,
    subtotal: MoneySchema,
    discount: MoneySchema,
    tax: MoneySchema,
    category_ids: Type.Optional(Type.Array(IdSchema, { uniqueItems: true })),
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { uniqueItems: true })),
    loyalty_eligible: Type.Optional(Type.Boolean()),
    metadata: Type.Optional(MetadataSchema)
  },
  { additionalProperties: false }
);

export const OrderTotalsSchema = Type.Object(
  {
    subtotal: MoneySchema,
    discount: MoneySchema,
    tax: MoneySchema,
    tip: MoneySchema,
    service_charge: MoneySchema,
    total: MoneySchema
  },
  { additionalProperties: false }
);

export const TenderSchema = Type.Object(
  {
    tender_id: IdSchema,
    type: Type.Union([
      Type.Literal("cash"),
      Type.Literal("card"),
      Type.Literal("gift_card"),
      Type.Literal("loyalty"),
      Type.Literal("third_party"),
      Type.Literal("other")
    ]),
    amount: MoneySchema
  },
  { additionalProperties: false }
);

export const FoodserviceOrderSchema = Type.Object(
  {
    order_id: IdSchema,
    order_number: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    scope: ProgramScopeSchema,
    member_id: Type.Optional(IdSchema),
    channel: OrderChannelSchema,
    status: OrderStatusSchema,
    business_date: BusinessDateSchema,
    placed_at: DateTimeSchema,
    closed_at: Type.Optional(DateTimeSchema),
    lines: Type.Array(OrderLineSchema, { minItems: 1 }),
    totals: OrderTotalsSchema,
    tenders: Type.Optional(Type.Array(TenderSchema, { minItems: 1 })),
    metadata: Type.Optional(MetadataSchema)
  },
  { additionalProperties: false }
);

export const LineAdjustmentSchema = Type.Object(
  {
    line_id: IdSchema,
    quantity_delta: Type.Integer(),
    subtotal_delta: MoneySchema
  },
  { additionalProperties: false }
);

export const OrderAdjustmentSchema = Type.Object(
  {
    adjustment_id: IdSchema,
    original_order_id: IdSchema,
    type: Type.Union([
      Type.Literal("partial_refund"),
      Type.Literal("full_refund"),
      Type.Literal("void"),
      Type.Literal("correction")
    ]),
    reason: Type.String({ minLength: 1, maxLength: 255 }),
    occurred_at: DateTimeSchema,
    order_total_delta: MoneySchema,
    eligible_spend_delta: MoneySchema,
    lines: Type.Optional(Type.Array(LineAdjustmentSchema, { minItems: 1 }))
  },
  { additionalProperties: false }
);

export type OrderChannel = Static<typeof OrderChannelSchema>;
export type OrderLine = Static<typeof OrderLineSchema>;
export type FoodserviceOrder = Static<typeof FoodserviceOrderSchema>;
export type OrderAdjustment = Static<typeof OrderAdjustmentSchema>;
