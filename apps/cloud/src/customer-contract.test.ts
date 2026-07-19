import { readFileSync } from "node:fs";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CustomerPlatformError,
  CustomerProviderUnavailableError
} from "./customer-errors.js";
import { MemoryCustomerRepository } from "./customer-memory-repository.js";
import {
  Auth0CustomerIdentityProvider,
  ClerkCustomerIdentityProvider,
  OidcCustomerIdentityProvider,
  type OidcCustomerIdentityProviderOptions
} from "./customer-provider.js";
import { CustomerPlatform } from "./customer-service.js";
import type {
  CustomerExternalIdentity,
  CustomerIdentityProvider,
  CustomerLoyaltyProvider,
  CustomerProviderKind,
  CustomerRepository,
  VerifiedCustomerIdentity
} from "./customer-types.js";

const issuer = "https://identity.example.com";
const audience = "craveup-customer";
const tenantId = "tenant_acme";
let privateKey: CryptoKey;
let key: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = "customer-contract-key";
  key = createLocalJWKSet({ keys: [jwk] });
});

async function token(input: {
  subject?: string;
  tokenIssuer?: string;
  tokenAudience?: string;
  expiresIn?: string;
  authorizedParty?: string;
} = {}): Promise<string> {
  return new SignJWT({
    email: "CUSTOMER@Example.com",
    email_verified: true,
    phone_number: "+15555550100",
    phone_number_verified: true,
    azp: input.authorizedParty ?? "https://acme.example.com"
  })
    .setProtectedHeader({ alg: "RS256", kid: "customer-contract-key" })
    .setIssuer(input.tokenIssuer ?? issuer)
    .setAudience(input.tokenAudience ?? audience)
    .setSubject(input.subject ?? "user_customer_001")
    .setIssuedAt()
    .setExpirationTime(input.expiresIn ?? "5m")
    .sign(privateKey);
}

type ProviderFactory = (
  options?: Partial<OidcCustomerIdentityProviderOptions>
) => CustomerIdentityProvider;

function providerContract(name: string, factory: ProviderFactory): void {
  describe(`${name} customer provider contract`, () => {
    it("verifies issuer, audience, expiry, subject, and verified contacts", async () => {
      const provider = factory();
      await expect(provider.verifySession({
        tenant_id: tenantId,
        token: await token()
      })).resolves.toMatchObject({
        tenant_id: tenantId,
        issuer,
        subject: "user_customer_001",
        audiences: [audience],
        authorized_party: "https://acme.example.com",
        email: { value: "customer@example.com" },
        phone: { value: "+15555550100" }
      });
    });

    it.each([
      ["issuer", { tokenIssuer: "https://attacker.example.com" }],
      ["audience", { tokenAudience: "different-api" }],
      ["expiry", { expiresIn: "-5m" }]
    ])("rejects an invalid %s", async (_label, claims) => {
      await expect(factory().verifySession({
        tenant_id: tenantId,
        token: await token(claims)
      })).rejects.toMatchObject({
        status: 401,
        code: "invalid_token"
      });
    });

    it("rejects the wrong authorized party and tenant binding", async () => {
      const provider = factory();
      await expect(provider.verifySession({
        tenant_id: tenantId,
        token: await token({ authorizedParty: "https://evil.example.com" })
      })).rejects.toMatchObject({ status: 401, code: "invalid_token" });
      await expect(provider.verifySession({
        tenant_id: "tenant_other",
        token: await token()
      })).rejects.toMatchObject({ status: 403, code: "tenant_mismatch" });
    });
  });
}

const baseProviderOptions = (): OidcCustomerIdentityProviderOptions => ({
  providerId: "primary",
  tenantId,
  issuer,
  audience,
  authorizedParties: ["https://acme.example.com"],
  key
});

providerContract("OIDC", (options) =>
  new OidcCustomerIdentityProvider({ ...baseProviderOptions(), ...options })
);
providerContract("Clerk", (options) =>
  new ClerkCustomerIdentityProvider({ ...baseProviderOptions(), ...options })
);
providerContract("Auth0", (options) =>
  new Auth0CustomerIdentityProvider({
    ...baseProviderOptions(),
    ...options,
    audience: options?.audience ?? audience
  })
);

