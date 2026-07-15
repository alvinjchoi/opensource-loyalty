import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoPlatform, ProgramManagementService } from "@loyalty-interchange/server";
import { makeContext, makeEnroll, makeProgram } from "../fixtures.js";

describe("program management", () => {
  it("validates drafts, publishes with optimistic concurrency, and rolls back", () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-program-manager-"));
    const databasePath = join(directory, "reference.db");
    const initial = makeProgram();
    const service = new ProgramManagementService({
      path: databasePath,
      initialProgram: initial,
      reset: true
    });
    const applied: unknown[] = [];
    service.bindPublisher((program) => applied.push(program));
    try {
      const invalid = service.saveDraft({ ...initial, currency: "dollars" }, "test-admin");
      expect(invalid.draft?.validation).toMatchObject({ ok: false });
      expect(() => service.publish(invalid.draft!.version, "test-admin")).toThrowError(/currency/i);

      const changed = {
        ...initial,
        name: "Published loyalty program",
        earn_rate: { points: 2, spend_minor_units: 100 }
      };
      const firstDraft = service.saveDraft(changed, "test-admin");
      const secondDraft = service.saveDraft(
        { ...changed, description: "Second saved version" },
        "test-admin"
      );
      expect(() => service.publish(firstDraft.draft!.version, "test-admin"))
        .toThrowError(/changed/);

      const published = service.publish(secondDraft.draft!.version, "test-admin");
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

      const rolledBack = service.rollback(1, "test-admin");
      expect(rolledBack.active_revision).toBe(3);
      expect(rolledBack.active_program.earn_rate).toEqual(initial.earn_rate);
      expect(rolledBack.audit.map((entry) => entry.action)).toContain("program.rolled_back");

      service.saveDraft(changed, "test-admin");
      const discarded = service.discardDraft("test-admin");
      expect(discarded.draft).toBeUndefined();
      expect(discarded.audit[0]?.action).toBe("draft.discarded");
    } finally {
      service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves member state while publishing live and across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-program-platform-"));
    const databasePath = join(directory, "reference.db");
    const initial = makeProgram();
    try {
      const first = createDemoPlatform({
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
      const draft = first.programs.saveDraft(changed, "test-admin");
      first.programs.publish(draft.draft!.version, "test-admin");
      expect(first.engine.inspectAdmin()).toMatchObject({
        program: {
          name: "Live program",
          earning: { rate: { amount: 3, spend: { amount: 100 } } }
        },
        summary: { active_members: 1 }
      });
      first.close();

      const second = createDemoPlatform({
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
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
