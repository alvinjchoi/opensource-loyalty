import type {
  CloudEnvironment,
  CloudOrganization,
  CloudProject,
  EnvironmentKind,
  ProvisioningStatus
} from "./types.js";

/**
 * HTTP client for onboarding one brand (= one tenant) onto the shared LIP
 * cluster through the existing control-plane API. It is a thin wrapper over
 * `POST /cloud/v1/organizations`, `POST .../projects`,
 * `POST .../environments`, and the environment list endpoint used to poll
 * provisioning status. It creates nothing the API cannot already create.
 *
 * Authentication boundary (PLA-416): the control plane is called with the
 * shared trusted-gateway key (`LIP_CLOUD_API_KEY`) plus an operator subject.
 * Tenant-scoped API keys are not implemented yet; the merchant data-plane key
 * generated during provisioning is written server-side to
 * `<LIP_CLOUD_DATA_DIR>/<environment_id>.credentials.json` and is NOT
 * returned by any API. Until PLA-416 lands, operators must read that file on
 * the data-plane host to hand the key to the consuming BFF.
 */
export interface TenantOnboardingTarget {
  /** Base URL of the control plane, e.g. https://lip-cloud.internal:3220 */
  cloudUrl: string;
  /** Shared trusted-gateway key (`LIP_CLOUD_API_KEY`). */
  apiKey: string;
  /** Stable identity subject recorded as the acting operator. */
  subject: string;
  /** Optional normalized operator email. */
  email?: string;
}

export interface TenantOnboardingRequest {
  organization: { name: string; slug: string };
  project: { name: string; slug: string };
  environment: {
    name: string;
    slug: string;
    kind: EnvironmentKind;
    region: string;
    programId: string;
  };
  /** Provisioning-status polling; defaults: 120s timeout, 2s interval. */
  poll?: { timeoutMs?: number; intervalMs?: number };
}

export interface TenantOnboardingResult {
  organization_id: string;
  project_id: string;
  environment_id: string;
  tenant_id: string;
  program_id: string;
  status: ProvisioningStatus;
  api_url?: string;
  admin_url?: string;
  status_message?: string;
  /** True when polling stopped while the environment was still pending. */
  timed_out: boolean;
  /** Which resources this run created (false = reused an existing slug). */
  created: { organization: boolean; project: boolean; environment: boolean };
}

export class TenantOnboardingError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TenantOnboardingError";
    this.status = status;
    this.code = code;
  }
}

interface ProblemBody {
  code?: string;
  detail?: string;
  title?: string;
}

function headers(target: TenantOnboardingTarget): Record<string, string> {
  return {
    authorization: `Bearer ${target.apiKey}`,
    "content-type": "application/json",
    "x-lip-cloud-subject": target.subject,
    ...(target.email ? { "x-lip-cloud-email": target.email } : {})
  };
}

async function call<T>(
  target: TenantOnboardingTarget,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const base = target.cloudUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: headers(target),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = (await response.json().catch(() => ({}))) as
    | { data?: T }
    | ProblemBody;
  if (!response.ok) {
    const problem = payload as ProblemBody;
    throw new TenantOnboardingError(
      response.status,
      problem.code ?? "request_failed",
      problem.detail ?? problem.title ?? `${method} ${path} failed with ${response.status}`
    );
  }
  return (payload as { data: T }).data;
}

function isSlugConflict(error: unknown): error is TenantOnboardingError {
  return error instanceof TenantOnboardingError &&
    error.status === 409 &&
    error.code === "slug_conflict";
}

async function ensureOrganization(
  target: TenantOnboardingTarget,
  input: { name: string; slug: string }
): Promise<{ organization: CloudOrganization; created: boolean }> {
  try {
    const dashboard = await call<{ organization: CloudOrganization }>(
      target,
      "POST",
      "/cloud/v1/organizations",
      input
    );
    return { organization: dashboard.organization, created: true };
  } catch (error) {
    if (!isSlugConflict(error)) throw error;
    const organizations = await call<CloudOrganization[]>(target, "GET", "/cloud/v1/organizations");
    const existing = organizations.find((candidate) => candidate.slug === input.slug);
    if (!existing) {
      throw new TenantOnboardingError(
        409,
        "slug_owned_elsewhere",
        `Organization slug ${input.slug} exists but is not visible to ${target.subject}; use a different slug or the owning subject`
      );
    }
    return { organization: existing, created: false };
  }
}

