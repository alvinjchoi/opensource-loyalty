import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RemoteEnvironmentAttacher } from "./remote-attach.js";
import { CloudRepositoryConflictError } from "./types.js";
import type {
  CloudDashboard,
  CloudAuditEntry,
  CloudEnvironment,
  CloudOrganization,
  CloudOrganizationInvitation,
  CloudOrganizationMembership,
  CloudPlan,
  CloudPrincipal,
  CloudProject,
  CloudRepository,
  CloudRole,
  CloudSubscription,
  CloudUsageCounter,
  CloudUsageEvent,
  EnvironmentKind,
  RotatedEnvironmentCredentials,
  UsageMetric
} from "./types.js";

const usageMetrics: UsageMetric[] = [
  "monthly_active_members",
  "loyalty_transactions",
  "messages"
];
const environmentKinds: EnvironmentKind[] = [
  "development",
  "staging",
  "production"
];
const managementRoles: CloudRole[] = ["owner", "admin"];
const billingRoles: CloudRole[] = ["owner", "admin", "billing"];

export class CloudError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CloudError";
    this.status = status;
    this.code = code;
  }
}

export interface CloudControlPlaneOptions {
  repository: CloudRepository;
  regions?: string[];
  defaultPlanId?: string;
  now?: () => Date;
  attacher?: RemoteEnvironmentAttacher;
}

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function assertSlug(value: string, label: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug)) {
    throw new CloudError(
      422,
      "validation_failed",
      `${label} slug must contain 3-63 lowercase letters, numbers, or hyphens`
    );
  }
  return slug;
}

function assertName(value: string, label: string): string {
  const name = value.trim();
  if (name.length < 2 || name.length > 120) {
    throw new CloudError(
      422,
      "validation_failed",
      `${label} name must contain 2-120 characters`
    );
  }
  return name;
}