describe("customer provider failures", () => {
  it("classifies a JWKS or provider outage separately from an invalid token", async () => {
    const provider = new OidcCustomerIdentityProvider({
      ...baseProviderOptions(),
      verify: (async () => {
        throw new CustomerProviderUnavailableError("JWKS offline");
      }) as NonNullable<OidcCustomerIdentityProviderOptions["verify"]>
    });
    await expect(provider.verifySession({
      tenant_id: tenantId,
      token: "header.payload.signature"
    })).rejects.toMatchObject({
      status: 503,
      code: "identity_provider_unavailable"
    });
  });

  it("supports credential-free Clerk verification with an injected public key", async () => {
    const provider = new ClerkCustomerIdentityProvider(baseProviderOptions());
    await expect(provider.verifySession({
      tenant_id: tenantId,
      token: await token()
    })).resolves.toMatchObject({
      provider_kind: "clerk",
      subject: "user_customer_001"
    });
    await expect(provider.deleteIdentity({
      customer_id: "crv_cus_test",
      tenant_id: tenantId,
      provider_id: "primary",
      provider_kind: "clerk",
      issuer,
      subject: "user_customer_001",
      active: true,
      created_at: new Date().toISOString()
    })).resolves.toBe("unsupported");
  });
});

class StubProvider implements CustomerIdentityProvider {
  public readonly subjects = new Map<string, string>();
  public deleteFailure = false;

  public constructor(
    public readonly provider_id: string,
    public readonly kind: CustomerProviderKind,
    private readonly tenantId: string,
    private readonly providerIssuer: string
  ) {}

  public async verifySession(input: {
    tenant_id: string;
    token: string;
  }): Promise<VerifiedCustomerIdentity> {
    if (input.tenant_id !== this.tenantId) {
      throw new CustomerPlatformError(403, "tenant_mismatch", "Wrong tenant");
    }
    const subject = this.subjects.get(input.token);
    if (!subject) {
      throw new CustomerPlatformError(401, "invalid_token", "Invalid token");
    }
    return {
      provider_id: this.provider_id,
      provider_kind: this.kind,
      tenant_id: this.tenantId,
      issuer: this.providerIssuer,
      subject,
      audiences: [audience],
      expires_at: "2030-07-16T20:00:00.000Z",
      email: { value: `${subject}@example.com` }
    };
  }

  public async deleteIdentity(
    _identity: CustomerExternalIdentity
  ): Promise<"deleted"> {
    if (this.deleteFailure) throw new Error("provider offline");
    return "deleted";
  }
}

function platformFixture(repository: CustomerRepository = new MemoryCustomerRepository()) {
  const clerk = new StubProvider(
    "clerk",
    "clerk",
    tenantId,
    "https://acme.clerk.accounts.dev"
  );
  const oidc = new StubProvider(
    "legacy",
    "oidc",
    tenantId,
    "https://legacy.example.com"
  );
  clerk.subjects.set("clerk-alice", "alice");
  clerk.subjects.set("clerk-bob", "bob");
  oidc.subjects.set("legacy-alice", "legacy-alice");
  oidc.subjects.set("legacy-bob", "legacy-bob");
  const enroll = vi.fn(async (input: {
    tenant_id: string;
    program_id: string;
    customer_id: string;
    idempotency_key: string;
  }) => ({
    member_id: `member_${input.program_id}_${input.customer_id}`
  }));
  const loyalty: CustomerLoyaltyProvider = { enroll };
  let sequence = 0;
  const platform = new CustomerPlatform({
    repository,
    providers: [clerk, oidc],
    loyalty,
    now: () => new Date("2026-07-16T19:00:00.000Z"),
    customerId: () => `crv_cus_${++sequence}`
  });
  return { platform, repository, clerk, oidc, enroll };
}

