import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import {
  LoyaltyEngine,
  programDefinitionFingerprint,
  type LoyaltyEngineState,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import type { PostgresEngineRepository as PostgresEngineRepositoryType } from "@loyalty-interchange/storage-postgres";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";

export const LIP_MIGRATION_FORMAT = "lip-engine-state";
export const LIP_MIGRATION_FORMAT_VERSION = 1;

export interface LoyaltyMigrationSummary {
  members: number;
  balances: number;
  ledger_entries: number;
  reservations: number;
  open_reservations: number;
  idempotency_records: number;
  order_accruals: number;
  order_adjustments: number;
  issued_rewards: number;
}

export interface LoyaltyMigrationArchive {
  format: typeof LIP_MIGRATION_FORMAT;
  format_version: typeof LIP_MIGRATION_FORMAT_VERSION;
  exported_at: string;
  program: ProgramDefinition;
  state: LoyaltyEngineState;
  summary: LoyaltyMigrationSummary;
  checksum: {
    algorithm: "sha256";
    value: string;
  };
}

export interface SqliteMigrationSource {
  databasePath: string;
  program: ProgramDefinition;
}

export interface PostgresMigrationSource {
  connectionString: string;
  tenantId: string;
  program: ProgramDefinition;
}

const postgresStoragePackage = "@loyalty-interchange/storage-postgres";

async function postgresRepository(input: {
  connectionString: string;
  tenantId: string;
  programId: string;
}): Promise<PostgresEngineRepositoryType> {
  // Keep the optional Postgres adapter out of SQLite-only CLI and test paths.
  const storage = await import(postgresStoragePackage) as typeof import(
    "@loyalty-interchange/storage-postgres"
  );
  return new storage.PostgresEngineRepository(input);
}

function checksum(program: ProgramDefinition, state: LoyaltyEngineState): string {
  return createHash("sha256")
    .update(JSON.stringify({ program, state }))
    .digest("hex");
}

function summary(state: LoyaltyEngineState): LoyaltyMigrationSummary {
  return {
    members: state.members.length,
    balances: state.points.length,
    ledger_entries: state.ledger.length,
    reservations: state.reservations.length,
    open_reservations: state.reservations.filter(([, reservation]) =>
      reservation.status === "reserved"
    ).length,
    idempotency_records: state.idempotency.length,
    order_accruals: state.accruals_by_order.length,
    order_adjustments: state.adjustments.length,
    issued_rewards: state.issued_rewards?.length ?? 0
  };
}

function archive(program: ProgramDefinition, state: LoyaltyEngineState): LoyaltyMigrationArchive {
  validateState(program, state);
  return {
    format: LIP_MIGRATION_FORMAT,
    format_version: LIP_MIGRATION_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    program: structuredClone(program),
    state: structuredClone(state),
    summary: summary(state),
    checksum: {
      algorithm: "sha256",
      value: checksum(program, state)
    }
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateState(program: ProgramDefinition, state: LoyaltyEngineState): void {
  if (state.program_id !== program.program_id) {
    throw new Error(
      `Migration state belongs to program ${state.program_id}, expected ${program.program_id}`
    );
  }
  if (state.program_fingerprint !== programDefinitionFingerprint(program)) {
    throw new Error("Migration program fingerprint does not match the engine state");
  }
  new LoyaltyEngine(program, { state });
}

export function parseMigrationArchive(
  value: unknown,
  expectedProgram?: ProgramDefinition
): LoyaltyMigrationArchive {
  if (
    !object(value) ||
    value["format"] !== LIP_MIGRATION_FORMAT ||
    value["format_version"] !== LIP_MIGRATION_FORMAT_VERSION ||
    !object(value["program"]) ||
    !object(value["state"]) ||
    typeof value["exported_at"] !== "string" ||
    !object(value["checksum"]) ||
    value["checksum"]["algorithm"] !== "sha256" ||
    typeof value["checksum"]["value"] !== "string"
  ) {
    throw new Error("Migration archive format is invalid or unsupported");
  }

  const parsed = value as unknown as LoyaltyMigrationArchive;
  if (checksum(parsed.program, parsed.state) !== parsed.checksum.value) {
    throw new Error("Migration archive checksum does not match its contents");
  }
  validateState(parsed.program, parsed.state);
  if (
    expectedProgram &&
    programDefinitionFingerprint(expectedProgram) !==
      programDefinitionFingerprint(parsed.program)
  ) {
    throw new Error("Migration archive program does not match the target program");
  }
  return structuredClone({
    ...parsed,
    summary: summary(parsed.state)
  });
}

export async function readMigrationArchive(
  path: string,
  expectedProgram?: ProgramDefinition
): Promise<LoyaltyMigrationArchive> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Unable to read migration archive: ${detail}`);
  }
  return parseMigrationArchive(value, expectedProgram);
}

export async function writeMigrationArchive(
  path: string,
  value: LoyaltyMigrationArchive,
  options: { force?: boolean } = {}
): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
    mode: 0o600
  });
  await chmod(path, 0o600);
}

export function exportSqliteMigration(input: SqliteMigrationSource): LoyaltyMigrationArchive {
  if (!existsSync(input.databasePath)) {
    throw new Error(`SQLite database does not exist: ${input.databasePath}`);
  }
  const store = new SqliteStateStore<LoyaltyEngineState>({
    path: input.databasePath,
    key: input.program.program_id
  });
  try {
    const state = store.load();
    if (!state) {
      throw new Error(`No engine state exists for program ${input.program.program_id}`);
    }
    return archive(input.program, state);
  } finally {
    store.close();
  }
}

export function importSqliteMigration(input: {
  archive: LoyaltyMigrationArchive;
  databasePath: string;
  program?: ProgramDefinition;
  force?: boolean;
}): void {
  const parsed = parseMigrationArchive(input.archive, input.program);
  const store = new SqliteStateStore<LoyaltyEngineState>({
    path: input.databasePath,
    key: parsed.state.program_id
  });
  try {
    if (store.load() && !input.force) {
      throw new Error(
        `Engine state already exists for program ${parsed.state.program_id}; use force to replace it`
      );
    }
    store.save(parsed.state);
  } finally {
    store.close();
  }
}

export async function exportPostgresMigration(
  input: PostgresMigrationSource
): Promise<LoyaltyMigrationArchive> {
  const store = await postgresRepository({
    connectionString: input.connectionString,
    tenantId: input.tenantId,
    programId: input.program.program_id
  });
  try {
    await store.migrate();
    const stored = await store.load();
    if (!stored) {
      throw new Error(
        `No engine state exists for tenant ${input.tenantId} and program ${input.program.program_id}`
      );
    }
    return archive(input.program, stored.state);
  } finally {
    await store.close();
  }
}

export async function importPostgresMigration(input: {
  archive: LoyaltyMigrationArchive;
  connectionString: string;
  tenantId: string;
  program?: ProgramDefinition;
  force?: boolean;
}): Promise<void> {
  const parsed = parseMigrationArchive(input.archive, input.program);
  const store = await postgresRepository({
    connectionString: input.connectionString,
    tenantId: input.tenantId,
    programId: parsed.state.program_id
  });
  try {
    await store.migrate();
    const existing = await store.load();
    if (existing && !input.force) {
      throw new Error(
        `Engine state already exists for tenant ${input.tenantId} and program ` +
        `${parsed.state.program_id}; use force to replace it`
      );
    }
    await store.save(parsed.state, existing?.revision ?? 0);
  } finally {
    await store.close();
  }
}
