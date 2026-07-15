import { describe, expect, it } from "vitest";
import {
  FoodserviceOrderBuilder,
  LipClient,
  LipOpenApiHttpError,
  LipOpenApiResponseError,
  LipTransportError,
  LipValidationError,
  addMoney,
  createLipOpenApiClient,
  formatMoney,
  generatedOperations,
  money,
  moneyFromDecimal,
  signWebhook,
  verifyWebhook,
  zeroMoney
} from "@loyalty-interchange/sdk";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { startReferenceServer } from "@loyalty-interchange/server";
import { makeOrder, makeProgram } from "../fixtures.js";

function deterministicIds(): (prefix: "request" | "idempotency") => string {
  let sequence = 0;
  return (prefix) => `${prefix}-${++sequence}`;
}

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({
    type: `https://loyalty-interchange.org/problems/${code}`,
    title: "Request failed",
    status,
    code
  }), {
    status,
    headers: { "content-type": "application/problem+json" }
  });
}

describe("SDK money helpers", () => {
  it("converts and formats exact decimal money without floating point", () => {
    expect(moneyFromDecimal("12.34", "USD")).toEqual({ amount: 1234, currency: "USD" });
    expect(moneyFromDecimal("-0.5", "USD")).toEqual({ amount: -50, currency: "USD" });
    expect(moneyFromDecimal("42", "JPY", 0)).toEqual({ amount: 42, currency: "JPY" });
    expect(formatMoney(money(-50, "USD"))).toBe("-0.50 USD");
    expect(formatMoney(money(42, "JPY"), 0)).toBe("42 JPY");
    expect(addMoney(money(100, "USD"), money(25, "USD"))).toEqual({
      amount: 125,
      currency: "USD"
    });
    expect(addMoney(
      money(Number.MAX_SAFE_INTEGER, "USD"),
      money(2, "USD"),
      money(-Number.MAX_SAFE_INTEGER, "USD")
    )).toEqual({ amount: 2, currency: "USD" });
    expect(zeroMoney("USD")).toEqual({ amount: 0, currency: "USD" });
  });

  it("rejects ambiguous decimals, currencies, scales, and mixed addition", () => {
    expect(() => moneyFromDecimal("1.001", "USD")).toThrow(/more than 2/);
    expect(() => moneyFromDecimal("$1.00", "USD")).toThrow(/optional sign/);
    expect(() => moneyFromDecimal("1", "usd")).toThrow(/uppercase/);
    expect(() => moneyFromDecimal("1", "USD", -1)).toThrow(/scale/);
    expect(() => money(1.5, "USD")).toThrow(/safe integer/);
    expect(() => addMoney()).toThrow(/at least one/);
    expect(() => addMoney(money(1, "USD"), money(1, "CAD"))).toThrow(/different currencies/);
  });
});

