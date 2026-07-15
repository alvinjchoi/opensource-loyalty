import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LoyaltyEngine, type LoyaltyEngineState } from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { createDemoProgram, seedDemoData } from "./demo.js";

export interface DemoPlatformOptions {
  databasePath: string;
  reset?: boolean;
  seed?: boolean;
  adminAssetRoot?: string;
}

export interface DemoPlatform {
  engine: LoyaltyEngine;
  store: SqliteStateStore<LoyaltyEngineState>;
  adminAssetRoot?: string;
  close(): void;
}

function discoverAdminAssetRoot(): string | undefined {
  const candidates = [
    fileURLToPath(new URL("./admin/", import.meta.url)),
    fileURLToPath(new URL("../dist/admin/", import.meta.url)),
    fileURLToPath(new URL("../../../apps/admin/dist/", import.meta.url))
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function createDemoPlatform(options: DemoPlatformOptions): DemoPlatform {
  const program = createDemoProgram();
  const store = new SqliteStateStore<LoyaltyEngineState>({
    path: options.databasePath,
    key: program.program_id
  });
  try {
    if (options.reset) store.clear();
    const state = store.load();
    const engine = new LoyaltyEngine(program, state ? { state } : {});
    if (!state && options.seed !== false) seedDemoData(engine);
    store.save(engine.exportState());
    const adminAssetRoot = options.adminAssetRoot ?? discoverAdminAssetRoot();
    return {
      engine,
      store,
      ...(adminAssetRoot ? { adminAssetRoot } : {}),
      close: () => store.close()
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
