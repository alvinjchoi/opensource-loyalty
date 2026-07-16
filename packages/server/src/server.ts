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
  IssuedRewardCancelRequestSchema,
  IssuedRewardIssueRequestSchema,
  IssuedRewardListRequestSchema,
  LedgerListRequestSchema,
  ManualAdjustmentRequestSchema,
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
import type { WebhookAdminStatus, WebhookDispatcher, WebhookSubscription } from "./webhooks.js";
import type { ProgramManagementService } from "./program-management.js";
import type { CampaignService } from "./campaigns.js";
import type { MembershipService } from "./memberships.js";
import {
  engagementAnalytics,
  memberExport,
  type EngagementService
} from "./engagement.js";
import type {
  AccessControlService,
  TenantPermission,
  TenantPrincipal,
  TenantRole
} from "./access-control.js";

const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_LOCAL_API_KEY = "lip-dev-key";

interface Route {
  schema: TSchema;
  status: number;
  handle(body: never): unknown;
}

class TransportError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly title: string;

  public constructor(status: number, code: string, title: string, detail: string) {
    super(detail);
    this.name = "TransportError";
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

export interface ServerOptions {
  apiKey: string;
  reservationTtlSeconds?: number;
  persistState?: (state: LoyaltyEngineState) => void;
  /**
   * Runs a protocol operation inside an external storage transaction. A
   * Postgres deployment uses this hook to reload, lock, mutate, and commit one
   * engine revision before the HTTP response is sent.
   */
  executeEngineOperation?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  rateLimit?: false | {
    maxRequests?: number;
    windowMs?: number;
  };
  metrics?: boolean;
  requestLogger?: false | ((entry: StructuredRequestLog) => void);
  admin?: {
    enabled?: boolean;
    assetRoot?: string;
    storage?: {
      driver: string;
      location: string;
      persistent: boolean;
    };
    webhooks?: () => WebhookAdminStatus;
    webhookManager?: WebhookDispatcher;
    programs?: ProgramManagementService;
    campaigns?: CampaignService;
    memberships?: MembershipService;
    access?: AccessControlService;
    engagement?: EngagementService;
  };
}

export interface StructuredRequestLog {
  timestamp: string;
  request_id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  response_bytes?: number;
}

export interface RunningServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

interface AdminStorageDescriptor {
  driver: string;
  location: string;
  persistent: boolean;
}

interface AdminBootstrapDocument {
  admin_api_version: "0.4";
  generated_at: string;
  status: true;
  auth: {
    mode: "api_key";
    requires_login: true;
    session_cookie: "lip_admin_session";
    default_local_key: boolean;
    credential_hint: string;
  };
  session: {
    authenticated: boolean;
  };
  platform: {
    protocol_version: "1.0";
    profile: "foodservice/1.0";
    storage: AdminStorageDescriptor;
  };
  onboarding: {
    title: string;
    description: string;
    steps: Array<{
      id: string;
      title: string;
      description: string;
      status: "ready" | "next" | "optional";
    }>;
    commands: Array<{ label: string; value: string }>;
  };
  links: {
    admin: string;
    health: string;
    capabilities: string;
    api: string;
  };
}

function equalSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

interface AdminSession {
  csrf: string;
  principal: TenantPrincipal;
}

function bearerSecret(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function rootPrincipal(options: ServerOptions): TenantPrincipal {
  return options.admin?.access?.rootPrincipal() ?? {
    tenant_id: "default",
    actor_id: "root",
    actor_type: "root",
    role: "owner",
    permissions: [
      "admin:read", "admin:write", "program:publish", "access:manage",
      "protocol:read", "protocol:write"
    ]
  };
}

function bearerPrincipal(
  request: IncomingMessage,
  options: ServerOptions
): TenantPrincipal | undefined {
  const secret = bearerSecret(request);
  if (!secret) return undefined;
  if (equalSecret(secret, options.apiKey)) {
    return rootPrincipal(options);
  }
  return options.admin?.access?.authenticate(secret);
}

function protocolAuthorized(
  request: IncomingMessage,
  options: ServerOptions,
  permission: "protocol:read" | "protocol:write"
): boolean {
  const principal = bearerPrincipal(request, options);
  return Boolean(
    principal &&
    (principal.actor_type === "root" ||
      options.admin?.access?.hasPermission(principal, permission))
  );
}

const protocolReadPaths = new Set([
  "/lip/v1/capabilities",
  "/lip/v1/members/lookup",
  "/lip/v1/programs/get",
  "/lip/v1/accounts/get",
  "/lip/v1/ledger/list",
  "/lip/v1/issued-rewards/list"
]);

function protocolPermission(path: string): "protocol:read" | "protocol:write" {
  return protocolReadPaths.has(path) ? "protocol:read" : "protocol:write";
}

function adminStorage(options: ServerOptions): AdminStorageDescriptor {
  return options.admin?.storage ?? {
    driver: "memory",
    location: "process",
    persistent: false
  };
}

function adminBootstrapDocument(
  options: ServerOptions,
  request: IncomingMessage,
  sessions: ReadonlyMap<string, AdminSession>
): AdminBootstrapDocument {
  const usesDefaultLocalKey = options.apiKey === DEFAULT_LOCAL_API_KEY;
  return {
    admin_api_version: "0.4",
    generated_at: new Date().toISOString(),
    status: true,
    auth: {
      mode: "api_key",
      requires_login: true,
      session_cookie: "lip_admin_session",
      default_local_key: usesDefaultLocalKey,
      credential_hint: usesDefaultLocalKey
        ? "The local development key is prefilled. Startup logs also print it as Admin/API key."
        : "Copy the Admin/API key from the terminal that started this server. Docker users can run docker compose logs lip."
    },
    session: {
      authenticated: isAdminAuthorized(request, options, sessions)
    },
    platform: {
      protocol_version: "1.0",
      profile: "foodservice/1.0",
      storage: adminStorage(options)
    },
    onboarding: {
      title: "Local workspace setup",
      description: "Sign in with the server API key, confirm the reference API is healthy, then configure the loyalty program model.",
      steps: [
        {
          id: "signin",
          title: "Sign in",
          description: "Authenticate to the local Admin with the same key used for Bearer API requests.",
          status: "next"
        },
        {
          id: "configure-program",
          title: "Choose a program model",
          description: "Review points, visit, wallet-credit, paid-membership, and hybrid program templates.",
          status: "ready"
        },
        {
          id: "test-flow",
          title: "Run a test order lifecycle",
          description: "Use the TypeScript SDK example or REST endpoints to evaluate, accrue, reserve, and redeem.",
          status: "optional"
        }
      ],
      commands: [
        { label: "Health", value: "curl http://127.0.0.1:3210/health" },
        { label: "SDK example", value: "npm run example:sdk" }
      ]
    },
    links: {
      admin: "/admin/",
      health: "/health",
      capabilities: "/lip/v1/capabilities",
      api: "/lip/v1"
    }
  };
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
      "ledger.list",
      "ledger.manual_adjustment",
      "issued_reward.list",
      "issued_reward.issue",
      "issued_reward.cancel"
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
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": `${contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(payload);
}

function sendMetrics(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
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
  options: ServerOptions,
  sessions: ReadonlyMap<string, AdminSession>
): boolean {
  const principal = adminPrincipal(request, options, sessions);
  return Boolean(
    principal &&
    (principal.actor_type === "root" ||
      options.admin?.access?.hasPermission(principal, "admin:read"))
  );
}

function isAdminWriteAuthorized(
  request: IncomingMessage,
  options: ServerOptions,
  sessions: ReadonlyMap<string, AdminSession>,
  permission: TenantPermission = "admin:write"
): boolean {
  const bearer = bearerPrincipal(request, options);
  if (bearer) {
    return bearer.actor_type === "root" ||
      Boolean(options.admin?.access?.hasPermission(bearer, permission));
  }
  const session = cookieValue(request, "lip_admin_session");
  const csrfCookie = cookieValue(request, "lip_admin_csrf");
  const csrfHeader = request.headers["x-lip-csrf"];
  if (!session || !csrfCookie || typeof csrfHeader !== "string") return false;
  const expected = sessions.get(session);
  return Boolean(
    expected &&
    (expected.principal.actor_type === "root" ||
      options.admin?.access?.hasPermission(expected.principal, permission)) &&
    equalSecret(expected.csrf, csrfCookie) &&
    equalSecret(expected.csrf, csrfHeader)
  );
}

function adminPrincipal(
  request: IncomingMessage,
  options: ServerOptions,
  sessions: ReadonlyMap<string, AdminSession>
): TenantPrincipal | undefined {
  return bearerPrincipal(request, options) ??
    sessions.get(cookieValue(request, "lip_admin_session") ?? "")?.principal;
}

function adminActor(
  request: IncomingMessage,
  options: ServerOptions,
  sessions: ReadonlyMap<string, AdminSession>
): string {
  return adminPrincipal(request, options, sessions)?.actor_id ?? "unknown-admin";
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
    throw new TransportError(
      415,
      "unsupported_media_type",
      "Unsupported Media Type",
      "Content-Type must be application/json"
    );
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new TransportError(413, "payload_too_large", "Payload Too Large", "Request body exceeds 1 MiB");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TransportError(400, "invalid_json", "Bad Request", "Request body is not valid JSON");
  }
}

interface RateLimitWindow {
  count: number;
  resetsAt: number;
}

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetsAt: number;
}

