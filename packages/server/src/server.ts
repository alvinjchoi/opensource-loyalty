import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import {
  AccrualPostRequestSchema,
  MemberAccountRequestSchema,
  type CapabilitiesDocument,
  EvaluationRequestSchema,
  LedgerListRequestSchema,
  MemberEnrollRequestSchema,
  MemberLookupRequestSchema,
  OrderAdjustmentRequestSchema,
  ProgramGetRequestSchema,
  RedemptionCaptureRequestSchema,
  RedemptionReserveRequestSchema,
  RedemptionReverseRequestSchema,
  validate,
  type ProblemDetails,
  type WellKnownDocument
} from "@loyalty-interchange/protocol";
import {
  EngineError,
  type LoyaltyEngine,
  type LoyaltyEngineState
} from "@loyalty-interchange/reference";

const MAX_BODY_BYTES = 1_048_576;

interface Route {
  schema: TSchema;
  status: number;
  handle(body: never): unknown;
}

export interface ServerOptions {
  apiKey: string;
  reservationTtlSeconds?: number;
  persistState?: (state: LoyaltyEngineState) => void;
  admin?: {
    enabled?: boolean;
    assetRoot?: string;
    storage?: {
      driver: string;
      location: string;
      persistent: boolean;
    };
  };
}

export interface RunningServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

function equalSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(request: IncomingMessage, apiKey: string): boolean {
  const authorization = request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") && equalSecret(authorization.slice(7), apiKey);
}

function wellKnownDocument(): WellKnownDocument {
  return {
    protocol: "LIP",
    protocol_version: "1.0",
    profiles: ["foodservice/1.0"],
    endpoints: {
      api: "/lip/v1",
      capabilities: "/lip/v1/capabilities",
      health: "/health"
    },
    authentication: ["bearer"]
  };
}

