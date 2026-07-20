import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteWebhookHistoryStore,
  SqliteWebhookOutbox,
  SqliteWebhookSubscriptionStore,
  type ManagedWebhookSubscription,
  type WebhookDeliveryArchiveEntry,
  type WebhookOutboxEntry
} from "@loyalty-interchange/server";

const makeOutboxEntry = (id: string): WebhookOutboxEntry => ({
  delivery_id: id,
  event: {
    specversion: "1.0",
    id: `event-${id}`,
    source: "urn:lip:test",
    type: "org.loyalty-interchange.member.enrolled.v1",
    time: "2026-07-20T00:00:00.000Z",
    datacontenttype: "application/json",
    data: {}
  } as unknown as WebhookOutboxEntry["event"],
  url: "https://receiver.example/webhooks",
  attempts: 0,
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-20T00:00:00.000Z"
});

describe("async webhook stores", () => {
  const cleanups: Array<() => void> = [];

  const tempPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lip-webhook-stores-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "state.db");
  };

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("outbox persists puts and removes across reopen", async () => {
    const path = tempPath();
    const outbox = await SqliteWebhookOutbox.create({ path, key: "demo:webhook-outbox" });
    await outbox.put(makeOutboxEntry("a"));
    await outbox.put(makeOutboxEntry("b"));
    await outbox.remove("a");
    expect((await outbox.list()).map((entry) => entry.delivery_id)).toEqual(["b"]);
    await outbox.close();

    const reopened = await SqliteWebhookOutbox.create({ path, key: "demo:webhook-outbox" });
    expect((await reopened.list()).map((entry) => entry.delivery_id)).toEqual(["b"]);
    await reopened.close();
  });

  it("outbox preserves the order of un-awaited writes", async () => {
    const path = tempPath();
    const outbox = await SqliteWebhookOutbox.create({ path, key: "demo:webhook-outbox" });
    void outbox.put(makeOutboxEntry("first"));
    void outbox.put(makeOutboxEntry("second"));
    void outbox.remove("first");
    await outbox.close();

    const reopened = await SqliteWebhookOutbox.create({ path, key: "demo:webhook-outbox" });
    expect((await reopened.list()).map((entry) => entry.delivery_id)).toEqual(["second"]);
    await reopened.close();
  });

  it("history round-trips archive entries", async () => {
    const path = tempPath();
    const history = new SqliteWebhookHistoryStore({ path, key: "demo:webhook-history" });
    const entry: WebhookDeliveryArchiveEntry = {
      ...makeOutboxEntry("archived"),
      event_id: "event-archived",
      event_type: "org.loyalty-interchange.member.enrolled.v1",
      attempts: 1,
      status: "delivered",
      completed_at: "2026-07-20T00:00:01.000Z"
    };
    await history.save([entry]);
    await history.close();

    const reopened = new SqliteWebhookHistoryStore({ path, key: "demo:webhook-history" });
    expect((await reopened.list()).map(({ delivery_id }) => delivery_id)).toEqual(["archived"]);
    await reopened.close();
  });

  it("subscription store round-trips subscriptions and reports absence as undefined", async () => {
    const path = tempPath();
    const store = new SqliteWebhookSubscriptionStore({ path, key: "demo:webhook-subscriptions" });
    expect(await store.load()).toBeUndefined();
    const subscription: ManagedWebhookSubscription = {
      subscription_id: "webhook_test",
      url: "https://receiver.example/webhooks",
      secret: "super-secret-value-123",
      active: true
    };
    await store.save([subscription]);
    await store.close();

    const reopened = new SqliteWebhookSubscriptionStore({ path, key: "demo:webhook-subscriptions" });
    expect((await reopened.load())?.map(({ subscription_id }) => subscription_id)).toEqual(["webhook_test"]);
    await reopened.close();
  });
});
