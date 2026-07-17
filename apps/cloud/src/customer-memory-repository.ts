import {
  CustomerRepositoryConflictError,
  type Customer,
  type CustomerConsent,
  type CustomerExternalIdentity,
  type CustomerLoyaltyMembership,
  type CustomerProfile,
  type CustomerRepository
} from "./customer-types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(...parts: string[]): string {
  return JSON.stringify(parts);
}

export class MemoryCustomerRepository implements CustomerRepository {
  private readonly customers = new Map<string, Customer>();
  private readonly identities = new Map<string, CustomerExternalIdentity>();
  private readonly consents = new Map<string, CustomerConsent>();
  private readonly memberships = new Map<string, CustomerLoyaltyMembership>();
  private readonly memberOwners = new Map<string, string>();

  public async migrate(): Promise<void> {}

  public async resolveOrCreate(input: {
    customer: Customer;
    identity: CustomerExternalIdentity;
  }): Promise<{
    customer: Customer;
    identity: CustomerExternalIdentity;
    created: boolean;
  }> {
    this.assertIdentity(input.customer, input.identity);
    const identityKey = this.identityKey(input.identity);
    const existingIdentity = this.identities.get(identityKey);
    if (existingIdentity) {
      const existingCustomer = this.customers.get(
        this.customerKey(existingIdentity.tenant_id, existingIdentity.customer_id)
      );
      if (!existingCustomer) {
        throw new Error("Customer identity points to a missing customer");
      }
      return {
        customer: clone(existingCustomer),
        identity: clone(existingIdentity),
        created: false
      };
    }
    const customerKey = this.customerKey(
      input.customer.tenant_id,
      input.customer.customer_id
    );
    if (this.customers.has(customerKey)) {
      throw new CustomerRepositoryConflictError(
        "customer_conflict",
        "Customer id is already in use"
      );
    }
    this.customers.set(customerKey, clone(input.customer));
    this.identities.set(identityKey, clone(input.identity));
    return {
      customer: clone(input.customer),
      identity: clone(input.identity),
      created: true
    };
  }

  public async customerById(
    tenantId: string,
    customerId: string
  ): Promise<Customer | undefined> {
    const value = this.customers.get(this.customerKey(tenantId, customerId));
    return value ? clone(value) : undefined;
  }

  public async identitiesForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerExternalIdentity[]> {
    return [...this.identities.values()]
      .filter(
        (identity) =>
          identity.tenant_id === tenantId &&
          identity.customer_id === customerId
      )
      .map(clone);
  }

  public async linkIdentity(input: {
    tenantId: string;
    customerId: string;
    identity: CustomerExternalIdentity;
  }): Promise<CustomerExternalIdentity> {
    if (
      input.identity.tenant_id !== input.tenantId ||
      input.identity.customer_id !== input.customerId
    ) {
      throw new Error("Linked identity scope must match the customer");
    }
    const customer = this.customers.get(
      this.customerKey(input.tenantId, input.customerId)
    );
    if (!customer) throw new Error("Customer was not found");
    const identityKey = this.identityKey(input.identity);
    const existing = this.identities.get(identityKey);
    if (existing) {
      if (existing.customer_id !== input.customerId) {
        throw new CustomerRepositoryConflictError(
          "identity_conflict",
          "External identity is already linked to another customer"
        );
      }
      return clone(existing);
    }
    this.identities.set(identityKey, clone(input.identity));
    return clone(input.identity);
  }

  public async replaceProfile(input: {
    tenantId: string;
    customerId: string;
    profile: CustomerProfile;
    updatedAt: string;
  }): Promise<Customer | undefined> {
    const customerKey = this.customerKey(input.tenantId, input.customerId);
    const customer = this.customers.get(customerKey);
    if (!customer) return undefined;
    customer.profile = clone(input.profile);
    customer.updated_at = input.updatedAt;
    return clone(customer);
  }

  public async setConsent(
    consent: CustomerConsent
  ): Promise<CustomerConsent> {
    const customer = this.customers.get(
      this.customerKey(consent.tenant_id, consent.customer_id)
    );
    if (!customer) throw new Error("Customer was not found");
    this.consents.set(
      key(consent.tenant_id, consent.customer_id, consent.purpose),
      clone(consent)
    );
    return clone(consent);
  }

  public async consentsForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerConsent[]> {
    return [...this.consents.values()]
      .filter(
        (consent) =>
          consent.tenant_id === tenantId &&
          consent.customer_id === customerId
      )
      .map(clone);
  }

  public async bindLoyaltyMembership(
    membership: CustomerLoyaltyMembership
  ): Promise<CustomerLoyaltyMembership> {
    const membershipKey = key(
      membership.tenant_id,
      membership.customer_id,
      membership.program_id
    );
    const existing = this.memberships.get(membershipKey);
    if (existing) return clone(existing);
    const ownerKey = key(
      membership.tenant_id,
      membership.program_id,
      membership.member_id
    );
    const owner = this.memberOwners.get(ownerKey);
    if (owner && owner !== membership.customer_id) {
      throw new CustomerRepositoryConflictError(
        "member_conflict",
        "LIP member id is already mapped to another customer"
      );
    }
    this.memberships.set(membershipKey, clone(membership));
    this.memberOwners.set(ownerKey, membership.customer_id);
    return clone(membership);
  }

  public async loyaltyMembership(
    tenantId: string,
    customerId: string,
    programId: string
  ): Promise<CustomerLoyaltyMembership | undefined> {
    const value = this.memberships.get(key(tenantId, customerId, programId));
    return value ? clone(value) : undefined;
  }

  public async loyaltyMembershipsForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<CustomerLoyaltyMembership[]> {
    return [...this.memberships.values()]
      .filter(
        (membership) =>
          membership.tenant_id === tenantId &&
          membership.customer_id === customerId
      )
      .map(clone);
  }

  public async deleteCustomer(input: {
    tenantId: string;
    customerId: string;
    deletedAt: string;
  }): Promise<Customer | undefined> {
    const customer = this.customers.get(
      this.customerKey(input.tenantId, input.customerId)
    );
    if (!customer) return undefined;
    if (customer.status === "deleted") return clone(customer);
    customer.status = "deleted";
    customer.profile = {};
    customer.deleted_at = input.deletedAt;
    customer.updated_at = input.deletedAt;
    for (const identity of this.identities.values()) {
      if (
        identity.tenant_id === input.tenantId &&
        identity.customer_id === input.customerId
      ) {
        identity.active = false;
        identity.disabled_at = input.deletedAt;
      }
    }
    for (const consent of this.consents.values()) {
      if (
        consent.tenant_id === input.tenantId &&
        consent.customer_id === input.customerId
      ) {
        consent.status = "withdrawn";
        consent.updated_at = input.deletedAt;
      }
    }
    return clone(customer);
  }

  public async close(): Promise<void> {}

  private customerKey(tenantId: string, customerId: string): string {
    return key(tenantId, customerId);
  }

  private identityKey(identity: CustomerExternalIdentity): string {
    return key(identity.tenant_id, identity.issuer, identity.subject);
  }

  private assertIdentity(
    customer: Customer,
    identity: CustomerExternalIdentity
  ): void {
    if (
      customer.tenant_id !== identity.tenant_id ||
      customer.customer_id !== identity.customer_id
    ) {
      throw new Error("Customer and external identity scope must match");
    }
  }
}