function capabilitiesDocument(reservationTtlSeconds: number): CapabilitiesDocument {
  return {
    protocol_version: "1.0",
    profiles: ["foodservice/1.0"],
    operations: [
      "member.lookup",
      "member.enroll",
      "order.evaluate",
      "accrual.post",
      "redemption.reserve",
      "redemption.capture",
      "redemption.reverse",
      "order.adjust",
      "program.get",
      "account.get",
      "ledger.list"
    ],
    reward_effects: ["discount", "free_item", "custom"],
    event_types: [
      "org.loyalty-interchange.member.enrolled.v1",
      "org.loyalty-interchange.balance.changed.v1",
      "org.loyalty-interchange.order.accrued.v1",
      "org.loyalty-interchange.order.adjusted.v1",
      "org.loyalty-interchange.redemption.reserved.v1",
      "org.loyalty-interchange.redemption.captured.v1",
      "org.loyalty-interchange.redemption.reversed.v1"
    ],
    limits: {
      max_body_bytes: MAX_BODY_BYTES,
      max_idempotency_key_length: 255,
      reservation_ttl_seconds: reservationTtlSeconds
    }
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  response.writeHead(status, {
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function isAdminAuthorized(
  request: IncomingMessage,
  apiKey: string,
  sessions: Set<string>
): boolean {
  return isAuthorized(request, apiKey) || sessions.has(cookieValue(request, "lip_admin_session") ?? "");
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

async function serveAdminAsset(
  response: ServerResponse,
  assetRoot: string | undefined,
  path: string
): Promise<void> {
  if (!assetRoot) {
    sendJson(response, 503, problem(503, "Admin unavailable", "admin_unavailable"), "application/problem+json");
    return;
  }
  const rawRelative = decodeURIComponent(path.slice("/admin/".length));
  const relative = rawRelative === "" ? "index.html" : normalize(rawRelative);
  if (relative.startsWith("..") || relative.includes("/../") || relative.includes("\\")) {
    sendJson(response, 400, problem(400, "Invalid Admin path", "invalid_path"), "application/problem+json");
    return;
  }
  const requested = join(assetRoot, relative);
  try {
    const body = await readFile(requested);
    response.writeHead(200, {
      "content-type": contentTypes[extname(requested)] ?? "application/octet-stream",
      "cache-control": relative === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    });
    response.end(body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !extname(relative)) {
      await serveAdminAsset(response, assetRoot, "/admin/");
      return;
    }
    sendJson(response, 404, problem(404, "Not Found", "not_found"), "application/problem+json");
  }
}

function problem(status: number, title: string, code: string, detail?: string): ProblemDetails {
  return {
    type: `https://loyalty-interchange.org/problems/${code}`,
    title,
    status,
    code,
    ...(detail ? { detail } : {})
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new EngineError("invalid_state", "Content-Type must be application/json", 415);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new EngineError("invalid_state", "Request body exceeds 1 MiB", 413);
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new EngineError("invalid_state", "Request body is not valid JSON", 400);
  }
}

function routeTable(engine: LoyaltyEngine): Map<string, Route> {
  return new Map<string, Route>([
    ["POST /lip/v1/programs/get", { schema: ProgramGetRequestSchema, status: 200, handle: (body) => engine.getProgram(body) }],
    ["POST /lip/v1/accounts/get", { schema: MemberAccountRequestSchema, status: 200, handle: (body) => engine.getAccount(body) }],
    ["POST /lip/v1/ledger/list", { schema: LedgerListRequestSchema, status: 200, handle: (body) => engine.listLedger(body) }],
    ["POST /lip/v1/members/lookup", { schema: MemberLookupRequestSchema, status: 200, handle: (body) => engine.lookup(body) }],
    ["POST /lip/v1/members/enroll", { schema: MemberEnrollRequestSchema, status: 201, handle: (body) => engine.enroll(body) }],
    ["POST /lip/v1/orders/evaluate", { schema: EvaluationRequestSchema, status: 200, handle: (body) => engine.evaluate(body) }],
    ["POST /lip/v1/accruals", { schema: AccrualPostRequestSchema, status: 201, handle: (body) => engine.postAccrual(body) }],
    ["POST /lip/v1/redemptions/reserve", { schema: RedemptionReserveRequestSchema, status: 201, handle: (body) => engine.reserve(body) }],
    ["POST /lip/v1/redemptions/capture", { schema: RedemptionCaptureRequestSchema, status: 200, handle: (body) => engine.capture(body) }],
    ["POST /lip/v1/redemptions/reverse", { schema: RedemptionReverseRequestSchema, status: 200, handle: (body) => engine.reverse(body) }],
    ["POST /lip/v1/orders/adjust", { schema: OrderAdjustmentRequestSchema, status: 201, handle: (body) => engine.adjustOrder(body) }]
  ]);
}

export function createReferenceServer(engine: LoyaltyEngine, options: ServerOptions): Server {
  if (options.apiKey.length < 8) {
    throw new Error("Reference server API key must contain at least 8 characters");
  }
  const routes = routeTable(engine);
  const adminSessions = new Set<string>();
  const adminEnabled = options.admin?.enabled ?? true;

  return createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://localhost").pathname;

      if (method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          protocol_version: "1.0",
          profile: "foodservice/1.0"
        });
        return;
      }

      if (method === "GET" && path === "/.well-known/lip") {
        sendJson(response, 200, wellKnownDocument());
        return;
      }

      if (method === "GET" && path === "/lip/v1/capabilities") {
        if (!isAuthorized(request, options.apiKey)) {
          response.setHeader("www-authenticate", "Bearer");
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        sendJson(response, 200, capabilitiesDocument(options.reservationTtlSeconds ?? 120));
        return;
      }

      if (adminEnabled && method === "GET" && path === "/admin") {
        response.writeHead(302, { location: "/admin/", "cache-control": "no-store" });
        response.end();
        return;
      }

      if (adminEnabled && method === "POST" && path === "/admin/api/v1/session") {
        const body = await readBody(request);
        const candidate = body && typeof body === "object"
          ? (body as { api_key?: unknown }).api_key
          : undefined;
        if (typeof candidate !== "string" || !equalSecret(candidate, options.apiKey)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        const session = randomUUID();
        adminSessions.add(session);
        response.writeHead(204, {
          "set-cookie": `lip_admin_session=${encodeURIComponent(session)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800`,
          "cache-control": "no-store"
        });
        response.end();
        return;
      }

      if (adminEnabled && method === "POST" && path === "/admin/api/v1/logout") {
        const session = cookieValue(request, "lip_admin_session");
        if (session) adminSessions.delete(session);
        response.writeHead(204, {
          "set-cookie": "lip_admin_session=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0",
          "cache-control": "no-store"
        });
        response.end();
        return;
      }

      if (adminEnabled && method === "GET" && path === "/admin/api/v1/snapshot") {
        if (!isAdminAuthorized(request, options.apiKey, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        const snapshot = engine.inspectAdmin();
        options.persistState?.(engine.exportState());
        sendJson(response, 200, {
          admin_api_version: "0.1",
          platform: {
            protocol_version: "1.0",
            profile: "foodservice/1.0",
            storage: options.admin?.storage ?? {
              driver: "memory",
              location: "process",
              persistent: false
            }
          },
          ...snapshot
        });
        return;
      }

      if (adminEnabled && method === "GET" && path.startsWith("/admin/")) {
        await serveAdminAsset(response, options.admin?.assetRoot, path);
        return;
      }

      const route = routes.get(`${method} ${path}`);
      if (!route) {
        sendJson(response, 404, problem(404, "Not Found", "not_found"), "application/problem+json");
        return;
      }

      if (!isAuthorized(request, options.apiKey)) {
        response.setHeader("www-authenticate", "Bearer");
        sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
        return;
      }

      const body = await readBody(request);
      const validation = validate(route.schema, body);
      if (!validation.ok) {
        const details: ProblemDetails = {
          ...problem(422, "Request validation failed", "validation_failed"),
          errors: validation.issues.map((issue) => ({ path: issue.path, message: issue.message }))
        };
        sendJson(response, 422, details, "application/problem+json");
        return;
      }

      const result = route.handle(validation.value as never);
      options.persistState?.(engine.exportState());
      sendJson(response, route.status, result);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof EngineError) {
        sendJson(
          response,
          error.status,
          problem(error.status, "Loyalty operation failed", error.code, error.message),
          "application/problem+json"
        );
        return;
      }
      sendJson(
        response,
        500,
        problem(500, "Internal Server Error", "internal_error"),
        "application/problem+json"
      );
    });
  });
}

export async function startReferenceServer(
  engine: LoyaltyEngine,
  options: ServerOptions & { host?: string; port?: number }
): Promise<RunningServer> {
  const server = createReferenceServer(engine, options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
