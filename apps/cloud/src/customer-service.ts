import { randomUUID } from "node:crypto";
import { CustomerPlatformError } from "./customer-errors.js";
import {
  CustomerRepositoryConflictError,
  type ConsentStatus,
  type Customer,
  type CustomerAccountExport,
  type CustomerConsent,
  type CustomerDeletionResult,
  type CustomerExternalIdentity,
  type CustomerIdentityProvider,
  type CustomerLoyaltyMembership,
  type CustomerLoyaltyProvider,
  type CustomerProfile,
  type CustomerRepository,
  type CustomerSession,
  type VerifiedCustomerIdentity
} from "./customer-types.js";

export interface CustomerPlatformOptions {
  repository: CustomerRepository;
  providers: CustomerIdentityProvider[];
  loyalty: CustomerLoyaltyProvider;
  now?: () => Date;
  customerId?: () => string;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  ) {
    throw new CustomerPlatformError(
      422,
      "validation_failed",
      `${label} is invalid`
    );
  }
  return normalized;
}

function optionalProfileValue(
  value: string | null | undefined,
  label: string,
  maxLength: number
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new CustomerPlatformError(
      422,
      "validation_failed",
      `${label} must contain 1-${maxLength} characters`
    );
  }
  return normalized;
}

function profileFromIdentity(identity: VerifiedCustomerIdentity): CustomerProfile {
  return {
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.phone ? { phone: identity.phone } : {})
  };
}

export class CustomerPlatform {
  private readonly repository: CustomerRepository;
  private readonly providers: Map<string, CustomerIdentityProvider>;
  private readonly loyalty: CustomerLoyaltyProvider;
  private readonly clock: () => Date;
  private readonly makeCustomerId: () => string;

  public constructor(options: CustomerPlatformOptions) {
    this.repository = options.repository;
    this.providers = new Map(
      options.providers.map((provider) => [provider.provider_id, provider])
    );
    if (
      this.providers.size === 0 ||
      this.providers.size !== options.providers.length
    ) {
      throw new Error("Customer providers must contain unique provider ids");
    }
    this.loyalty = options.loyalty;
    this.clock = options.now ?? (() => new Date());
    this.makeCustomerId =
      options.customerId ?? (() => `crv_cus_${randomUUID()}`);
  }

  public async migrate(): Promise<void> {
    await this.repository.migrate();
  }

  public async introspectSession(input: {
    tenant_id: string;
    provider_id: string;
    token: string;
  }): Promise<CustomerSession> {
    const tenantId = requiredIdentifier(input.tenant_id, "tenant_id");
    const provider = this.provider(input.provider_id);
    const verified = await provider.verifySession({
      tenant_id: tenantId,
      token: input.token
    });
    this.assertVerifiedIdentity(provider, tenantId, verified);
    const timestamp = this.clock().toISOString();
    const customerId = this.makeCustomerId();
    const customer: Customer = {
      customer_id: customerId,
      tenant_id: tenantId,
      status: "active",
      profile: profileFromIdentity(verified),
      created_at: timestamp,
      updated_at: timestamp
    };
    const identity: CustomerExternalIdentity = {
      customer_id: customerId,
      tenant_id: tenantId,
      provider_id: provider.provider_id,
      provider_kind: provider.kind,
      issuer: verified.issuer,
      subject: verified.subject,
      active: true,
      created_at: timestamp
    };
    let resolved;
    try {
      resolved = await this.repository.resolveOrCreate({
        customer,
        identity
      });
    } catch (error) {
      throw this.repositoryError(error);
    }
    if (resolved.customer.status === "deleted" || !resolved.identity.active) {
      throw new CustomerPlatformError(
        410,
        "account_deleted",
        "Customer account has been deleted"
      );
    }
    return {
      active: true,
      customer_id: resolved.customer.customer_id,
      tenant_id: tenantId,
      provider_id: provider.provider_id,
      issuer: verified.issuer,
      audiences: [...verified.audiences],
      expires_at: verified.expires_at,
      ...(verified.session_id ? { session_id: verified.session_id } : {}),
      ...(verified.authorized_party
        ? { authorized_party: verified.authorized_party }
        : {}),
      profile: structuredClone(resolved.customer.profile)
    };
  }

