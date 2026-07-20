import { AsyncSqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import type { ManagedWebhookSubscription } from "./webhooks.js";

interface WebhookSubscriptionState {
  version: 1;
  subscriptions: ManagedWebhookSubscription[];
}

/**
 * Durable store for managed webhook subscriptions. Saves are serialized,
 * unconditional snapshots — the dispatcher is the single writer.
 */
export class SqliteWebhookSubscriptionStore {
  private readonly store: AsyncSqliteStateStore<WebhookSubscriptionState>;
  private tail: Promise<void> = Promise.resolve();

  public constructor(options: { path: string; key: string }) {
    this.store = new AsyncSqliteStateStore<WebhookSubscriptionState>(options);
  }

  public async load(): Promise<ManagedWebhookSubscription[] | undefined> {
    await this.tail;
    const loaded = await this.store.load();
    if (!loaded) return undefined;
    if (loaded.state.version !== 1) {
      throw new Error(`Unsupported webhook subscription state version: ${String(loaded.state.version)}`);
    }
    return structuredClone(loaded.state.subscriptions);
  }

  public save(subscriptions: readonly ManagedWebhookSubscription[]): Promise<void> {
    const snapshot = structuredClone([...subscriptions]);
    const run = this.tail.then(() =>
      this.store.save({ version: 1, subscriptions: snapshot }).then(() => undefined)
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
