import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AsyncSqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { LocationDirectoryService, type LocationDirectoryState } from "@loyalty-interchange/server";

describe("location directory", () => {
  const makeStore = (path: string): AsyncSqliteStateStore<LocationDirectoryState> =>
    new AsyncSqliteStateStore<LocationDirectoryState>({
      path,
      key: "demo-foodservice:locations"
    });

  it("persists franchise locations with audit across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-locations-"));
    const databasePath = join(directory, "reference.db");
    try {
      const first = await LocationDirectoryService.create({
        store: makeStore(databasePath),
        reset: true
      });
      const created = await first.upsertLocation({
        location_id: "location-42",
        name: "Downtown Drive-Thru",
        franchisee_id: "franchisee-7"
      }, "test-admin");
      expect(created).toMatchObject({
        location_id: "location-42",
        name: "Downtown Drive-Thru",
        franchisee_id: "franchisee-7",
        active: true,
        created_at: expect.any(String),
        updated_at: expect.any(String)
      });
      await first.upsertLocation({
        location_id: "location-77",
        name: "Airport Kiosk",
        franchisee_id: "franchisee-9"
      }, "test-admin");

      // A partial update that omits franchisee_id must preserve the owner.
      const retired = await first.upsertLocation({
        location_id: "location-77",
        name: "Airport Kiosk",
        active: false
      }, "test-admin");
      expect(retired).toMatchObject({ active: false, created_at: expect.any(String) });
      expect(retired.franchisee_id).toBe("franchisee-9");

      // Only an explicit null clears the franchisee attribution.
      const released = await first.upsertLocation({
        location_id: "location-77",
        name: "Airport Kiosk",
        franchisee_id: null
      }, "test-admin");
      expect(released.franchisee_id).toBeUndefined();

      await expect(first.upsertLocation({
        location_id: "  ",
        name: "Nameless"
      }, "test-admin")).rejects.toThrowError(/location_id/);
      await expect(first.upsertLocation({
        location_id: "bad id!",
        name: "Invalid id"
      }, "test-admin")).rejects.toThrowError(/location_id/);
      await expect(first.upsertLocation({
        location_id: `x${"y".repeat(128)}`,
        name: "Too long"
      }, "test-admin")).rejects.toThrowError(/location_id/);
      await expect(first.upsertLocation({
        location_id: "location-99",
        name: "   "
      }, "test-admin")).rejects.toThrowError(/name/);
      await first.close();

      const second = await LocationDirectoryService.create({ store: makeStore(databasePath) });
      const snapshot = second.snapshot();
      expect(snapshot.locations.map(({ location_id }) => location_id)).toEqual([
        "location-42",
        "location-77"
      ]);
      expect(second.locationById("location-42")).toMatchObject({
        franchisee_id: "franchisee-7"
      });
      expect(second.locationById("location-404")).toBeUndefined();
      expect(snapshot.audit.map(({ action }) => action)).toEqual(
        expect.arrayContaining(["location.upserted"])
      );
      expect(snapshot.audit[0]).toMatchObject({ actor: "test-admin" });
      // Audit entries surface the attribution fields so ownership changes are visible.
      const creationAudit = [...snapshot.audit].reverse()
        .find((entry) => entry.location_id === "location-42");
      expect(creationAudit?.metadata).toMatchObject({
        active: true,
        franchisee_id: "franchisee-7"
      });

      await second.removeLocation("location-77", "test-admin");
      expect(second.snapshot().locations.map(({ location_id }) => location_id))
        .toEqual(["location-42"]);
      await expect(second.removeLocation("location-404", "test-admin"))
        .rejects.toThrowError(/not found/);
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists locations without cloning the audit trail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-locations-list-"));
    const databasePath = join(directory, "reference.db");
    const service = await LocationDirectoryService.create({
      store: makeStore(databasePath),
      reset: true
    });
    try {
      await service.upsertLocation({ location_id: "location-1", name: "One" }, "tester");
      await service.upsertLocation({ location_id: "location-2", name: "Two" }, "tester");
      const listed = service.listLocations();
      expect(listed.map(({ location_id }) => location_id)).toEqual(["location-1", "location-2"]);
      // Cloned: mutations must not leak back into the directory.
      listed[0]!.name = "Mutated";
      expect(service.locationById("location-1")).toMatchObject({ name: "One" });
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns immutable snapshots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-locations-immutable-"));
    const databasePath = join(directory, "reference.db");
    const service = await LocationDirectoryService.create({
      store: makeStore(databasePath),
      reset: true
    });
    try {
      await service.upsertLocation({ location_id: "location-1", name: "One" }, "tester");
      const snapshot = service.snapshot();
      snapshot.locations[0]!.name = "Mutated";
      expect(service.locationById("location-1")).toMatchObject({ name: "One" });
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
