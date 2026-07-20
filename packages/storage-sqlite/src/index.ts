import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  StateRevisionConflictError,
  type AsyncStateStore,
  type StateStore,
  type StateStoreStatus,
  type VersionedState
} from "@loyalty-interchange/storage";

interface StateRow {
  value: string;
}

interface VersionedStateRow {
  value: string;
  revision: number;
}

export interface SqliteStateStoreOptions {
  path: string;
  key: string;
}

export class SqliteStateStore<T> implements StateStore<T> {
  private readonly database: Database.Database;
  private readonly key: string;
  public readonly status: StateStoreStatus;

  public constructor(options: SqliteStateStoreOptions) {
    if (!options.key.trim()) throw new Error("SQLite state key is required");
    const location = options.path === ":memory:" ? options.path : resolve(options.path);
    if (location !== ":memory:") mkdirSync(dirname(location), { recursive: true });

    this.key = options.key;
    this.database = new Database(location);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS lip_state (
        state_key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.status = {
      driver: "sqlite",
      location,
      persistent: location !== ":memory:"
    };
  }

  public load(): T | null {
    const row = this.database
      .prepare("SELECT value FROM lip_state WHERE state_key = ?")
      .get(this.key) as StateRow | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      throw new Error(`Stored state for ${this.key} is not valid JSON`);
    }
  }

  public save(state: T): void {
    const value = JSON.stringify(state);
    this.database.prepare(`
      INSERT INTO lip_state (state_key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(this.key, value, new Date().toISOString());
  }

  public clear(): void {
    this.database.prepare("DELETE FROM lip_state WHERE state_key = ?").run(this.key);
  }

  public close(): void {
    this.database.close();
  }
}

export interface AsyncSqliteStateStoreOptions {
  path: string;
  key: string;
}

export class AsyncSqliteStateStore<T> implements AsyncStateStore<T> {
  private readonly database: Database.Database;
  private readonly key: string;
  public readonly status: StateStoreStatus;

  public constructor(options: AsyncSqliteStateStoreOptions) {
    if (!options.key.trim()) throw new Error("SQLite state key is required");
    const location = options.path === ":memory:" ? options.path : resolve(options.path);
    if (location !== ":memory:") mkdirSync(dirname(location), { recursive: true });

    this.key = options.key;
    this.database = new Database(location);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS lip_state (
        state_key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const columns = this.database.prepare("SELECT name FROM pragma_table_info('lip_state')").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "revision")) {
      this.database.exec("ALTER TABLE lip_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    }
    this.status = {
      driver: "sqlite",
      location,
      persistent: location !== ":memory:"
    };
  }

  public async load(): Promise<VersionedState<T> | null> {
    const row = this.database
      .prepare("SELECT value, revision FROM lip_state WHERE state_key = ?")
      .get(this.key) as VersionedStateRow | undefined;
    if (!row) return null;
    try {
      return { state: JSON.parse(row.value) as T, revision: row.revision };
    } catch {
      throw new Error(`Stored state for ${this.key} is not valid JSON`);
    }
  }

  public async save(state: T, expectedRevision?: number): Promise<number> {
    const value = JSON.stringify(state);
    const nextRevision = this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT revision FROM lip_state WHERE state_key = ?")
        .get(this.key) as { revision: number } | undefined;
      const currentRevision = row?.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new StateRevisionConflictError(expectedRevision, currentRevision);
      }
      const revision = currentRevision + 1;
      this.database.prepare(`
        INSERT INTO lip_state (state_key, value, updated_at, revision)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(this.key, value, new Date().toISOString(), revision);
      return revision;
    })();
    return nextRevision;
  }

  public async clear(): Promise<void> {
    this.database.prepare("DELETE FROM lip_state WHERE state_key = ?").run(this.key);
  }

  public async close(): Promise<void> {
    this.database.close();
  }
}
