import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import {
  createDemoPlatform,
  createPostgresProtocolPlatform,
  locationReport,
  startReferenceServer
} from "@loyalty-interchange/server";
import { makeContext, makeEnroll, makeOrder, makeProgram } from "../fixtures.js";

const postgresDescribe = process.env["LIP_TEST_POSTGRES_URL"] ? describe : describe.skip;

describe("location report read path (server wiring)", () => {
  it("prefers readEngineSnapshot over executeEngineOperation and never persists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-report-read-path-"));
    const platform = await createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false,
      program: makeProgram()
    });
    platform.engine.enroll(makeEnroll("read-path-enroll"));
    platform.engine.postAccrual({
      context: makeContext("read-path-accrual"),
      member_id: "member-001",
      order: makeOrder()
    });

    let executeCalls = 0;
    const executeEngineOperation = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      executeCalls += 1;
      return operation();
    };
    let snapshotCalls = 0;
    let persistCalls = 0;
    // Mirrors the Postgres platform: hydrate a scratch engine from the latest
    // committed state and run the read against it.
    const readEngineSnapshot = async <T>(
      read: (engine: LoyaltyEngine) => T | Promise<T>
    ): Promise<T> => {
      snapshotCalls += 1;
      const scratch = new LoyaltyEngine(platform.engine.getProgramDefinition(), {
        state: platform.engine.exportState()
      });
      return read(scratch);
    };
    const running = await startReferenceServer(platform.engine, {
      apiKey: "read-path-admin-key",
      executeEngineOperation,
      readEngineSnapshot,
      persistState: () => {
        persistCalls += 1;
      },
      admin: {
        programs: platform.programs,
        campaigns: platform.campaigns,
        memberships: platform.memberships,
        access: platform.access,
        engagement: platform.engagement,
        locations: platform.locations,
        storage: platform.store.status
      }
    });
    try {
      const response = await fetch(`${running.url}/admin/api/v1/reports/locations`, {
        headers: { authorization: "Bearer read-path-admin-key" }
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        locations: Array<{ location_id: string; orders_accrued: number }>;
      };
      expect(body.locations).toEqual([
        expect.objectContaining({ location_id: "location-42", orders_accrued: 1 })
      ]);
      expect(snapshotCalls).toBe(1);
      expect(executeCalls).toBe(0);
      expect(persistCalls).toBe(0);
    } finally {
      await running.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back to executeEngineOperation when no snapshot reader is provided", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-report-write-path-"));
    const platform = await createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false,
      program: makeProgram()
    });
    platform.engine.enroll(makeEnroll("write-path-enroll"));
    let executeCalls = 0;
    const executeEngineOperation = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      executeCalls += 1;
      return operation();
    };
    const running = await startReferenceServer(platform.engine, {
      apiKey: "write-path-admin-key",
      executeEngineOperation,
      admin: {
        programs: platform.programs,
        campaigns: platform.campaigns,
        memberships: platform.memberships,
        access: platform.access,
        engagement: platform.engagement,
        locations: platform.locations,
        storage: platform.store.status
      }
    });
    try {
      const response = await fetch(`${running.url}/admin/api/v1/reports/locations`, {
        headers: { authorization: "Bearer write-path-admin-key" }
      });
      expect(response.status).toBe(200);
      expect(executeCalls).toBe(1);
    } finally {
      await running.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

postgresDescribe("Postgres lock-free location report read path", () => {
  it("serves reports from a scratch snapshot without advancing the revision or persisting expiry", async () => {
    const connectionString = process.env["LIP_TEST_POSTGRES_URL"]!;
    const tenantId = `test-report-read-${randomUUID()}`;
    // A one-second reservation TTL lets the test observe expiry inside the
    // scratch read without persisting it.
    const program = { ...makeProgram(), reservation_ttl_seconds: 1 };
    const platform = await createPostgresProtocolPlatform({
      connectionString,
      tenantId,
      seed: false,
      program
    });
    try {
      await platform.executeEngineOperation(() => {
        platform.engine.enroll(makeEnroll("report-read-enroll"));
        platform.engine.postAccrual({
          context: makeContext("report-read-accrual"),
          member_id: "member-001",
          order: makeOrder()
        });
        return platform.engine.reserve({
          context: makeContext("report-read-reserve"),
          redemption_id: "redemption-read-001",
          member_id: "member-001",
          reward_id: "one-dollar-off",
          order: makeOrder({ order_id: "order-reserve-1" })
        });
      });
      const before = await platform.store.load();
      expect(before).not.toBeNull();

      await delay(1_200); // let the reservation lapse
      const report = await platform.readEngineSnapshot((engine) => locationReport(engine));
      const row = report.locations.find(({ location_id }) => location_id === "location-42");
      expect(row).toMatchObject({
        orders_accrued: 1,
        reservations: expect.objectContaining({ expired: 1 })
      });
      // Repeated reads stay side-effect free.
      await platform.readEngineSnapshot((engine) => locationReport(engine));

      const after = await platform.store.load();
      expect(after!.revision).toBe(before!.revision);
      // The expiry computed during the read stayed in the scratch copy: the
      // committed reservation row is still "reserved" until a real write path
      // (accrual/redemption under the lock) persists the transition.
      expect(after!.state.reservations.map(([, reservation]) => reservation.status))
        .toEqual(["reserved"]);
    } finally {
      await platform.close();
    }
  });

  it("does not queue behind a long-running engine operation and reads the last committed state", async () => {
    const connectionString = process.env["LIP_TEST_POSTGRES_URL"]!;
    const tenantId = `test-report-concurrent-${randomUUID()}`;
    const platform = await createPostgresProtocolPlatform({
      connectionString,
      tenantId,
      seed: false,
      program: makeProgram()
    });
    try {
      await platform.executeEngineOperation(() => {
        platform.engine.enroll(makeEnroll("concurrent-enroll"));
        return platform.engine.postAccrual({
          context: makeContext("concurrent-accrual"),
          member_id: "member-001",
          order: makeOrder()
        });
      });

      let mutationSettled = false;
      const slowMutation = platform.executeEngineOperation(async () => {
        await delay(700); // holds the advisory lock and the in-process queue
        return platform.engine.postAccrual({
          context: makeContext("concurrent-slow-accrual"),
          member_id: "member-001",
          order: makeOrder({ order_id: "order-slow-1" })
        });
      }).then((result) => {
        mutationSettled = true;
        return result;
      });
      await delay(50); // let the mutation acquire the lock first

      const startedAt = Date.now();
      const report = await platform.readEngineSnapshot((engine) => locationReport(engine));
      const elapsedMs = Date.now() - startedAt;

      expect(mutationSettled).toBe(false); // the report finished while the write was in flight
      expect(elapsedMs).toBeLessThan(500);
      // Staleness contract: the snapshot reflects the last committed revision,
      // not the in-flight mutation.
      const row = report.locations.find(({ location_id }) => location_id === "location-42");
      expect(row?.orders_accrued).toBe(1);

      await slowMutation;
      expect(mutationSettled).toBe(true);
      const final = await platform.readEngineSnapshot((engine) => locationReport(engine));
      const finalRow = final.locations.find(({ location_id }) => location_id === "location-42");
      expect(finalRow?.orders_accrued).toBe(2);
    } finally {
      await platform.close();
    }
  });
});
