import { Type, type Static } from "@sinclair/typebox";
import {
  DateTimeSchema,
  IdSchema,
  LoyaltyUnitSchema,
  MetadataSchema,
  RequestContextSchema,
  ResponseContextSchema
} from "./primitives.js";

export const IdentityReferenceSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("loyalty_id"),
      Type.Literal("token"),
      Type.Literal("email_hash"),
      Type.Literal("phone_hash"),
      Type.Literal("external")
    ]),
    value: Type.String({ minLength: 1, maxLength: 512 }),
    issuer: Type.Optional(IdSchema)
  },
  { additionalProperties: false }
);

export const MemberSchema = Type.Object(
  {
    member_id: IdSchema,
    program_id: IdSchema,
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("suspended"),
      Type.Literal("closed")
    ]),
    joined_at: DateTimeSchema,
    tier_id: Type.Optional(IdSchema),
    identities: Type.Array(IdentityReferenceSchema, { minItems: 1 }),
    attributes: Type.Optional(MetadataSchema)
  },
  { additionalProperties: false }
);

export const BalanceSchema = Type.Object(
  {
    account_id: IdSchema,
    member_id: IdSchema,
    program_id: IdSchema,
    unit: LoyaltyUnitSchema,
    unit_label: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    amount: Type.Integer(),
    reserved: Type.Integer({ minimum: 0 }),
    available: Type.Integer(),
    as_of: DateTimeSchema
  },
  { additionalProperties: false }
);

export const MemberLookupRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    program_id: IdSchema,
    identity: IdentityReferenceSchema
  },
  { additionalProperties: false }
);

export const MemberLookupResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    member: Type.Union([MemberSchema, Type.Null()]),
    balances: Type.Array(BalanceSchema)
  },
  { additionalProperties: false }
);

export const MemberEnrollRequestSchema = Type.Object(
  {
    context: RequestContextSchema,
    program_id: IdSchema,
    identity: IdentityReferenceSchema,
    member_id: Type.Optional(IdSchema),
    attributes: Type.Optional(MetadataSchema)
  },
  { additionalProperties: false }
);

export const MemberEnrollResponseSchema = Type.Object(
  {
    context: ResponseContextSchema,
    member: MemberSchema,
    balances: Type.Array(BalanceSchema)
  },
  { additionalProperties: false }
);

export type IdentityReference = Static<typeof IdentityReferenceSchema>;
export type Member = Static<typeof MemberSchema>;
export type Balance = Static<typeof BalanceSchema>;
export type MemberLookupRequest = Static<typeof MemberLookupRequestSchema>;
export type MemberLookupResponse = Static<typeof MemberLookupResponseSchema>;
export type MemberEnrollRequest = Static<typeof MemberEnrollRequestSchema>;
export type MemberEnrollResponse = Static<typeof MemberEnrollResponseSchema>;