function createRateLimiter(
  options: Exclude<ServerOptions["rateLimit"], false>
): (key: string) => RateLimitResult {
  const maxRequests = options?.maxRequests ?? 120;
  const windowMs = options?.windowMs ?? 60_000;
  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new RangeError("rateLimit.maxRequests must be a positive integer");
  }
  if (!Number.isInteger(windowMs) || windowMs < 1000) {
    throw new RangeError("rateLimit.windowMs must be an integer of at least 1000");
  }
  const windows = new Map<string, RateLimitWindow>();

  return (key) => {
    const now = Date.now();
    let window = windows.get(key);
    if (!window || window.resetsAt <= now) {
      window = { count: 0, resetsAt: now + windowMs };
      windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= maxRequests,
      limit: maxRequests,
      remaining: Math.max(0, maxRequests - window.count),
      resetsAt: window.resetsAt
    };
  };
}

function applyRateLimitHeaders(response: ServerResponse, result: RateLimitResult): void {
  response.setHeader("ratelimit-limit", String(result.limit));
  response.setHeader("ratelimit-remaining", String(result.remaining));
  response.setHeader("ratelimit-reset", String(Math.ceil(result.resetsAt / 1000)));
}

interface HttpMetric {
  method: string;
  path: string;
  status: number;
  count: number;
  durationSeconds: number;
}

