#!/usr/bin/env node

/**
 * Release-phase migration runner for the shared LIP cluster.
 *
 * Intended to run as the Render `preDeployCommand` (or any release step)
 * before the control-plane process boots:
 *
 *   node apps/cloud/dist/migrate-cli.js
 *
 * Environment:
 * - `LIP_CLOUD_DATABASE_URL` (falls back to `LIP_DATABASE_URL`) — required.
 * - `LIP_CLOUD_DATA_PLANE_DATABASE_URL` — optional; defaults to the
 *   control-plane database (the shared-cluster topology).
 */

import { runSharedClusterMigrations } from "./migrate.js";

const controlPlaneUrl =
  process.env["LIP_CLOUD_DATABASE_URL"] ??
  process.env["LIP_DATABASE_URL"];
if (!controlPlaneUrl) {
  console.error(JSON.stringify({
    event: "shared_cluster_migrations_failed",
    message: "LIP_CLOUD_DATABASE_URL or LIP_DATABASE_URL is required"
  }));
  process.exit(1);
}

try {
  const result = await runSharedClusterMigrations({
    controlPlaneUrl,
    ...(process.env["LIP_CLOUD_DATA_PLANE_DATABASE_URL"]
      ? { dataPlaneUrl: process.env["LIP_CLOUD_DATA_PLANE_DATABASE_URL"] }
      : {})
  });
  console.log(JSON.stringify({ event: "shared_cluster_migrations_applied", ...result }));
} catch (error) {
  console.error(JSON.stringify({
    event: "shared_cluster_migrations_failed",
    message: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
}
