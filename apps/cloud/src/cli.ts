#!/usr/bin/env node

import { OidcAuthenticator } from "./auth.js";
import { PostgresCloudRepository } from "./postgres-repository.js";
import { CloudControlPlane } from "./service.js";
import { startCloudServer } from "./server.js";

const connectionString =
  process.env["LIP_CLOUD_DATABASE_URL"] ??
  process.env["LIP_DATABASE_URL"];
if (!connectionString) {
  throw new Error("LIP_CLOUD_DATABASE_URL or LIP_DATABASE_URL is required");
}
const apiKey = process.env["LIP_CLOUD_API_KEY"];
const oidcIssuer = process.env["LIP_CLOUD_OIDC_ISSUER"];
const oidcAudience = process.env["LIP_CLOUD_OIDC_AUDIENCE"];
if (Boolean(oidcIssuer) !== Boolean(oidcAudience)) {
  throw new Error("LIP_CLOUD_OIDC_ISSUER and LIP_CLOUD_OIDC_AUDIENCE must be set together");
}
if (!oidcIssuer && (!apiKey || apiKey.length < 16)) {
  throw new Error("LIP_CLOUD_API_KEY must contain at least 16 characters");
}
const authenticator = oidcIssuer && oidcAudience
  ? new OidcAuthenticator({
      issuer: oidcIssuer,
      audience: oidcAudience,
      ...(process.env["LIP_CLOUD_OIDC_JWKS_URI"]
        ? { jwksUri: process.env["LIP_CLOUD_OIDC_JWKS_URI"] }
        : {})
    })
  : undefined;
const regions = (process.env["LIP_CLOUD_REGIONS"] ?? "us-east-1")
  .split(",")
  .map((region) => region.trim())
  .filter(Boolean);
const repository = new PostgresCloudRepository({ connectionString });
const controlPlane = new CloudControlPlane({
  repository,
  regions,
  defaultPlanId: process.env["LIP_CLOUD_DEFAULT_PLAN"] ?? "free"
});
await controlPlane.migrate();
const running = await startCloudServer(controlPlane, {
  ...(authenticator ? { authenticator } : { apiKey: apiKey! }),
  host: process.env["LIP_CLOUD_HOST"] ?? "0.0.0.0",
  port: Number.parseInt(process.env["LIP_CLOUD_PORT"] ?? "3220", 10),
  ...(process.env["LIP_CLOUD_ALLOWED_ORIGINS"]
    ? {
        allowedOrigins: process.env["LIP_CLOUD_ALLOWED_ORIGINS"]
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      }
    : {})
});

console.log(JSON.stringify({
  event: "cloud_control_plane_ready",
  url: running.url,
  regions
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void running.close()
      .then(() => controlPlane.close())
      .then(() => process.exit(0));
  });
}
