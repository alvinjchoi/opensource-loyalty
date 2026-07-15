import { Type, type Static } from "@sinclair/typebox";
import { EventTypeSchema } from "./events.js";
import { ProfileSchema, ProtocolVersionSchema } from "./primitives.js";

export const HealthDocumentSchema = Type.Object(
  {
    status: Type.Literal("ok"),
    protocol_version: ProtocolVersionSchema,
    profile: ProfileSchema
  },
  { additionalProperties: false }
);

export const OperationNameSchema = Type.Union([
  Type.Literal("member.lookup"),
  Type.Literal("member.enroll"),
  Type.Literal("order.evaluate"),
  Type.Literal("accrual.post"),
  Type.Literal("redemption.reserve"),
  Type.Literal("redemption.capture"),
  Type.Literal("redemption.reverse"),
  Type.Literal("order.adjust"),
  Type.Literal("program.get"),
  Type.Literal("account.get"),
  Type.Literal("ledger.list"),
  Type.Literal("ledger.manual_adjustment")
]);

export const WellKnownDocumentSchema = Type.Object(
  {
    protocol: Type.Literal("LIP"),
    protocol_version: ProtocolVersionSchema,
    profiles: Type.Array(ProfileSchema, { minItems: 1, uniqueItems: true }),
    endpoints: Type.Object(
      {
        api: Type.String({ pattern: "^/" }),
        capabilities: Type.String({ pattern: "^/" }),
        health: Type.String({ pattern: "^/" })
      },
      { additionalProperties: false }
    ),
    authentication: Type.Array(Type.Literal("bearer"), { minItems: 1, uniqueItems: true })
  },
  { additionalProperties: false }
);

export const CapabilitiesDocumentSchema = Type.Object(
  {
    protocol_version: ProtocolVersionSchema,
    profiles: Type.Array(ProfileSchema, { minItems: 1, uniqueItems: true }),
    operations: Type.Array(OperationNameSchema, { minItems: 1, uniqueItems: true }),
    reward_effects: Type.Array(
      Type.Union([Type.Literal("discount"), Type.Literal("free_item"), Type.Literal("custom")]),
      { minItems: 1, uniqueItems: true }
    ),
    event_types: Type.Array(EventTypeSchema, { uniqueItems: true }),
    limits: Type.Object(
      {
        max_body_bytes: Type.Integer({ minimum: 1 }),
        max_idempotency_key_length: Type.Integer({ minimum: 1 }),
        reservation_ttl_seconds: Type.Integer({ minimum: 1 })
      },
      { additionalProperties: false }
    )
  },
  { additionalProperties: false }
);

export type OperationName = Static<typeof OperationNameSchema>;
export type HealthDocument = Static<typeof HealthDocumentSchema>;
export type WellKnownDocument = Static<typeof WellKnownDocumentSchema>;
export type CapabilitiesDocument = Static<typeof CapabilitiesDocumentSchema>;
