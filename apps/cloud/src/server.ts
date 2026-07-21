import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import type { CloudAuthenticator } from "./auth.js";
import { CloudControlPlane, CloudError } from "./service.js";
import type {
  CloudPrincipal,
  CloudRole,
  EnvironmentCredentialRotation,
  EnvironmentCredentialRotationOptions,
  EnvironmentKind,
  UsageMetric
} from "./types.js";

const maxBodyBytes = 1_048_576;

export interface CloudServerOptions {
  apiKey?: string;
  authenticator?: CloudAuthenticator;
  allowedOrigins?: string[];
  /**
   * Data-plane hook for POST /cloud/v1/environments/{id}/credentials/rotate
   * (PLA-416). When absent the route answers 409
   * credential_rotation_unavailable.
   */
  rotateEnvironmentCredentials?: (
    environmentId: string,
    options: EnvironmentCredentialRotationOptions
  ) => Promise<EnvironmentCredentialRotation>;
}

export interface RunningCloudServer {
  url: string;
  close(): Promise<void>;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

async function principal(
  request: IncomingMessage,
  options: CloudServerOptions
): Promise<CloudPrincipal> {
  if (options.authenticator) {
    return options.authenticator.authenticate({
      headers: request.headers,
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {})
    });
  }
  const secret = bearer(request);
  if (!secret || !options.apiKey || !secureEqual(secret, options.apiKey)) {
    throw new CloudError(401, "unauthorized", "Valid Cloud API credentials are required");
  }
  const subject = request.headers["x-lip-cloud-subject"];
  const email = request.headers["x-lip-cloud-email"];
  if (typeof subject !== "string" || !subject.trim()) {
    throw new CloudError(401, "unauthorized", "x-lip-cloud-subject is required");
  }
  return {
    issuer: "urn:lip:trusted-gateway",
    subject: subject.trim(),
    ...(typeof email === "string" && email.trim()
      ? { email: email.trim().toLowerCase() }
      : {})
  };
}

function corsHeaders(
  request: IncomingMessage,
  options: CloudServerOptions
): Record<string, string> {
  const origin = request.headers.origin;
  if (
    typeof origin === "string" &&
    options.allowedOrigins?.includes(origin)
  ) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers":
        "Authorization, Content-Type, X-LIP-Cloud-Subject, X-LIP-Cloud-Email",
      "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
      vary: "Origin"
    };
  }
  return {};
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers
  });
  response.end(payload);
}

function sendProblem(
  response: ServerResponse,
  error: CloudError,
  headers: Record<string, string>
): void {
  sendJson(response, error.status, {
    type: `https://opensource-loyalty.dev/problems/${error.code}`,
    title: error.code
      .split("_")
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" "),
    status: error.status,
    detail: error.message,
    code: error.code
  }, {
    "content-type": "application/problem+json; charset=utf-8",
    ...headers
  });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new CloudError(413, "payload_too_large", "Request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body is not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new CloudError(400, "invalid_json", "Request body must be a JSON object");
  }
}

function requiredString(
  body: Record<string, unknown>,
  key: string
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CloudError(422, "validation_failed", `${key} is required`);
  }
  return value;
}

