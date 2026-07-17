import { createHash, randomUUID } from "node:crypto";
import type { LipClient } from "@loyalty-interchange/sdk";
import {
  CustomerIdentityError,
  type CustomerDirectoryRepository,
  type CustomerMemberLink,
  type CustomerRecord,
  type ExternalIdentityLink,
  type IdentityProviderPrincipal,
  type LinkCustomerMemberInput,
  type LinkExternalIdentityInput,
  type ResolveCustomerInput
} from "./types.js";

export const LIP_CUSTOMER_IDENTITY_ISSUER = "craveup-customer";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function assertId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || !ID_PATTERN.test(trimmed)) {
    throw new CustomerIdentityError(
      "invalid_identity",
      `${field} must be a valid opaque identifier`
    );
  }
  return trimmed;
}

function assertPrincipal(principal: IdentityProviderPrincipal): void {
  if (!principal.issuer.trim() || principal.issuer.length > 2048) {
    throw new CustomerIdentityError("invalid_identity", "Identity issuer is invalid");
  }
  if (!principal.subject.trim() || principal.subject.length > 512) {
    throw new CustomerIdentityError("invalid_identity", "Identity subject is invalid");
  }
}

function identityKey(tenantId: string, issuer: string, subject: string): string {
  return JSON.stringify([tenantId, issuer, subject]);
}

function customerKey(tenantId: string, customerId: string): string {
  return JSON.stringify([tenantId, customerId]);
}

function memberKey(tenantId: string, customerId: string, programId: string): string {
  return JSON.stringify([tenantId, customerId, programId]);
}

function copyCustomer(customer: CustomerRecord): CustomerRecord {
  return { ...customer };
}

function copyIdentity(identity: ExternalIdentityLink): ExternalIdentityLink {
  return { ...identity };
}

function copyMember(link: CustomerMemberLink): CustomerMemberLink {
  return { ...link };
}

/**
 * Reference repository for local development and contract tests. Production
 * applications implement CustomerDirectoryRepository in their own database.
 */
export class MemoryCustomerDirectoryRepository implements CustomerDirectoryRepository {
  private readonly customers = new Map<string, CustomerRecord>();
  private readonly identities = new Map<string, ExternalIdentityLink>();
  private readonly members = new Map<string, CustomerMemberLink>();

  public async resolveOrCreateCustomer(input: ResolveCustomerInput): Promise<CustomerRecord> {
    const tenantId = assertId(input.tenantId, "tenantId");
    assertPrincipal(input.principal);
    const key = identityKey(tenantId, input.principal.issuer, input.principal.subject);
    const linked = this.identities.get(key);
    if (linked) {
      const existing = this.customers.get(customerKey(tenantId, linked.customerId));
      if (!existing) {
        throw new CustomerIdentityError(
          "customer_not_found",
          "External identity references a missing customer"
        );
      }
      return copyCustomer(existing);
    }

    const customerId = assertId(input.customerId, "customerId");
    const recordKey = customerKey(tenantId, customerId);
    if (this.customers.has(recordKey)) {
      throw new CustomerIdentityError("identity_conflict", "Customer id already exists");
    }
    const customer: CustomerRecord = {
      tenantId,
      customerId,
      status: "active",
      createdAt: input.now,
      updatedAt: input.now
    };
    const identity: ExternalIdentityLink = {
      tenantId,
      issuer: input.principal.issuer,
      subject: input.principal.subject,
      customerId,
      linkedAt: input.now
    };
    this.customers.set(recordKey, customer);
    this.identities.set(key, identity);
    return copyCustomer(customer);
  }

  public async customerForIdentity(
    tenantIdInput: string,
    issuer: string,
    subject: string
  ): Promise<CustomerRecord | undefined> {
    const tenantId = assertId(tenantIdInput, "tenantId");
    const identity = this.identities.get(identityKey(tenantId, issuer, subject));
    if (!identity) return undefined;
    const customer = this.customers.get(customerKey(tenantId, identity.customerId));
    return customer ? copyCustomer(customer) : undefined;
  }

  public async linkExternalIdentity(
    input: LinkExternalIdentityInput
  ): Promise<ExternalIdentityLink> {
    const tenantId = assertId(input.tenantId, "tenantId");
    const customerId = assertId(input.customerId, "customerId");
    assertPrincipal(input.principal);
    const customer = this.customers.get(customerKey(tenantId, customerId));
    if (!customer) {
      throw new CustomerIdentityError("customer_not_found", "Customer does not exist");
    }
    if (customer.status === "deleted") {
      throw new CustomerIdentityError("customer_deleted", "Customer has been deleted");
    }
    const key = identityKey(tenantId, input.principal.issuer, input.principal.subject);
    const existing = this.identities.get(key);
    if (existing && existing.customerId !== customerId) {
      throw new CustomerIdentityError(
        "identity_conflict",
        "External identity belongs to a different customer"
      );
    }
    if (existing) return copyIdentity(existing);
    const link: ExternalIdentityLink = {
      tenantId,
      issuer: input.principal.issuer,
      subject: input.principal.subject,
      customerId,
      linkedAt: input.now
    };
    this.identities.set(key, link);
    return copyIdentity(link);
  }