describe("FoodserviceOrderBuilder", () => {
  it("builds a reconciled paid order with modifiers and tenders", () => {
    const order = new FoodserviceOrderBuilder({
      orderId: "builder-order-1",
      orderNumber: "1001",
      scope: {
        program_id: "demo-foodservice",
        brand_id: "demo-brand",
        merchant_id: "merchant-west",
        location_id: "location-42",
        franchisee_id: "franchisee-7"
      },
      memberId: "member-001",
      currency: "USD",
      channel: "drive_thru",
      businessDate: "2026-07-14",
      placedAt: "2026-07-14T10:05:00.000Z",
      status: "paid"
    })
      .addItem({
        lineId: "line-1",
        productId: "burger-1",
        name: "Classic Burger",
        unitPrice: moneyFromDecimal("10.00", "USD"),
        discount: moneyFromDecimal("1.00", "USD"),
        tax: moneyFromDecimal("0.80", "USD")
      })
      .addModifier("line-1", {
        lineId: "line-2",
        productId: "extra-cheese",
        unitPrice: moneyFromDecimal("1.00", "USD"),
        tax: moneyFromDecimal("0.08", "USD")
      })
      .addFee({
        lineId: "line-3",
        productId: "packaging-fee",
        unitPrice: moneyFromDecimal("0.50", "USD")
      })
      .setTip(moneyFromDecimal("1.00", "USD"))
      .setServiceCharge(moneyFromDecimal("0.50", "USD"))
      .addTender({
        tenderId: "tender-1",
        type: "card",
        amount: moneyFromDecimal("12.88", "USD")
      })
      .close("2026-07-14T10:08:00.000Z")
      .build();

    expect(order).toMatchObject({
      status: "paid",
      closed_at: "2026-07-14T10:08:00.000Z",
      totals: {
        subtotal: { amount: 1150 },
        discount: { amount: 100 },
        tax: { amount: 88 },
        tip: { amount: 100 },
        service_charge: { amount: 50 },
        total: { amount: 1288 }
      },
      lines: [
        { line_id: "line-1", subtotal: { amount: 1000 } },
        { line_id: "line-2", parent_line_id: "line-1", subtotal: { amount: 100 } },
        { line_id: "line-3", kind: "fee", subtotal: { amount: 50 } }
      ]
    });
  });

  it("rejects invalid quantities, currencies, parents, and unreconciled tenders", () => {
    const options = {
      orderId: "bad-builder-order",
      scope: {
        program_id: "demo-foodservice",
        brand_id: "demo-brand",
        merchant_id: "merchant-west",
        location_id: "location-42"
      },
      currency: "USD",
      channel: "counter" as const,
      businessDate: "2026-07-14",
      placedAt: "2026-07-14T10:05:00.000Z",
      status: "paid" as const
    };
    expect(() => new FoodserviceOrderBuilder(options).addItem({
      lineId: "line-1",
      productId: "item",
      unitPrice: money(100, "USD"),
      quantity: 0
    })).toThrow(/quantity/);
    expect(() => new FoodserviceOrderBuilder(options).addItem({
      lineId: "line-1",
      productId: "item",
      unitPrice: money(100, "CAD")
    })).toThrow(/expected USD/);

    const invalidParent = new FoodserviceOrderBuilder(options)
      .addModifier("missing", {
        lineId: "line-1",
        productId: "modifier",
        unitPrice: money(100, "USD")
      });
    expect(() => invalidParent.build()).toThrow(LipValidationError);

    const badTender = new FoodserviceOrderBuilder(options)
      .addItem({ lineId: "line-1", productId: "item", unitPrice: money(100, "USD") })
      .addTender({ tenderId: "tender", type: "cash", amount: money(99, "USD") });
    expect(() => badTender.build()).toThrow(/tenders/);
  });
});

describe("SDK webhook signatures", () => {
  const payload = JSON.stringify({ type: "org.loyalty-interchange.balance.changed.v1" });
  const secret = "test-webhook-secret-with-at-least-32-bytes";
  const timestamp = 1_700_000_000;
  const now = () => new Date(timestamp * 1000);

  it("signs and verifies raw payloads with rotation-friendly headers", async () => {
    const signed = await signWebhook(payload, secret, timestamp);
    expect(signed.timestamp).toBe(`${timestamp}`);
    expect(signed.signature).toMatch(/^v1=[A-Za-z0-9_-]+$/);

    await expect(verifyWebhook({
      payload,
      secret,
      timestamp: signed.timestamp,
      signature: `v2=ignored,v1=invalid,${signed.signature}`,
      now
    })).resolves.toBeUndefined();

    const bytes = new TextEncoder().encode(payload);
    await expect(verifyWebhook({
      payload: bytes,
      secret: new TextEncoder().encode(secret),
      timestamp: signed.timestamp,
      signature: signed.signature,
      now
    })).resolves.toBeUndefined();
  });

  it("rejects changed payloads, stale timestamps, and malformed headers", async () => {
    const signed = await signWebhook(payload, secret, timestamp);
    await expect(verifyWebhook({
      payload: `${payload} `,
      secret,
      timestamp: signed.timestamp,
      signature: signed.signature,
      now
    })).rejects.toMatchObject({ code: "invalid_signature" });

    await expect(verifyWebhook({
      payload,
      secret,
      timestamp: signed.timestamp,
      signature: signed.signature,
      now: () => new Date((timestamp + 301) * 1000)
    })).rejects.toMatchObject({ code: "timestamp_out_of_tolerance" });

    await expect(verifyWebhook({
      payload,
      secret,
      timestamp: "not-a-timestamp",
      signature: "v1=invalid",
      now
    })).rejects.toMatchObject({ code: "invalid_header" });

    await expect(verifyWebhook({
      payload,
      secret,
      timestamp: signed.timestamp,
      signature: "v2=unsupported",
      now
    })).rejects.toMatchObject({ code: "invalid_header" });
  });

  it("rejects invalid signing and tolerance options", async () => {
    await expect(signWebhook(payload, secret, -1)).rejects.toThrow(/timestamp/);
    const signed = await signWebhook(payload, secret, timestamp);
    await expect(verifyWebhook({
      payload,
      secret,
      timestamp: signed.timestamp,
      signature: signed.signature,
      toleranceSeconds: -1,
      now
    })).rejects.toThrow(/tolerance/);
  });
});

