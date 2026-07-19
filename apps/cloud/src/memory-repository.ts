import {
  CloudRepositoryConflictError,
  type CloudAuditEntry,
  type CloudEnvironment,
  type CloudOrganization,
  type CloudOrganizationInvitation,
  type CloudOrganizationMembership,
  type CloudPlan,
  type CloudPrincipal,
  type CloudProvisioningJob,
  type CloudProvisioningResult,
  type CloudProject,
  type CloudRepository,
  type CloudSubscription,
  type CloudUsageEvent,
  type ProvisioningStatus,
  type UsageMetric
} from "./types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

const timestamp = "2026-01-01T00:00:00.000Z";
const defaultPlans: CloudPlan[] = [
  {
    plan_id: "free",
    name: "Free",
    active: true,
    monthly_price_minor: 0,
    currency: "USD",
    included_usage: {
      monthly_active_members: 100,
      loyalty_transactions: 1_000,
      messages: 100
    },
    hard_limits: {
      monthly_active_members: 100,
      loyalty_transactions: 1_000,
      messages: 100
    },
    created_at: timestamp,
    updated_at: timestamp
  },
  {
    plan_id: "pro",
    name: "Pro",
    active: true,
    monthly_price_minor: 9_900,
    currency: "USD",
    included_usage: {
      monthly_active_members: 5_000,
      loyalty_transactions: 50_000,
      messages: 10_000
    },
    hard_limits: {
      monthly_active_members: 10_000,
      loyalty_transactions: 100_000,
      messages: 25_000
    },
    created_at: timestamp,
    updated_at: timestamp
  }
];

export class MemoryCloudRepository implements CloudRepository {
  private readonly organizations = new Map<string, CloudOrganization>();
  private readonly memberships = new Map<string, CloudOrganizationMembership>();
  private readonly invitations = new Map<
    string,
    { invitation: CloudOrganizationInvitation; tokenHash: string }
  >();
  private readonly projects = new Map<string, CloudProject>();
  private readonly environments = new Map<string, CloudEnvironment>();
  private readonly subscriptions = new Map<string, CloudSubscription>();
  private readonly provisioningJobs = new Map<string, CloudProvisioningJob>();
  private readonly planRecords = new Map(defaultPlans.map((plan) => [plan.plan_id, plan]));
  private readonly usageEvents = new Set<string>();
  private readonly usageCounters = new Map<string, number>();
  private readonly audit: CloudAuditEntry[] = [];

  public async migrate(): Promise<void> {}

  public async createOrganization(input: {
    organization: CloudOrganization;
    owner: CloudOrganizationMembership;
    subscription: CloudSubscription;
    audit: CloudAuditEntry;
  }): Promise<void> {
    if (
      await this.organizationBySlug(input.organization.slug) ||
      this.organizations.has(input.organization.organization_id)
    ) {
      throw new CloudRepositoryConflictError("Organization already exists");
    }
    this.organizations.set(
      input.organization.organization_id,
      clone(input.organization)
    );
    this.memberships.set(
      this.membershipKey(
        input.owner.organization_id,
        input.owner.issuer,
        input.owner.subject
      ),
      clone(input.owner)
    );
    this.subscriptions.set(
      input.subscription.organization_id,
      clone(input.subscription)
    );
    this.audit.unshift(clone(input.audit));
  }

  public async organizationById(
    organizationId: string
  ): Promise<CloudOrganization | undefined> {
    const value = this.organizations.get(organizationId);
    return value ? clone(value) : undefined;
  }

  public async organizationBySlug(
    slug: string
  ): Promise<CloudOrganization | undefined> {
    const value = [...this.organizations.values()].find(
      (organization) => organization.slug === slug
    );
    return value ? clone(value) : undefined;
  }

  public async organizationsForPrincipal(
    issuer: string,
    subject: string
  ): Promise<CloudOrganization[]> {
    const organizationIds = new Set(
      [...this.memberships.values()]
        .filter((membership) =>
          membership.issuer === issuer &&
          membership.subject === subject &&
          membership.active
        )
        .map((membership) => membership.organization_id)
    );
    return [...this.organizations.values()]
      .filter((organization) => organizationIds.has(organization.organization_id))
      .map(clone);
  }

