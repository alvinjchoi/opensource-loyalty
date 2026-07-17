import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from "jose";
import {
  CustomerPlatformError,
  CustomerProviderUnavailableError
} from "./customer-errors.js";
import type {
  CustomerExternalIdentity,
  CustomerIdentityProvider,
  CustomerProviderKind,
  ProviderDeletionStatus,
  VerifiedContact,
  VerifiedCustomerIdentity
} from "./customer-types.js";

type DeleteIdentity = (
  identity: CustomerExternalIdentity
) => Promise<Exclude<ProviderDeletionStatus, "pending">>;

export interface OidcCustomerIdentityProviderOptions {
  providerId: string;
  tenantId: string;
  issuer: string;
  audience?: string | string[];
  authorizedParties?: string[];
  jwksUri?: string;
  algorithms?: string[];
  clockToleranceSeconds?: number;
  tenantClaim?: string;
  emailClaim?: string;
  emailVerifiedClaim?: string;
  phoneClaim?: string;
  phoneVerifiedClaim?: string;
  key?: JWTVerifyGetKey;
  verify?: typeof jwtVerify;
  deleteIdentity?: DeleteIdentity;
  isProviderUnavailable?: (error: unknown) => boolean;
}

function normalizedIssuer(value: string): string {
  const issuer = value.trim().replace(/\/$/, "");
  if (!issuer) throw new Error("Customer identity issuer is required");
  return issuer;
}

function normalizedList(
  value: string | string[] | undefined,
  label: string
): string[] {
  const values = (Array.isArray(value) ? value : value ? [value] : [])
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (value !== undefined && values.length === 0) {
    throw new Error(`${label} must contain at least one value`);
  }
  return [...new Set(values)];
}

function audienceValues(payload: JWTPayload): string[] {
  return payload.aud
    ? Array.isArray(payload.aud)
      ? payload.aud
      : [payload.aud]
    : [];
}

function isoNumericDate(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return new Date(value * 1_000).toISOString();
}

function verifiedContact(
  payload: JWTPayload,
  valueClaim: string,
  verifiedClaim: string,
  normalize: (value: string) => string
): VerifiedContact | undefined {
  const value = payload[valueClaim];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    payload[verifiedClaim] !== true
  ) {
    return undefined;
  }
  return { value: normalize(value.trim()) };
}

function defaultProviderUnavailable(error: unknown): boolean {
  if (error instanceof CustomerProviderUnavailableError) return true;
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JWKS_FETCH_FAILED") {
    return true;
  }
  return (
    error instanceof TypeError &&
    /fetch|network|socket|connect|timeout/i.test(error.message)
  );
}

export class OidcCustomerIdentityProvider implements CustomerIdentityProvider {
  public readonly provider_id: string;
  public readonly kind: CustomerProviderKind;

  private readonly tenantId: string;
  private readonly issuer: string;
  private readonly audiences: string[];
  private readonly authorizedParties: string[];
  private readonly algorithms: string[];
  private readonly clockTolerance: number;
  private readonly tenantClaim: string | undefined;
  private readonly emailClaim: string;
  private readonly emailVerifiedClaim: string;
  private readonly phoneClaim: string;
  private readonly phoneVerifiedClaim: string;
  private readonly key: JWTVerifyGetKey;
  private readonly verify: typeof jwtVerify;
  private readonly delete: DeleteIdentity;
  private readonly unavailable: (error: unknown) => boolean;

  public constructor(
    options: OidcCustomerIdentityProviderOptions,
    kind: CustomerProviderKind = "oidc"
  ) {
    this.provider_id = options.providerId.trim();
    this.tenantId = options.tenantId.trim();
    if (!this.provider_id || !this.tenantId) {
      throw new Error("Customer provider id and tenant id are required");
    }
    this.kind = kind;
    this.issuer = normalizedIssuer(options.issuer);
    this.audiences = normalizedList(options.audience, "OIDC audience");
    this.authorizedParties = normalizedList(
      options.authorizedParties,
      "OIDC authorized parties"
    );
    this.algorithms = options.algorithms ?? ["RS256", "ES256"];
    this.clockTolerance = options.clockToleranceSeconds ?? 5;
    this.tenantClaim = options.tenantClaim;
    this.emailClaim = options.emailClaim ?? "email";
    this.emailVerifiedClaim = options.emailVerifiedClaim ?? "email_verified";
    this.phoneClaim = options.phoneClaim ?? "phone_number";
    this.phoneVerifiedClaim =
      options.phoneVerifiedClaim ?? "phone_number_verified";
    const jwksUrl = new URL(
      options.jwksUri ?? `${this.issuer}/.well-known/jwks.json`
    );
    if (!options.key && jwksUrl.protocol !== "https:") {
      throw new Error("Customer identity JWKS URI must use HTTPS");
    }
    this.key = options.key ?? createRemoteJWKSet(jwksUrl);
    this.verify = options.verify ?? jwtVerify;
    this.delete =
      options.deleteIdentity ?? (async () => "unsupported" as const);
    this.unavailable =
      options.isProviderUnavailable ?? defaultProviderUnavailable;
  }