  public async memberLink(
    tenantIdInput: string,
    customerIdInput: string,
    programIdInput: string
  ): Promise<CustomerMemberLink | undefined> {
    const tenantId = assertId(tenantIdInput, "tenantId");
    const customerId = assertId(customerIdInput, "customerId");
    const programId = assertId(programIdInput, "programId");
    const link = this.members.get(memberKey(tenantId, customerId, programId));
    return link ? copyMember(link) : undefined;
  }

  public async linkMember(input: LinkCustomerMemberInput): Promise<CustomerMemberLink> {
    const tenantId = assertId(input.tenantId, "tenantId");
    const customerId = assertId(input.customerId, "customerId");
    const programId = assertId(input.programId, "programId");
    const memberId = assertId(input.memberId, "memberId");
    const customer = this.customers.get(customerKey(tenantId, customerId));
    if (!customer) {
      throw new CustomerIdentityError("customer_not_found", "Customer does not exist");
    }
    const key = memberKey(tenantId, customerId, programId);
    const existing = this.members.get(key);
    if (existing && existing.memberId !== memberId) {
      throw new CustomerIdentityError(
        "member_conflict",
        "Customer is already linked to a different loyalty member"
      );
    }
    if (existing) return copyMember(existing);
    const link: CustomerMemberLink = {
      tenantId,
      customerId,
      programId,
      memberId,
      linkedAt: input.now
    };
    this.members.set(key, link);
    return copyMember(link);
  }

  public async markCustomerDeleted(
    tenantIdInput: string,
    customerIdInput: string,
    now: string
  ): Promise<CustomerRecord> {
    const tenantId = assertId(tenantIdInput, "tenantId");
    const customerId = assertId(customerIdInput, "customerId");
    const key = customerKey(tenantId, customerId);
    const customer = this.customers.get(key);
    if (!customer) {
      throw new CustomerIdentityError("customer_not_found", "Customer does not exist");
    }
    const deleted: CustomerRecord = {
      ...customer,
      status: "deleted",
      updatedAt: now,
      deletedAt: customer.deletedAt ?? now
    };
    this.customers.set(key, deleted);
    return copyCustomer(deleted);
  }
}

export interface CustomerLoyaltyResolution {
  customer: CustomerRecord;
  memberLink: CustomerMemberLink;
}

export interface CustomerLoyaltyResolverOptions {
  repository: CustomerDirectoryRepository;
  lip: Pick<LipClient, "members">;
  clock?: () => Date;
  customerId?: () => string;
}

/**
 * Resolves an already-authenticated OIDC principal to one stable customer and
 * one program-scoped LIP member. Authentication stays with the external IdP.
 */
export class CustomerLoyaltyResolver {
  private readonly repository: CustomerDirectoryRepository;
  private readonly lip: Pick<LipClient, "members">;
  private readonly clock: () => Date;
  private readonly customerId: () => string;

  public constructor(options: CustomerLoyaltyResolverOptions) {
    this.repository = options.repository;
    this.lip = options.lip;
    this.clock = options.clock ?? (() => new Date());
    this.customerId = options.customerId ?? (() => `customer_${randomUUID()}`);
  }

  public async resolve(input: {
    tenantId: string;
    programId: string;
    principal: IdentityProviderPrincipal;
  }): Promise<CustomerLoyaltyResolution> {
    const tenantId = assertId(input.tenantId, "tenantId");
    const programId = assertId(input.programId, "programId");
    assertPrincipal(input.principal);
    const now = this.clock().toISOString();
    const customer = await this.repository.resolveOrCreateCustomer({
      tenantId,
      principal: input.principal,
      customerId: this.customerId(),
      now
    });
    if (customer.status === "deleted") {
      throw new CustomerIdentityError("customer_deleted", "Customer has been deleted");
    }

    const existing = await this.repository.memberLink(
      tenantId,
      customer.customerId,
      programId
    );
    if (existing) return { customer, memberLink: existing };

    const response = await this.lip.members.enroll(
      {
        program_id: programId,
        identity: {
          type: "external",
          issuer: LIP_CUSTOMER_IDENTITY_ISSUER,
          value: customer.customerId
        }
      },
      { idempotencyKey: this.memberIdempotencyKey(tenantId, customer.customerId, programId) }
    );
    const memberLink = await this.repository.linkMember({
      tenantId,
      customerId: customer.customerId,
      programId,
      memberId: response.member.member_id,
      now
    });
    if (memberLink.memberId !== response.member.member_id) {
      throw new CustomerIdentityError(
        "member_conflict",
        "Stored member link does not match the loyalty identity"
      );
    }
    return { customer, memberLink };
  }

  public linkIdentity(input: {
    tenantId: string;
    customerId: string;
    principal: IdentityProviderPrincipal;
  }): Promise<ExternalIdentityLink> {
    return this.repository.linkExternalIdentity({
      ...input,
      now: this.clock().toISOString()
    });
  }

  public deleteCustomer(tenantId: string, customerId: string): Promise<CustomerRecord> {
    return this.repository.markCustomerDeleted(
      tenantId,
      customerId,
      this.clock().toISOString()
    );
  }

  private memberIdempotencyKey(
    tenantId: string,
    customerId: string,
    programId: string
  ): string {
    const digest = createHash("sha256")
      .update(JSON.stringify([tenantId, customerId, programId]))
      .digest("hex");
    return `customer-member:${digest}`;
  }
}
