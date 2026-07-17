import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoyaltyEngine, type LoyaltyEngineState } from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { makeContext, makeEnroll, makeOrder, makeProgram } from "../../../tests/fixtures.js";
import {
  exportSqliteMigration,
  importSqliteMigration,
  parseMigrationArchive,
  readMigrationArchive,
  writeMigrationArchive
} from "./migration.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "lip-migration-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function sourceState(): {
  engine: LoyaltyEngine;
  accrualRequest: Parameters<LoyaltyEngine["postAccrual"]>[0];
  accrualEntryId: string;
} {
  const engine = new LoyaltyEngine(makeProgram());
  engine.enroll(makeEnroll());
  const accrualRequest = {
    context: makeContext("migration-accrual"),
    member_id: "member-001",
    order: makeOrder({ order_id: "migration-order" })
  };
  const accrual = engine.postAccrual(accrualRequest);
  engine.reserve({
    context: makeContext("migration-reserve"),
    redemption_id: "migration-redemption",
    member_id: "member-001",
    reward_id: "one-dollar-off",
    order: makeOrder({ order_id: "migration-redemption-order" })
  });
  return {
    engine,
    accrualRequest,
    accrualEntryId: accrual.entry.entry_id
  };
}

function saveState(path: string, state: LoyaltyEngineState): void {
  const store = new SqliteStateStore<LoyaltyEngineState>({
    path,
    key: state.program_id
  });
  store.save(state);
  store.close();
}

function loadState(path: string, programId: string): LoyaltyEngineState | null {
  const store = new SqliteStateStore<LoyaltyEngineState>({ path, key: programId });
  const state = store.load();
  store.close();
  return state;
}

describe("LIP migration archive", () => {
  it("exports and imports the complete engine state without losing idempotency", async () => {
    const directory = await temporaryDirectory();
    const source = resolve(directory, "source.db");
    const target = resolve(directory, "target.db");
    const output = resolve(directory, "migration.json");
    const program = makeProgram();
    const fixture = sourceState();
    const state = fixture.engine.exportState();
    saveState(source, state);

    const archive = exportSqliteMigration({ databasePath: source, program });
    expect(archive.summary).toMatchObject({
      members: 1,
      balances: 1,
      ledger_entries: 1,
      reservations: 1,
      open_reservations: 1,
      order_accruals: 1
    });
    expect(archive.summary.idempotency_records).toBeGreaterThanOrEqual(3);

    await writeMigrationArchive(output, archive);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const fromFile = await readMigrationArchive(output, program);
    importSqliteMigration({ archive: fromFile, databasePath: target, program });

    expect(loadState(target, program.program_id)).toEqual(state);
    const restored = new LoyaltyEngine(program, { state: fromFile.state });
    const retried = restored.postAccrual({
      ...fixture.accrualRequest,
      context: {
        ...fixture.accrualRequest.context,
        request_id: "migration-retry"
      }
    });
    expect(retried.entry.entry_id).toBe(fixture.accrualEntryId);
    expect(restored.getLedger()).toHaveLength(1);
  });

  it("rejects tampering, a different target program, and accidental overwrite", async () => {
    const directory = await temporaryDirectory();
    const source = resolve(directory, "source.db");
    const target = resolve(directory, "target.db");
    const program = makeProgram();
    const state = sourceState().engine.exportState();
    saveState(source, state);
    const archive = exportSqliteMigration({ databasePath: source, program });

    const tampered = structuredClone(archive);
    tampered.state.points[0]![1] += 1;
    expect(() => parseMigrationArchive(tampered)).toThrow(/checksum/);

    const changedProgram = makeProgram();
    changedProgram.earn_rate.points += 1;
    expect(() => parseMigrationArchive(archive, changedProgram)).toThrow(/target program/);

    importSqliteMigration({ archive, databasePath: target, program });
    expect(() =>
      importSqliteMigration({ archive, databasePath: target, program })
    ).toThrow(/already exists/);
    expect(() =>
      importSqliteMigration({ archive, databasePath: target, program, force: true })
    ).not.toThrow();
  });

  it("refuses missing source databases and existing output files", async () => {
    const directory = await temporaryDirectory();
    const missing = resolve(directory, "missing.db");
    expect(() =>
      exportSqliteMigration({ databasePath: missing, program: makeProgram() })
    ).toThrow(/does not exist/);

    const source = resolve(directory, "source.db");
    const output = resolve(directory, "migration.json");
    const state = sourceState().engine.exportState();
    saveState(source, state);
    const archive = exportSqliteMigration({
      databasePath: source,
      program: makeProgram()
    });
    await writeMigrationArchive(output, archive);
    await expect(writeMigrationArchive(output, archive)).rejects.toThrow();
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      format: "lip-engine-state",
      format_version: 1
    });
  });
});