describe("generated OpenAPI client", () => {
  it("preserves paths, authentication, schema names, and retry safety from OpenAPI", () => {
    expect(Object.keys(generatedOperations)).toHaveLength(14);
    expect(generatedOperations.discoverLoyaltyProtocol).toMatchObject({
      path: "/.well-known/lip",
      authenticated: false,
      safeToRetry: true,
      responseSchema: "WellKnownDocument"
    });
    expect(generatedOperations.lookupMember).toMatchObject({
      path: "/lip/v1/members/lookup",
      authenticated: true,
      safeToRetry: true,
      requestSchema: "MemberLookupRequest",
      responseSchema: "MemberLookupResponse"
    });
    expect(generatedOperations.enrollMember.safeToRetry).toBe(false);
    expect(generatedOperations.listLedgerEntries).toMatchObject({
      path: "/lip/v1/ledger/list",
      safeToRetry: true,
      requestSchema: "LedgerListRequest",
      responseSchema: "LedgerListResponse"
    });
  });

  it("executes a typed operation with the generated path and bearer authentication", async () => {
    let receivedUrl = "";
    let receivedRequest: RequestInit | undefined;
    const client = createLipOpenApiClient({
      baseUrl: "https://loyalty.example.test/",
      apiKey: async () => "generated-client-key",
      fetch: async (input, init) => {
        receivedUrl = input.toString();
        receivedRequest = init;
        const request = JSON.parse(init?.body as string) as { context: { request_id: string } };
        return new Response(JSON.stringify({
          context: {
            protocol_version: "1.0",
            profile: "foodservice/1.0",
            request_id: request.context.request_id,
            processed_at: "2026-07-14T10:00:00.000Z"
          },
          member: null,
          balances: []
        }), { status: 200 });
      }
    });

    const result = await client.lookupMember({
      context: {
        protocol_version: "1.0",
        profile: "foodservice/1.0",
        request_id: "generated-request-1",
        idempotency_key: "generated-idempotency-1",
        occurred_at: "2026-07-14T10:00:00.000Z",
        source: { system: "generated-client-test" }
      },
      program_id: "demo-foodservice",
      identity: { type: "token", value: "guest-token" }
    });

    expect(result.member).toBeNull();
    expect(receivedUrl).toBe("https://loyalty.example.test/lip/v1/members/lookup");
    expect(new Headers(receivedRequest?.headers).get("authorization"))
      .toBe("Bearer generated-client-key");
    expect(new Headers(receivedRequest?.headers).get("content-type")).toBe("application/json");
  });

  it("exposes stable low-level errors for missing credentials, HTTP failures, and invalid JSON", async () => {
    const missingKey = createLipOpenApiClient({
      baseUrl: "https://loyalty.example.test",
      fetch: async () => { throw new Error("fetch should not be called"); }
    });
    await expect(missingKey.getCapabilities()).rejects.toThrow(/apiKey is required/);

    const httpFailure = createLipOpenApiClient({
      baseUrl: "https://loyalty.example.test",
      apiKey: "bad-key",
      fetch: async () => problemResponse(401, "unauthorized")
    });
    await expect(httpFailure.getCapabilities()).rejects.toBeInstanceOf(LipOpenApiHttpError);

    const invalidJson = createLipOpenApiClient({
      baseUrl: "https://loyalty.example.test",
      fetch: async () => new Response("not-json", { status: 200 })
    });
    await expect(invalidJson.getHealth()).rejects.toBeInstanceOf(LipOpenApiResponseError);
  });
});

