import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair
} from "jose";
import { describe, expect, it, vi } from "vitest";
import type { LipClient } from "@loyalty-interchange/sdk";
import {
  CustomerIdentityError,
  CustomerLoyaltyResolver,
  LIP_CUSTOMER_IDENTITY_ISSUER,
  MemoryCustomerDirectoryRepository,
  OidcTokenVerifier,
  bearerToken,
  type IdentityProviderPrincipal
} from "./index.js";

const NOW = "2026-07-17T02:00:00.000Z";

function principal(
  subject: string,
  issuer = "https://identity.example.com"
): IdentityProviderPrincipal {
  return {
    issuer,
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    claims: {}
  };
}

function lipFixture(memberId = "member-001") {
  const enroll = vi.fn(async (_input: unknown, _options?: unknown) => ({
    context: {
      protocol_version: "1.0" as const,
      profile: "foodservice/1.0" as const,
      request_id: "request-001",
      idempotency_key: "idempotency-001",
      occurred_at: NOW,
      source: { system: "test" },
      provider: { system: "test" }
    },
    member: {
      member_id: memberId,
      program_id: "sakura-rewards",
      status: "active" as const,
      joined_at: NOW,
      identities: [
        {
          type: "external" as const,
          issuer: LIP_CUSTOMER_IDENTITY_ISSUER,
          value: "customer-001"
        }
      ]
    },
    balances: []
  }));
  return {
    enroll,
    lip: {
      members: {
        enroll,
        lookup: vi.fn()
      }
    } as unknown as Pick<LipClient, "members">
  };
}

