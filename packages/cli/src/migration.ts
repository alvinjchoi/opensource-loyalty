import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProgramDefinition } from "@loyalty-interchange/reference";
import {
  exportPostgresMigration,
  exportSqliteMigration,
  importPostgresMigration,
  importSqliteMigration,
  readMigrationArchive,
  writeMigrationArchive,
  type LoyaltyMigrationArchive
} from "@loyalty-interchange/server";

export interface StateStorageOptions {
  database?: string;
  databaseUrl?: string;
  tenantId?: string;
}

export interface StateExportOptions extends StateStorageOptions {
  program: string;
  output: string;
  force?: boolean;
}

export interface StateImportOptions extends StateStorageOptions {
  program: string;
  input: string;
  force?: boolean;
}

async function loadProgram(path: string): Promise<ProgramDefinition> {
  const resolved = resolve(path);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Unable to read program definition ${resolved}: ${detail}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Program definition ${resolved} must contain a JSON object`);
  }
  return value as ProgramDefinition;
}

function databaseUrl(options: StateStorageOptions): string | undefined {
  return options.databaseUrl ?? process.env.LIP_DATABASE_URL;
}

function databasePath(options: StateStorageOptions): string {
  return resolve(
    options.database ??
    process.env.LIP_DATABASE_PATH ??
    ".lip/reference.db"
  );
}

function tenantId(options: StateStorageOptions, program: ProgramDefinition): string {
  return options.tenantId ?? process.env.LIP_TENANT_ID ?? program.program_id;
}

function formatSummary(action: "Exported" | "Imported", value: LoyaltyMigrationArchive): string {
  return [
    `${action} program ${value.state.program_id}:`,
    `${value.summary.members} members,`,
    `${value.summary.balances} balances,`,
    `${value.summary.ledger_entries} ledger entries,`,
    `${value.summary.open_reservations} open reservations,`,
    `${value.summary.idempotency_records} idempotency records`
  ].join(" ");
}

export async function runStateExport(
  options: StateExportOptions,
  output: (message: string) => void = console.log
): Promise<LoyaltyMigrationArchive> {
  const program = await loadProgram(options.program);
  const postgres = databaseUrl(options);
  const value = postgres
    ? await exportPostgresMigration({
        connectionString: postgres,
        tenantId: tenantId(options, program),
        program
      })
    : exportSqliteMigration({
        databasePath: databasePath(options),
        program
      });
  const target = resolve(options.output);
  await writeMigrationArchive(target, value, { ...(options.force ? { force: true } : {}) });
  output(formatSummary("Exported", value));
  output(`Archive: ${target}`);
  return value;
}

export async function runStateImport(
  options: StateImportOptions,
  output: (message: string) => void = console.log
): Promise<LoyaltyMigrationArchive> {
  const program = await loadProgram(options.program);
  const source = resolve(options.input);
  const value = await readMigrationArchive(source, program);
  const postgres = databaseUrl(options);
  if (postgres) {
    await importPostgresMigration({
      archive: value,
      connectionString: postgres,
      tenantId: tenantId(options, program),
      program,
      ...(options.force ? { force: true } : {})
    });
  } else {
    importSqliteMigration({
      archive: value,
      databasePath: databasePath(options),
      program,
      ...(options.force ? { force: true } : {})
    });
  }
  output(formatSummary("Imported", value));
  return value;
}
