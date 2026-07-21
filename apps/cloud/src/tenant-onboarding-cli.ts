#!/usr/bin/env node

/**
 * Operator CLI for onboarding one brand (= one tenant) onto the shared LIP
 * cluster via the control-plane API:
 *
 *   LIP_CLOUD_API_KEY=... npm run cloud:provision -- \
 *     --cloud-url https://lip-cloud.example.com \
 *     --subject org_business_manager_123 \
 *     --org-slug demo-restaurants --org-name "Demo Restaurants" \
 *     --project-slug loyalty --project-name Loyalty \
 *     --env-slug production --env-name Production \
 *     --kind production --region us-east-1 --program-id demo-rewards
 *
 * Rotate (or first-retrieve) the merchant credential of a provisioned
 * environment — PLA-416 replaces reading credentials files off the disk:
 *
 *   LIP_CLOUD_API_KEY=... npm run cloud:provision -- rotate-credentials \
 *     --cloud-url https://lip-cloud.example.com \
 *     --subject org_business_manager_123 \
 *     --environment env_...
 *
 * The control-plane key comes ONLY from `LIP_CLOUD_API_KEY` (never a flag, to
 * keep it out of shell history); see
 * docs/runbooks/shared-cluster-provisioning.md.
 */

import { parseArgs } from "node:util";
import { provisionTenant, rotateTenantCredentials } from "./tenant-onboarding.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    environment: { type: "string" },
    "cloud-url": { type: "string" },
    subject: { type: "string" },
    email: { type: "string" },
    "org-slug": { type: "string" },
    "org-name": { type: "string" },
    "project-slug": { type: "string" },
    "project-name": { type: "string" },
    "env-slug": { type: "string" },
    "env-name": { type: "string" },
    kind: { type: "string", default: "production" },
    region: { type: "string" },
    "program-id": { type: "string" },
    "timeout-seconds": { type: "string", default: "120" }
  }
});

function required(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== "string" || !value.trim()) {
    console.error(`--${String(name)} is required`);
    process.exit(1);
  }
  return value.trim();
}

const apiKey = process.env["LIP_CLOUD_API_KEY"];
if (!apiKey || apiKey.length < 16) {
  console.error("LIP_CLOUD_API_KEY (>= 16 characters) is required in the environment");
  process.exit(1);
}

const command = positionals[0] ?? "provision";
if (!["provision", "rotate-credentials"].includes(command)) {
  console.error(`Unknown command ${command}; use provision or rotate-credentials`);
  process.exit(1);
}

if (command === "rotate-credentials") {
  try {
    const rotated = await rotateTenantCredentials(
      {
        cloudUrl: required("cloud-url"),
        apiKey,
        subject: required("subject"),
        ...(values.email ? { email: values.email } : {})
      },
      required("environment")
    );
    console.log(JSON.stringify({ event: "tenant_credentials_rotated", ...rotated }, undefined, 2));
    console.error(
      "[note] Store merchant_api_key in the password manager and update the " +
      "consuming BFF now; the replaced key expires after the overlap window."
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "tenant_credential_rotation_failed",
      message: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
  process.exit(0);
}

const kind = required("kind");
if (!["development", "staging", "production"].includes(kind)) {
  console.error("--kind must be development, staging, or production");
  process.exit(1);
}
const timeoutSeconds = Number.parseInt(required("timeout-seconds"), 10);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
  console.error("--timeout-seconds must be a positive integer");
  process.exit(1);
}

try {
  const result = await provisionTenant(
    {
      cloudUrl: required("cloud-url"),
      apiKey,
      subject: required("subject"),
      ...(values.email ? { email: values.email } : {})
    },
    {
      organization: { name: required("org-name"), slug: required("org-slug") },
      project: { name: required("project-name"), slug: required("project-slug") },
      environment: {
        name: required("env-name"),
        slug: required("env-slug"),
        kind: kind as "development" | "staging" | "production",
        region: required("region"),
        programId: required("program-id")
      },
      poll: { timeoutMs: timeoutSeconds * 1_000 }
    }
  );
  console.log(JSON.stringify({ event: "tenant_provisioned", ...result }, undefined, 2));
  if (result.status === "ready") {
    console.error(
      "[note] Retrieve the merchant API key with: npm run cloud:provision -- " +
      `rotate-credentials --cloud-url <url> --subject <subject> --environment ${result.environment_id}`
    );
  }
  if (result.status !== "ready" || result.timed_out) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    event: "tenant_provisioning_failed",
    message: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
}
