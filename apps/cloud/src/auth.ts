import {
  CustomerIdentityError,
  OidcTokenVerifier,
  type OidcTokenVerifierOptions
} from "@loyalty-interchange/identity";
import { CloudError } from "./service.js";
import type { CloudPrincipal } from "./types.js";

export interface CloudAuthenticationRequest {
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface CloudAuthenticator {
  authenticate(request: CloudAuthenticationRequest): Promise<CloudPrincipal>;
}

export class OidcAuthenticator implements CloudAuthenticator {
  private readonly verifier: OidcTokenVerifier;

  public constructor(options: OidcTokenVerifierOptions) {
    this.verifier = new OidcTokenVerifier(options);
  }

  public async authenticate(
    request: CloudAuthenticationRequest
  ): Promise<CloudPrincipal> {
    try {
      const principal = await this.verifier.verifyAuthorization(request.authorization);
      return {
        issuer: principal.issuer,
        subject: principal.subject,
        ...(principal.email ? { email: principal.email } : {})
      };
    } catch (error) {
      if (error instanceof CloudError) throw error;
      if (
        error instanceof CustomerIdentityError &&
        error.code === "missing_token"
      ) {
        throw new CloudError(401, "unauthorized", error.message);
      }
      throw new CloudError(401, "invalid_token", "OIDC access token is invalid");
    }
  }
}
