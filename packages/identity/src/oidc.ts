import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from "jose";
import {
  CustomerIdentityError,
  type IdentityProviderPrincipal
} from "./types.js";

export interface OidcTokenVerifierOptions {
  issuer: string;
  audience: string | string[];
  jwksUri?: string;
  algorithms?: string[];
  authorizedParties?: string[];
  clockToleranceSeconds?: number;
  emailClaim?: string;
  emailVerifiedClaim?: string;
  phoneNumberClaim?: string;
  phoneNumberVerifiedClaim?: string;
  requireVerifiedEmail?: boolean;
  requireVerifiedPhoneNumber?: boolean;
  key?: JWTVerifyGetKey;
  verify?: typeof jwtVerify;
}

function normalizedIssuer(issuer: string): string {
  return issuer.trim().replace(/\/$/, "");
}

function nonemptyAudience(audience: string | string[]): boolean {
  return typeof audience === "string"
    ? Boolean(audience.trim())
    : audience.length > 0 && audience.every((value) => Boolean(value.trim()));
}

function optionalString(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function bearerToken(authorization?: string): string {
  if (!authorization?.startsWith("Bearer ")) {
    throw new CustomerIdentityError("missing_token", "Bearer authentication is required");
  }
  const token = authorization.slice(7).trim();
  if (!token) {
    throw new CustomerIdentityError("missing_token", "Bearer token is empty");
  }
  return token;
}

/**
 * Standards-based verifier for access tokens issued by Clerk, Auth0, or any
 * compatible OIDC provider. It validates tokens; it never creates sessions or
 * calls provider account-management APIs.
 */
export class OidcTokenVerifier {
  private readonly issuer: string;
  private readonly audience: string | string[];
  private readonly algorithms: string[];
  private readonly authorizedParties: Set<string> | undefined;
  private readonly clockTolerance: number;
  private readonly emailClaim: string;
  private readonly emailVerifiedClaim: string;
  private readonly phoneNumberClaim: string;
  private readonly phoneNumberVerifiedClaim: string;
  private readonly requireVerifiedEmail: boolean;
  private readonly requireVerifiedPhoneNumber: boolean;
  private readonly key: JWTVerifyGetKey;
  private readonly verify: typeof jwtVerify;

  public constructor(options: OidcTokenVerifierOptions) {
    this.issuer = normalizedIssuer(options.issuer);
    if (!this.issuer) {
      throw new CustomerIdentityError("invalid_configuration", "OIDC issuer is required");
    }
    if (!nonemptyAudience(options.audience)) {
      throw new CustomerIdentityError("invalid_configuration", "OIDC audience is required");
    }
    this.audience = options.audience;
    this.algorithms = options.algorithms ?? ["RS256", "ES256"];
    if (this.algorithms.length === 0) {
      throw new CustomerIdentityError(
        "invalid_configuration",
        "At least one OIDC signing algorithm is required"
      );
    }
    this.authorizedParties = options.authorizedParties
      ? new Set(options.authorizedParties.map((value) => value.trim()).filter(Boolean))
      : undefined;
    if (options.authorizedParties && this.authorizedParties?.size === 0) {
      throw new CustomerIdentityError(
        "invalid_configuration",
        "Authorized parties cannot be empty"
      );
    }
    this.clockTolerance = options.clockToleranceSeconds ?? 5;
    this.emailClaim = options.emailClaim ?? "email";
    this.emailVerifiedClaim = options.emailVerifiedClaim ?? "email_verified";
    this.phoneNumberClaim = options.phoneNumberClaim ?? "phone_number";
    this.phoneNumberVerifiedClaim =
      options.phoneNumberVerifiedClaim ?? "phone_number_verified";
    this.requireVerifiedEmail = options.requireVerifiedEmail ?? true;
    this.requireVerifiedPhoneNumber = options.requireVerifiedPhoneNumber ?? true;
    const jwksUri = options.jwksUri ?? `${this.issuer}/.well-known/jwks.json`;
    const jwksUrl = new URL(jwksUri);
    if (!options.key && jwksUrl.protocol !== "https:") {
      throw new CustomerIdentityError(
        "invalid_configuration",
        "OIDC JWKS URI must use HTTPS"
      );
    }
    this.key = options.key ?? createRemoteJWKSet(jwksUrl);
    this.verify = options.verify ?? jwtVerify;
  }

  public async verifyToken(token: string): Promise<IdentityProviderPrincipal> {
    if (!token.trim()) {
      throw new CustomerIdentityError("missing_token", "Bearer token is empty");
    }
    try {
      const { payload } = await this.verify(token, this.key, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: this.algorithms,
        clockTolerance: this.clockTolerance,
        requiredClaims: ["sub"]
      });
      return this.principal(payload);
    } catch (error) {
      if (error instanceof CustomerIdentityError) throw error;
      throw new CustomerIdentityError("invalid_token", "OIDC access token is invalid");
    }
  }

  public verifyAuthorization(authorization?: string): Promise<IdentityProviderPrincipal> {
    return this.verifyToken(bearerToken(authorization));
  }

  private principal(payload: JWTPayload): IdentityProviderPrincipal {
    const subject = payload.sub?.trim();
    if (!subject) {
      throw new CustomerIdentityError("invalid_token", "OIDC subject claim is required");
    }
    if (this.authorizedParties) {
      const authorizedParty = optionalString(payload, "azp");
      if (!authorizedParty || !this.authorizedParties.has(authorizedParty)) {
        throw new CustomerIdentityError(
          "invalid_token",
          "OIDC authorized party is invalid"
        );
      }
    }

    const emailValue = optionalString(payload, this.emailClaim);
    const emailVerified = payload[this.emailVerifiedClaim] === true;
    const email =
      emailValue && (!this.requireVerifiedEmail || emailVerified)
        ? emailValue.toLowerCase()
        : undefined;
    const phoneNumberValue = optionalString(payload, this.phoneNumberClaim);
    const phoneNumberVerified = payload[this.phoneNumberVerifiedClaim] === true;
    const phoneNumber =
      phoneNumberValue && (!this.requireVerifiedPhoneNumber || phoneNumberVerified)
        ? phoneNumberValue
        : undefined;

    return {
      issuer: this.issuer,
      subject,
      ...(email ? { email, emailVerified } : {}),
      ...(phoneNumber ? { phoneNumber, phoneNumberVerified } : {}),
      claims: Object.freeze({ ...payload })
    };
  }
}
