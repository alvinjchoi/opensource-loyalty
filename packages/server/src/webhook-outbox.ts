import type { AsyncStateStore } from "@loyalty-interchange/storage";
import type { WebhookOutboxEntry, WebhookOutboxStore } from "./webhooks.js";

export interface WebhookOutboxState {
  version: 1;
  deliveries: WebhookOutboxEntry[];
}

/**
 * Persists pending webhook deliveries in an injected AsyncStateStore (SQLite
 * in the demo platform, tenant-scoped Postgres in cluster mode). Writes are
 * serialized in call order; the dispatcher is the single writer, so saves are
 * unconditional (last-writer-wins) snapshots of the in-memory outbox.
 */
export class WebhookOutboxJournal implements WebhookOutboxStore {
  private readonly store: AsyncStateStore<WebhookOutboxState>;
  private readonly entries: Map<string, WebhookOutboxEntry>;
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    store: AsyncStateStore<WebhookOutboxState>,
    entries: Map<string, WebhookOutboxEntry>
  ) {
    this.store = store;
    this.entries = entries;
  }

  public static async create(options: {
    store: AsyncStateStore<WebhookOutboxState>;
  }): Promise<WebhookOutboxJournal> {
    const loaded = await options.store.load();
    if (loaded && loaded.state.version !== 1) {
      await options.store.close();
      throw new Error(`Unsupported webhook outbox version: ${String(loaded.state.version)}`);
    }
    const entries = new Map(
      (loaded?.state.deliveries ?? []).map((entry) => [entry.delivery_id, entry])
    );
    return new WebhookOutboxJournal(options.store, entries);
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