function pathId(path: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export function createCloudServer(
  controlPlane: CloudControlPlane,
  options: CloudServerOptions
): Server {
  if (Boolean(options.authenticator) === Boolean(options.apiKey)) {
    throw new Error("Configure exactly one Cloud API key or authenticator");
  }
  if (options.apiKey && options.apiKey.length < 16) {
    throw new Error("Cloud API key must contain at least 16 characters");
  }
  return createServer((request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://cloud.local");
    const path = url.pathname;
    const headers = corsHeaders(request, options);
    if (method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }

    void (async () => {
      if (method === "GET" && path === "/health") {
        sendJson(response, 200, { status: "ok", service: "lip-cloud-control-plane" });
        return;
      }
      const actor = await principal(request, options);
      if (method === "GET" && path === "/cloud/v1/plans") {
        sendJson(response, 200, { data: await controlPlane.plans(actor) }, headers);
        return;
      }
      if (method === "GET" && path === "/cloud/v1/organizations") {
        sendJson(
          response,
          200,
          { data: await controlPlane.organizations(actor) },
          headers
        );
        return;
      }
      if (method === "POST" && path === "/cloud/v1/organizations") {
        const body = await readBody(request);
        const dashboard = await controlPlane.createOrganization(actor, {
          name: requiredString(body, "name"),
          slug: requiredString(body, "slug")
        });
        sendJson(response, 201, { data: dashboard }, {
          location: `/cloud/v1/organizations/${dashboard.organization.organization_id}`,
          ...headers
        });
        return;
      }

      const organizationId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)$/
      );
      if (method === "GET" && organizationId) {
        sendJson(
          response,
          200,
          { data: await controlPlane.dashboard(actor, organizationId) },
          headers
        );
        return;
      }
      const organizationProjectsId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)\/projects$/
      );
      if (organizationProjectsId && method === "GET") {
        sendJson(response, 200, {
          data: await controlPlane.projects(actor, organizationProjectsId)
        }, headers);
        return;
      }
      if (organizationProjectsId && method === "POST") {
        const body = await readBody(request);
        const project = await controlPlane.createProject(
          actor,
          organizationProjectsId,
          {
            name: requiredString(body, "name"),
            slug: requiredString(body, "slug")
          }
        );
        sendJson(response, 201, { data: project }, {
          location: `/cloud/v1/projects/${project.project_id}`,
          ...headers
        });
        return;
      }
      const organizationMembersId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)\/members$/
      );
      if (organizationMembersId && method === "GET") {
        sendJson(response, 200, {
          data: await controlPlane.members(actor, organizationMembersId)
        }, headers);
        return;
      }
      if (organizationMembersId && method === "PATCH") {
        const body = await readBody(request);
        const active = body["active"];
        const role = body["role"];
        sendJson(response, 200, {
          data: await controlPlane.updateMember(
            actor,
            organizationMembersId,
            {
              issuer: requiredString(body, "issuer"),
              subject: requiredString(body, "subject"),
              ...(typeof role === "string"
                ? { role: role as Exclude<CloudRole, "owner"> }
                : {}),
              ...(typeof active === "boolean" ? { active } : {})
            }
          )
        }, headers);
        return;
      }
      const organizationInvitationsId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)\/invitations$/
      );
      if (organizationInvitationsId && method === "POST") {
        const body = await readBody(request);
        const result = await controlPlane.inviteMember(
          actor,
          organizationInvitationsId,
          {
            email: requiredString(body, "email"),
            role: requiredString(body, "role") as Exclude<CloudRole, "owner">,
            ...(typeof body["expires_at"] === "string"
              ? { expires_at: body["expires_at"] }
              : {})
          }
        );
        sendJson(response, 201, { data: result }, {
          location: `/cloud/v1/invitations/${result.invitation.invitation_id}`,
          ...headers
        });
        return;
      }
      if (method === "POST" && path === "/cloud/v1/invitations/accept") {
        const body = await readBody(request);
        sendJson(response, 200, {
          data: await controlPlane.acceptInvitation(
            actor,
            requiredString(body, "secret")
          )
        }, headers);
        return;
      }

      const projectEnvironmentsId = pathId(
        path,
        /^\/cloud\/v1\/projects\/([^/]+)\/environments$/
      );
      if (projectEnvironmentsId && method === "GET") {
        sendJson(response, 200, {
          data: await controlPlane.environments(actor, projectEnvironmentsId)
        }, headers);
        return;
      }
      if (projectEnvironmentsId && method === "POST") {
        const body = await readBody(request);
        const environment = await controlPlane.createEnvironment(
          actor,
          projectEnvironmentsId,
          {
            name: requiredString(body, "name"),
            slug: requiredString(body, "slug"),
            kind: requiredString(body, "kind") as EnvironmentKind,
            region: requiredString(body, "region"),
            program_id: requiredString(body, "program_id")
          }
        );
        sendJson(response, 201, { data: environment }, {
          location: `/cloud/v1/environments/${environment.environment_id}`,
          ...headers
        });
        return;
      }

      const environmentAttachId = pathId(
        path,
        /^\/cloud\/v1\/environments\/([^/]+)\/attach$/
      );
      if (environmentAttachId && method === "POST") {
        const body = await readBody(request);
        const environment = await controlPlane.attachEnvironment(actor, environmentAttachId, {
          endpoint_url: requiredString(body, "endpoint_url"),
          api_key: requiredString(body, "api_key")
        });
        sendJson(response, 200, { data: environment }, headers);
        return;
      }

      const environmentRotateId = pathId(
        path,
        /^\/cloud\/v1\/environments\/([^/]+)\/credentials\/rotate$/
      );
      if (environmentRotateId && method === "POST") {
        const body = await readBody(request);
        const overlap = body["overlap_seconds"];
        if (overlap !== undefined && typeof overlap !== "number") {
          throw new CloudError(422, "validation_failed", "overlap_seconds must be a number");
        }
        sendJson(response, 200, {
          data: await controlPlane.rotateEnvironmentCredentials(
            actor,
            environmentRotateId,
            options.rotateEnvironmentCredentials,
            typeof overlap === "number" ? { overlap_seconds: overlap } : {}
          )
        }, headers);
        return;
      }

      const environmentUsageEventsId = pathId(
        path,
        /^\/cloud\/v1\/environments\/([^/]+)\/usage-events$/
      );
      if (environmentUsageEventsId && method === "POST") {
        const body = await readBody(request);
        const quantity = body["quantity"];
        const result = await controlPlane.recordUsage(
          actor,
          environmentUsageEventsId,
          {
            metric: requiredString(body, "metric") as UsageMetric,
            quantity: typeof quantity === "number" ? quantity : Number.NaN,
            idempotency_key: requiredString(body, "idempotency_key"),
            ...(typeof body["occurred_at"] === "string"
              ? { occurred_at: body["occurred_at"] }
              : {}),
            ...(body["metadata"] &&
              typeof body["metadata"] === "object" &&
              !Array.isArray(body["metadata"])
              ? { metadata: body["metadata"] as Record<string, unknown> }
              : {})
          }
        );
        sendJson(response, result.duplicate ? 200 : 201, { data: result }, headers);
        return;
      }
      const environmentUsageId = pathId(
        path,
        /^\/cloud\/v1\/environments\/([^/]+)\/usage$/
      );
      if (environmentUsageId && method === "GET") {
        const at = url.searchParams.get("at");
        const date = at ? new Date(at) : undefined;
        if (date && !Number.isFinite(date.getTime())) {
          throw new CloudError(422, "validation_failed", "at must be an ISO timestamp");
        }
        sendJson(response, 200, {
          data: await controlPlane.usage(actor, environmentUsageId, date)
        }, headers);
        return;
      }

      throw new CloudError(404, "not_found", "Cloud API route was not found");
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof CloudError) {
        if (error.status === 401) response.setHeader("www-authenticate", "Bearer");
        sendProblem(response, error, headers);
        return;
      }
      console.error("[lip-cloud] request failed", error);
      sendProblem(
        response,
        new CloudError(500, "internal_error", "Cloud control plane request failed"),
        headers
      );
    });
  });
}

export async function startCloudServer(
  controlPlane: CloudControlPlane,
  options: CloudServerOptions & { host?: string; port?: number }
): Promise<RunningCloudServer> {
  const server = createCloudServer(controlPlane, options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3220;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
