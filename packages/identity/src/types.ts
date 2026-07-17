export interface IdentityProviderPrincipal {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
  claims: Readonly<Record<string, unknown>>;
}

export interface CustomerRecord {
  tenantId: string;
  customerId: string;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ExternalIdentityLink {
  tenantId: string;
  issuer: string;
  subject: string;
  customerId: string;
  linkedAt: string;
}

export interface CustomerMemberLink {
  tenantId: string;
  customerId: string;
  programId: string;
  memberId: string;
  linkedAt: string;
}

export interface ResolveCustomerInput {
  tenantId: string;
  principal: IdentityProviderPrincipal;
  customerId: string;
  now: string;
}

export interface LinkExternalIdentityInput {
  tenantId: string;
  customerId: string;
  principal: IdentityProviderPrincipal;
  now: string;
}

export interface LinkCustomerMemberInput {
  tenantId: string;
  customerId: string;
  programId: string;
  memberId: string;
  now: string;
}

/**
 * Persistence boundary implemented by the application or platform database.
 * Credential material, passwords, sessions, and raw tokens never belong here.
 */
export interface CustomerDirectoryRepository {
  resolveOrCreateCustomer(input: ResolveCustomerInput): Promise<CustomerRecord>;
  customerForIdentity(
    tenantId: string,
    issuer: string,
    subject: string
  ): Promise<CustomerRecord | undefined>;
  linkExternalIdentity(input: LinkExternalIdentityInput): Promise<ExternalIdentityLink>;
  memberLink(
    tenantId: string,
    customerId: string,
    programId: string
  ): Promise<CustomerMemberLink | undefined>;
  memberLinksForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerMemberLink[]>;
  linkMember(input: LinkCustomerMemberInput): Promise<CustomerMemberLink>;
  markCustomerDeleted(
    tenantId: string,
    customerId: string,
    now: string
  ): Promise<CustomerRecord>;
}

export type CustomerIdentityErrorCode =
  | "invalid_configuration"
  | "missing_token"
  | "invalid_token"
  | "invalid_identity"
  | "customer_deleted"
  | "identity_conflict"
  | "member_conflict"
  | "customer_not_found";

export class CustomerIdentityError extends Error {
  public readonly code: CustomerIdentityErrorCode;

  public constructor(code: CustomerIdentityErrorCode, message: string) {
    super(message);
    this.name = "CustomerIdentityError";
    this.code = code;
  }
}