function monthPeriod(date: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function defaultSubscriptionPeriod(date: Date): { start: string; end: string } {
  const end = new Date(date);
  end.setUTCDate(end.getUTCDate() + 30);
  return { start: date.toISOString(), end: end.toISOString() };
}

export class CloudControlPlane {
  private readonly repository: CloudRepository;
  private readonly regions: Set<string>;
  private readonly defaultPlanId: string;
  private readonly clock: () => Date;
  private readonly attacher: RemoteEnvironmentAttacher;

  public constructor(options: CloudControlPlaneOptions) {
    this.repository = options.repository;
    this.regions = new Set(options.regions ?? ["us-east-1"]);
    if (this.regions.size === 0) throw new Error("At least one Cloud region is required");
    this.defaultPlanId = options.defaultPlanId ?? "free";
    this.clock = options.now ?? (() => new Date());
    this.attacher = options.attacher ?? new RemoteEnvironmentAttacher();
  }

  public async migrate(): Promise<void> {
    await this.repository.migrate();
  }

  public async createOrganization(
    principal: CloudPrincipal,
    input: { name: string; slug: string }
  ): Promise<CloudDashboard> {
    this.assertPrincipal(principal);
    const slug = assertSlug(input.slug, "Organization");
    if (await this.repository.organizationBySlug(slug)) {
      throw new CloudError(409, "slug_conflict", "Organization slug is already in use");
    }
    const plan = await this.requiredPlan(this.defaultPlanId);
    const timestamp = this.clock().toISOString();
    const organization: CloudOrganization = {
      organization_id: identifier("org"),
      slug,
      name: assertName(input.name, "Organization"),
      created_at: timestamp,
      updated_at: timestamp
    };
    const owner: CloudOrganizationMembership = {
      organization_id: organization.organization_id,
      issuer: principal.issuer,
      subject: principal.subject,
      role: "owner",
      active: true,
      created_at: timestamp,
      updated_at: timestamp,
      ...(principal.email ? { email: principal.email.trim().toLowerCase() } : {})
    };
    const period = defaultSubscriptionPeriod(this.clock());
    const subscription: CloudSubscription = {
      subscription_id: identifier("sub"),
      organization_id: organization.organization_id,
      plan_id: plan.plan_id,
      status: "active",
      billing_provider: "manual",
      current_period_start: period.start,
      current_period_end: period.end,
      created_at: timestamp,
      updated_at: timestamp
    };
    try {
      await this.repository.createOrganization({
        organization,
        owner,
        subscription,
        audit: this.audit(
          organization.organization_id,
          principal,
          "cloud.organization.created",
          "organization",
          organization.organization_id,
          timestamp
        )
      });
    } catch (error) {
      if (error instanceof CloudRepositoryConflictError) {
        throw new CloudError(409, "resource_conflict", error.message);
      }
      throw error;
    }
    return {
      organization,
      membership: owner,
      subscription,
      plan,
      projects: []
    };
  }

  public async organizations(principal: CloudPrincipal): Promise<CloudOrganization[]> {
    this.assertPrincipal(principal);
    return this.repository.organizationsForPrincipal(
      principal.issuer,
      principal.subject
    );
  }

  public async members(
    principal: CloudPrincipal,
    organizationId: string
  ): Promise<CloudOrganizationMembership[]> {
    await this.requiredMembership(principal, organizationId);
    return this.repository.membershipsForOrganization(organizationId);
  }

  public async updateMember(
    principal: CloudPrincipal,
    organizationId: string,
    input: {
      issuer: string;
      subject: string;
      role?: Exclude<CloudRole, "owner">;
      active?: boolean;
    }
  ): Promise<CloudOrganizationMembership> {
    await this.requireRole(principal, organizationId, managementRoles);
    if (!input.issuer.trim() || !input.subject.trim()) {
      throw new CloudError(422, "validation_failed", "Member issuer and subject are required");
    }
    if (input.role && !["admin", "developer", "billing", "viewer"].includes(input.role)) {
      throw new CloudError(422, "validation_failed", "Unknown membership role");
    }
    if (input.role === undefined && input.active === undefined) {
      throw new CloudError(422, "validation_failed", "A role or active state is required");
    }
    const target = await this.repository.membership(
      organizationId,
      input.issuer,
      input.subject
    );
    if (!target) throw new CloudError(404, "not_found", "Organization member was not found");
    if (target.role === "owner") {
      throw new CloudError(409, "owner_protected", "Owner membership cannot be changed");
    }
    const updatedAt = this.clock().toISOString();
    const updated = await this.repository.updateMembership({
      organizationId,
      issuer: input.issuer,
      subject: input.subject,
      updatedAt,
      audit: this.audit(
        organizationId,
        principal,
        "cloud.organization.membership.updated",
        "organization_membership",
        input.subject,
        updatedAt,
        {
          issuer: input.issuer,
          ...(input.role ? { role: input.role } : {}),
          ...(input.active !== undefined ? { active: input.active } : {})
        }
      ),
      ...(input.role ? { role: input.role } : {}),
      ...(input.active !== undefined ? { active: input.active } : {})
    });
    if (!updated) throw new CloudError(404, "not_found", "Organization member was not found");
    return updated;
  }

  public async inviteMember(
    principal: CloudPrincipal,
    organizationId: string,
    input: {
      email: string;
      role: Exclude<CloudRole, "owner">;
      expires_at?: string;
    }
  ): Promise<{ invitation: CloudOrganizationInvitation; secret: string }> {
    await this.requireRole(principal, organizationId, managementRoles);
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new CloudError(422, "validation_failed", "A valid invitation email is required");
    }
    if (!["admin", "developer", "billing", "viewer"].includes(input.role)) {
      throw new CloudError(422, "validation_failed", "Unknown invitation role");
    }
    const createdAt = this.clock();
    const expiresAt = input.expires_at
      ? new Date(input.expires_at)
      : new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= createdAt ||
      expiresAt.getTime() > createdAt.getTime() + 30 * 24 * 60 * 60 * 1_000
    ) {
      throw new CloudError(
        422,
        "validation_failed",
        "Invitation expiration must be within the next 30 days"
      );
    }
    const secret = `lip_inv_${randomBytes(32).toString("base64url")}`;
    const invitation: CloudOrganizationInvitation = {
      invitation_id: identifier("invite"),
      organization_id: organizationId,
      email,
      role: input.role,
      invited_by: principal.subject,
      expires_at: expiresAt.toISOString(),
      created_at: createdAt.toISOString()
    };
    try {
      await this.repository.createInvitation({
        invitation,
        tokenHash: hashSecret(secret),
        audit: this.audit(
          organizationId,
          principal,
          "cloud.organization.invitation.created",
          "organization_invitation",
          invitation.invitation_id,
          invitation.created_at,
          { email, role: input.role }
        )
      });
    } catch (error) {
      if (error instanceof CloudRepositoryConflictError) {
        throw new CloudError(409, "invitation_conflict", error.message);
      }
      throw error;
    }
    return { invitation, secret };
  }

  public async acceptInvitation(
    principal: CloudPrincipal,
    secret: string
  ): Promise<CloudOrganizationMembership> {
    this.assertPrincipal(principal);
    if (!principal.email) {
      throw new CloudError(
        422,
        "verified_email_required",
        "A verified email claim is required to accept an invitation"
      );
    }
    if (!secret.startsWith("lip_inv_") || secret.length < 40) {
      throw new CloudError(404, "invitation_not_found", "Invitation was not found");
    }
    const result = await this.repository.acceptInvitation({
      tokenHash: hashSecret(secret),
      principal,
      acceptedAt: this.clock().toISOString(),
      auditId: identifier("audit")
    });
    if (result.status === "accepted") return result.membership;
    const errors = {
      not_found: [404, "invitation_not_found", "Invitation was not found"],
      expired: [410, "invitation_expired", "Invitation has expired"],
      email_mismatch: [403, "invitation_email_mismatch", "Invitation email does not match"],
      already_accepted: [409, "invitation_accepted", "Invitation was already accepted"]
    } as const;
    const [status, code, message] = errors[result.status];
    throw new CloudError(status, code, message);
  }

  public async dashboard(
    principal: CloudPrincipal,
    organizationId: string
  ): Promise<CloudDashboard> {
    const membership = await this.requiredMembership(principal, organizationId);
    const organization = await this.requiredOrganization(organizationId);
    const subscription = await this.repository.subscriptionForOrganization(organizationId);
    if (!subscription) {
      throw new CloudError(409, "subscription_missing", "Organization has no subscription");
    }
    const plan = await this.requiredPlan(subscription.plan_id);
    return {
      organization,
      membership,
      subscription,
      plan,
      projects: await this.repository.projectsForOrganization(organizationId)
    };
  }

  public async createProject(
    principal: CloudPrincipal,
    organizationId: string,
    input: { name: string; slug: string }
  ): Promise<CloudProject> {
    await this.requireRole(principal, organizationId, managementRoles);
    const slug = assertSlug(input.slug, "Project");
    if (await this.repository.projectBySlug(organizationId, slug)) {
      throw new CloudError(409, "slug_conflict", "Project slug is already in use");
    }
    const timestamp = this.clock().toISOString();
    const project: CloudProject = {
      project_id: identifier("project"),
      organization_id: organizationId,
      slug,
      name: assertName(input.name, "Project"),
      created_at: timestamp,
      updated_at: timestamp
    };
    try {
      await this.repository.createProject(
        project,
        this.audit(
          organizationId,
          principal,
          "cloud.project.created",
          "project",
          project.project_id,
          timestamp
        )
      );
    } catch (error) {
      if (error instanceof CloudRepositoryConflictError) {
        throw new CloudError(409, "resource_conflict", error.message);
      }
      throw error;
    }
    return project;
  }

  public async projects(
    principal: CloudPrincipal,
    organizationId: string
  ): Promise<CloudProject[]> {
    await this.requiredMembership(principal, organizationId);
    return this.repository.projectsForOrganization(organizationId);
  }

  public async createEnvironment(
    principal: CloudPrincipal,
    projectId: string,
    input: {
      name: string;
      slug: string;
      kind: EnvironmentKind;
      region: string;
      program_id: string;
    }
  ): Promise<CloudEnvironment> {
    const project = await this.requiredProject(projectId);
    await this.requireRole(principal, project.organization_id, managementRoles);
    const slug = assertSlug(input.slug, "Environment");
    if (await this.repository.environmentBySlug(projectId, slug)) {
      throw new CloudError(409, "slug_conflict", "Environment slug is already in use");
    }
    if (!environmentKinds.includes(input.kind)) {
      throw new CloudError(422, "validation_failed", "Unknown environment kind");
    }
    if (!this.regions.has(input.region)) {
      throw new CloudError(422, "unsupported_region", `Region ${input.region} is unavailable`);
    }
    const programId = input.program_id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(programId)) {
      throw new CloudError(422, "validation_failed", "A valid program_id is required");
    }
    const timestamp = this.clock().toISOString();
    const environment: CloudEnvironment = {
      environment_id: identifier("env"),
      project_id: projectId,
      slug,
      name: assertName(input.name, "Environment"),
      kind: input.kind,
      region: input.region,
      tenant_id: identifier("tenant"),
      program_id: programId,
      status: "pending",
      created_at: timestamp,
      updated_at: timestamp
    };
    try {
      await this.repository.createEnvironment(
        environment,
        this.audit(
          project.organization_id,
          principal,
          "cloud.environment.created",
          "environment",
          environment.environment_id,
          timestamp,
          { region: environment.region, kind: environment.kind }
        )
      );
    } catch (error) {
      if (error instanceof CloudRepositoryConflictError) {
        throw new CloudError(409, "resource_conflict", error.message);
      }
      throw error;
    }
    return environment;
  }

  public async environments(
    principal: CloudPrincipal,
    projectId: string
  ): Promise<CloudEnvironment[]> {
    const project = await this.requiredProject(projectId);
    await this.requiredMembership(principal, project.organization_id);
    return this.repository.environmentsForProject(projectId);
  }

  public async recordUsage(
    principal: CloudPrincipal,
    environmentId: string,
    input: {
      metric: UsageMetric;
      quantity: number;
      idempotency_key: string;
      occurred_at?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ event: CloudUsageEvent; duplicate: boolean }> {
    const environment = await this.requiredEnvironment(environmentId);
    const project = await this.requiredProject(environment.project_id);
    await this.requireRole(principal, project.organization_id, managementRoles);
    if (!usageMetrics.includes(input.metric)) {
      throw new CloudError(422, "validation_failed", "Unknown usage metric");
    }
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
      throw new CloudError(422, "validation_failed", "Usage quantity must be a positive integer");
    }
    const idempotencyKey = input.idempotency_key.trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new CloudError(
        422,
        "validation_failed",
        "Usage idempotency_key must contain 8-200 characters"
      );
    }
    const occurredAt = input.occurred_at
      ? new Date(input.occurred_at)
      : this.clock();
    if (!Number.isFinite(occurredAt.getTime())) {
      throw new CloudError(422, "validation_failed", "occurred_at must be an ISO timestamp");
    }
    const subscription = await this.repository.subscriptionForOrganization(
      project.organization_id
    );
    if (!subscription || !["active", "trialing"].includes(subscription.status)) {
      throw new CloudError(402, "subscription_inactive", "An active subscription is required");
    }
    const plan = await this.requiredPlan(subscription.plan_id);
    const period = monthPeriod(occurredAt);
    const event: CloudUsageEvent = {
      usage_event_id: identifier("usage"),
      environment_id: environmentId,
      metric: input.metric,
      quantity: input.quantity,
      idempotency_key: idempotencyKey,
      occurred_at: occurredAt.toISOString(),
      ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {})
    };
    const result = await this.repository.recordUsage({
      organizationId: project.organization_id,
      event,
      periodStart: period.start,
      periodEnd: period.end,
      hardLimit: plan.hard_limits[input.metric]
    });
    if (result === "limit_exceeded") {
      throw new CloudError(429, "usage_limit_exceeded", `${input.metric} hard limit exceeded`);
    }
    return { event, duplicate: result === "duplicate" };
  }

  /**
   * PLA-416 rotation surface: authorizes the caller as an owner/admin of the
   * environment's organization, delegates minting to the wired data-plane
   * provisioner, audits the rotation, and returns the fresh merchant
   * credential. The deprecated root runtime key is never returned.
   */
  public async rotateEnvironmentCredentials(
    principal: CloudPrincipal,
    environmentId: string,
    rotate?: (environmentId: string) => Promise<{
      environment_id: string;
      tenant_id: string;
      program_id: string;
      api_url: string;
      admin_url: string;
      merchant_api_key: string;
      merchant_api_key_id: string;
    }>
  ): Promise<RotatedEnvironmentCredentials> {
    const environment = await this.requiredEnvironment(environmentId);
    const project = await this.requiredProject(environment.project_id);
    await this.requireRole(principal, project.organization_id, managementRoles);
    if (!rotate) {
      throw new CloudError(
        409,
        "credential_rotation_unavailable",
        "This control plane has no data-plane provisioner wired for credential rotation"
      );
    }
    let rotated;
    try {
      rotated = await rotate(environmentId);
    } catch (error) {
      throw new CloudError(
        409,
        "runtime_unavailable",
        error instanceof Error ? error.message : "Data-plane runtime is unavailable"
      );
    }
    const rotatedAt = this.clock().toISOString();
    await this.repository.recordAudit(this.audit(
      project.organization_id,
      principal,
      "cloud.environment.credentials_rotated",
      "environment",
      environmentId,
      rotatedAt,
      { merchant_api_key_id: rotated.merchant_api_key_id }
    ));
    return {
      environment_id: rotated.environment_id,
      tenant_id: rotated.tenant_id,
      program_id: rotated.program_id,
      api_url: rotated.api_url,
      admin_url: rotated.admin_url,
      merchant_api_key: rotated.merchant_api_key,
      merchant_api_key_id: rotated.merchant_api_key_id,
      rotated_at: rotatedAt
    };
  }

  public async attachEnvironment(
    principal: CloudPrincipal,
    environmentId: string,
    input: { endpoint_url: string; api_key: string }
  ): Promise<CloudEnvironment> {
    const environment = await this.requiredEnvironment(environmentId);
    const project = await this.requiredProject(environment.project_id);
    await this.requireRole(principal, project.organization_id, managementRoles);
    const attachableStatuses = new Set(["pending", "ready", "failed"]);
    if (!attachableStatuses.has(environment.status)) {
      throw new CloudError(
        409,
        "environment_not_attachable",
        `An environment in status ${environment.status} cannot be attached`
      );
    }
    const result = await this.attacher.validate({
      endpoint_url: input.endpoint_url.trim(),
      api_key: input.api_key,
      program_id: environment.program_id
    });
    if (!result.ok) {
      await this.repository.attachEnvironment(environmentId, {
        api_url: input.endpoint_url.trim(),
        status: "failed",
        status_message: result.code
      });
      throw new CloudError(422, result.code, result.message);
    }
    return this.repository.attachEnvironment(environmentId, {
      api_url: result.binding.api_url,
      admin_url: result.binding.admin_url,
      api_key_fingerprint: result.binding.api_key_fingerprint,
      status: "ready"
    });
  }

  public async usage(
    principal: CloudPrincipal,
    environmentId: string,
    at: Date = this.clock()
  ): Promise<CloudUsageCounter[]> {
    const environment = await this.requiredEnvironment(environmentId);
    const project = await this.requiredProject(environment.project_id);
    await this.requireRole(principal, project.organization_id, billingRoles);
    const subscription = await this.repository.subscriptionForOrganization(
      project.organization_id
    );
    if (!subscription) {
      throw new CloudError(409, "subscription_missing", "Organization has no subscription");
    }
    const plan = await this.requiredPlan(subscription.plan_id);
    const period = monthPeriod(at);
    const usage = new Map(
      (await this.repository.usageForEnvironment({
        environmentId,
        periodStart: period.start,
        periodEnd: period.end
      })).map((entry) => [entry.metric, entry.quantity])
    );
    return usageMetrics.map((metric) => {
      const quantity = usage.get(metric) ?? 0;
      const included = plan.included_usage[metric];
      const hardLimit = plan.hard_limits[metric];
      return {
        environment_id: environmentId,
        metric,
        period_start: period.start,
        period_end: period.end,
        quantity,
        included,
        hard_limit: hardLimit,
        remaining: Math.max(0, hardLimit - quantity),
        overage: Math.max(0, quantity - included)
      };
    });
  }

  public async plans(principal: CloudPrincipal): Promise<CloudPlan[]> {
    this.assertPrincipal(principal);
    return this.repository.plans();
  }

  public async close(): Promise<void> {
    await this.repository.close();
  }

  private assertPrincipal(principal: CloudPrincipal): void {
    if (
      !principal.issuer.trim() ||
      principal.issuer.length > 500 ||
      !principal.subject.trim() ||
      principal.subject.length > 200
    ) {
      throw new CloudError(401, "unauthorized", "A valid identity subject is required");
    }
  }

  private async requiredMembership(
    principal: CloudPrincipal,
    organizationId: string
  ): Promise<CloudOrganizationMembership> {
    this.assertPrincipal(principal);
    const membership = await this.repository.membership(
      organizationId,
      principal.issuer,
      principal.subject
    );
    if (!membership?.active) {
      throw new CloudError(404, "not_found", "Organization was not found");
    }
    return membership;
  }

  private async requireRole(
    principal: CloudPrincipal,
    organizationId: string,
    roles: CloudRole[]
  ): Promise<CloudOrganizationMembership> {
    const membership = await this.requiredMembership(principal, organizationId);
    if (!roles.includes(membership.role)) {
      throw new CloudError(403, "forbidden", "Organization role does not permit this action");
    }
    return membership;
  }

  private async requiredOrganization(
    organizationId: string
  ): Promise<CloudOrganization> {
    const organization = await this.repository.organizationById(organizationId);
    if (!organization) throw new CloudError(404, "not_found", "Organization was not found");
    return organization;
  }

  private async requiredProject(projectId: string): Promise<CloudProject> {
    const project = await this.repository.projectById(projectId);
    if (!project) throw new CloudError(404, "not_found", "Project was not found");
    return project;
  }

  private async requiredEnvironment(
    environmentId: string
  ): Promise<CloudEnvironment> {
    const environment = await this.repository.environmentById(environmentId);
    if (!environment) throw new CloudError(404, "not_found", "Environment was not found");
    return environment;
  }

  private async requiredPlan(planId: string): Promise<CloudPlan> {
    const plan = await this.repository.planById(planId);
    if (!plan?.active) throw new CloudError(409, "plan_unavailable", "Cloud plan is unavailable");
    return plan;
  }

  private audit(
    organizationId: string,
    principal: CloudPrincipal,
    action: string,
    resourceType: string,
    resourceId: string,
    occurredAt: string,
    metadata?: Record<string, unknown>
  ): CloudAuditEntry {
    return {
      audit_id: identifier("audit"),
      organization_id: organizationId,
      actor_subject: principal.subject,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      occurred_at: occurredAt,
      ...(metadata ? { metadata } : {})
    };
  }
}