  public async verifySession(input: {
    tenant_id: string;
    token: string;
  }): Promise<VerifiedCustomerIdentity> {
    if (input.tenant_id !== this.tenantId) {
      throw new CustomerPlatformError(
        403,
        "tenant_mismatch",
        "Customer token was presented to the wrong tenant"
      );
    }
    if (!input.token.trim()) {
      throw new CustomerPlatformError(
        401,
        "invalid_token",
        "Customer session token is required"
      );
    }
    try {
      const { payload } = await this.verify(input.token, this.key, {
        issuer: this.issuer,
        ...(this.audiences.length > 0
          ? {
              audience:
                this.audiences.length === 1
                  ? this.audiences[0]!
                  : this.audiences
            }
          : {}),
        algorithms: this.algorithms,
        clockTolerance: this.clockTolerance,
        requiredClaims: ["sub", "exp"]
      });
      return this.identity(payload);
    } catch (error) {
      if (error instanceof CustomerPlatformError) throw error;
      if (this.unavailable(error)) {
        throw new CustomerPlatformError(
          503,
          "identity_provider_unavailable",
          "Customer identity verification is temporarily unavailable",
          { cause: error }
        );
      }
      throw new CustomerPlatformError(
        401,
        "invalid_token",
        "Customer session token is invalid",
        { cause: error }
      );
    }
  }

  public async deleteIdentity(
    identity: CustomerExternalIdentity
  ): Promise<Exclude<ProviderDeletionStatus, "pending">> {
    if (
      identity.tenant_id !== this.tenantId ||
      identity.provider_id !== this.provider_id ||
      identity.issuer !== this.issuer
    ) {
      throw new CustomerPlatformError(
        409,
        "identity_provider_mismatch",
        "Customer identity does not belong to this provider"
      );
    }
    return this.delete(identity);
  }

  private identity(payload: JWTPayload): VerifiedCustomerIdentity {
    const subject = payload.sub?.trim();
    const expiresAt = isoNumericDate(payload.exp);
    if (!subject || !expiresAt) {
      throw new CustomerPlatformError(
        401,
        "invalid_token",
        "Customer token requires subject and expiry claims"
      );
    }
    if (
      this.tenantClaim &&
      payload[this.tenantClaim] !== this.tenantId
    ) {
      throw new CustomerPlatformError(
        403,
        "tenant_mismatch",
        "Customer token tenant claim is invalid"
      );
    }
    const authorizedParty =
      typeof payload.azp === "string" ? payload.azp : undefined;
    if (
      this.authorizedParties.length > 0 &&
      (!authorizedParty || !this.authorizedParties.includes(authorizedParty))
    ) {
      throw new CustomerPlatformError(
        401,
        "invalid_token",
        "Customer token authorized party is invalid"
      );
    }
    const email = verifiedContact(
      payload,
      this.emailClaim,
      this.emailVerifiedClaim,
      (value) => value.toLowerCase()
    );
    const phone = verifiedContact(
      payload,
      this.phoneClaim,
      this.phoneVerifiedClaim,
      (value) => value
    );
    const issuedAt = isoNumericDate(payload.iat);
    return {
      provider_id: this.provider_id,
      provider_kind: this.kind,
      tenant_id: this.tenantId,
      issuer: this.issuer,
      subject,
      audiences: audienceValues(payload),
      expires_at: expiresAt,
      ...(issuedAt ? { issued_at: issuedAt } : {}),
      ...(typeof payload.sid === "string" ? { session_id: payload.sid } : {}),
      ...(authorizedParty ? { authorized_party: authorizedParty } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {})
    };
  }
}

export interface ClerkCustomerIdentityProviderOptions
  extends Omit<OidcCustomerIdentityProviderOptions, "algorithms"> {}

export interface Auth0CustomerIdentityProviderOptions
  extends Omit<OidcCustomerIdentityProviderOptions, "algorithms" | "audience"> {
  audience: string | string[];
}

export class Auth0CustomerIdentityProvider extends OidcCustomerIdentityProvider {
  public constructor(options: Auth0CustomerIdentityProviderOptions) {
    super({ ...options, algorithms: ["RS256"] }, "auth0");
  }
}

export class ClerkCustomerIdentityProvider extends OidcCustomerIdentityProvider {
  public constructor(options: ClerkCustomerIdentityProviderOptions) {
    if (!options.audience && !options.authorizedParties?.length) {
      throw new Error(
        "Clerk verification requires an audience or authorized party allowlist"
      );
    }
    super({ ...options, algorithms: ["RS256"] }, "clerk");
  }
}
