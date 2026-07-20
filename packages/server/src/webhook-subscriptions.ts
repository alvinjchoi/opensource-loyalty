import type { AsyncStateStore } from "@loyalty-interchange/storage";
import type { ManagedWebhookSubscription } from "./webhooks.js";

export interface WebhookSubscriptionState {
  version: 1;
  subscriptions: ManagedWebhookSubscription[];
}

/**
 * Durable store for managed webhook subscriptions over an injected
 * AsyncStateStore. Saves are serialized, unconditional snapshots — the
 * dispatcher is the single writer.
 */
export class WebhookSubscriptionJournal {
  private readonly store: AsyncStateStore<WebhookSubscriptionState>;
  private tail: Promise<void> = Promise.resolve();

  public constructor(options: { store: AsyncStateStore<WebhookSubscriptionState> }) {
    this.store = options.store;
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