  public async membership(
    organizationId: string,
    issuer: string,
    subject: string
  ): Promise<CloudOrganizationMembership | undefined> {
    const value = this.memberships.get(
      this.membershipKey(organizationId, issuer, subject)
    );
    return value ? clone(value) : undefined;
  }

  public async membershipsForOrganization(
    organizationId: string
  ): Promise<CloudOrganizationMembership[]> {
    return [...this.memberships.values()]
      .filter((membership) => membership.organization_id === organizationId)
      .map(clone);
  }

  public async updateMembership(input: {
    organizationId: string;
    issuer: string;
    subject: string;
    role?: Exclude<CloudOrganizationMembership["role"], "owner">;
    active?: boolean;
    updatedAt: string;
    audit: CloudAuditEntry;
  }): Promise<CloudOrganizationMembership | undefined> {
    const key = this.membershipKey(
      input.organizationId,
      input.issuer,
      input.subject
    );
    const value = this.memberships.get(key);
    if (!value) return undefined;
    if (input.role) value.role = input.role;
    if (input.active !== undefined) value.active = input.active;
    value.updated_at = input.updatedAt;
    this.audit.unshift(clone(input.audit));
    return clone(value);
  }

  public async createInvitation(input: {
    invitation: CloudOrganizationInvitation;
    tokenHash: string;
    audit: CloudAuditEntry;
  }): Promise<void> {
    const duplicate = [...this.invitations.values()].find(
      ({ invitation }) =>
        invitation.organization_id === input.invitation.organization_id &&
        invitation.email === input.invitation.email &&
        !invitation.accepted_at
    );
    if (duplicate) {
      throw new CloudRepositoryConflictError("An active invitation already exists");
    }
    this.invitations.set(input.tokenHash, {
      invitation: clone(input.invitation),
      tokenHash: input.tokenHash
    });
    this.audit.unshift(clone(input.audit));
  }

  public async acceptInvitation(input: {
    tokenHash: string;
    principal: CloudPrincipal;
    acceptedAt: string;
    auditId: string;
  }): Promise<
    | { status: "accepted"; membership: CloudOrganizationMembership }
    | { status: "not_found" | "expired" | "email_mismatch" | "already_accepted" }
  > {
    const stored = this.invitations.get(input.tokenHash);
    if (!stored) return { status: "not_found" };
    if (stored.invitation.accepted_at) return { status: "already_accepted" };
    if (Date.parse(stored.invitation.expires_at) <= Date.parse(input.acceptedAt)) {
      return { status: "expired" };
    }
    if (stored.invitation.email !== input.principal.email?.toLowerCase()) {
      return { status: "email_mismatch" };
    }
    const membership: CloudOrganizationMembership = {
      organization_id: stored.invitation.organization_id,
      issuer: input.principal.issuer,
      subject: input.principal.subject,
      email: stored.invitation.email,
      role: stored.invitation.role,
      active: true,
      created_at: input.acceptedAt,
      updated_at: input.acceptedAt
    };
    this.memberships.set(
      this.membershipKey(
        membership.organization_id,
        membership.issuer,
        membership.subject
      ),
      membership
    );
    stored.invitation.accepted_at = input.acceptedAt;
    this.audit.unshift({
      audit_id: input.auditId,
      organization_id: membership.organization_id,
      actor_subject: input.principal.subject,
      action: "cloud.organization.invitation.accepted",
      resource_type: "organization_membership",
      resource_id: input.principal.subject,
      occurred_at: input.acceptedAt,
      metadata: { issuer: input.principal.issuer, email: membership.email }
    });
    return { status: "accepted", membership: clone(membership) };
  }

  public async createProject(
    project: CloudProject,
    audit: CloudAuditEntry
  ): Promise<void> {
    if (
      this.projects.has(project.project_id) ||
      await this.projectBySlug(project.organization_id, project.slug)
    ) {
      throw new CloudRepositoryConflictError("Project already exists");
    }
    this.projects.set(project.project_id, clone(project));
    this.audit.unshift(clone(audit));
  }

  public async projectById(projectId: string): Promise<CloudProject | undefined> {
    const value = this.projects.get(projectId);
    return value ? clone(value) : undefined;
  }

