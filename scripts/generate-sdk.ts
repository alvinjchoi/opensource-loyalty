import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

interface OpenApiOperation {
  operationId?: unknown;
  servers?: Array<{ url?: unknown }>;
  security?: unknown[];
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: unknown } }>;
  };
  responses?: Record<string, {
    content?: Record<string, { schema?: { $ref?: unknown } }>;
  }>;
  "x-lip-safe-to-retry"?: unknown;
}

interface OpenApiDocument {
  servers?: Array<{ url?: unknown }>;
  security?: unknown[];
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

interface GeneratedOperation {
  operationId: string;
  method: string;
  path: string;
  authenticated: boolean;
  safeToRetry: boolean;
  requestSchema?: string;
  responseSchema: string;
}

const root = resolve(import.meta.dirname, "..");
const openApiPath = resolve(root, "spec/openapi.yaml");
const outputPath = resolve(root, "packages/sdk/src/generated/client.ts");

function schemaName(content: Record<string, { schema?: { $ref?: unknown } }> | undefined): string | undefined {
  const reference = content?.["application/json"]?.schema?.$ref ??
    content?.["application/problem+json"]?.schema?.$ref;
  return typeof reference === "string" ? reference.split("/").at(-1) : undefined;
}

function serverPath(operation: OpenApiOperation, api: OpenApiDocument): string {
  const url = operation.servers?.[0]?.url ?? api.servers?.[0]?.url;
  if (typeof url !== "string") return "";
  const path = new URL(url).pathname.replace(/\/+$/, "");
  return path === "/" ? "" : path;
}

function operationPath(basePath: string, path: string): string {
  return `${basePath}${path}`.replace(/\/{2,}/g, "/");
}

function successResponse(operation: OpenApiOperation): string | undefined {
  const response = Object.entries(operation.responses ?? {})
    .filter(([status]) => /^2\d\d$/.test(status))
    .sort(([left], [right]) => Number(left) - Number(right))[0]?.[1];
  return schemaName(response?.content);
}

function collectOperations(api: OpenApiDocument): GeneratedOperation[] {
  const operations: GeneratedOperation[] = [];
  for (const [path, pathItem] of Object.entries(api.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operation || typeof operation.operationId !== "string") continue;
      const responseSchema = successResponse(operation);
      if (!responseSchema) {
        throw new Error(`${operation.operationId} must have a named success response schema`);
      }
      const requestSchema = schemaName(operation.requestBody?.content);
      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: operationPath(serverPath(operation, api), path),
        authenticated: (operation.security ?? api.security ?? []).length > 0,
        safeToRetry: operation["x-lip-safe-to-retry"] === true,
        ...(requestSchema ? { requestSchema } : {}),
        responseSchema
      });
    }
  }
  return operations;
}

function generatedSource(operations: GeneratedOperation[]): string {
  const schemaTypes = [...new Set(
    operations.flatMap((operation) => [operation.requestSchema, operation.responseSchema])
      .filter((name): name is string => name !== undefined)
  )].sort();
  const imports = ["schemaRegistry", ...schemaTypes].join(",\n  ");
  const metadata = operations.map((operation) => {
    const request = operation.requestSchema ? `\n    requestSchema: ${JSON.stringify(operation.requestSchema)},` : "";
    return `  ${operation.operationId}: {\n` +
      `    operationId: ${JSON.stringify(operation.operationId)},\n` +
      `    method: ${JSON.stringify(operation.method)},\n` +
      `    path: ${JSON.stringify(operation.path)},\n` +
      `    authenticated: ${operation.authenticated},\n` +
      `    safeToRetry: ${operation.safeToRetry},${request}\n` +
      `    responseSchema: ${JSON.stringify(operation.responseSchema)}\n` +
      "  }";
  }).join(",\n");
  const methods = operations.map((operation) => {
    const requestType = operation.requestSchema ?? "never";
    const parameters = operation.requestSchema
      ? `body: ${requestType}, options?: GeneratedCallOptions`
      : "options?: GeneratedCallOptions";
    const body = operation.requestSchema ? "body" : "undefined";
    return `  public ${operation.operationId}(${parameters}): Promise<${operation.responseSchema}> {\n` +
      `    return this.transport.request<${requestType}, ${operation.responseSchema}>(\n` +
      `      generatedOperations.${operation.operationId},\n` +
      `      ${body},\n` +
      "      options\n" +
      "    );\n" +
      "  }";
  }).join("\n\n");

  return `// Generated from spec/openapi.yaml by scripts/generate-sdk.ts. Do not edit.\n` +
    `import type {\n  ${imports}\n} from "@loyalty-interchange/protocol";\n\n` +
    "export type GeneratedSchemaName = keyof typeof schemaRegistry;\n\n" +
    "export interface GeneratedCallOptions {\n  signal?: AbortSignal;\n}\n\n" +
    "export interface GeneratedOperation<TRequest = unknown, TResponse = unknown> {\n" +
    "  readonly operationId: string;\n" +
    "  readonly method: string;\n" +
    "  readonly path: string;\n" +
    "  readonly authenticated: boolean;\n" +
    "  readonly safeToRetry: boolean;\n" +
    "  readonly requestSchema?: GeneratedSchemaName;\n" +
    "  readonly responseSchema: GeneratedSchemaName;\n" +
    "  readonly __types?: { request: TRequest; response: TResponse };\n" +
    "}\n\n" +
    "export interface GeneratedTransport {\n" +
    "  request<TRequest, TResponse>(\n" +
    "    operation: GeneratedOperation<TRequest, TResponse>,\n" +
    "    body: TRequest | undefined,\n" +
    "    options?: GeneratedCallOptions\n" +
    "  ): Promise<TResponse>;\n" +
    "}\n\n" +
    `export const generatedOperations = {\n${metadata}\n} as const satisfies Record<string, GeneratedOperation>;\n\n` +
    "export class GeneratedLipClient {\n" +
    "  public constructor(private readonly transport: GeneratedTransport) {}\n\n" +
    `${methods}\n` +
    "}\n";
}

const api = YAML.parse(await readFile(openApiPath, "utf8")) as OpenApiDocument;
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, generatedSource(collectOperations(api)));