class HttpMetrics {
  private readonly values = new Map<string, HttpMetric>();

  public observe(method: string, path: string, status: number, durationMs: number): void {
    const key = `${method}\0${path}\0${status}`;
    const metric = this.values.get(key) ?? {
      method,
      path,
      status,
      count: 0,
      durationSeconds: 0
    };
    metric.count += 1;
    metric.durationSeconds += durationMs / 1000;
    this.values.set(key, metric);
  }

  public render(): string {
    const lines = [
      "# HELP lip_http_requests_total Completed HTTP requests.",
      "# TYPE lip_http_requests_total counter",
      ...[...this.values.values()].map((metric) =>
        `lip_http_requests_total{method="${metric.method}",path="${metric.path}",status="${metric.status}"} ${metric.count}`
      ),
      "# HELP lip_http_request_duration_seconds Request duration in seconds.",
      "# TYPE lip_http_request_duration_seconds summary",
      ...[...this.values.values()].flatMap((metric) => {
        const labels = `method="${metric.method}",path="${metric.path}",status="${metric.status}"`;
        return [
          `lip_http_request_duration_seconds_sum{${labels}} ${metric.durationSeconds}`,
          `lip_http_request_duration_seconds_count{${labels}} ${metric.count}`
        ];
      })
    ];
    return `${lines.join("\n")}\n`;
  }
}

