import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { schemaRegistry } from "@loyalty-interchange/protocol";

const root = resolve(import.meta.dirname, "../..");

describe("generated protocol contract", () => {
  it("is a valid and fully resolvable OpenAPI document", async () => {
    const path = resolve(root, "spec/openapi.yaml");
    const api = await SwaggerParser.validate(path) as unknown as {
      openapi?: string;
      paths?: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };

    expect(api.openapi).toBe("3.1.2");
    expect(Object.keys(api.paths ?? {})).toHaveLength(18);
    expect(api.components?.schemas).toHaveProperty("FoodserviceOrder");
    expect(api.components?.schemas).toHaveProperty("MemberAccountResponse");
    expect(YAML.parse(readFileSync(path, "utf8"))).toHaveProperty("webhooks.loyaltyEvent");
  });

  it("publishes one Draft 2020-12 schema for every registry entry", () => {
    const directory = resolve(root, "spec/schemas");
    const files = readdirSync(directory).filter((file) => file !== "catalog.json");
    expect(files).toHaveLength(Object.keys(schemaRegistry).length);

    for (const name of Object.keys(schemaRegistry)) {
      const schema = JSON.parse(readFileSync(resolve(directory, `${name}.json`), "utf8"));
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `https://loyalty-interchange.org/schema/v1/${name}.json`,
        title: name
      });
    }
  });

  it("keeps the documented SDK lifecycle below 50 non-empty lines without protocol context", () => {
    const example = readFileSync(
      resolve(root, "examples/typescript/full-lifecycle.ts"),
      "utf8"
    );
    const nonEmptyLines = example.split("\n").filter((line) => line.trim().length > 0);
    expect(nonEmptyLines.length).toBeLessThan(50);
    expect(example).not.toContain("protocol_version");
    expect(example).not.toContain("idempotency_key");
    expect(example).not.toContain("request_id");
  });
});
