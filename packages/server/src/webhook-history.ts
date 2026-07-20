import { AsyncSqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import type { WebhookDeliveryArchiveEntry, WebhookHistoryStore } from "./webhooks.js";

interface WebhookHistoryState {
  version: 1;
  deliveries: WebhookDeliveryArchiveEntry[];
}

/**
 * Durable archive of completed webhook deliveries. Saves are serialized,
 * unconditional snapshots — the dispatcher is the single writer.
 */
export class SqliteWebhookHistoryStore implements WebhookHistoryStore {
  private readonly store: AsyncSqliteStateStore<WebhookHistoryState>;
  private tail: Promise<void> = Promise.resolve();

  public constructor(options: { path: string; key: string }) {
    this.store = new AsyncSqliteStateStore<WebhookHistoryState>(options);
  }

  public async list(): Promise<WebhookDeliveryArchiveEntry[]> {
    await this.tail;
    const loaded = await this.store.load();
    if (!loaded) return [];
    if (loaded.state.version !== 1) {
      throw new Error(`Unsupported webhook history version: ${String(loaded.state.version)}`);
    }
    return structuredClone(loaded.state.deliveries);
  }

  public save(entries: readonly WebhookDeliveryArchiveEntry[]): Promise<void> {
    const snapshot = structuredClone([...entries]);
    const run = this.tail.then(() =>
      this.store.save({ version: 1, deliveries: snapshot }).then(() => undefined)
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  public async clear(): Promise<void> {
    await this.tail;
    await this.store.clear();
  }

  public async close(): Promise<void> {
    await this.tail;
    await this.store.close();
  }
}
