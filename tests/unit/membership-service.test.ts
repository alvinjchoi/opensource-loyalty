import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoyaltyEngine, type LoyaltyEngineState } from "@loyalty-interchange/reference";
import { AsyncSqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { MembershipService, type MembershipAuditState } from "@loyalty-interchange/server";
import { makeEnroll, makeMembershipProgram } from "../fixtures.js";

describe("MembershipService with an injected async store", () => {
  const cleanups: Array<() => void> = [];

  const tempPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lip-membership-service-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "state.db");
  };

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  const makeEngine = (): LoyaltyEngine => {
    const engine = new LoyaltyEngine(makeMembershipProgram());
    engine.enroll(makeEnroll("membership-service-enroll"));
    return engine;
  };

  it("grants a membership through the injected store and persists the audit", async () => {
    const path = tempPath();
    const engine = makeEngine();
    const persisted: LoyaltyEngineState[] = [];

    const service = await MembershipService.create({
      store: new AsyncSqliteStateStore<MembershipAuditState>({ path, key: "memberships" }),
      engine,
      persistEngine: (state) => persisted.push(state),
      schedulerIntervalMs: false
    });
    const membership = await service.grant({
      member_id: "member-001",
      plan_id: "premium",
      valid_until: "2099-01-01T00:00:00.000Z"
    }, "test-admin");
    expect(membership.status).toBe("active");
    expect(persisted.length).toBeGreaterThan(0);
    expect(service.snapshot().audit.map(({ action }) => action)).toContain("membership.granted");
    await service.close();

    const reopened = await MembershipService.create({
      store: new AsyncSqliteStateStore<MembershipAuditState>({ path, key: "memberships" }),
      engine,
      persistEngine: () => undefined,
      schedulerIntervalMs: false
    });
    expect(reopened.snapshot().audit.map(({ action }) => action)).toContain("membership.granted");
    await reopened.close();
  });

  it("rejects a grant for an unknown plan", async () => {
    const service = await MembershipService.create({
      store: new AsyncSqliteStateStore<MembershipAuditState>({ path: tempPath(), key: "memberships" }),
      engine: makeEngine(),
      persistEngine: () => undefined,
      schedulerIntervalMs: false
    });
    await expect(service.grant({
      member_id: "member-001",
      plan_id: "missing-plan",
      valid_until: "2099-01-01T00:00:00.000Z"
    }, "test-admin")).rejects.toThrowError(/plan/);
    await service.close();
  });

  it("lapses expired memberships asynchronously", async () => {
    const service = await MembershipService.create({
      store: new AsyncSqliteStateStore<MembershipAuditState>({ path: tempPath(), key: "memberships" }),
      engine: makeEngine(),
      persistEngine: () => undefined,
      schedulerIntervalMs: false
    });
    await service.grant({
      member_id: "member-001",
      plan_id: "premium",
      valid_until: "2099-01-01T00:00:00.000Z"
    }, "test-admin");
    expect(await service.lapseExpired("test-scheduler", new Date("2100-01-01T00:00:00.000Z"))).toBe(1);
    await service.close();
  });
});