describe("LipClient", () => {
  it("executes the complete lifecycle without manually constructing context", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "sdk-integration-key"
    });
    try {
      const client = new LipClient({
        baseUrl: running.url,
        apiKey: "sdk-integration-key",
        source: { system: "sdk-test", instance: "lane-1" },
        clock: () => new Date("2026-07-14T10:00:00.000Z"),
        idGenerator: deterministicIds()
      });

      await expect(client.discover()).resolves.toMatchObject({ protocol: "LIP" });
      await expect(client.capabilities()).resolves.toMatchObject({
        operations: expect.arrayContaining(["order.evaluate", "accrual.post"])
      });

      const enrolled = await client.members.enroll({
        program_id: "demo-foodservice",
        identity: { type: "token", value: "sdk-guest-token", issuer: "sdk-test" },
        member_id: "member-001"
      }, { idempotencyKey: "sdk-enroll-key" });
      expect(enrolled.member.member_id).toBe("member-001");

      const program = await client.programs.get({ program_id: "demo-foodservice" });
      expect(program.program.tiers).toHaveLength(3);

      const initialAccount = await client.accounts.get({
        member_id: "member-001",
        program_id: "demo-foodservice"
      });
      expect(initialAccount.tier_progress).toMatchObject({ current_tier_id: "starter" });

      const evaluated = await client.orders.evaluate({
        member_id: "member-001",
        order: makeOrder()
      });
      expect(evaluated.estimated_accrual.amount).toBe(110);

      const accrued = await client.accruals.post({
        member_id: "member-001",
        order: makeOrder()
      }, { idempotencyKey: "sdk-accrual-key" });
      expect(accrued.balances[0]?.amount).toBe(110);
      expect(accrued.entry.expires_at).toEqual(expect.any(String));

      const account = await client.accounts.get({
        member_id: "member-001",
        program_id: "demo-foodservice"
      });
      expect(account).toMatchObject({
        member: { tier_id: "regular" },
        expiring_balances: [{ amount: 110, expires_at: accrued.entry.expires_at }],
        tier_progress: { current_tier_id: "regular", remaining_to_next: 140 }
      });

      const tierEvaluation = await client.orders.evaluate({
        member_id: "member-001",
        order: makeOrder({ order_id: "sdk-tier-rate-order" })
      });
      expect(tierEvaluation.estimated_accrual.amount).toBe(132);

      const history = await client.ledger.list({
        member_id: "member-001",
        program_id: "demo-foodservice",
        operations: ["accrual"]
      });
      expect(history.entries).toEqual([
        expect.objectContaining({ operation: "accrual", amount: 110 })
      ]);

      const reserved = await client.redemptions.reserve({
        redemption_id: "sdk-redemption-1",
        member_id: "member-001",
        reward_id: "one-dollar-off",
        order: makeOrder({ order_id: "sdk-redemption-order" })
      });
      expect(reserved.balances[0]).toMatchObject({ reserved: 100, available: 10 });

      const captured = await client.redemptions.capture({
        reservation_id: reserved.reservation.reservation_id,
        order_id: "sdk-redemption-order"
      });
      expect(captured.balances[0]?.amount).toBe(10);

      const reversed = await client.redemptions.reverse({
        reservation_id: reserved.reservation.reservation_id,
        reason: "guest changed order"
      });
      expect(reversed.balances[0]?.amount).toBe(110);

      const adjusted = await client.orders.adjust({
        member_id: "member-001",
        program_id: "demo-foodservice",
        adjustment: {
          adjustment_id: "sdk-refund-1",
          original_order_id: "order-1001",
          type: "partial_refund",
          reason: "item refund",
          occurred_at: "2026-07-14T11:00:00.000Z",
          order_total_delta: money(-550, "USD"),
          eligible_spend_delta: money(-500, "USD")
        }
      });
      expect(adjusted.entry).toMatchObject({ operation: "adjustment", amount: -50 });
    } finally {
      await running.close();
    }
  });

  it("retries safe operations with the same generated context", async () => {
    let attempts = 0;
    const requestBodies: string[] = [];
    const delays: number[] = [];
    const client = new LipClient({
      baseUrl: "https://loyalty.example.test",
      apiKey: async () => "sdk-test-key",
      source: { system: "sdk-test" },
      retry: { attempts: 2, baseDelayMs: 5, maxDelayMs: 5 },
      idGenerator: deterministicIds(),
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      fetch: async (_url, init) => {
        attempts += 1;
        requestBodies.push(init?.body as string);
        if (attempts === 1) return problemResponse(503, "unavailable");
        const request = JSON.parse(init?.body as string) as { context: { request_id: string } };
        return new Response(JSON.stringify({
          context: {
            protocol_version: "1.0",
            profile: "foodservice/1.0",
            request_id: request.context.request_id,
            processed_at: "2026-07-14T10:00:00.000Z"
          },
          member: null,
          balances: []
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const result = await client.members.lookup({
      program_id: "demo-foodservice",
      identity: { type: "token", value: "unknown-token" }
    });
    expect(result.member).toBeNull();
    expect(attempts).toBe(2);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(delays).toEqual([5]);
    expect(JSON.parse(requestBodies[0]!) as unknown).toMatchObject({
      context: { source: { system: "sdk-test" } }
    });
  });

  it("does not silently retry mutations and exposes typed API errors", async () => {
    let attempts = 0;
    const client = new LipClient({
      baseUrl: "https://loyalty.example.test",
      apiKey: "wrong-key",
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async () => {
        attempts += 1;
        return problemResponse(503, "unavailable");
      }
    });

    const operation = client.members.enroll({
      program_id: "demo-foodservice",
      identity: { type: "token", value: "guest-token" }
    });
    await expect(operation).rejects.toMatchObject({
      name: "LipApiError",
      status: 503,
      code: "unavailable"
    });
    expect(attempts).toBe(1);
  });

  it("retries safe network failures and preserves the transport cause", async () => {
    const cause = new Error("socket closed");
    const delays: number[] = [];
    let attempts = 0;
    const client = new LipClient({
      baseUrl: "https://loyalty.example.test",
      apiKey: "sdk-test-key",
      retry: { attempts: 2, baseDelayMs: 3, maxDelayMs: 3 },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      fetch: async () => {
        attempts += 1;
        throw cause;
      }
    });

    const error = await client.members.lookup({
      program_id: "demo-foodservice",
      identity: { type: "token", value: "guest-token" }
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LipTransportError);
    expect((error as LipTransportError).cause).toBe(cause);
    expect(attempts).toBe(2);
    expect(delays).toEqual([3]);
  });

  it("rejects mismatched response correlation and invalid retry policies", async () => {
    const client = new LipClient({
      baseUrl: "https://loyalty.example.test",
      apiKey: "sdk-test-key",
      idGenerator: deterministicIds(),
      fetch: async () => new Response(JSON.stringify({
        context: {
          protocol_version: "1.0",
          profile: "foodservice/1.0",
          request_id: "different-request-id",
          processed_at: "2026-07-14T10:00:00.000Z"
        },
        member: null,
        balances: []
      }), { status: 200 })
    });
    await expect(client.members.lookup({
      program_id: "demo-foodservice",
      identity: { type: "token", value: "guest-token" }
    })).rejects.toMatchObject({ phase: "response" });

    expect(() => new LipClient({
      baseUrl: "https://loyalty.example.test",
      apiKey: "sdk-test-key",
      retry: { attempts: 0 }
    })).toThrow(/attempts/);
    expect(() => new LipClient({
      baseUrl: "https://loyalty.example.test",
      apiKey: "sdk-test-key",
      retry: { baseDelayMs: 10, maxDelayMs: 5 }
    })).toThrow(/maxDelayMs/);
  });

  it("rejects invalid requests and invalid successful responses", async () => {
    let fetchCalled = false;
    const client = new LipClient({
      baseUrl: "https://loyalty.example.test",
      apiKey: "sdk-test-key",
      fetch: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    await expect(client.members.lookup({
      program_id: "",
      identity: { type: "token", value: "guest-token" }
    })).rejects.toMatchObject({ phase: "request" });
    expect(fetchCalled).toBe(false);

    await expect(client.members.lookup({
      program_id: "demo-foodservice",
      identity: { type: "token", value: "guest-token" }
    })).rejects.toMatchObject({ phase: "response" });
  });
});
