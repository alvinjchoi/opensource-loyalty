import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { schemaRegistry } from "../packages/protocol/src/index.js";

const root = resolve(import.meta.dirname, "..");
const schemaDirectory = resolve(root, "spec/schemas");

function plainSchema(name: string): Record<string, unknown> {
  const source = schemaRegistry[name as keyof typeof schemaRegistry];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://loyalty-interchange.org/schema/v1/${name}.json`,
    title: name,
    ...JSON.parse(JSON.stringify(source)) as Record<string, unknown>
  };
}

function schemaRef(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function requestBody(name: string): Record<string, unknown> {
  return {
    required: true,
    content: { "application/json": { schema: schemaRef(name) } }
  };
}

function responses(successStatus: number, description: string, schema: string): Record<string, unknown> {
  return {
    [successStatus]: {
      description,
      content: { "application/json": { schema: schemaRef(schema) } }
    },
    default: { $ref: "#/components/responses/Problem" }
  };
}

function jsonResponse(description: string, schema: Record<string, unknown>): Record<string, unknown> {
  return {
    description,
    content: { "application/json": { schema } }
  };
}

function operation(
  operationId: string,
  summary: string,
  tag: string,
  request: string,
  response: string,
  successStatus = 200,
  safeToRetry = false
): Record<string, unknown> {
  return {
    operationId,
    summary,
    tags: [tag],
    requestBody: requestBody(request),
    responses: responses(successStatus, summary, response),
    "x-lip-safe-to-retry": safeToRetry
  };
}

const openapi = {
  openapi: "3.1.2",
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "Loyalty Interchange Protocol",
    version: "0.1.0",
    description: "Vendor-neutral loyalty transaction API with the foodservice/1.0 profile.",
    license: { name: "Apache-2.0", identifier: "Apache-2.0" }
  },
  servers: [{ url: "https://loyalty.example.com/lip/v1" }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Discovery" },
    { name: "Programs" },
    { name: "Accounts" },
    { name: "Ledger" },
    { name: "Members" },
    { name: "Orders" },
    { name: "Accruals" },
    { name: "Redemptions" }
  ],
  paths: {
    "/.well-known/lip": {
      get: {
        operationId: "discoverLoyaltyProtocol",
        summary: "Discover LIP endpoints and authentication",
        tags: ["Discovery"],
        servers: [{ url: "https://loyalty.example.com" }],
        security: [],
        "x-lip-safe-to-retry": true,
        responses: {
          200: jsonResponse("LIP discovery document", schemaRef("WellKnownDocument"))
        }
      }
    },
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Check service health",
        tags: ["Discovery"],
        servers: [{ url: "https://loyalty.example.com" }],
        security: [],
        "x-lip-safe-to-retry": true,
        responses: {
          200: jsonResponse("Service is healthy", schemaRef("HealthDocument"))
        }
      }
    },
    "/capabilities": {
      get: {
        operationId: "getCapabilities",
        summary: "Get negotiated operations, effects, events, and limits",
        tags: ["Discovery"],
        "x-lip-safe-to-retry": true,
        responses: {
          200: jsonResponse("Supported LIP capabilities", schemaRef("CapabilitiesDocument")),
          default: { $ref: "#/components/responses/Problem" }
        }
      }
    },
    "/programs/get": {
      post: operation("getProgram", "Get program, tier, and reward definitions", "Programs", "ProgramGetRequest", "ProgramGetResponse", 200, true)
    },
    "/accounts/get": {
      post: operation("getMemberAccount", "Get balances, metrics, and tier progress", "Accounts", "MemberAccountRequest", "MemberAccountResponse", 200, true)
    },
    "/ledger/list": {
      post: operation("listLedgerEntries", "List member ledger entries", "Ledger", "LedgerListRequest", "LedgerListResponse", 200, true)
    },
    "/ledger/manual-adjustments": {
      post: operation("postManualAdjustment", "Credit or debit points with an operator classification", "Ledger", "ManualAdjustmentRequest", "LedgerResponse", 201)
    },
    "/members/lookup": {
      post: operation("lookupMember", "Resolve a member identity", "Members", "MemberLookupRequest", "MemberLookupResponse", 200, true)
    },
    "/members/enroll": {
      post: operation("enrollMember", "Enroll or return a member", "Members", "MemberEnrollRequest", "MemberEnrollResponse", 201)
    },
    "/orders/evaluate": {
      post: operation("evaluateOrder", "Evaluate accrual and available rewards", "Orders", "EvaluationRequest", "EvaluationResponse", 200, true)
    },
    "/accruals": {
      post: operation("postAccrual", "Post accrual for a paid order", "Accruals", "AccrualPostRequest", "LedgerResponse", 201)
    },
    "/redemptions/reserve": {
      post: operation("reserveRedemption", "Reserve a reward for an order", "Redemptions", "RedemptionReserveRequest", "RedemptionReservationResponse", 201)
    },
    "/redemptions/capture": {
      post: operation("captureRedemption", "Capture a reserved reward", "Redemptions", "RedemptionCaptureRequest", "RedemptionReservationResponse")
    },
    "/redemptions/reverse": {
      post: operation("reverseRedemption", "Release or refund a redemption", "Redemptions", "RedemptionReverseRequest", "RedemptionReservationResponse")
    },
    "/orders/adjust": {
      post: operation("adjustOrder", "Adjust accrual after refund, void, or correction", "Orders", "OrderAdjustmentRequest", "LedgerResponse", 201)
    }
  },
  webhooks: {
    loyaltyEvent: {
      post: {
        summary: "LIP lifecycle event encoded as CloudEvents 1.0 structured JSON",
        requestBody: requestBody("LoyaltyEvent"),
        responses: { 204: { description: "Event accepted" } }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" }
    },
    responses: {
      Problem: {
        description: "RFC 9457 problem details",
        content: { "application/problem+json": { schema: schemaRef("ProblemDetails") } }
      }
    },
    schemas: Object.fromEntries(
      Object.keys(schemaRegistry).map((name) => {
        const { $schema: _schema, $id: _id, ...schema } = plainSchema(name);
        return [name, schema];
      })
    )
  }
};

await mkdir(schemaDirectory, { recursive: true });
await Promise.all(
  Object.keys(schemaRegistry).map(async (name) => {
    const path = resolve(schemaDirectory, `${name}.json`);
    await writeFile(path, `${JSON.stringify(plainSchema(name), null, 2)}\n`);
  })
);

const catalog = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://loyalty-interchange.org/schema/v1/catalog.json",
  title: "LIP v1 schema catalog",
  $defs: Object.fromEntries(
    Object.keys(schemaRegistry).map((name) => [name, { $ref: `./${name}.json` }])
  )
};
await writeFile(resolve(schemaDirectory, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
const openapiYaml = YAML.stringify(openapi, { lineWidth: 100 });
await writeFile(resolve(root, "spec/openapi.yaml"), openapiYaml);
await writeFile(resolve(root, "docs-site/api-reference/openapi.yaml"), openapiYaml);