  public async projectBySlug(
    organizationId: string,
    slug: string
  ): Promise<CloudProject | undefined> {
    const value = [...this.projects.values()].find(
      (project) =>
        project.organization_id === organizationId &&
        project.slug === slug
    );
    return value ? clone(value) : undefined;
  }

  public async projectsForOrganization(
    organizationId: string
  ): Promise<CloudProject[]> {
    return [...this.projects.values()]
      .filter((project) => project.organization_id === organizationId)
      .map(clone);
  }

  public async createEnvironment(
    environment: CloudEnvironment,
    audit: CloudAuditEntry
  ): Promise<void> {
    if (
      this.environments.has(environment.environment_id) ||
      await this.environmentBySlug(environment.project_id, environment.slug)
    ) {
      throw new CloudRepositoryConflictError("Environment already exists");
    }
    this.environments.set(environment.environment_id, clone(environment));
    const job: CloudProvisioningJob = {
      provisioning_job_id: `provision_${environment.environment_id}`,
      environment_id: environment.environment_id,
      operation: "create",
      status: "pending",
      attempts: 0,
      available_at: environment.created_at,
      created_at: environment.created_at,
      updated_at: environment.updated_at
    };
    this.provisioningJobs.set(job.provisioning_job_id, job);
    this.audit.unshift(clone(audit));
  }

  public async environmentById(
    environmentId: string
  ): Promise<CloudEnvironment | undefined> {
    const value = this.environments.get(environmentId);
    return value ? clone(value) : undefined;
  }

  public async environmentBySlug(
    projectId: string,
    slug: string
  ): Promise<CloudEnvironment | undefined> {
    const value = [...this.environments.values()].find(
      (environment) =>
        environment.project_id === projectId &&
        environment.slug === slug
    );
    return value ? clone(value) : undefined;
  }

  public async environmentsForProject(projectId: string): Promise<CloudEnvironment[]> {
    return [...this.environments.values()]
      .filter((environment) => environment.project_id === projectId)
      .map(clone);
  }

  public async attachEnvironment(
    environmentId: string,
    binding: {
      api_url: string;
      admin_url?: string;
      api_key_fingerprint?: string;
      status: ProvisioningStatus;
      status_message?: string;
    }
  ): Promise<CloudEnvironment> {
    const existing = this.environments.get(environmentId);
    if (!existing) throw new Error(`Environment ${environmentId} was not found`);
    const timestamp = new Date().toISOString();
    const updated: CloudEnvironment = {
      ...existing,
      status: binding.status,
      api_url: binding.api_url,
      updated_at: timestamp
    };
    if (binding.admin_url) updated.admin_url = binding.admin_url;
    else delete updated.admin_url;
    if (binding.api_key_fingerprint) updated.api_key_fingerprint = binding.api_key_fingerprint;
    else delete updated.api_key_fingerprint;
    if (binding.status_message) updated.status_message = binding.status_message;
    else delete updated.status_message;
    this.environments.set(environmentId, clone(updated));
    return clone(updated);
  }

  public async plans(): Promise<CloudPlan[]> {
    return [...this.planRecords.values()].map(clone);
  }

  public async planById(planId: string): Promise<CloudPlan | undefined> {
    const value = this.planRecords.get(planId);
    return value ? clone(value) : undefined;
  }

  public async subscriptionForOrganization(
    organizationId: string
  ): Promise<CloudSubscription | undefined> {
    const value = this.subscriptions.get(organizationId);
    return value ? clone(value) : undefined;
  }

  public async replaceSubscription(
    subscription: CloudSubscription,
    audit: CloudAuditEntry
  ): Promise<void> {
    if (!this.organizations.has(subscription.organization_id)) {
      throw new Error("Subscription organization was not found");
    }
    this.subscriptions.set(subscription.organization_id, clone(subscription));
    this.audit.unshift(clone(audit));
  }

  public async recordAudit(entry: CloudAuditEntry): Promise<void> {
    this.audit.unshift(clone(entry));
  }

