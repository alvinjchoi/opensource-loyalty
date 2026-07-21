import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPostgresProtocolPlatform } from "@loyalty-interchange/server";
import { makeEnroll, makeMembershipProgram } from "../fixtures.js";

const postgresDescribe = process.env["LIP_TEST_POSTGRES_URL"] ? describe : describe.skip;

postgresDescribe("Postgres protocol platform with admin services", () => {
  it("wires tenant-scoped admin services and persists engine + admin state across restart", async () => {
    const connectionString = process.env["LIP_TEST_POSTGRES_URL"]!;
    const tenantId = `test-platform-${randomUUID()}`;
    const program = makeMembershipProgram();

    const first = await createPostgresProtocolPlatform({
      connectionString,
      tenantId,
      seed: false,
      program
    });
    try {
      expect(first.programs.activeProgram().program_id).toBe(program.program_id);
      expect(first.access.rootPrincipal().tenant_id).toBe(tenantId);

      await first.executeEngineOperation(() =>
        first.engine.enroll(makeEnroll("postgres-platform-enroll"))
      );
      const membership = await first.memberships.grant({
        member_id: "member-001",
        plan_id: "premium",
        valid_until: "2099-01-01T00:00:00.000Z"
      }, "test-admin");
      expect(membership.status).toBe("active");
      await first.locations.upsertLocation({
        location_id: "location-42",
        name: "Downtown Drive-Thru",
        franchisee_id: "franchisee-7"
      }, "test-admin");
    } finally {
      await first.close();
    }

    const second = await createPostgresProtocolPlatform({
      connectionString,
      tenantId,
      seed: false,
      program
    });
    try {
      expect(second.memberships.snapshot().audit.map(({ action }) => action))
        .toContain("membership.granted");
      expect(second.memberships.snapshot().memberships).toEqual(expect.arrayContaining([
        expect.objectContaining({
          member_id: "member-001",
          membership: expect.objectContaining({ plan_id: "premium", status: "active" })
        })
      ]));
      expect(second.locations.snapshot().locations).toEqual([
        expect.objectContaining({
          location_id: "location-42",
          name: "Downtown Drive-Thru",
          franchisee_id: "franchisee-7",
          active: true
        })
      ]);
    } finally {
      await second.close();
    }
  });

  it("isolates admin state between tenants sharing one database", async () => {
    const connectionString = process.env["LIP_TEST_POSTGRES_URL"]!;
    const program = makeMembershipProgram();
    const tenantA = `test-platform-${randomUUID()}`;
    const tenantB = `test-platform-${randomUUID()}`;

    const platformA = await createPostgresProtocolPlatform({
      connectionString, tenantId: tenantA, seed: false, program
    });
    try {
      await platformA.executeEngineOperation(() =>
        platformA.engine.enroll(makeEnroll("tenant-a-enroll"))
      );
      await platformA.memberships.grant({
        member_id: "member-001",
        plan_id: "premium",
        valid_until: "2099-01-01T00:00:00.000Z"
      }, "tenant-a-admin");
      await platformA.locations.upsertLocation({
        location_id: "location-a",
        name: "Tenant A Flagship"
      }, "tenant-a-admin");
    } finally {
      await platformA.close();
    }

    const platformB = await createPostgresProtocolPlatform({
      connectionString, tenantId: tenantB, seed: false, program
    });
    try {
      expect(platformB.memberships.snapshot().audit).toEqual([]);
      expect(platformB.locations.snapshot().locations).toEqual([]);
    } finally {
      await platformB.close();
    }
  });
});
