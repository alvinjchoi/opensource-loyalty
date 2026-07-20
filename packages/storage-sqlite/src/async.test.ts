import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateRevisionConflictError } from "@loyalty-interchange/storage";
import { AsyncSqliteStateStore } from "./index.js";
import { SqliteStateStore } from "./index.js";

interface DemoState {
  version: 1;
  entries: string[];
}

describe("AsyncSqliteStateStore", () => {
  const cleanups: Array<() => void> = [];

  const tempPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lip-async-sqlite-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "state.db");
  };

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("returns null when no state was saved", async () => {
    const store = new AsyncSqliteStateStore<DemoState>({ path: tempPath(), key: "demo" });
    expect(await store.load()).toBeNull();
    await store.close();
  });

  it("round-trips state with an incrementing revision", async () => {
    const store = new AsyncSqliteStateStore<DemoState>({ path: tempPath(), key: "demo" });
    const first = await store.save({ version: 1, entries: ["a"] });
    expect(first).toBe(1);

    const loaded = await store.load();
    expect(loaded).toEqual({ state: { version: 1, entries: ["a"] }, revision: 1 });

    const second = await store.save({ version: 1, entries: ["a", "b"] }, first);
    expect(second).toBe(2);
    await store.close();
  });

  it("rejects a save against a stale revision", async () => {
    const store = new AsyncSqliteStateStore<DemoState>({ path: tempPath(), key: "demo" });
    await store.save({ version: 1, entries: [] });
    await store.save({ version: 1, entries: ["a"] }, 1);

    await expect(store.save({ version: 1, entries: ["b"] }, 1)).rejects.toBeInstanceOf(
      StateRevisionConflictError
    );
    await store.close();
  });

  it("clears state so the next load returns null", async () => {
    const store = new AsyncSqliteStateStore<DemoState>({ path: tempPath(), key: "demo" });
    await store.save({ version: 1, entries: ["a"] });
    await store.clear();
    expect(await store.load()).toBeNull();
    await store.close();
  });

  it("reads state written by the legacy sync store at revision 0", async () => {
    const path = tempPath();
    const legacy = new SqliteStateStore<DemoState>({ path, key: "demo" });
    legacy.save({ version: 1, entries: ["legacy"] });
    legacy.close();

    const store = new AsyncSqliteStateStore<DemoState>({ path, key: "demo" });
    const loaded = await store.load();
    expect(loaded?.state).toEqual({ version: 1, entries: ["legacy"] });
    expect(loaded?.revision).toBe(0);
    await store.close();
  });

  it("isolates state between different keys in the same database file", async () => {
    const path = tempPath();
    const one = new AsyncSqliteStateStore<DemoState>({ path, key: "one" });
    const two = new AsyncSqliteStateStore<DemoState>({ path, key: "two" });
    await one.save({ version: 1, entries: ["one"] });
    expect(await two.load()).toBeNull();
    await one.close();
    await two.close();
  });

  it("requires a non-empty key", () => {
    expect(() => new AsyncSqliteStateStore<DemoState>({ path: ":memory:", key: "  " })).toThrow(
      "SQLite state key is required"
    );
  });
});