  public async recordUsage(input: {
    organizationId: string;
    event: CloudUsageEvent;
    periodStart: string;
    periodEnd: string;
    hardLimit: number;
  }): Promise<"recorded" | "duplicate" | "limit_exceeded"> {
    const eventKey = [
      input.event.environment_id,
      input.event.metric,
      input.event.idempotency_key
    ].join(":");
    if (this.usageEvents.has(eventKey)) return "duplicate";
    const counterKey = this.counterKey(
      input.event.environment_id,
      input.event.metric,
      input.periodStart,
      input.periodEnd
    );
    const quantity = this.usageCounters.get(counterKey) ?? 0;
    if (quantity + input.event.quantity > input.hardLimit) {
      return "limit_exceeded";
    }
    this.usageEvents.add(eventKey);
    this.usageCounters.set(counterKey, quantity + input.event.quantity);
    return "recorded";
  }

  public async usageForEnvironment(input: {
    environmentId: string;
    periodStart: string;
    periodEnd: string;
  }): Promise<Array<{ metric: UsageMetric; quantity: number }>> {
    const metrics: UsageMetric[] = [
      "monthly_active_members",
      "loyalty_transactions",
      "messages"
    ];
    return metrics.flatMap((metric) => {
      const quantity = this.usageCounters.get(
        this.counterKey(
          input.environmentId,
          metric,
          input.periodStart,
          input.periodEnd
        )
      );
      return quantity === undefined ? [] : [{ metric, quantity }];
    });
  }

  public async claimProvisioningJob(
    workerId: string,
    leaseSeconds: number
  ): Promise<CloudProvisioningJob | undefined> {
    if (!workerId.trim() || leaseSeconds < 5) {
      throw new Error("Provisioning worker id and a lease of at least 5 seconds are required");
    }
    const job = [...this.provisioningJobs.values()].find(
      (candidate) =>
        candidate.status === "pending" ||
        (
          candidate.status === "running" &&
          Boolean(
            candidate.claimed_until &&
            Date.parse(candidate.claimed_until) < Date.now()
          )
        )
    );
    if (!job) return undefined;
    const timestamp = new Date().toISOString();
    job.status = "running";
    job.attempts += 1;
    job.claimed_by = workerId;
    job.claimed_until = new Date(Date.now() + leaseSeconds * 1_000).toISOString();
    job.updated_at = timestamp;
    const environment = this.environments.get(job.environment_id);
    if (environment) {
      environment.status = "provisioning";
      environment.updated_at = timestamp;
      delete environment.status_message;
    }
    return clone(job);
  }

  public async completeProvisioningJob(
    jobId: string,
    result: CloudProvisioningResult
  ): Promise<void> {
    const job = this.provisioningJobs.get(jobId);
    if (!job || job.status !== "running") {
      throw new Error("Running provisioning job was not found");
    }
    const timestamp = new Date().toISOString();
    job.status = "succeeded";
    job.updated_at = timestamp;
    delete job.claimed_by;
    delete job.claimed_until;
    delete job.last_error;
    const environment = this.environments.get(job.environment_id);
    if (!environment) throw new Error("Provisioning environment was not found");
    environment.status = "ready";
    environment.api_url = result.api_url;
    if (result.admin_url) environment.admin_url = result.admin_url;
    environment.updated_at = timestamp;
    delete environment.status_message;
  }

  public async failProvisioningJob(
    jobId: string,
    message: string,
    retryAt?: string
  ): Promise<void> {
    const job = this.provisioningJobs.get(jobId);
    if (!job || job.status !== "running") {
      throw new Error("Running provisioning job was not found");
    }
    const exhausted = job.attempts >= 5 || !retryAt;
    const timestamp = new Date().toISOString();
    job.status = exhausted ? "failed" : "pending";
    job.last_error = message;
    job.updated_at = timestamp;
    if (retryAt) job.available_at = retryAt;
    delete job.claimed_by;
    delete job.claimed_until;
    const environment = this.environments.get(job.environment_id);
    if (environment) {
      environment.status = exhausted ? "failed" : "pending";
      environment.status_message = message;
      environment.updated_at = timestamp;
    }
  }

  public async close(): Promise<void> {}

  private membershipKey(
    organizationId: string,
    issuer: string,
    subject: string
  ): string {
    return `${organizationId}:${issuer}:${subject}`;
  }

  private counterKey(
    environmentId: string,
    metric: UsageMetric,
    periodStart: string,
    periodEnd: string
  ): string {
    return `${environmentId}:${metric}:${periodStart}:${periodEnd}`;
  }
}
