import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoyaltyEventSchema, validate, type LoyaltyEvent } from "@loyalty-interchange/protocol";
import {
  EventedLoyaltyEngine,
  SqliteWebhookOutbox,
  WebhookDispatcher,
  createDemoPlatform,
  webhookSubscriptionsFromEnv
} from "@loyalty-interchange/server";
import { verifyWebhook } from "@loyalty-interchange/sdk";
import {
  MutableClock,
  makeContext,
  makeEnroll,
  makeOrder,
  makeProgram,
  sequentialIds
} from "../fixtures.js";

interface CapturedRequest {
  url: string;
  timestamp: string;
  signature: string;
  body: string;
}

function capturingFetch(captured: CapturedRequest[], statuses: number[] = []): typeof fetch {
  let call = 0;
  return async (input, init) => {
    const status = statuses[call] ?? 200;
    call += 1;
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(input),
      timestamp: headers.get("lip-webhook-timestamp") ?? "",
      signature: headers.get("lip-webhook-signature") ?? "",
      body: String(init?.body)
    });
    return new Response(null, { status });
  };
}

function makeEvent(overrides: Partial<LoyaltyEvent> = {}): LoyaltyEvent {
  return {
    specversion: "1.0",
    id: "evt-test-001",
    source: "urn:lip:program:demo-foodservice",
    type: "org.loyalty-interchange.member.enrolled.v1",
    subject: "member-001",
    time: "2026-07-01T00:00:00.000Z",
    datacontenttype: "application/json",
    lipversion: "1.0",
    data: {
      member: {
        member_id: "member-001",
        program_id: "demo-foodservice",
        status: "active",
        tier_id: "regular",
        joined_at: "2026-07-01T00:00:00.000Z",
        identities: [{ type: "token", value: "guest-token-001", issuer: "test-identity" }]
      }
    },
    ...overrides
  };
}

function eventedEngine(emitted: LoyaltyEvent[], clock = new MutableClock()): EventedLoyaltyEngine {
  return new EventedLoyaltyEngine(makeProgram(), {
    clock,
    ids: sequentialIds(),
    emit: (event) => emitted.push(event)
  });
}

