import { createHash, createHmac } from "node:crypto";
import type { LoyaltyEvent, LoyaltyEventType } from "@loyalty-interchange/protocol";

export interface WebhookSubscription {
  url: string;
  secret: string;
  /** Optional allowlist of event types. All events are delivered when omitted. */
  events?: readonly LoyaltyEventType[];
}

export interface WebhookDeliveryRecord {
  event_id: string;
  event_type: LoyaltyEventType;
  url: string;
  attempts: number;
  status: "delivered" | "failed";
  completed_at: string;
  last_error?: string;
}

export interface WebhookOutboxEntry {
  delivery_id: string;
  event: LoyaltyEvent;
  url: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error?: string;
}

export interface WebhookOutboxStore {
  list(): WebhookOutboxEntry[];
  put(entry: WebhookOutboxEntry): void;
  remove(deliveryId: string): void;
}

export interface WebhookAdminStatus {
  enabled: boolean;
  pending: Array<{
    delivery_id: string;
    event_id: string;
    event_type: LoyaltyEventType;
    url: string;
    attempts: number;
    created_at: string;
    updated_at: string;
    last_error?: string;
  }>;
  recent: WebhookDeliveryRecord[];
}

export interface WebhookDispatcherOptions {
  subscriptions: readonly WebhookSubscription[];
  /** Total attempts per delivery including the first one. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay between attempts; doubles per retry. Defaults to 250ms. */
  backoffMs?: number;
  /** Per-request timeout. Defaults to 5000ms. */
  timeoutMs?: number;
  /** How many completed delivery records to retain. Defaults to 200. */
  historyLimit?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  onError?: (message: string) => void;
  /**
   * Durable storage for pending deliveries. Failed deliveries remain in the
   * outbox and are retried when `resumePending()` is called after restart.
   */
  outbox?: WebhookOutboxStore;
}

