import { AsyncSqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import type { WebhookOutboxEntry, WebhookOutboxStore } from "./webhooks.js";

interface WebhookOutboxState {
  version: 1;
  deliveries: WebhookOutboxEntry[];
}

/**
 * Persists pending webhook deliveries in the same SQLite database as the
 * reference engine, under a separate state key. Writes are serialized in call
 * order; the dispatcher is the single writer, so saves are unconditional
 * (last-writer-wins) snapshots of the in-memory outbox.
 */
export class SqliteWebhookOutbox implements WebhookOutboxStore {
  private readonly store: AsyncSqliteStateStore<WebhookOutboxState>;
  private readonly entries: Map<string, WebhookOutboxEntry>;
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    store: AsyncSqliteStateStore<WebhookOutboxState>,
    entries: Map<string, WebhookOutboxEntry>
  ) {
    this.store = store;
    this.entries = entries;
  }

  public static async create(options: { path: string; key: string }): Promise<SqliteWebhookOutbox> {
    const store = new AsyncSqliteStateStore<WebhookOutboxState>(options);
    const loaded = await store.load();
    if (loaded && loaded.state.version !== 1) {
      await store.close();
      throw new Error(`Unsupported webhook outbox version: ${String(loaded.state.version)}`);
    }
    const entries = new Map(
      (loaded?.state.deliveries ?? []).map((entry) => [entry.delivery_id, entry])
    );
    return new SqliteWebhookOutbox(store, entries);
  }

  public async list(): Promise<WebhookOutboxEntry[]> {
    await this.tail;
    return [...this.entries.values()].map((entry) => structuredClone(entry));
  }

  public put(entry: WebhookOutboxEntry): Promise<void> {
    this.entries.set(entry.delivery_id, structuredClone(entry));
    return this.enqueueSave();
  }

  public remove(deliveryId: string): Promise<void> {
    if (!this.entries.delete(deliveryId)) return Promise.resolve();
    return this.enqueueSave();
  }

  public async clear(): Promise<void> {
    this.entries.clear();
    await this.tail;
    await this.store.clear();
  }

  public async close(): Promise<void> {
    await this.tail;
    await this.store.close();
  }

  private enqueueSave(): Promise<void> {
    const run = this.tail.then(() =>
      this.store.save({
        version: 1,
        deliveries: [...this.entries.values()]
      }).then(() => undefined)
    );
    this.tail = run.catch(() => undefined);
    return run;
  }
}