describe("WebhookDispatcher", () => {
  it("signs deliveries so SDK receivers can verify them", async () => {
    const captured: CapturedRequest[] = [];
    const dispatcher = new WebhookDispatcher({
      subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
      fetch: capturingFetch(captured)
    });
    const event = makeEvent();
    dispatcher.emit(event);
    await dispatcher.flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.body).toBe(JSON.stringify(event));
    await expect(
      verifyWebhook({
        payload: captured[0]!.body,
        secret: "hook-secret",
        timestamp: captured[0]!.timestamp,
        signature: captured[0]!.signature
      })
    ).resolves.toBeUndefined();
    await expect(
      verifyWebhook({
        payload: captured[0]!.body,
        secret: "wrong-secret",
        timestamp: captured[0]!.timestamp,
        signature: captured[0]!.signature
      })
    ).rejects.toMatchObject({ code: "invalid_signature" });
    expect(dispatcher.deliveries()).toEqual([
      expect.objectContaining({
        event_id: "evt-test-001",
        status: "delivered",
        attempts: 1
      })
    ]);
  });

  it("retries failed deliveries with backoff and gives up after max attempts", async () => {
    const retried: CapturedRequest[] = [];
    const recovering = new WebhookDispatcher({
      subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
      fetch: capturingFetch(retried, [500, 503, 200]),
      backoffMs: 1
    });
    recovering.emit(makeEvent());
    await recovering.flush();
    expect(retried).toHaveLength(3);
    expect(recovering.deliveries()).toEqual([
      expect.objectContaining({ status: "delivered", attempts: 3 })
    ]);

    const exhausted: CapturedRequest[] = [];
    const errors: string[] = [];
    const failing = new WebhookDispatcher({
      subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
      fetch: capturingFetch(exhausted, [500, 500, 500]),
      backoffMs: 1,
      onError: (message) => errors.push(message)
    });
    failing.emit(makeEvent());
    await failing.flush();
    expect(exhausted).toHaveLength(3);
    expect(failing.deliveries()).toEqual([
      expect.objectContaining({
        status: "failed",
        attempts: 3,
        last_error: "receiver responded with HTTP 500"
      })
    ]);
    expect(errors).toHaveLength(1);
  });

  it("respects per-subscription event-type filters", async () => {
    const captured: CapturedRequest[] = [];
    const dispatcher = new WebhookDispatcher({
      subscriptions: [
        {
          url: "https://receiver.example/redemptions",
          secret: "hook-secret",
          events: ["org.loyalty-interchange.redemption.captured.v1"]
        }
      ],
      fetch: capturingFetch(captured)
    });
    dispatcher.emit(makeEvent());
    await dispatcher.flush();
    expect(captured).toHaveLength(0);
  });

  it("persists failed deliveries and resumes them after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-webhook-outbox-"));
    const databasePath = join(directory, "reference.db");
    const outboxKey = "demo-foodservice:webhook-outbox";
    try {
      const firstAttempts: CapturedRequest[] = [];
      const firstOutbox = new SqliteWebhookOutbox({ path: databasePath, key: outboxKey });
      const first = new WebhookDispatcher({
        subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
        outbox: firstOutbox,
        fetch: capturingFetch(firstAttempts, [503]),
        maxAttempts: 1
      });
      first.emit(makeEvent());
      await first.flush();

      expect(firstAttempts).toHaveLength(1);
      expect(first.pendingDeliveries()).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({ id: "evt-test-001" }),
          attempts: 1,
          last_error: "receiver responded with HTTP 503"
        })
      ]);
      firstOutbox.close();

      const resumedAttempts: CapturedRequest[] = [];
      const secondOutbox = new SqliteWebhookOutbox({ path: databasePath, key: outboxKey });
      const second = new WebhookDispatcher({
        subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
        outbox: secondOutbox,
        fetch: capturingFetch(resumedAttempts),
        maxAttempts: 1
      });
      second.resumePending();
      await second.flush();

      expect(resumedAttempts).toHaveLength(1);
      expect(second.pendingDeliveries()).toEqual([]);
      expect(second.deliveries()).toEqual([
        expect.objectContaining({
          event_id: "evt-test-001",
          status: "delivered",
          attempts: 2
        })
      ]);
      expect(secondOutbox.list()).toEqual([]);
      secondOutbox.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("EventedLoyaltyEngine", () => {
  it("emits schema-valid events across the loyalty lifecycle", () => {
    const emitted: LoyaltyEvent[] = [];
    const engine = eventedEngine(emitted);

    engine.enroll(makeEnroll());
    engine.postAccrual({
      context: makeContext("webhook-accrual-key"),
      member_id: "member-001",
      order: makeOrder()
    });
    const reserved = engine.reserve({
      context: makeContext("webhook-reserve-key"),
      redemption_id: "redemption-001",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: makeOrder({ order_id: "order-redemption" })
    });
    engine.capture({
      context: makeContext("webhook-capture-key"),
      reservation_id: reserved.reservation.reservation_id,
      order_id: "order-redemption"
    });
    engine.postManualAdjustment({
      context: makeContext("webhook-manual-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      adjustment_id: "webhook-manual-001",
      amount: 10,
      classification: "bonus",
      reason: "Birthday bonus",
      qualifies_for_tier: false
    });

    expect(emitted.map((event) => event.type)).toEqual([
      "org.loyalty-interchange.member.enrolled.v1",
      "org.loyalty-interchange.order.accrued.v1",
      "org.loyalty-interchange.redemption.reserved.v1",
      "org.loyalty-interchange.redemption.captured.v1",
      "org.loyalty-interchange.balance.changed.v1"
    ]);
    for (const event of emitted) {
      const result = validate(LoyaltyEventSchema, event);
      expect(result.ok, JSON.stringify("issues" in result ? result.issues : [])).toBe(true);
      expect(event.source).toBe("urn:lip:program:demo-foodservice");
      expect(event.subject).toBe("member-001");
    }
  });

  it("derives event ids from resource ids so idempotent replays stay deduplicable", () => {
    const emitted: LoyaltyEvent[] = [];
    const engine = eventedEngine(emitted);
    engine.enroll(makeEnroll());

    const request = {
      context: makeContext("webhook-replay-key"),
      member_id: "member-001",
      order: makeOrder()
    };
    engine.postAccrual(request);
    engine.postAccrual({
      ...request,
      context: { ...request.context, request_id: "webhook-replay-request-2" }
    });

    const accrualEvents = emitted.filter(
      (event) => event.type === "org.loyalty-interchange.order.accrued.v1"
    );
    expect(accrualEvents).toHaveLength(2);
    expect(accrualEvents[0]!.id).toBe(accrualEvents[1]!.id);
  });
});

describe("platform webhook wiring", () => {
  it("parses subscriptions from the environment", () => {
    expect(webhookSubscriptionsFromEnv({})).toEqual([]);
    expect(
      webhookSubscriptionsFromEnv({
        LIP_WEBHOOK_URL: "https://receiver.example/hooks",
        LIP_WEBHOOK_SECRET: "hook-secret",
        LIP_WEBHOOK_EVENTS: "org.loyalty-interchange.order.accrued.v1, org.loyalty-interchange.redemption.captured.v1"
      })
    ).toEqual([
      {
        url: "https://receiver.example/hooks",
        secret: "hook-secret",
        events: [
          "org.loyalty-interchange.order.accrued.v1",
          "org.loyalty-interchange.redemption.captured.v1"
        ]
      }
    ]);
    expect(() => webhookSubscriptionsFromEnv({ LIP_WEBHOOK_URL: "https://x.example" })).toThrowError(
      /LIP_WEBHOOK_SECRET/
    );
  });

  it("delivers signed events from a live platform to an HTTP receiver", async () => {
    const received: Array<{ timestamp: string; signature: string; body: string }> = [];
    const receiver = await startReceiver(received);
    const directory = mkdtempSync(join(tmpdir(), "lip-webhooks-"));
    const platform = createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false,
      webhooks: [{ url: receiverUrl(receiver), secret: "platform-secret" }]
    });
    try {
      platform.engine.enroll(makeEnroll("platform-webhook-enroll-key"));
      await platform.webhooks!.flush();

      expect(received).toHaveLength(1);
      await expect(
        verifyWebhook({
          payload: received[0]!.body,
          secret: "platform-secret",
          timestamp: received[0]!.timestamp,
          signature: received[0]!.signature
        })
      ).resolves.toBeUndefined();
      const event = JSON.parse(received[0]!.body) as LoyaltyEvent;
      expect(event.type).toBe("org.loyalty-interchange.member.enrolled.v1");
      expect(validate(LoyaltyEventSchema, event).ok).toBe(true);
    } finally {
      platform.close();
      receiver.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function startReceiver(
  received: Array<{ timestamp: string; signature: string; body: string }>
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        received.push({
          timestamp: String(request.headers["lip-webhook-timestamp"] ?? ""),
          signature: String(request.headers["lip-webhook-signature"] ?? ""),
          body
        });
        response.writeHead(204).end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function receiverUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/hooks`;
}