async function ensureProject(
  target: TenantOnboardingTarget,
  organizationId: string,
  input: { name: string; slug: string }
): Promise<{ project: CloudProject; created: boolean }> {
  const path = `/cloud/v1/organizations/${organizationId}/projects`;
  try {
    return { project: await call<CloudProject>(target, "POST", path, input), created: true };
  } catch (error) {
    if (!isSlugConflict(error)) throw error;
    const projects = await call<CloudProject[]>(target, "GET", path);
    const existing = projects.find((candidate) => candidate.slug === input.slug);
    if (!existing) {
      throw new TenantOnboardingError(409, "slug_conflict", `Project slug ${input.slug} conflicts but was not found`);
    }
    return { project: existing, created: false };
  }
}

async function ensureEnvironment(
  target: TenantOnboardingTarget,
  projectId: string,
  input: TenantOnboardingRequest["environment"]
): Promise<{ environment: CloudEnvironment; created: boolean }> {
  const path = `/cloud/v1/projects/${projectId}/environments`;
  try {
    const environment = await call<CloudEnvironment>(target, "POST", path, {
      name: input.name,
      slug: input.slug,
      kind: input.kind,
      region: input.region,
      program_id: input.programId
    });
    return { environment, created: true };
  } catch (error) {
    if (!isSlugConflict(error)) throw error;
    const environments = await call<CloudEnvironment[]>(target, "GET", path);
    const existing = environments.find((candidate) => candidate.slug === input.slug);
    if (!existing) {
      throw new TenantOnboardingError(409, "slug_conflict", `Environment slug ${input.slug} conflicts but was not found`);
    }
    if (existing.program_id !== input.programId) {
      throw new TenantOnboardingError(
        409,
        "program_mismatch",
        `Environment ${existing.environment_id} serves program ${existing.program_id}, not ${input.programId}`
      );
    }
    return { environment: existing, created: false };
  }
}

async function pollEnvironment(
  target: TenantOnboardingTarget,
  projectId: string,
  environmentId: string,
  poll: { timeoutMs: number; intervalMs: number }
): Promise<{ environment: CloudEnvironment; timedOut: boolean }> {
  const deadline = Date.now() + poll.timeoutMs;
  for (;;) {
    const environments = await call<CloudEnvironment[]>(
      target,
      "GET",
      `/cloud/v1/projects/${projectId}/environments`
    );
    const environment = environments.find(
      (candidate) => candidate.environment_id === environmentId
    );
    if (!environment) {
      throw new TenantOnboardingError(404, "environment_missing", `Environment ${environmentId} disappeared during polling`);
    }
    const settled = environment.status !== "pending" && environment.status !== "provisioning";
    if (settled) return { environment, timedOut: false };
    if (Date.now() >= deadline) return { environment, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, poll.intervalMs));
  }
}

/**
 * Provisions (or idempotently re-resolves) one tenant on the shared cluster:
 * organization → project → environment, then waits for the control-plane
 * provisioning worker to mark the environment `ready`.
 *
 * The returned `tenant_id` is the row scope every engine table uses for this
 * brand. The merchant API key is not part of the result — see the class-level
 * note on the PLA-416 boundary.
 */
export async function provisionTenant(
  target: TenantOnboardingTarget,
  request: TenantOnboardingRequest
): Promise<TenantOnboardingResult> {
  if (!target.cloudUrl.trim()) throw new Error("A control-plane URL is required");
  if (!target.apiKey.trim()) throw new Error("A control-plane API key is required");
  if (!target.subject.trim()) throw new Error("An operator subject is required");

  const { organization, created: organizationCreated } = await ensureOrganization(
    target,
    request.organization
  );
  const { project, created: projectCreated } = await ensureProject(
    target,
    organization.organization_id,
    request.project
  );
  const { environment: initial, created: environmentCreated } = await ensureEnvironment(
    target,
    project.project_id,
    request.environment
  );
  const { environment, timedOut } = await pollEnvironment(
    target,
    project.project_id,
    initial.environment_id,
    {
      timeoutMs: request.poll?.timeoutMs ?? 120_000,
      intervalMs: request.poll?.intervalMs ?? 2_000
    }
  );

  return {
    organization_id: organization.organization_id,
    project_id: project.project_id,
    environment_id: environment.environment_id,
    tenant_id: environment.tenant_id,
    program_id: environment.program_id,
    status: environment.status,
    ...(environment.api_url ? { api_url: environment.api_url } : {}),
    ...(environment.admin_url ? { admin_url: environment.admin_url } : {}),
    ...(environment.status_message ? { status_message: environment.status_message } : {}),
    timed_out: timedOut,
    created: {
      organization: organizationCreated,
      project: projectCreated,
      environment: environmentCreated
    }
  };
}