/**
 * Computes the `LIP-Webhook-Signature` value for a payload per spec/webhooks.md:
 * unpadded base64url of HMAC-SHA256(secret, `${timestamp}.${body}`).
 */
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
  return `v1=${digest}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deliveryId(event: LoyaltyEvent, url: string): string {
  return createHash("sha256")
    .update(`${event.source}\0${event.id}\0${url}`)
    .digest("hex");
}

class MemoryWebhookOutbox implements WebhookOutboxStore {
  private readonly entries = new Map<string, WebhookOutboxEntry>();

  public list(): WebhookOutboxEntry[] {
    return [...this.entries.values()];
  }

  public put(entry: WebhookOutboxEntry): void {
    this.entries.set(entry.delivery_id, entry);
  }

  public remove(deliveryIdValue: string): void {
    this.entries.delete(deliveryIdValue);
  }
}

/**
 * Delivers CloudEvents to webhook subscribers with the normative LIP signature
 * headers, bounded retry cycles, a durable outbox, and an inspectable delivery
 * history. Deliveries are fire-and-forget from the caller's perspective; use
 * `flush()` to await the current retry cycle (for tests and graceful shutdown).
 */
export class WebhookDispatcher {
  private readonly subscriptions: readonly WebhookSubscription[];
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly historyLimit: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly onError: ((message: string) => void) | undefined;
  private readonly outbox: WebhookOutboxStore;
  private readonly queued = new Map<string, WebhookOutboxEntry>();
  private readonly history: WebhookDeliveryRecord[] = [];
  private readonly pending = new Map<string, Promise<void>>();

  public constructor(options: WebhookDispatcherOptions) {
    this.subscriptions = [...options.subscriptions];
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.historyLimit = options.historyLimit ?? 200;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
    this.outbox = options.outbox ?? new MemoryWebhookOutbox();
    for (const entry of this.outbox.list()) {
      this.queued.set(entry.delivery_id, entry);
    }
  }

  public emit(event: LoyaltyEvent): void {
    for (const subscription of this.subscriptions) {
      if (subscription.events && !subscription.events.includes(event.type)) continue;
      const id = deliveryId(event, subscription.url);
      const existing = this.queued.get(id);
      const timestamp = this.now().toISOString();
      const entry: WebhookOutboxEntry = existing ?? {
        delivery_id: id,
        event,
        url: subscription.url,
        attempts: 0,
        created_at: timestamp,
        updated_at: timestamp
      };
      this.queued.set(id, entry);
      this.outbox.put(entry);
      this.schedule(entry, subscription);
    }
  }

  /**
   * Retries every persisted delivery whose subscription is still configured.
   * Call once after platform startup.
   */
  public resumePending(): void {
    for (const entry of this.queued.values()) {
      const subscription = this.subscriptions.find((candidate) => candidate.url === entry.url);
      if (!subscription) {
        this.onError?.(`webhook delivery ${entry.delivery_id} has no configured subscription for ${entry.url}`);
        continue;
      }
      this.schedule(entry, subscription);
    }
  }

  /** Waits until every in-flight delivery has completed its current retry cycle. */
  public async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending.values()]);
    }
  }

  /** Persisted deliveries still awaiting a successful 2xx response. */
  public pendingDeliveries(): WebhookOutboxEntry[] {
    return [...this.queued.values()];
  }

  public inFlightDeliveries(): number {
    return this.pending.size;
  }

  public adminStatus(): WebhookAdminStatus {
    return {
      enabled: this.subscriptions.length > 0,
      pending: [...this.queued.values()].map((entry) => ({
        delivery_id: entry.delivery_id,
        event_id: entry.event.id,
        event_type: entry.event.type,
        url: entry.url,
        attempts: entry.attempts,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        ...(entry.last_error ? { last_error: entry.last_error } : {})
      })),
      recent: this.deliveries()
    };
  }

  /** Completed delivery records, oldest first. */
  public deliveries(): WebhookDeliveryRecord[] {
    return [...this.history];
  }

  private record(record: WebhookDeliveryRecord): void {
    this.history.push(record);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }

  private schedule(entry: WebhookOutboxEntry, subscription: WebhookSubscription): void {
    if (this.pending.has(entry.delivery_id)) return;
    const delivery = this.deliver(subscription, entry).catch((error: unknown) => {
      this.onError?.(`webhook delivery crashed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.pending.set(entry.delivery_id, delivery);
    void delivery.finally(() => this.pending.delete(entry.delivery_id));
  }

  private async deliver(
    subscription: WebhookSubscription,
    entry: WebhookOutboxEntry
  ): Promise<void> {
    const body = JSON.stringify(entry.event);
    let lastError = "delivery was not attempted";
    for (let cycleAttempt = 1; cycleAttempt <= this.maxAttempts; cycleAttempt += 1) {
      if (cycleAttempt > 1) await sleep(this.backoffMs * 2 ** (cycleAttempt - 2));
      entry.attempts += 1;
      entry.updated_at = this.now().toISOString();
      delete entry.last_error;
      this.outbox.put(entry);
      const timestamp = Math.floor(this.now().getTime() / 1000);
      try {
        const response = await this.fetchImpl(subscription.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "lip-webhook-timestamp": `${timestamp}`,
            "lip-webhook-signature": signWebhookPayload(subscription.secret, timestamp, body)
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (response.ok) {
          this.queued.delete(entry.delivery_id);
          this.outbox.remove(entry.delivery_id);
          this.record({
            event_id: entry.event.id,
            event_type: entry.event.type,
            url: subscription.url,
            attempts: entry.attempts,
            status: "delivered",
            completed_at: this.now().toISOString()
          });
          return;
        }
        lastError = `receiver responded with HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      entry.last_error = lastError;
      entry.updated_at = this.now().toISOString();
      this.outbox.put(entry);
    }
    this.record({
      event_id: entry.event.id,
      event_type: entry.event.type,
      url: subscription.url,
      attempts: entry.attempts,
      status: "failed",
      completed_at: this.now().toISOString(),
      last_error: lastError
    });
    this.onError?.(
      `webhook delivery to ${subscription.url} failed after ${this.maxAttempts} attempts: ${lastError}`
    );
  }
}
