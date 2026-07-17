export type CustomerProviderKind = "clerk" | "auth0" | "oidc";
export type CustomerStatus = "active" | "deleted";
export type ConsentStatus = "granted" | "denied" | "withdrawn";
export type ProviderDeletionStatus =
  | "deleted"
  | "not_found"
  | "unsupported"
  | "pending";

export interface VerifiedContact {
  value: string;
  verified_at?: string;
}

export interface VerifiedCustomerIdentity {
  provider_id: string;
  provider_kind: CustomerProviderKind;
  tenant_id: string;
  issuer: string;
  subject: string;
  audiences: string[];
  expires_at: string;
  issued_at?: string;
  session_id?: string;
  authorized_party?: string;
  email?: VerifiedContact;
  phone?: VerifiedContact;
}

export interface CustomerIdentityProvider {
  readonly provider_id: string;
  readonly kind: CustomerProviderKind;
  verifySession(input: {
    tenant_id: string;
    token: string;
  }): Promise<VerifiedCustomerIdentity>;
  deleteIdentity(
    identity: CustomerExternalIdentity
  ): Promise<Exclude<ProviderDeletionStatus, "pending">>;
}

export interface CustomerProfile {
  email?: VerifiedContact;
  phone?: VerifiedContact;
  given_name?: string;
  family_name?: string;
  locale?: string;
}

export interface Customer {
  customer_id: string;
  tenant_id: string;
  status: CustomerStatus;
  profile: CustomerProfile;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface CustomerExternalIdentity {
  customer_id: string;
  tenant_id: string;
  provider_id: string;
  provider_kind: CustomerProviderKind;
  issuer: string;
  subject: string;
  active: boolean;
  created_at: string;
  disabled_at?: string;
}

export interface CustomerConsent {
  customer_id: string;
  tenant_id: string;
  purpose: string;
  status: ConsentStatus;
  policy_version: string;
  source: string;
  updated_at: string;
}

export interface CustomerLoyaltyMembership {
  customer_id: string;
  tenant_id: string;
  program_id: string;
  member_id: string;
  enrolled_at: string;
}

export interface CustomerSession {
  active: true;
  customer_id: string;
  tenant_id: string;
  provider_id: string;
  issuer: string;
  audiences: string[];
  expires_at: string;
  session_id?: string;
  authorized_party?: string;
  profile: CustomerProfile;
}

export interface CustomerAccountExport {
  customer: Customer;
  identities: Array<Omit<CustomerExternalIdentity, "subject">>;
  consents: CustomerConsent[];
  loyalty_memberships: CustomerLoyaltyMembership[];
}

export interface CustomerDeletionResult {
  customer_id: string;
  deleted_at: string;
  retained_loyalty_memberships: CustomerLoyaltyMembership[];
  provider_cleanup: Array<{
    provider_id: string;
    status: ProviderDeletionStatus;
  }>;
}

export interface CustomerLoyaltyProvider {
  enroll(input: {
    tenant_id: string;
    program_id: string;
    customer_id: string;
    idempotency_key: string;
  }): Promise<{ member_id: string }>;
}

export class CustomerRepositoryConflictError extends Error {
  public constructor(
    public readonly code:
      | "identity_conflict"
      | "member_conflict"
      | "customer_conflict",
    message: string
  ) {
    super(message);
    this.name = "CustomerRepositoryConflictError";
  }
}

export interface CustomerRepository {
  migrate(): Promise<void>;
  resolveOrCreate(input: {
    customer: Customer;
    identity: CustomerExternalIdentity;
  }): Promise<{
    customer: Customer;
    identity: CustomerExternalIdentity;
    created: boolean;
  }>;
  customerById(
    tenantId: string,
    customerId: string
  ): Promise<Customer | undefined>;
  identitiesForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerExternalIdentity[]>;
  linkIdentity(input: {
    tenantId: string;
    customerId: string;
    identity: CustomerExternalIdentity;
  }): Promise<CustomerExternalIdentity>;
  replaceProfile(input: {
    tenantId: string;
    customerId: string;
    profile: CustomerProfile;
    updatedAt: string;
  }): Promise<Customer | undefined>;
  setConsent(consent: CustomerConsent): Promise<CustomerConsent>;
  consentsForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerConsent[]>;
  bindLoyaltyMembership(
    membership: CustomerLoyaltyMembership
  ): Promise<CustomerLoyaltyMembership>;
  loyaltyMembership(
    tenantId: string,
    customerId: string,
    programId: string
  ): Promise<CustomerLoyaltyMembership | undefined>;
  loyaltyMembershipsForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerLoyaltyMembership[]>;
  deleteCustomer(input: {
    tenantId: string;
    customerId: string;
    deletedAt: string;
  }): Promise<Customer | undefined>;
  close(): Promise<void>;
}
