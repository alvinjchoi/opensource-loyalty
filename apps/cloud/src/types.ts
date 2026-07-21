export type CloudRole = "owner" | "admin" | "developer" | "billing" | "viewer";
export type EnvironmentKind = "development" | "staging" | "production";
export type ProvisioningStatus = "pending" | "provisioning" | "ready" | "failed" | "suspended";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";
export type UsageMetric =
  | "monthly_active_members"
  | "loyalty_transactions"
  | "messages";

export interface CloudPrincipal {
  issuer: string;
  subject: string;
  email?: string;
}

export class CloudRepositoryConflictError extends Error {
  public constructor(message = "Cloud resource already exists") {
    super(message);
    this.name = "CloudRepositoryConflictError";
  }
}

export interface CloudOrganization {
  organization_id: string;
  slug: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CloudOrganizationMembership {
  organization_id: string;
  issuer: string;
  subject: string;
  email?: string;
  role: CloudRole;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CloudOrganizationInvitation {
  invitation_id: string;
  organization_id: string;
  email: string;
  role: Exclude<CloudRole, "owner">;
  invited_by: string;
  expires_at: string;
  accepted_at?: string;
  created_at: string;
}

export interface CloudProject {
  project_id: string;
  organization_id: string;
  slug: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CloudEnvironment {
  environment_id: string;
  project_id: string;
  slug: string;
  name: string;
  kind: EnvironmentKind;
  region: string;
  tenant_id: string;
  program_id: string;
  status: ProvisioningStatus;
  status_message?: string;
  api_url?: string;
  admin_url?: string;
  api_key_fingerprint?: string;
  created_at: string;
  updated_at: string;
}

export interface CloudPlan {
  plan_id: string;
  name: string;
  active: boolean;
  monthly_price_minor: number;
  currency: string;
  included_usage: Record<UsageMetric, number>;
  hard_limits: Record<UsageMetric, number>;
  created_at: string;
  updated_at: string;
}

export interface CloudSubscription {
  subscription_id: string;
  organization_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  billing_provider: "manual" | "stripe";
  provider_customer_id?: string;
  provider_subscription_id?: string;
  current_period_start: string;
  current_period_end: string;
  created_at: string;
  updated_at: string;
}

export interface CloudUsageEvent {
  usage_event_id: string;
  environment_id: string;
  metric: UsageMetric;
  quantity: number;
  idempotency_key: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

export interface CloudUsageCounter {
  environment_id: string;
  metric: UsageMetric;
  period_start: string;
  period_end: string;
  quantity: number;
  included: number;
  hard_limit: number;
  remaining: number;
  overage: number;
}

export interface CloudAuditEntry {
  audit_id: string;
  organization_id: string;
  actor_subject: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

export interface CloudProvisioningJob {
  provisioning_job_id: string;
  environment_id: string;
  operation: "create" | "upgrade" | "suspend" | "delete";
  status: "pending" | "running" | "succeeded" | "failed";
  attempts: number;
  available_at: string;
  claimed_by?: string;
  claimed_until?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface CloudProvisioningResult {
  api_url: string;
  admin_url?: string;
}

/**
 * Merchant credential handed back by the control-plane rotation surface
 * (PLA-416). Deliberately excludes the deprecated root runtime key.
 */
export interface RotatedEnvironmentCredentials {
  environment_id: string;
  tenant_id: string;
  program_id: string;
  api_url: string;
  admin_url: string;
  merchant_api_key: string;
  merchant_api_key_id: string;
  rotated_at: string;
}

export interface CloudDashboard {
  organization: CloudOrganization;
  membership: CloudOrganizationMembership;
  subscription: CloudSubscription;
  plan: CloudPlan;
  projects: CloudProject[];
}

export interface CloudRepository {
  migrate(): Promise<void>;
  createOrganization(input: {
    organization: CloudOrganization;
    owner: CloudOrganizationMembership;
    subscription: CloudSubscription;
    audit: CloudAuditEntry;
  }): Promise<void>;
  organizationById(organizationId: string): Promise<CloudOrganization | undefined>;
  organizationBySlug(slug: string): Promise<CloudOrganization | undefined>;
  organizationsForPrincipal(
    issuer: string,
    subject: string
  ): Promise<CloudOrganization[]>;
  membership(
    organizationId: string,
    issuer: string,
    subject: string
  ): Promise<CloudOrganizationMembership | undefined>;
  membershipsForOrganization(
    organizationId: string
  ): Promise<CloudOrganizationMembership[]>;
  updateMembership(input: {
    organizationId: string;
    issuer: string;
    subject: string;
    role?: Exclude<CloudRole, "owner">;
    active?: boolean;
    updatedAt: string;
    audit: CloudAuditEntry;
  }): Promise<CloudOrganizationMembership | undefined>;
  createInvitation(input: {
    invitation: CloudOrganizationInvitation;
    tokenHash: string;
    audit: CloudAuditEntry;
  }): Promise<void>;
  acceptInvitation(input: {
    tokenHash: string;
    principal: CloudPrincipal;
    acceptedAt: string;
    auditId: string;
  }): Promise<
    | { status: "accepted"; membership: CloudOrganizationMembership }
    | { status: "not_found" | "expired" | "email_mismatch" | "already_accepted" }
  >;
  createProject(project: CloudProject, audit: CloudAuditEntry): Promise<void>;
  projectById(projectId: string): Promise<CloudProject | undefined>;
  projectBySlug(
    organizationId: string,
    slug: string
  ): Promise<CloudProject | undefined>;
  projectsForOrganization(organizationId: string): Promise<CloudProject[]>;
  createEnvironment(
    environment: CloudEnvironment,
    audit: CloudAuditEntry
  ): Promise<void>;
  environmentById(environmentId: string): Promise<CloudEnvironment | undefined>;
  environmentBySlug(
    projectId: string,
    slug: string
  ): Promise<CloudEnvironment | undefined>;
  environmentsForProject(projectId: string): Promise<CloudEnvironment[]>;
  attachEnvironment(
    environmentId: string,
    binding: {
      api_url: string;
      admin_url?: string;
      api_key_fingerprint?: string;
      status: ProvisioningStatus;
      status_message?: string;
    }
  ): Promise<CloudEnvironment>;
  plans(): Promise<CloudPlan[]>;
  planById(planId: string): Promise<CloudPlan | undefined>;
  subscriptionForOrganization(
    organizationId: string
  ): Promise<CloudSubscription | undefined>;
  replaceSubscription(
    subscription: CloudSubscription,
    audit: CloudAuditEntry
  ): Promise<void>;
  recordAudit(entry: CloudAuditEntry): Promise<void>;
  recordUsage(input: {
    organizationId: string;
    event: CloudUsageEvent;
    periodStart: string;
    periodEnd: string;
    hardLimit: number;
  }): Promise<"recorded" | "duplicate" | "limit_exceeded">;
  usageForEnvironment(input: {
    environmentId: string;
    periodStart: string;
    periodEnd: string;
  }): Promise<Array<{ metric: UsageMetric; quantity: number }>>;
  claimProvisioningJob(
    workerId: string,
    leaseSeconds: number
  ): Promise<CloudProvisioningJob | undefined>;
  completeProvisioningJob(
    jobId: string,
    result: CloudProvisioningResult
  ): Promise<void>;
  failProvisioningJob(
    jobId: string,
    message: string,
    retryAt?: string
  ): Promise<void>;
  close(): Promise<void>;
}
