import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from "jose";
import { CloudError } from "./service.js";
import type { CloudPrincipal } from "./types.js";

export interface CloudAuthenticationRequest {
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface CloudAuthenticator {
  authenticate(request: CloudAuthenticationRequest): Promise<CloudPrincipal>;
}

function bearerToken(authorization?: string): string {
  if (!authorization?.startsWith("Bearer ")) {
    throw new CloudError(401, "unauthorized", "Bearer authentication is required");
  }
  const token = authorization.slice(7).trim();
  if (!token) throw new CloudError(401, "unauthorized", "Bearer token is empty");
  return token;
}

export class OidcAuthenticator implements CloudAuthenticator {
  private readonly issuer: string;
  private readonly audience: string | string[];
  private readonly algorithms: string[];
  private readonly clockTolerance: number;
  private readonly emailClaim: string;
  private readonly requireVerifiedEmail: boolean;
  private readonly key: JWTVerifyGetKey;
  private readonly verify: typeof jwtVerify;

  public constructor(options: {
    issuer: string;
    audience: string | string[];
    jwksUri?: string;
    algorithms?: string[];
    clockToleranceSeconds?: number;
    emailClaim?: string;
    requireVerifiedEmail?: boolean;
    key?: JWTVerifyGetKey;
    verify?: typeof jwtVerify;
  }) {
    this.issuer = options.issuer.trim().replace(/\/$/, "");
    if (!this.issuer) throw new Error("OIDC issuer is required");
    this.audience = options.audience;
    if (
      (typeof this.audience === "string" && !this.audience.trim()) ||
      (Array.isArray(this.audience) && this.audience.length === 0)
    ) {
      throw new Error("OIDC audience is required");
    }
    this.algorithms = options.algorithms ?? ["RS256", "ES256"];
    this.clockTolerance = options.clockToleranceSeconds ?? 5;
    this.emailClaim = options.emailClaim ?? "email";
    this.requireVerifiedEmail = options.requireVerifiedEmail ?? true;
    const jwksUri = options.jwksUri ?? `${this.issuer}/.well-known/jwks.json`;
    const jwksUrl = new URL(jwksUri);
    if (!options.key && jwksUrl.protocol !== "https:") {
      throw new Error("OIDC JWKS URI must use HTTPS");
    }
    this.key = options.key ?? createRemoteJWKSet(jwksUrl);
    this.verify = options.verify ?? jwtVerify;
  }

  public async authenticate(
    request: CloudAuthenticationRequest
  ): Promise<CloudPrincipal> {
    const token = bearerToken(request.authorization);
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
      if (error instanceof CloudError) throw error;
      throw new CloudError(401, "invalid_token", "OIDC access token is invalid");
    }
  }

  private principal(payload: JWTPayload): CloudPrincipal {
    if (!payload.sub?.trim()) {
      throw new CloudError(401, "invalid_token", "OIDC subject claim is required");
    }
    const emailValue = payload[this.emailClaim];
    const emailVerified = payload["email_verified"];
    const email =
      typeof emailValue === "string" &&
      emailValue.trim() &&
      (!this.requireVerifiedEmail || emailVerified === true)
        ? emailValue.trim().toLowerCase()
        : undefined;
    return {
      issuer: this.issuer,
      subject: payload.sub,
      ...(email ? { email } : {})
    };
  }
}
