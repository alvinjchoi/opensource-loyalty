import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import type { ManagedWebhookSubscription } from "./webhooks.js";

interface WebhookSubscriptionState {
  version: 1;
  subscriptions: ManagedWebhookSubscription[];
}

export class SqliteWebhookSubscriptionStore {
  private readonly store: SqliteStateStore<WebhookSubscriptionState>;

  public constructor(options: { path: string; key: string }) {
    this.store = new SqliteStateStore<WebhookSubscriptionState>(options);
  }

  public load(): ManagedWebhookSubscription[] | undefined {
    const state = this.store.load();
    if (!state) return undefined;
    if (state.version !== 1) {
      throw new Error(`Unsupported webhook subscription state version: ${String(state.version)}`);
    }
    return structuredClone(state.subscriptions);
  }

  public save(subscriptions: readonly ManagedWebhookSubscription[]): void {
    this.store.save({
      version: 1,
      subscriptions: structuredClone([...subscriptions])
    });
  }

  public clear(): void {
    this.store.clear();
  }

  public close(): void {
    this.store.close();
  }
}
