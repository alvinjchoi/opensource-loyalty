import { Type, type Static } from "@sinclair/typebox";
import { IssuedRewardSchema, LedgerEntrySchema, RedemptionReservationSchema } from "./loyalty.js";
import { MemberSchema } from "./member.js";
import { DateTimeSchema, IdSchema, ProtocolVersionSchema } from "./primitives.js";

export const EventTypeSchema = Type.Union([
  Type.Literal("org.loyalty-interchange.member.enrolled.v1"),
  Type.Literal("org.loyalty-interchange.balance.changed.v1"),
  Type.Literal("org.loyalty-interchange.order.accrued.v1"),
  Type.Literal("org.loyalty-interchange.order.adjusted.v1"),
  Type.Literal("org.loyalty-interchange.redemption.reserved.v1"),
  Type.Literal("org.loyalty-interchange.redemption.captured.v1"),
  Type.Literal("org.loyalty-interchange.redemption.reversed.v1"),
  Type.Literal("org.loyalty-interchange.issued-reward.issued.v1"),
  Type.Literal("org.loyalty-interchange.issued-reward.redeemed.v1"),
  Type.Literal("org.loyalty-interchange.issued-reward.restored.v1"),
  Type.Literal("org.loyalty-interchange.issued-reward.cancelled.v1")
]);

export const EventDataSchema = Type.Union([
  Type.Object({ member: MemberSchema }, { additionalProperties: false }),
  Type.Object({ entry: LedgerEntrySchema }, { additionalProperties: false }),
  Type.Object({ reservation: RedemptionReservationSchema }, { additionalProperties: false }),
  Type.Object({ issued_reward: IssuedRewardSchema }, { additionalProperties: false })
]);

export const LoyaltyEventSchema = Type.Object(
  {
    specversion: Type.Literal("1.0"),
    id: IdSchema,
    source: Type.String({ format: "uri-reference" }),
    type: EventTypeSchema,
    subject: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    time: DateTimeSchema,
    datacontenttype: Type.Literal("application/json"),
    lipversion: ProtocolVersionSchema,
    data: EventDataSchema
  },
  { additionalProperties: false }
);

export type LoyaltyEvent = Static<typeof LoyaltyEventSchema>;
export type LoyaltyEventType = Static<typeof EventTypeSchema>;
