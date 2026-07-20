import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AsyncSqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import {
  createDemoPlatform,
  ProgramManagementService,
  type ProgramManagementState
} from "@loyalty-interchange/server";
import { makeContext, makeEnroll, makeOrder, makeProgram, makeStampProgram } from "../fixtures.js";

const makeStore = (path: string): AsyncSqliteStateStore<ProgramManagementState> =>
  new AsyncSqliteStateStore<ProgramManagementState>({
    path,
    key: "reference:program-management"
  });

describe("program management", () => {
  it("edits individual rewards through validated program drafts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-reward-manager-"));
    const service = await ProgramManagementService.create({
      store: makeStore(join(directory, "reference.db")),
      initialProgram: makeProgram(),
      reset: true
    });
    try {
      const template = makeProgram().rewards[0]!;
      const added = await service.upsertReward({
        ...template,
        reward_id: "birthday-reward",
        name: "Birthday reward"
      }, "test-admin");
      expect(added.draft?.validation.ok).toBe(true);
      expect((added.draft?.program as ReturnType<typeof makeProgram>).rewards).toContainEqual(
        expect.objectContaining({ reward_id: "birthday-reward" })
      );
      const removed = await service.deleteReward("birthday-reward", "test-admin");
      expect((removed.draft?.program as ReturnType<typeof makeProgram>).rewards).not.toContainEqual(
        expect.objectContaining({ reward_id: "birthday-reward" })
      );
      await expect(service.deleteReward("missing", "test-admin")).rejects.toThrowError(/not found/);
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates drafts, publishes with optimistic concurrency, and rolls back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-program-manager-"));
    const databasePath = join(directory, "reference.db");
    const initial = makeProgram();
    const service = await ProgramManagementService.create({
      store: makeStore(databasePath),
      initialProgram: initial,
      reset: true
    });
    const applied: unknown[] = [];
    service.bindPublisher((program) => { applied.push(program); });
    try {
      const invalid = await service.saveDraft({ ...initial, currency: "dollars" }, "test-admin");
      expect(invalid.draft?.validation).toMatchObject({ ok: false });
      await expect(service.publish(invalid.draft!.version, "test-admin"))
        .rejects.toThrowError(/currency/i);

      const changed = {
        ...initial,
        name: "Published loyalty program",
        earn_rate: { points: 2, spend_minor_units: 100 }
      };
      const firstDraft = await service.saveDraft(changed, "test-admin");
      const secondDraft = await service.saveDraft(
        { ...changed, description: "Second saved version" },
        "test-admin"
      );
      await expect(service.publish(firstDraft.draft!.version, "test-admin"))
        .rejects.toThrowError(/changed/);

      const published = await service.publish(secondDraft.draft!.version, "test-admin");
      expect(published).toMatchObject({
        active_revision: 2,
        active_program: {
          name: "Published loyalty program",
          description: "Second saved version",
          earn_rate: { points: 2, spend_minor_units: 100 }
        },
        history: [{ revision: 1 }]
      });
      expect(published.draft).toBeUndefined();
      expect(applied).toHaveLength(1);

      const rolledBack = await service.rollback(1, "test-admin");
      expect(rolledBack.active_revision).toBe(3);
      expect(rolledBack.active_program.earn_rate).toEqual(initial.earn_rate);
      expect(rolledBack.audit.map((entry) => entry.action)).toContain("program.rolled_back");

      await service.saveDraft(changed, "test-admin");
      const discarded = await service.discardDraft("test-admin");
      expect(discarded.draft).toBeUndefined();
      expect(discarded.audit[0]?.action).toBe("draft.discarded");
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves member state while publishing live and across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-program-platform-"));
    const databasePath = join(directory, "reference.db");
    const initial = makeProgram();
    try {
      const first = await createDemoPlatform({
        databasePath,
        reset: true,
        seed: false,
        program: initial
      });
      first.engine.enroll(makeEnroll());
      const changed = {
        ...initial,
        name: "Live program",
        earn_rate: { points: 3, spend_minor_units: 100 }
      };
      const draft = await first.programs.saveDraft(changed, "test-admin");
      await first.programs.publish(draft.draft!.version, "test-admin");
      expect(first.engine.inspectAdmin()).toMatchObject({
        program: {
          name: "Live program",
          earning: { rate: { amount: 3, spend: { amount: 100 } } }
        },
        summary: { active_members: 1 }
      });
      await first.close();

      const second = await createDemoPlatform({
        databasePath,
        seed: false,
        program: initial
      });
      expect(second.engine.inspectAdmin()).toMatchObject({
        program: {
          name: "Live program",
          earning: { rate: { amount: 3, spend: { amount: 100 } } }
        },
        summary: { active_members: 1 }
      });
      expect(second.engine.lookup({
        context: makeContext("program-restart-lookup"),
        program_id: initial.program_id,
        identity: makeEnroll().identity
      }).member?.member_id).toBe("member-001");
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes stamp-card policy changes without reinterpreting account units", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-stamp-program-"));
    const platform = await createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false,
      program: makeStampProgram()
    });
    try {
      platform.engine.enroll(makeEnroll("stamp-program-enroll"));
      platform.engine.postAccrual({
        context: makeContext("stamp-program-accrual"),
        member_id: "member-001",
        order: makeOrder({ order_id: "stamp-program-order" })
      });
      const changed = makeStampProgram();
      changed.visit_stamp_policy = { ...changed.visit_stamp_policy!, threshold: 4 };
      const draft = await platform.programs.saveDraft(changed, "test-admin");
      await platform.programs.publish(draft.draft!.version, "test-admin");
      expect(platform.engine.getAccount({
        context: makeContext("stamp-program-account"),
        member_id: "member-001",
        program_id: "demo-foodservice"
      }).balances[0]).toMatchObject({ unit: "stamps", amount: 1 });

      const pointsDraft = await platform.programs.saveDraft(makeProgram(), "test-admin");
      await expect(platform.programs.publish(pointsDraft.draft!.version, "test-admin"))
        .rejects.toThrowError(/primary account unit/);
    } finally {
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
