import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import type { WebhookDeliveryArchiveEntry, WebhookHistoryStore } from "./webhooks.js";

interface WebhookHistoryState {
  version: 1;
  deliveries: WebhookDeliveryArchiveEntry[];
}

export class SqliteWebhookHistoryStore implements WebhookHistoryStore {
  private readonly store: SqliteStateStore<WebhookHistoryState>;

  public constructor(options: { path: string; key: string }) {
    this.store = new SqliteStateStore<WebhookHistoryState>(options);
  }

  public list(): WebhookDeliveryArchiveEntry[] {
    const state = this.store.load();
    if (!state) return [];
    if (state.version !== 1) {
      throw new Error(`Unsupported webhook history version: ${String(state.version)}`);
    }
    return structuredClone(state.deliveries);
  }

  public save(entries: readonly WebhookDeliveryArchiveEntry[]): void {
    this.store.save({ version: 1, deliveries: structuredClone([...entries]) });
  }

  public clear(): void {
    this.store.clear();
  }

  public close(): void {
    this.store.close();
  }
}
