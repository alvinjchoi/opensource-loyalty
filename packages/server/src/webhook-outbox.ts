import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import type { WebhookOutboxEntry, WebhookOutboxStore } from "./webhooks.js";

interface WebhookOutboxState {
  version: 1;
  deliveries: WebhookOutboxEntry[];
}

/**
 * Persists pending webhook deliveries in the same SQLite database as the
 * reference engine, under a separate state key.
 */
export class SqliteWebhookOutbox implements WebhookOutboxStore {
  private readonly store: SqliteStateStore<WebhookOutboxState>;
  private readonly entries = new Map<string, WebhookOutboxEntry>();

  public constructor(options: { path: string; key: string }) {
    this.store = new SqliteStateStore<WebhookOutboxState>(options);
    const state = this.store.load();
    if (state && state.version !== 1) {
      this.store.close();
      throw new Error(`Unsupported webhook outbox version: ${String(state.version)}`);
    }
    for (const entry of state?.deliveries ?? []) {
      this.entries.set(entry.delivery_id, entry);
    }
  }

  public list(): WebhookOutboxEntry[] {
    return [...this.entries.values()];
  }

  public put(entry: WebhookOutboxEntry): void {
    this.entries.set(entry.delivery_id, structuredClone(entry));
    this.save();
  }

  public remove(deliveryId: string): void {
    if (!this.entries.delete(deliveryId)) return;
    this.save();
  }

  public clear(): void {
    this.entries.clear();
    this.store.clear();
  }

  public close(): void {
    this.store.close();
  }

  private save(): void {
    this.store.save({
      version: 1,
      deliveries: [...this.entries.values()]
    });
  }
}