function routeTable(engine: LoyaltyEngine): Map<string, Route> {
  return new Map<string, Route>([
    ["POST /lip/v1/programs/get", { schema: ProgramGetRequestSchema, status: 200, handle: (body) => engine.getProgram(body) }],
    ["POST /lip/v1/accounts/get", { schema: MemberAccountRequestSchema, status: 200, handle: (body) => engine.getAccount(body) }],
    ["POST /lip/v1/ledger/list", { schema: LedgerListRequestSchema, status: 200, handle: (body) => engine.listLedger(body) }],
    ["POST /lip/v1/ledger/manual-adjustments", { schema: ManualAdjustmentRequestSchema, status: 201, handle: (body) => engine.postManualAdjustment(body) }],
    ["POST /lip/v1/issued-rewards/list", { schema: IssuedRewardListRequestSchema, status: 200, handle: (body) => engine.listIssuedRewards(body) }],
    ["POST /lip/v1/issued-rewards/issue", { schema: IssuedRewardIssueRequestSchema, status: 201, handle: (body) => engine.issueReward(body) }],
    ["POST /lip/v1/issued-rewards/cancel", { schema: IssuedRewardCancelRequestSchema, status: 200, handle: (body) => engine.cancelIssuedReward(body) }],
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
  const adminSessions = new Map<string, AdminSession>();
  const adminEnabled = options.admin?.enabled ?? true;
  const rateLimiter = options.rateLimit === false ? undefined : createRateLimiter(options.rateLimit);
  const metrics = options.metrics === false ? undefined : new HttpMetrics();

  const allowedMethods = new Map<string, string[]>([
    ["/health", ["GET"]],
    ["/favicon.ico", ["GET"]],
    ["/.well-known/lip", ["GET"]],
    ["/lip/v1/capabilities", ["GET"]],
    ...(metrics ? [["/metrics", ["GET"]] as [string, string[]]] : [])
  ]);
  for (const key of routes.keys()) {
    const separator = key.indexOf(" ");
    const routeMethod = key.slice(0, separator);
    const routePath = key.slice(separator + 1);
    const methods = allowedMethods.get(routePath) ?? [];
    methods.push(routeMethod);
    allowedMethods.set(routePath, methods);
  }
  if (adminEnabled) {
    allowedMethods.set("/admin/api/v1/bootstrap", ["GET"]);
    allowedMethods.set("/admin/api/v1/session", ["POST"]);
    allowedMethods.set("/admin/api/v1/logout", ["POST"]);
    allowedMethods.set("/admin/api/v1/snapshot", ["GET"]);
    if (options.admin?.access) {
      allowedMethods.set("/admin/api/v1/access/users", ["PUT"]);
      allowedMethods.set("/admin/api/v1/access/api-keys", ["POST"]);
      allowedMethods.set("/admin/api/v1/access/api-keys/revoke", ["POST"]);
    }
    if (options.admin?.programs) {
      allowedMethods.set("/admin/api/v1/program/draft", ["PUT", "DELETE"]);
      allowedMethods.set("/admin/api/v1/program/draft/validate", ["POST"]);
      allowedMethods.set("/admin/api/v1/program/publish", ["POST"]);
      allowedMethods.set("/admin/api/v1/program/rollback", ["POST"]);
      allowedMethods.set("/admin/api/v1/program/rewards", ["PUT"]);
      allowedMethods.set("/admin/api/v1/program/rewards/delete", ["POST"]);
    }
    if (options.admin?.webhookManager) {
      allowedMethods.set("/admin/api/v1/webhooks/subscription", ["PUT"]);
      allowedMethods.set("/admin/api/v1/webhooks/subscription/delete", ["POST"]);
      allowedMethods.set("/admin/api/v1/webhooks/subscription/rotate-secret", ["POST"]);
      allowedMethods.set("/admin/api/v1/webhooks/deliveries/retry", ["POST"]);
      allowedMethods.set("/admin/api/v1/webhooks/deliveries/replay", ["POST"]);
    }
    if (options.admin?.campaigns) {
      allowedMethods.set("/admin/api/v1/segments", ["PUT"]);
      allowedMethods.set("/admin/api/v1/segments/delete", ["POST"]);
      allowedMethods.set("/admin/api/v1/campaigns", ["PUT"]);
      allowedMethods.set("/admin/api/v1/campaigns/delete", ["POST"]);
      allowedMethods.set("/admin/api/v1/campaigns/run", ["POST"]);
    }
    if (options.admin?.memberships) {
      allowedMethods.set("/admin/api/v1/memberships/grant", ["POST"]);
      allowedMethods.set("/admin/api/v1/memberships/status", ["POST"]);
    }
  }

  return createServer((request, response) => {
    const startedAt = performance.now();
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const suppliedRequestId = request.headers["x-request-id"];
    const requestId = typeof suppliedRequestId === "string" &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      const durationMs = performance.now() - startedAt;
      const normalizedPath = allowedMethods.has(path)
        ? path
        : path.startsWith("/admin/")
          ? "/admin/*"
          : "unmatched";
      metrics?.observe(method, normalizedPath, response.statusCode, durationMs);
      if (
        options.admin?.access &&
        path.startsWith("/admin/api/v1/") &&
        !["GET", "HEAD", "OPTIONS"].includes(method) &&
        !["/admin/api/v1/session", "/admin/api/v1/logout"].includes(path) &&
        response.statusCode < 400
      ) {
        const principal = adminPrincipal(request, options, adminSessions);
        if (principal) {
          try {
            options.admin.access.recordAudit(
              principal,
              `admin.${method.toLowerCase()}`,
              path,
              undefined,
              { status: response.statusCode },
              requestId
            );
          } catch {
            // Audit persistence must never change an already completed response.
          }
        }
      }
      if (
        options.admin?.access &&
        path.startsWith("/lip/v1/") &&
        protocolPermission(path) === "protocol:write" &&
        response.statusCode < 400
      ) {
        const principal = bearerPrincipal(request, options);
        if (principal) {
          try {
            options.admin.access.recordAudit(
              principal,
              "protocol.write",
              path,
              undefined,
              { status: response.statusCode },
              requestId
            );
          } catch {
            // Audit persistence must never change an already completed response.
          }
        }
      }
      if (!options.requestLogger) return;
      const contentLength = response.getHeader("content-length");
      const entry: StructuredRequestLog = {
        timestamp: new Date().toISOString(),
        request_id: requestId,
        method,
        path,
        status: response.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        ...(typeof contentLength === "number" ? { response_bytes: contentLength } : {}),
        ...(typeof contentLength === "string" && /^\d+$/.test(contentLength)
          ? { response_bytes: Number(contentLength) }
          : {})
      };
      try {
        options.requestLogger(entry);
      } catch {
        // Request logging must never change the HTTP response.
      }
    });

    const enforceRateLimit = (): boolean => {
      if (!rateLimiter) return true;
      const result = rateLimiter(request.socket.remoteAddress ?? "unknown");
      applyRateLimitHeaders(response, result);
      if (result.allowed) return true;
      response.setHeader("retry-after", String(Math.max(1, Math.ceil((result.resetsAt - Date.now()) / 1000))));
      sendJson(
        response,
        429,
        problem(429, "Too Many Requests", "rate_limit_exceeded"),
        "application/problem+json"
      );
      return false;
    };

    void (async () => {
      if (method === "GET" && path === "/health") {
        sendJson(response, 200, {
          status: "ok",
          protocol_version: "1.0",
          profile: "foodservice/1.0"
        });
        return;
      }

      if (metrics && method === "GET" && path === "/metrics") {
        if (!protocolAuthorized(request, options, "protocol:read")) {
          response.setHeader("www-authenticate", "Bearer");
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        sendMetrics(response, metrics.render());
        return;
      }

      if (method === "GET" && path === "/favicon.ico") {
        response.writeHead(204, { "cache-control": "public, max-age=86400" });
        response.end();
        return;
      }

      if (method === "GET" && path === "/.well-known/lip") {
        sendJson(response, 200, wellKnownDocument());
        return;
      }

      if (method === "GET" && path === "/lip/v1/capabilities") {
        if (!protocolAuthorized(request, options, "protocol:read")) {
          response.setHeader("www-authenticate", "Bearer");
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        if (!enforceRateLimit()) return;
        sendJson(response, 200, capabilitiesDocument(options.reservationTtlSeconds ?? 120));
        return;
      }

      if (adminEnabled && method === "GET" && path === "/admin") {
        response.writeHead(302, { location: "/admin/", "cache-control": "no-store" });
        response.end();
        return;
      }

      if (adminEnabled && method === "GET" && path === "/admin/api/v1/bootstrap") {
        sendJson(response, 200, adminBootstrapDocument(options, request, adminSessions));
        return;
      }

      if (adminEnabled && method === "POST" && path === "/admin/api/v1/session") {
        const body = await readBody(request);
        const candidate = body && typeof body === "object"
          ? (body as { api_key?: unknown }).api_key
          : undefined;
        const principal = typeof candidate === "string"
          ? (equalSecret(candidate, options.apiKey)
              ? rootPrincipal(options)
              : options.admin?.access?.authenticate(candidate))
          : undefined;
        if (
          !principal ||
          (principal.actor_type !== "root" &&
            !options.admin?.access?.hasPermission(principal, "admin:read"))
        ) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        const session = randomUUID();
        const csrf = randomUUID();
        adminSessions.set(session, { csrf, principal });
        response.writeHead(204, {
          "set-cookie": [
            `lip_admin_session=${encodeURIComponent(session)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800`,
            `lip_admin_csrf=${encodeURIComponent(csrf)}; Path=/admin; SameSite=Strict; Max-Age=28800`
          ],
          "x-lip-csrf-token": csrf,
          "cache-control": "no-store"
        });
        response.end();
        return;
      }

      if (adminEnabled && method === "POST" && path === "/admin/api/v1/logout") {
        const session = cookieValue(request, "lip_admin_session");
        if (session) adminSessions.delete(session);
        response.writeHead(204, {
          "set-cookie": [
            "lip_admin_session=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0",
            "lip_admin_csrf=; Path=/admin; SameSite=Strict; Max-Age=0"
          ],
          "cache-control": "no-store"
        });
        response.end();
        return;
      }

      if (adminEnabled && method === "GET" && path === "/admin/api/v1/snapshot") {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        const snapshot = options.executeEngineOperation
          ? await options.executeEngineOperation(() => engine.inspectAdmin())
          : engine.inspectAdmin();
        if (!options.executeEngineOperation) options.persistState?.(engine.exportState());
        sendJson(response, 200, {
          admin_api_version: "0.4",
          platform: {
            protocol_version: "1.0",
            profile: "foodservice/1.0",
            storage: adminStorage(options)
          },
          webhooks: options.admin?.webhookManager?.adminStatus() ?? options.admin?.webhooks?.() ?? {
            enabled: false,
            subscriptions: [],
            pending: [],
            recent: []
          },
          ...(options.admin?.programs
            ? { program_management: options.admin.programs.snapshot() }
            : {}),
          campaigns: options.admin?.campaigns?.snapshot() ?? {
            segments: [],
            campaigns: [],
            runs: []
          },
          memberships: options.admin?.memberships?.snapshot() ?? {
            memberships: [],
            audit: []
          },
          ...(options.admin?.access
            ? { access_control: options.admin.access.snapshot() }
            : {}),
          engagement: options.admin?.engagement?.snapshot() ?? {
            connectors: [],
            jobs: []
          },
          ...(options.admin?.campaigns
            ? { analytics: engagementAnalytics(engine, options.admin.campaigns) }
            : {}),
          ...snapshot
        });
        return;
      }

      if (
        adminEnabled &&
        method === "GET" &&
        ["/admin/api/v1/analytics", "/admin/api/v1/exports/members"].includes(path)
      ) {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        if (path === "/admin/api/v1/analytics") {
          if (!options.admin?.campaigns) {
            throw new TransportError(404, "not_found", "Not Found", "Analytics are unavailable");
          }
          const analytics = options.executeEngineOperation
            ? await options.executeEngineOperation(
                () => engagementAnalytics(engine, options.admin!.campaigns!)
              )
            : engagementAnalytics(engine, options.admin.campaigns);
          if (!options.executeEngineOperation) options.persistState?.(engine.exportState());
          sendJson(response, 200, analytics);
          return;
        }
        const url = new URL(request.url ?? "/", "http://localhost");
        const format = url.searchParams.get("format") === "json" ? "json" : "csv";
        const marketingOnly = url.searchParams.get("include_unconsented") !== "true";
        const exported = options.executeEngineOperation
          ? await options.executeEngineOperation(
              () => memberExport(engine, { format, marketingOnly })
            )
          : memberExport(engine, { format, marketingOnly });
        if (!options.executeEngineOperation) options.persistState?.(engine.exportState());
        if (format === "json") {
          sendJson(response, 200, { members: exported });
        } else {
          const body = exported as string;
          response.writeHead(200, {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": "attachment; filename=lip-members.csv",
            "content-length": Buffer.byteLength(body),
            "cache-control": "no-store"
          });
          response.end(body);
        }
        return;
      }

      const engagement = options.admin?.engagement;
      if (
        adminEnabled &&
        engagement &&
        path.startsWith("/admin/api/v1/engagement/") &&
        ["PUT", "POST"].includes(method)
      ) {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        if (!isAdminWriteAuthorized(request, options, adminSessions)) {
          sendJson(response, 403, problem(403, "Forbidden", "forbidden"), "application/problem+json");
          return;
        }
        const body = await readBody(request);
        const values = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        if (method === "PUT" && path === "/admin/api/v1/engagement/connectors") {
          if (
            typeof values["name"] !== "string" ||
            typeof values["type"] !== "string" ||
            !values["configuration"] ||
            typeof values["configuration"] !== "object" ||
            Array.isArray(values["configuration"])
          ) {
            throw new TransportError(422, "validation_failed", "Validation Failed", "Connector fields are invalid");
          }
          sendJson(response, 200, engagement.upsertConnector({
            ...(typeof values["connector_id"] === "string"
              ? { connector_id: values["connector_id"] }
              : {}),
            name: values["name"],
            type: values["type"],
            ...(typeof values["active"] === "boolean" ? { active: values["active"] } : {}),
            configuration: values["configuration"] as Record<string, unknown>,
            ...(typeof values["secret"] === "string" ? { secret: values["secret"] } : {})
          }));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/engagement/connectors/delete") {
          if (typeof values["connector_id"] !== "string") {
            throw new TransportError(422, "validation_failed", "Validation Failed", "connector_id is required");
          }
          sendJson(response, 200, { removed: engagement.removeConnector(values["connector_id"]) });
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/engagement/messages") {
          if (
            typeof values["idempotency_key"] !== "string" ||
            typeof values["connector_id"] !== "string" ||
            typeof values["segment_id"] !== "string" ||
            typeof values["template_id"] !== "string" ||
            !values["content"] ||
            typeof values["content"] !== "object" ||
            Array.isArray(values["content"])
          ) {
            throw new TransportError(422, "validation_failed", "Validation Failed", "Message fields are invalid");
          }
          sendJson(response, 201, engagement.enqueue({
            idempotency_key: values["idempotency_key"],
            connector_id: values["connector_id"],
            segment_id: values["segment_id"],
            template_id: values["template_id"],
            content: values["content"] as Record<string, unknown>,
            ...(values["purpose"] === "transactional" ? { purpose: "transactional" as const } : {})
          }));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/engagement/messages/run") {
          if (typeof values["job_id"] !== "string") {
            throw new TransportError(422, "validation_failed", "Validation Failed", "job_id is required");
          }
          sendJson(response, 200, await engagement.runJob(values["job_id"]));
          return;
        }
      }

      const access = options.admin?.access;
      if (
        adminEnabled &&
        access &&
        path.startsWith("/admin/api/v1/access/") &&
        ["PUT", "POST"].includes(method)
      ) {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        if (!isAdminWriteAuthorized(request, options, adminSessions, "access:manage")) {
          sendJson(
            response,
            403,
            problem(403, "Forbidden", "forbidden", "Permission access:manage is required"),
            "application/problem+json"
          );
          return;
        }
        const principal = adminPrincipal(request, options, adminSessions)!;
        const body = await readBody(request);
        const values = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        if (method === "PUT" && path === "/admin/api/v1/access/users") {
          if (typeof values["email"] !== "string" || typeof values["role"] !== "string") {
            throw new TransportError(
              422,
              "validation_failed",
              "Request validation failed",
              "email and role are required"
            );
          }
          sendJson(response, 200, access.upsertUser({
            ...(typeof values["user_id"] === "string" ? { user_id: values["user_id"] } : {}),
            email: values["email"],
            role: values["role"] as TenantRole,
            ...(typeof values["name"] === "string" ? { name: values["name"] } : {}),
            ...(typeof values["active"] === "boolean" ? { active: values["active"] } : {})
          }, principal));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/access/api-keys") {
          if (typeof values["name"] !== "string" || typeof values["role"] !== "string") {
            throw new TransportError(
              422,
              "validation_failed",
              "Request validation failed",
              "name and role are required"
            );
          }
          sendJson(response, 201, access.createApiKey({
            name: values["name"],
            role: values["role"] as TenantRole,
            ...(typeof values["expires_at"] === "string"
              ? { expires_at: values["expires_at"] }
              : {})
          }, principal));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/access/api-keys/revoke") {
          if (typeof values["key_id"] !== "string") {
            throw new TransportError(
              422,
              "validation_failed",
              "Request validation failed",
              "key_id is required"
            );
          }
          access.revokeApiKey(values["key_id"], principal);
          sendJson(response, 200, { revoked: true });
          return;
        }
      }

      const memberships = options.admin?.memberships;
      if (
        adminEnabled &&
        memberships &&
        ["/admin/api/v1/memberships/grant", "/admin/api/v1/memberships/status"].includes(path) &&
        method === "POST"
      ) {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        if (!isAdminWriteAuthorized(request, options, adminSessions)) {
          sendJson(
            response,
            403,
            problem(403, "Forbidden", "csrf_failed", "Admin writes require a valid CSRF token"),
            "application/problem+json"
          );
          return;
        }
        const body = await readBody(request);
        const values = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        const actor = adminActor(request, options, adminSessions);
        if (path === "/admin/api/v1/memberships/grant") {
          if (
            typeof values["member_id"] !== "string" ||
            typeof values["plan_id"] !== "string" ||
            typeof values["valid_until"] !== "string"
          ) {
            throw new TransportError(422, "validation_failed", "Request validation failed", "member_id, plan_id, and valid_until are required");
          }
          sendJson(response, 200, memberships.grant({
            member_id: values["member_id"],
            plan_id: values["plan_id"],
            valid_until: values["valid_until"],
            ...(typeof values["valid_from"] === "string"
              ? { valid_from: values["valid_from"] }
              : {}),
            ...(typeof values["billing_reference"] === "string"
              ? { billing_reference: values["billing_reference"] }
              : {})
          }, actor));
          return;
        }
        if (
          typeof values["member_id"] !== "string" ||
          !["lapsed", "cancelled"].includes(String(values["status"]))
        ) {
          throw new TransportError(422, "validation_failed", "Request validation failed", "member_id and a lapsed/cancelled status are required");
        }
        sendJson(
          response,
          200,
          memberships.changeStatus(
            values["member_id"],
            values["status"] as "lapsed" | "cancelled",
            actor
          )
        );
        return;
      }

      const campaigns = options.admin?.campaigns;
      if (
        adminEnabled &&
        campaigns &&
        ["/admin/api/v1/segments", "/admin/api/v1/segments/delete",
          "/admin/api/v1/campaigns", "/admin/api/v1/campaigns/delete",
          "/admin/api/v1/campaigns/run"].includes(path) &&
        ["PUT", "POST"].includes(method)
      ) {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        if (!isAdminWriteAuthorized(request, options, adminSessions)) {
          sendJson(
            response,
            403,
            problem(403, "Forbidden", "csrf_failed", "Admin writes require a valid CSRF token"),
            "application/problem+json"
          );
          return;
        }
        const body = await readBody(request);
        const values = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        if (method === "PUT" && path === "/admin/api/v1/segments") {
          if (typeof values["name"] !== "string") {
            throw new TransportError(422, "validation_failed", "Request validation failed", "name is required");
          }
          sendJson(response, 200, campaigns.upsertSegment({
            ...(typeof values["segment_id"] === "string"
              ? { segment_id: values["segment_id"] }
              : {}),
            name: values["name"],
            ...(Array.isArray(values["member_ids"])
              ? {
                  member_ids: values["member_ids"].filter((value): value is string =>
                    typeof value === "string"
                  )
                }
              : {}),
            ...(values["rules"] && typeof values["rules"] === "object"
              ? { rules: values["rules"] as never }
              : {})
          }));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/segments/delete") {
          if (typeof values["segment_id"] !== "string") {
            throw new TransportError(422, "validation_failed", "Request validation failed", "segment_id is required");
          }
          campaigns.deleteSegment(values["segment_id"]);
          sendJson(response, 200, { deleted: true });
          return;
        }
        if (method === "PUT" && path === "/admin/api/v1/campaigns") {
          if (
            typeof values["name"] !== "string" ||
            typeof values["reward_id"] !== "string" ||
            typeof values["segment_id"] !== "string"
          ) {
            throw new TransportError(422, "validation_failed", "Request validation failed", "name, reward_id, and segment_id are required");
          }
          sendJson(response, 200, campaigns.upsertCampaign({
            ...(typeof values["campaign_id"] === "string"
              ? { campaign_id: values["campaign_id"] }
              : {}),
            name: values["name"],
            reward_id: values["reward_id"],
            segment_id: values["segment_id"],
            ...(typeof values["issued_reward_ttl_seconds"] === "number"
              ? { issued_reward_ttl_seconds: values["issued_reward_ttl_seconds"] }
              : {}),
            ...(typeof values["starts_at"] === "string" ? { starts_at: values["starts_at"] } : {}),
            ...(typeof values["ends_at"] === "string" ? { ends_at: values["ends_at"] } : {})
          }));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/campaigns/delete") {
          if (typeof values["campaign_id"] !== "string") {
            throw new TransportError(422, "validation_failed", "Request validation failed", "campaign_id is required");
          }
          campaigns.deleteCampaign(values["campaign_id"]);
          sendJson(response, 200, { deleted: true });
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/campaigns/run") {
          if (typeof values["campaign_id"] !== "string") {
            throw new TransportError(422, "validation_failed", "Request validation failed", "campaign_id is required");
          }
          sendJson(
            response,
            200,
            campaigns.runCampaign(
              values["campaign_id"],
              adminActor(request, options, adminSessions)
            )
          );
          return;
        }
      }

      const webhookManager = options.admin?.webhookManager;
      if (
        adminEnabled &&
        webhookManager &&
        path.startsWith("/admin/api/v1/webhooks/") &&
        ["PUT", "POST"].includes(method)
      ) {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        if (!isAdminWriteAuthorized(request, options, adminSessions)) {
          sendJson(
            response,
            403,
            problem(403, "Forbidden", "csrf_failed", "Admin writes require a valid CSRF token"),
            "application/problem+json"
          );
          return;
        }
        const body = await readBody(request);
        const values = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        if (method === "PUT" && path === "/admin/api/v1/webhooks/subscription") {
          if (typeof values["url"] !== "string" || typeof values["secret"] !== "string") {
            throw new TransportError(422, "validation_failed", "Request validation failed", "url and secret are required");
          }
          const subscription: WebhookSubscription = {
            url: values["url"],
            secret: values["secret"],
            ...(typeof values["subscription_id"] === "string"
              ? { subscription_id: values["subscription_id"] }
              : {}),
            ...(typeof values["active"] === "boolean" ? { active: values["active"] } : {}),
            ...(Array.isArray(values["events"]) ? { events: values["events"] as never[] } : {}),
            ...(values["retry_policy"] && typeof values["retry_policy"] === "object"
              ? { retry_policy: values["retry_policy"] as never }
              : {})
          };
          sendJson(response, 200, webhookManager.upsertSubscription(subscription));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/webhooks/subscription/delete") {
          const id = values["subscription_id"];
          if (typeof id !== "string" || !webhookManager.removeSubscription(id)) {
            throw new TransportError(404, "not_found", "Not Found", "Webhook subscription was not found");
          }
          sendJson(response, 200, { deleted: true });
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/webhooks/subscription/rotate-secret") {
          const id = values["subscription_id"];
          const secret = values["secret"];
          if (typeof id !== "string" || typeof secret !== "string") {
            throw new TransportError(422, "validation_failed", "Request validation failed", "subscription_id and secret are required");
          }
          webhookManager.rotateSecret(id, secret);
          sendJson(response, 200, { rotated: true });
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/webhooks/deliveries/retry") {
          const id = values["delivery_id"];
          if (typeof id !== "string" || !webhookManager.retryDelivery(id)) {
            throw new TransportError(404, "not_found", "Not Found", "Pending webhook delivery was not found");
          }
          sendJson(response, 202, { queued: true });
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/webhooks/deliveries/replay") {
          const id = values["delivery_id"];
          if (typeof id !== "string" || !webhookManager.replayDelivery(id)) {
            throw new TransportError(404, "not_found", "Not Found", "Completed webhook delivery was not found");
          }
          sendJson(response, 202, { queued: true });
          return;
        }
      }

      const programManagement = options.admin?.programs;
      if (
        adminEnabled &&
        programManagement &&
        path.startsWith("/admin/api/v1/program/") &&
        ["PUT", "POST", "DELETE"].includes(method)
      ) {
        if (!isAdminAuthorized(request, options, adminSessions)) {
          sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
          return;
        }
        const requiredPermission: TenantPermission =
          ["/admin/api/v1/program/publish", "/admin/api/v1/program/rollback"].includes(path)
            ? "program:publish"
            : "admin:write";
        if (!isAdminWriteAuthorized(request, options, adminSessions, requiredPermission)) {
          sendJson(
            response,
            403,
            problem(403, "Forbidden", "csrf_failed", "Admin writes require a valid CSRF token"),
            "application/problem+json"
          );
          return;
        }
        const body = await readBody(request);
        const values = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        const actor = adminActor(request, options, adminSessions);

        if (method === "PUT" && path === "/admin/api/v1/program/draft") {
          sendJson(response, 200, programManagement.saveDraft(values["program"], actor));
          return;
        }
        if (method === "DELETE" && path === "/admin/api/v1/program/draft") {
          sendJson(response, 200, programManagement.discardDraft(actor));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/program/draft/validate") {
          sendJson(response, 200, programManagement.validateDraft());
          return;
        }
        if (method === "PUT" && path === "/admin/api/v1/program/rewards") {
          sendJson(response, 200, programManagement.upsertReward(values["reward"], actor));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/program/rewards/delete") {
          if (typeof values["reward_id"] !== "string") {
            throw new TransportError(
              422,
              "validation_failed",
              "Request validation failed",
              "reward_id is required"
            );
          }
          sendJson(response, 200, programManagement.deleteReward(values["reward_id"], actor));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/program/publish") {
          const expectedVersion = values["expected_draft_version"];
          if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
            throw new TransportError(
              422,
              "validation_failed",
              "Request validation failed",
              "expected_draft_version must be a positive integer"
            );
          }
          sendJson(response, 200, programManagement.publish(expectedVersion as number, actor));
          return;
        }
        if (method === "POST" && path === "/admin/api/v1/program/rollback") {
          const revision = values["revision"];
          if (!Number.isInteger(revision) || (revision as number) < 1) {
            throw new TransportError(
              422,
              "validation_failed",
              "Request validation failed",
              "revision must be a positive integer"
            );
          }
          sendJson(response, 200, programManagement.rollback(revision as number, actor));
          return;
        }
      }

      if (adminEnabled && method === "GET" && path.startsWith("/admin/")) {
        await serveAdminAsset(response, options.admin?.assetRoot, path);
        return;
      }

      const route = routes.get(`${method} ${path}`);
      if (!route) {
        const allowed = allowedMethods.get(path);
        if (allowed && !allowed.includes(method)) {
          response.setHeader("allow", allowed.join(", "));
          sendJson(
            response,
            405,
            problem(405, "Method Not Allowed", "method_not_allowed", `Use ${allowed.join(" or ")} for this path`),
            "application/problem+json"
          );
          return;
        }
        sendJson(response, 404, problem(404, "Not Found", "not_found"), "application/problem+json");
        return;
      }

      if (!protocolAuthorized(request, options, protocolPermission(path))) {
        response.setHeader("www-authenticate", "Bearer");
        sendJson(response, 401, problem(401, "Unauthorized", "unauthorized"), "application/problem+json");
        return;
      }
      if (!enforceRateLimit()) return;

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

      const result = options.executeEngineOperation
        ? await options.executeEngineOperation(() => route.handle(validation.value as never))
        : route.handle(validation.value as never);
      if (!options.executeEngineOperation) options.persistState?.(engine.exportState());
      sendJson(response, route.status, result);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof TransportError) {
        sendJson(
          response,
          error.status,
          problem(error.status, error.title, error.code, error.message),
          "application/problem+json"
        );
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
