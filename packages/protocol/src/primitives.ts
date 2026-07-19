import { Type, type Static } from "@sinclair/typebox";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export const IdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  description: "Opaque, stable identifier within the owning system."
});

export const ProtocolVersionSchema = Type.Literal("1.0");
export const ProfileSchema = Type.Literal("foodservice/1.0");

export const DateTimeSchema = Type.String({ format: "date-time" });
export const BusinessDateSchema = Type.String({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
});
export const CurrencyCodeSchema = Type.String({ pattern: "^[A-Z]{3}$" });

export const MoneySchema = Type.Object(
  {
    amount: Type.Integer({
      minimum: -MAX_SAFE_INTEGER,
      maximum: MAX_SAFE_INTEGER,
      description: "Signed amount in the currency's minor unit."
    }),
    currency: CurrencyCodeSchema
  },
  { additionalProperties: false }
);

export type Money = Static<typeof MoneySchema>;

export const LoyaltyUnitSchema = Type.Union([
  Type.Literal("points"),
  Type.Literal("visits"),
  Type.Literal("stamps"),
  Type.Literal("credits"),
  Type.Literal("custom")
]);

export const MetadataSchema = Type.Record(Type.String({ maxLength: 64 }), Type.Unknown(), {
  description: "Non-normative extension data. Consumers must ignore unknown keys."
});

export const SourceSystemSchema = Type.Object(
  {
    system: IdSchema,
    instance: Type.Optional(IdSchema)
  },
  { additionalProperties: false }
);

export const RequestContextSchema = Type.Object(
  {
    protocol_version: ProtocolVersionSchema,
    profile: ProfileSchema,
    request_id: IdSchema,
    idempotency_key: Type.String({ minLength: 8, maxLength: 255 }),
    occurred_at: DateTimeSchema,
    source: SourceSystemSchema
  },
  { additionalProperties: false }
);

export const ResponseContextSchema = Type.Object(
  {
    protocol_version: ProtocolVersionSchema,
    profile: ProfileSchema,
    request_id: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
      description:
        "Echoes the request's request_id. On an idempotent replay it echoes the replaying request's request_id, not the original."
    }),
    processed_at: DateTimeSchema
  },
  { additionalProperties: false }
);

export const ExternalReferenceSchema = Type.Object(
  {
    system: IdSchema,
    id: Type.String({ minLength: 1, maxLength: 255 })
  },
  { additionalProperties: false }
);

export const ProgramScopeSchema = Type.Object(
  {
    program_id: IdSchema,
    brand_id: IdSchema,
    merchant_id: IdSchema,
    location_id: IdSchema,
    franchisee_id: Type.Optional(IdSchema)
  },
  { additionalProperties: false }
);

export const FundingPartyTypeSchema = Type.Union([
  Type.Literal("brand"),
  Type.Literal("franchisee"),
  Type.Literal("location"),
  Type.Literal("merchant"),
  Type.Literal("partner")
]);

export const FundingShareSchema = Type.Object(
  {
    party_id: IdSchema,
    party_type: FundingPartyTypeSchema,
    share_bps: Type.Integer({ minimum: 1, maximum: 10_000 }),
    amount: Type.Optional(MoneySchema)
  },
  { additionalProperties: false }
);

export type RequestContext = Static<typeof RequestContextSchema>;
export type ResponseContext = Static<typeof ResponseContextSchema>;
export type ProgramScope = Static<typeof ProgramScopeSchema>;
export type LoyaltyUnit = Static<typeof LoyaltyUnitSchema>;
export type FundingShare = Static<typeof FundingShareSchema>;
