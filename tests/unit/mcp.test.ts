import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  assertReadable,
  readRepoFile,
  validateJsonPayload
} from "../../packages/mcp/src/lib.js";

describe("LIP MCP helpers", () => {
  it("reads llms.txt from the repo root", async () => {
    const text = await readRepoFile("llms.txt");
    expect(text).toContain("Loyalty Interchange Protocol");
    expect(text).toContain("npx skills add");
  });

  it("rejects path traversal", () => {
    expect(() => assertReadable("../package.json")).toThrow(/traversal/);
    expect(() => assertReadable("node_modules/foo")).toThrow(/not exposed/);
  });

  it("validates the paid-order fixture", async () => {
    const json = await readFile(`${REPO_ROOT}/spec/examples/paid-order.json`, "utf8");
    const result = validateJsonPayload("FoodserviceOrder", json);
    expect(result.ok).toBe(true);
  });

  it("reports schema validation failures", () => {
    const result = validateJsonPayload("FoodserviceOrder", "{}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("LIP MCP server factory", () => {
  it("creates a server without throwing", async () => {
    const { createLipMcpServer } = await import("../../packages/mcp/src/server.js");
    expect(createLipMcpServer()).toBeDefined();
  });
});
