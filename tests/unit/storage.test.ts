import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";

describe("SQLite state store", () => {
  it("persists, replaces, and clears JSON state", () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-sqlite-"));
    const path = join(directory, "nested", "reference.db");
    try {
      const first = new SqliteStateStore<{ count: number }>({ path, key: "demo" });
      expect(first.status).toMatchObject({ driver: "sqlite", persistent: true });
      expect(first.load()).toBeNull();
      first.save({ count: 1 });
      first.save({ count: 2 });
      first.close();

      const second = new SqliteStateStore<{ count: number }>({ path, key: "demo" });
      expect(second.load()).toEqual({ count: 2 });
      second.clear();
      expect(second.load()).toBeNull();
      second.close();
      expect(readFileSync(path).length).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects empty state keys", () => {
    expect(() => new SqliteStateStore({ path: ":memory:", key: "" }))
      .toThrowError(/key is required/);
  });
});