  public async getProfile(session: CustomerSession): Promise<CustomerProfile> {
    const customer = await this.activeCustomer(session);
    return structuredClone(customer.profile);
  }

  public async updateProfile(
    session: CustomerSession,
    patch: {
      given_name?: string | null;
      family_name?: string | null;
      locale?: string | null;
    }
  ): Promise<CustomerProfile> {
    const customer = await this.activeCustomer(session);
    const profile: CustomerProfile = {
      ...(customer.profile.email ? { email: customer.profile.email } : {}),
      ...(customer.profile.phone ? { phone: customer.profile.phone } : {})
    };
    const values = {
      given_name:
        patch.given_name === undefined
          ? customer.profile.given_name
          : optionalProfileValue(patch.given_name, "given_name", 100),
      family_name:
        patch.family_name === undefined
          ? customer.profile.family_name
          : optionalProfileValue(patch.family_name, "family_name", 100),
      locale:
        patch.locale === undefined
          ? customer.profile.locale
          : optionalProfileValue(patch.locale, "locale", 35)
    };
    if (values.given_name) profile.given_name = values.given_name;
    if (values.family_name) profile.family_name = values.family_name;
    if (values.locale) profile.locale = values.locale;
    const updated = await this.repository.replaceProfile({
      tenantId: session.tenant_id,
      customerId: session.customer_id,
      profile,
      updatedAt: this.clock().toISOString()
    });
    if (!updated) throw this.notFound();
    return structuredClone(updated.profile);
  }

  public async setConsent(
    session: CustomerSession,
    input: {
      purpose: string;
      status: ConsentStatus;
      policy_version: string;
      source: string;
    }
  ): Promise<CustomerConsent> {
    await this.activeCustomer(session);
    if (!["granted", "denied", "withdrawn"].includes(input.status)) {
      throw new CustomerPlatformError(
        422,
        "validation_failed",
        "Consent status is invalid"
      );
    }
    const consent: CustomerConsent = {
      customer_id: session.customer_id,
      tenant_id: session.tenant_id,
      purpose: requiredIdentifier(input.purpose, "purpose"),
      status: input.status,
      policy_version: requiredIdentifier(
        input.policy_version,
        "policy_version"
      ),
      source: requiredIdentifier(input.source, "source"),
      updated_at: this.clock().toISOString()
    };
    return this.repository.setConsent(consent);
  }

  public async linkIdentity(
    session: CustomerSession,
    input: { provider_id: string; token: string }
  ): Promise<CustomerExternalIdentity> {
    await this.activeCustomer(session);
    const provider = this.provider(input.provider_id);
    const verified = await provider.verifySession({
      tenant_id: session.tenant_id,
      token: input.token
    });
    this.assertVerifiedIdentity(provider, session.tenant_id, verified);
    const identity: CustomerExternalIdentity = {
      customer_id: session.customer_id,
      tenant_id: session.tenant_id,
      provider_id: provider.provider_id,
      provider_kind: provider.kind,
      issuer: verified.issuer,
      subject: verified.subject,
      active: true,
      created_at: this.clock().toISOString()
    };
    try {
      return await this.repository.linkIdentity({
        tenantId: session.tenant_id,
        customerId: session.customer_id,
        identity
      });
    } catch (error) {
      throw this.repositoryError(error);
    }
  }

  public async enrollLoyalty(
    session: CustomerSession,
    input: { program_id: string }
  ): Promise<CustomerLoyaltyMembership> {
    await this.activeCustomer(session);
    const programId = requiredIdentifier(input.program_id, "program_id");
    const existing = await this.repository.loyaltyMembership(
      session.tenant_id,
      session.customer_id,
      programId
    );
    if (existing) return existing;
    let enrolled: { member_id: string };
    try {
      enrolled = await this.loyalty.enroll({
        tenant_id: session.tenant_id,
        program_id: programId,
        customer_id: session.customer_id,
        idempotency_key: `customer:${session.customer_id}:program:${programId}`
      });
    } catch (error) {
      throw new CustomerPlatformError(
        503,
        "loyalty_provider_unavailable",
        "Loyalty enrollment is temporarily unavailable",
        { cause: error }
      );
    }
    const membership: CustomerLoyaltyMembership = {
      customer_id: session.customer_id,
      tenant_id: session.tenant_id,
      program_id: programId,
      member_id: requiredIdentifier(enrolled.member_id, "member_id"),
      enrolled_at: this.clock().toISOString()
    };
    try {
      return await this.repository.bindLoyaltyMembership(membership);
    } catch (error) {
      throw this.repositoryError(error);
    }
  }

