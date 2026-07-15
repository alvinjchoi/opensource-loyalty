#!/usr/bin/env node

import { resolve } from "node:path";
import { createDemoPlatform } from "./platform.js";
import { startReferenceServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3210", 10);
const host = process.env.HOST ?? "127.0.0.1";
const apiKey = process.env.LIP_API_KEY ?? "lip-dev-key";
const databasePath = resolve(process.env.LIP_DATABASE_PATH ?? ".lip/reference.db");
const platform = createDemoPlatform({ databasePath, seed: process.env.LIP_SEED_DEMO !== "false" });

const running = await startReferenceServer(platform.engine, {
  apiKey,
  host,
  port,
  reservationTtlSeconds: 120,
  persistState: (state) => platform.store.save(state),
  admin: {
    ...(platform.adminAssetRoot ? { assetRoot: platform.adminAssetRoot } : {}),
    storage: platform.store.status
  }
});

console.log(`LIP reference server listening at ${running.url}`);
console.log(`Bearer token: ${apiKey}`);
console.log(`Admin: ${running.url}/admin/`);
console.log(`State: ${databasePath}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void running.close().then(() => {
      platform.close();
      process.exit(0);
    });
  });
}