async function signedToken(input: {
  issuer?: string;
  audience?: string;
  subject?: string;
  azp?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const key = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] });
  const token = await new SignJWT({
    email: "Customer@Example.com",
    email_verified: input.emailVerified ?? true,
    phone_number: "+15555550123",
    phone_number_verified: input.phoneVerified ?? true,
    ...(input.azp ? { azp: input.azp } : {})
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(input.issuer ?? "https://identity.example.com")
    .setAudience(input.audience ?? "sakura-bff")
    .setSubject(input.subject ?? "user_123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { key, token };
}

describe("OIDC token verifier", () => {
  it("validates a token and exposes only verified contact claims", async () => {
    const { key, token } = await signedToken({});
    const verifier = new OidcTokenVerifier({
      issuer: "https://identity.example.com/",
      audience: "sakura-bff",
      key
    });

    await expect(verifier.verifyAuthorization(`Bearer ${token}`)).resolves.toMatchObject({
      issuer: "https://identity.example.com",
      subject: "user_123",
      email: "customer@example.com",
      emailVerified: true,
      phoneNumber: "+15555550123",
      phoneNumberVerified: true
    });
  });

  it("rejects the wrong audience and unauthorized Clerk-style azp", async () => {
    const { key, token } = await signedToken({ audience: "another-api", azp: "https://bad.app" });
    const verifier = new OidcTokenVerifier({
      issuer: "https://identity.example.com",
      audience: "sakura-bff",
      authorizedParties: ["https://sakura.app"],
      key
    });

    await expect(verifier.verifyToken(token)).rejects.toMatchObject({
      code: "invalid_token"
    });
  });

  it("accepts an allowed authorized party", async () => {
    const { key, token } = await signedToken({ azp: "https://sakura.app" });
    const verifier = new OidcTokenVerifier({
      issuer: "https://identity.example.com",
      audience: "sakura-bff",
      authorizedParties: ["https://sakura.app"],
      key
    });

    await expect(verifier.verifyToken(token)).resolves.toMatchObject({
      subject: "user_123"
    });
  });

  it("does not expose unverified email or phone claims", async () => {
    const { key, token } = await signedToken({
      emailVerified: false,
      phoneVerified: false
    });
    const verifier = new OidcTokenVerifier({
      issuer: "https://identity.example.com",
      audience: "sakura-bff",
      key
    });

    const verified = await verifier.verifyToken(token);
    expect(verified.email).toBeUndefined();
    expect(verified.phoneNumber).toBeUndefined();
  });

  it("validates configuration and bearer syntax", () => {
    expect(
      () => new OidcTokenVerifier({ issuer: "", audience: "api", key: vi.fn() })
    ).toThrowError(CustomerIdentityError);
    expect(
      () =>
        new OidcTokenVerifier({
          issuer: "https://identity.example.com",
          audience: [],
          key: vi.fn()
        })
    ).toThrowError(/audience/i);
    expect(() => bearerToken()).toThrowError(/Bearer/);
    expect(() => bearerToken("Bearer   ")).toThrowError(/empty/);
  });
});

describe("customer-to-member resolution", () => {
  it("creates one stable customer and one program member", async () => {
    const repository = new MemoryCustomerDirectoryRepository();
    const { lip, enroll } = lipFixture();
    const resolver = new CustomerLoyaltyResolver({
      repository,
      lip,
      clock: () => new Date(NOW),
      customerId: () => "customer-001"
    });

    const first = await resolver.resolve({
      tenantId: "sakura",
      programId: "sakura-rewards",
      principal: principal("clerk-user")
    });
    const second = await resolver.resolve({
      tenantId: "sakura",
      programId: "sakura-rewards",
      principal: principal("clerk-user")
    });

    expect(second).toEqual(first);
    expect(first.memberLink.memberId).toBe("member-001");
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(enroll.mock.calls[0]?.[0]).toEqual({
      program_id: "sakura-rewards",
      identity: {
        type: "external",
        issuer: LIP_CUSTOMER_IDENTITY_ISSUER,
        value: "customer-001"
      }
    });
    expect(JSON.stringify(enroll.mock.calls[0])).not.toContain("clerk-user");
    expect(JSON.stringify(enroll.mock.calls[0])).not.toContain("@example.com");
  });

  it("isolates the same provider subject by tenant", async () => {
    const repository = new MemoryCustomerDirectoryRepository();
    const firstLip = lipFixture("member-sakura");
    const secondLip = lipFixture("member-another");
    let sequence = 0;
    const ids = () => `customer-00${++sequence}`;
    const sakura = new CustomerLoyaltyResolver({
      repository,
      lip: firstLip.lip,
      clock: () => new Date(NOW),
      customerId: ids
    });
    const another = new CustomerLoyaltyResolver({
      repository,
      lip: secondLip.lip,
      clock: () => new Date(NOW),
      customerId: ids
    });

    const first = await sakura.resolve({
      tenantId: "sakura",
      programId: "sakura-rewards",
      principal: principal("shared-subject")
    });
    const second = await another.resolve({
      tenantId: "another-brand",
      programId: "another-rewards",
      principal: principal("shared-subject")
    });

    expect(first.customer.customerId).not.toBe(second.customer.customerId);
  });

  it("links another external identity without changing customer id", async () => {
    const repository = new MemoryCustomerDirectoryRepository();
    const { lip } = lipFixture();
    const resolver = new CustomerLoyaltyResolver({
      repository,
      lip,
      clock: () => new Date(NOW),
      customerId: () => "customer-001"
    });
    const resolved = await resolver.resolve({
      tenantId: "sakura",
      programId: "sakura-rewards",
      principal: principal("clerk-user", "https://clerk.example.com")
    });

    await resolver.linkIdentity({
      tenantId: "sakura",
      customerId: resolved.customer.customerId,
      principal: principal("auth0-user", "https://auth0.example.com")
    });

    await expect(
      repository.customerForIdentity(
        "sakura",
        "https://auth0.example.com",
        "auth0-user"
      )
    ).resolves.toMatchObject({ customerId: "customer-001" });
  });

  it("retains identity linkage while preventing deleted customers from resolving", async () => {
    const repository = new MemoryCustomerDirectoryRepository();
    const { lip } = lipFixture();
    const resolver = new CustomerLoyaltyResolver({
      repository,
      lip,
      clock: () => new Date(NOW),
      customerId: () => "customer-001"
    });
    await resolver.resolve({
      tenantId: "sakura",
      programId: "sakura-rewards",
      principal: principal("clerk-user")
    });
    await resolver.deleteCustomer("sakura", "customer-001");

    await expect(
      resolver.resolve({
        tenantId: "sakura",
        programId: "sakura-rewards",
        principal: principal("clerk-user")
      })
    ).rejects.toMatchObject({ code: "customer_deleted" });
  });

  it("rejects conflicting identity and member links", async () => {
    const repository = new MemoryCustomerDirectoryRepository();
    await repository.resolveOrCreateCustomer({
      tenantId: "sakura",
      principal: principal("first"),
      customerId: "customer-first",
      now: NOW
    });
    await repository.resolveOrCreateCustomer({
      tenantId: "sakura",
      principal: principal("second"),
      customerId: "customer-second",
      now: NOW
    });
    await repository.linkExternalIdentity({
      tenantId: "sakura",
      customerId: "customer-first",
      principal: principal("shared"),
      now: NOW
    });
    await expect(
      repository.linkExternalIdentity({
        tenantId: "sakura",
        customerId: "customer-second",
        principal: principal("shared"),
        now: NOW
      })
    ).rejects.toMatchObject({ code: "identity_conflict" });

    await repository.linkMember({
      tenantId: "sakura",
      customerId: "customer-first",
      programId: "sakura-rewards",
      memberId: "member-first",
      now: NOW
    });
    await expect(
      repository.linkMember({
        tenantId: "sakura",
        customerId: "customer-first",
        programId: "sakura-rewards",
        memberId: "member-second",
        now: NOW
      })
    ).rejects.toMatchObject({ code: "member_conflict" });
  });
});