  public async exportAccount(
    session: CustomerSession
  ): Promise<CustomerAccountExport> {
    const customer = await this.activeCustomer(session);
    const [identities, consents, memberships] = await Promise.all([
      this.repository.identitiesForCustomer(
        session.tenant_id,
        session.customer_id
      ),
      this.repository.consentsForCustomer(
        session.tenant_id,
        session.customer_id
      ),
      this.repository.loyaltyMembershipsForCustomer(
        session.tenant_id,
        session.customer_id
      )
    ]);
    return {
      customer,
      identities: identities.map(({ subject: _subject, ...identity }) => identity),
      consents,
      loyalty_memberships: memberships
    };
  }

  public async deleteAccount(
    session: CustomerSession
  ): Promise<CustomerDeletionResult> {
    const customer = await this.customerForSession(session);
    const identities = await this.repository.identitiesForCustomer(
      session.tenant_id,
      session.customer_id
    );
    const deletedAt =
      customer.deleted_at ?? this.clock().toISOString();
    if (customer.status !== "deleted") {
      await this.repository.deleteCustomer({
        tenantId: session.tenant_id,
        customerId: session.customer_id,
        deletedAt
      });
    }
    const retained = await this.repository.loyaltyMembershipsForCustomer(
      session.tenant_id,
      session.customer_id
    );
    const providerCleanup = await Promise.all(
      identities.map(async (identity) => {
        const provider = this.providers.get(identity.provider_id);
        if (!provider) {
          return { provider_id: identity.provider_id, status: "pending" as const };
        }
        try {
          return {
            provider_id: identity.provider_id,
            status: await provider.deleteIdentity(identity)
          };
        } catch {
          return { provider_id: identity.provider_id, status: "pending" as const };
        }
      })
    );
    return {
      customer_id: session.customer_id,
      deleted_at: deletedAt,
      retained_loyalty_memberships: retained,
      provider_cleanup: providerCleanup
    };
  }

  public async close(): Promise<void> {
    await this.repository.close();
  }

  private provider(providerId: string): CustomerIdentityProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new CustomerPlatformError(
        400,
        "unknown_identity_provider",
        "Customer identity provider is not configured"
      );
    }
    return provider;
  }

  private assertVerifiedIdentity(
    provider: CustomerIdentityProvider,
    tenantId: string,
    identity: VerifiedCustomerIdentity
  ): void {
    if (
      identity.provider_id !== provider.provider_id ||
      identity.provider_kind !== provider.kind ||
      identity.tenant_id !== tenantId ||
      !identity.issuer.trim() ||
      !identity.subject.trim()
    ) {
      throw new CustomerPlatformError(
        502,
        "invalid_provider_response",
        "Identity provider returned an invalid customer identity"
      );
    }
  }

  private async activeCustomer(session: CustomerSession): Promise<Customer> {
    const customer = await this.customerForSession(session);
    if (customer.status === "deleted") {
      throw new CustomerPlatformError(
        410,
        "account_deleted",
        "Customer account has been deleted"
      );
    }
    return customer;
  }

  private async customerForSession(session: CustomerSession): Promise<Customer> {
    const expiresAt = Date.parse(session.expires_at);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.clock().getTime()
    ) {
      throw new CustomerPlatformError(
        401,
        "session_expired",
        "Customer session has expired"
      );
    }
    const customer = await this.repository.customerById(
      session.tenant_id,
      session.customer_id
    );
    if (!customer) throw this.notFound();
    return customer;
  }

  private notFound(): CustomerPlatformError {
    return new CustomerPlatformError(
      404,
      "customer_not_found",
      "Customer was not found"
    );
  }

  private repositoryError(error: unknown): Error {
    if (error instanceof CustomerRepositoryConflictError) {
      return new CustomerPlatformError(409, error.code, error.message, {
        cause: error
      });
    }
    return error instanceof Error ? error : new Error("Customer repository failed");
  }
}
