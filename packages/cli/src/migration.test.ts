import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoyaltyEngine, type LoyaltyEngineState } from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { makeContext, makeEnroll, makeOrder, makeProgram } from "../../../tests/fixtures.js";
import { runStateExport, runStateImport } from "./migration.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("lip state commands", () => {
  it("exports and imports a complete SQLite archive", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "lip-state-cli-"));
    temporaryDirectories.push(directory);
    const source = resolve(directory, "source.db");
    const target = resolve(directory, "target.db");
    const programPath = resolve(directory, "program.json");
    const archivePath = resolve(directory, "archive.json");
    const program = makeProgram();
    await writeFile(programPath, JSON.stringify(program), "utf8");

    const engine = new LoyaltyEngine(program);
    engine.enroll(makeEnroll());
    engine.postAccrual({
      context: makeContext("cli-migration-accrual"),
      member_id: "member-001",
      order: makeOrder({ order_id: "cli-migration-order" })
    });
    const sourceStore = new SqliteStateStore<LoyaltyEngineState>({
      path: source,
      key: program.program_id
    });
    const state = engine.exportState();
    sourceStore.save(state);
    sourceStore.close();

    const messages: string[] = [];
    const exported = await runStateExport({
      database: source,
      program: programPath,
      output: archivePath
    }, (message) => messages.push(message));
    expect(exported.summary).toMatchObject({
      members: 1,
      balances: 1,
      ledger_entries: 1
    });
    expect(messages.join("\n")).toContain("1 members");

    await runStateImport({
      database: target,
      program: programPath,
      input: archivePath
    }, (message) => messages.push(message));
    const targetStore = new SqliteStateStore<LoyaltyEngineState>({
      path: target,
      key: program.program_id
    });
    expect(targetStore.load()).toEqual(state);
    targetStore.close();
    expect(messages.join("\n")).toContain(`Imported program ${program.program_id}`);
  });
});
