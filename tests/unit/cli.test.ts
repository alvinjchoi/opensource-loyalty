import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultConfig,
  formatReport,
  initializeConfig,
  readConfig,
  runBaselineConformance,
  runDoctor,
  schemaNames,
  startMockServer,
  validateFile
} from "@loyalty-interchange/cli";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "lip-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("lip CLI configuration", () => {
  it("initializes, reads, protects, and force-replaces configuration", async () => {
    const directory = await temporaryDirectory();
    const target = await initializeConfig(directory);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(defaultConfig);
    expect(await readConfig(directory)).toEqual(defaultConfig);

    await expect(initializeConfig(directory)).rejects.toThrow(/Refusing to overwrite/);
    await writeFile(target, "{}\n", "utf8");
    await initializeConfig(directory, { force: true });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(defaultConfig);
  });

  it("returns undefined when no local configuration exists", async () => {
    expect(await readConfig(await temporaryDirectory())).toBeUndefined();
  });
});

describe("lip validate", () => {
  it("validates a checked-in order and lists the schema", async () => {
    const file = resolve(import.meta.dirname, "../../spec/examples/paid-order.json");
    const result = await validateFile(file, "FoodserviceOrder");
    expect(result).toMatchObject({ ok: true, schema: "FoodserviceOrder", issues: [] });
    expect(schemaNames()).toContain("FoodserviceOrder");
  });

  it("reports malformed JSON, schema violations, and unknown schemas", async () => {
    const directory = await temporaryDirectory();
    const malformed = resolve(directory, "malformed.json");
    const invalid = resolve(directory, "invalid.json");
    await writeFile(malformed, "{not-json", "utf8");
    await writeFile(invalid, "{}\n", "utf8");

    expect(await validateFile(malformed, "FoodserviceOrder")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ keyword: "json" })]
    });
    expect(await validateFile(invalid, "FoodserviceOrder")).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: "required" })])
    });
    await expect(validateFile(invalid, "MissingSchema")).rejects.toThrow(/Unknown schema/);
  });
});

describe("lip diagnostics", () => {
  it("passes doctor and baseline conformance against the mock server", async () => {
    const running = await startMockServer({ host: "127.0.0.1", port: 0, apiKey: "cli-test-key" });
    try {
      const doctor = await runDoctor({ baseUrl: `${running.url}/`, apiKey: "cli-test-key" });
      expect(doctor.ok).toBe(true);
      expect(doctor.checks).toHaveLength(3);
      expect(formatReport(doctor)).toContain("PASS");

      const conformance = await runBaselineConformance({
        baseUrl: running.url,
        apiKey: "cli-test-key"
      });
      expect(conformance.ok).toBe(true);
      expect(conformance.checks).toHaveLength(5);
    } finally {
      await running.close();
    }
  });

  it("returns actionable failures for a bad credential or unreachable server", async () => {
    const running = await startMockServer({ host: "127.0.0.1", port: 0, apiKey: "right-api-key" });
    try {
      const report = await runDoctor({ baseUrl: running.url, apiKey: "wrong-api-key" });
      expect(report.ok).toBe(false);
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: "authentication and capabilities",
        ok: false,
        detail: expect.stringContaining("HTTP 401")
      }));
      expect(formatReport(report)).toContain("FAIL");
    } finally {
      await running.close();
    }

    const unreachable = await runDoctor({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "unused-api-key"
    });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.checks.every((check) => !check.ok)).toBe(true);
  });
});