describe("managed customer identity contract", () => {
  it("keeps one stable customer id per tenant, issuer, and subject", async () => {
    const { platform } = platformFixture();
    const first = await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-alice"
    });
    const retry = await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-alice"
    });
    const other = await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-bob"
    });
    expect(retry.customer_id).toBe(first.customer_id);
    expect(other.customer_id).not.toBe(first.customer_id);
  });

  it("isolates an identical issuer and subject across tenants", async () => {
    const repository = new MemoryCustomerRepository();
    const first = platformFixture(repository);
    const otherProvider = new StubProvider(
      "other-clerk",
      "clerk",
      "tenant_other",
      "https://acme.clerk.accounts.dev"
    );
    otherProvider.subjects.set("same-subject", "alice");
    const second = new CustomerPlatform({
      repository,
      providers: [otherProvider],
      loyalty: { enroll: async () => ({ member_id: "member_other" }) },
      customerId: () => "crv_cus_other"
    });
    const firstSession = await first.platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-alice"
    });
    const secondSession = await second.introspectSession({
      tenant_id: "tenant_other",
      provider_id: "other-clerk",
      token: "same-subject"
    });
    expect(secondSession.customer_id).not.toBe(firstSession.customer_id);
  });

  it("links a second identity without changing the customer id", async () => {
    const { platform } = platformFixture();
    const session = await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-alice"
    });
    await expect(platform.linkIdentity(session, {
      provider_id: "legacy",
      token: "legacy-alice"
    })).resolves.toMatchObject({
      customer_id: session.customer_id,
      provider_id: "legacy"
    });
    await expect(platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "legacy",
      token: "legacy-alice"
    })).resolves.toMatchObject({ customer_id: session.customer_id });
  });

  it("never reassigns an identity already mapped to another customer", async () => {
    const { platform } = platformFixture();
    const alice = await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-alice"
    });
    await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "legacy",
      token: "legacy-bob"
    });
    await expect(platform.linkIdentity(alice, {
      provider_id: "legacy",
      token: "legacy-bob"
    })).rejects.toMatchObject({
      status: 409,
      code: "identity_conflict"
    });
  });

  it("enrolls once per program with a stable idempotency key", async () => {
    const { platform, enroll } = platformFixture();
    const session = await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-alice"
    });
    const first = await platform.enrollLoyalty(session, {
      program_id: "acme-rewards"
    });
    const retry = await platform.enrollLoyalty(session, {
      program_id: "acme-rewards"
    });
    const secondProgram = await platform.enrollLoyalty(session, {
      program_id: "acme-vip"
    });
    expect(retry.member_id).toBe(first.member_id);
    expect(secondProgram.member_id).not.toBe(first.member_id);
    expect(enroll).toHaveBeenCalledTimes(2);
    expect(enroll).toHaveBeenCalledWith(expect.objectContaining({
      idempotency_key:
        `customer:${session.customer_id}:program:acme-rewards`
    }));
  });

  it("prevents a LIP member id from being assigned to two customers", async () => {
    const { repository, clerk } = platformFixture();
    const platform = new CustomerPlatform({
      repository,
      providers: [clerk],
      loyalty: { enroll: async () => ({ member_id: "member_shared" }) },
      customerId: (() => {
        let sequence = 0;
        return () => `crv_cus_unique_${++sequence}`;
      })()
    });
    const alice = await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-alice"
    });
    const bob = await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-bob"
    });
    await platform.enrollLoyalty(alice, { program_id: "acme-rewards" });
    await expect(platform.enrollLoyalty(
      bob,
      { program_id: "acme-rewards" }
    )).rejects.toMatchObject({
      status: 409,
      code: "member_conflict"
    });
  });

  it("redacts profiles and consent while retaining loyalty ledger anchors", async () => {
    const { platform, repository, clerk } = platformFixture();
    const session = await platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-alice"
    });
    await platform.updateProfile(session, { given_name: "Alice", locale: "en-US" });
    await platform.setConsent(session, {
      purpose: "marketing_email",
      status: "granted",
      policy_version: "2026-07",
      source: "acme-app"
    });
    const membership = await platform.enrollLoyalty(session, {
      program_id: "acme-rewards"
    });
    const exported = await platform.exportAccount(session);
    expect(exported.identities[0]).not.toHaveProperty("subject");
    clerk.deleteFailure = true;
    const deleted = await platform.deleteAccount(session);
    expect(deleted).toMatchObject({
      customer_id: session.customer_id,
      retained_loyalty_memberships: [membership],
      provider_cleanup: [{ provider_id: "clerk", status: "pending" }]
    });
    expect(await repository.customerById(
      tenantId,
      session.customer_id
    )).toMatchObject({ status: "deleted", profile: {} });
    expect(await repository.consentsForCustomer(
      tenantId,
      session.customer_id
    )).toMatchObject([{ status: "withdrawn" }]);
    expect(await repository.loyaltyMembershipsForCustomer(
      tenantId,
      session.customer_id
    )).toEqual([membership]);
    await expect(platform.introspectSession({
      tenant_id: tenantId,
      provider_id: "clerk",
      token: "clerk-alice"
    })).rejects.toMatchObject({ status: 410, code: "account_deleted" });
  });
});

describe("customer identity persistence contract", () => {
  it("uses immutable tenant identity and member uniqueness constraints", () => {
    const sql = readFileSync(
      new URL("../migrations/003_customer_identity.sql", import.meta.url),
      "utf8"
    );
    for (const table of [
      "lip_cloud_customers",
      "lip_cloud_customer_identities",
      "lip_cloud_customer_consents",
      "lip_cloud_customer_loyalty_memberships"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("PRIMARY KEY (tenant_id, issuer, subject)");
    expect(sql).toContain("UNIQUE (tenant_id, program_id, member_id)");
    expect(sql).toContain("ON DELETE RESTRICT");
    expect(sql).not.toContain("ON DELETE CASCADE");
  });
});
