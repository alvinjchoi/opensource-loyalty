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
 * The control-plane key comes ONLY from `LIP_CLOUD_API_KEY` (never a flag, to
 * keep it out of shell history). PLA-416 boundary: the merchant data-plane
 * key is written server-side to the environment's credentials file and is not
 * printed here; see docs/runbooks/shared-cluster-provisioning.md.
 */

import { parseArgs } from "node:util";
import { provisionTenant } from "./tenant-onboarding.js";

const { values } = parseArgs({
  options: {
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
      "[note] The merchant API key is in " +
      `<LIP_CLOUD_DATA_DIR>/${result.environment_id}.credentials.json on the ` +
      "data-plane host (tenant-scoped keys pending PLA-416)."
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
