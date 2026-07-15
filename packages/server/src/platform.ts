import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LoyaltyEngine,
  type LoyaltyEngineState,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { createDemoProgram, seedDemoData } from "./demo.js";

export interface DemoPlatformOptions {
  databasePath: string;
  reset?: boolean;
  seed?: boolean;
  adminAssetRoot?: string;
  /**
   * Custom program definition. When provided it replaces the built-in demo
   * program and demo seeding is skipped, because the synthetic members and
   * activity are only valid against the demo program.
   */
  program?: ProgramDefinition;
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
  const program = options.program ?? createDemoProgram();
  const store = new SqliteStateStore<LoyaltyEngineState>({
    path: options.databasePath,
    key: program.program_id
  });
  try {
    if (options.reset) store.clear();
    const state = store.load();
    const engine = new LoyaltyEngine(program, state ? { state } : {});
    if (!state && options.seed !== false && !options.program) seedDemoData(engine);
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
