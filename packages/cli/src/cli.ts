#!/usr/bin/env node

import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { defaultConfig, initializeConfig, readConfig } from "./config.js";
import { formatReport, runBaselineConformance, runDoctor } from "./diagnostics.js";
import { runMockServer } from "./mock.js";
import { schemaNames, validateFile } from "./validate.js";

interface ConnectionFlags {
  apiKey?: string;
}

async function connection(url: string | undefined, flags: ConnectionFlags) {
  const config = await readConfig();
  const apiKeyEnvironment = config?.api_key_env ?? defaultConfig.api_key_env;
  return {
    baseUrl: url ?? config?.base_url ?? defaultConfig.base_url,
    apiKey: flags.apiKey ?? process.env[apiKeyEnvironment] ?? "lip-dev-key"
  };
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new InvalidArgumentError("port must be an integer between 1 and 65535");
  }
  return parsed;
}

function positiveCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1_000_000) {
    throw new InvalidArgumentError("value must be an integer between 1 and 1000000");
  }
  return parsed;
}

const program = new Command()
  .name("lip")
  .description("Build, validate, and test Loyalty Interchange Protocol integrations")
  .version("0.2.0")
  .showSuggestionAfterError();

program
  .command("init [directory]")
  .description("Create a minimal lip.config.json")
  .option("-f, --force", "replace an existing configuration")
  .action(async (directory = ".", options: { force?: boolean }) => {
    const target = await initializeConfig(
      resolve(directory),
      options.force ? { force: true } : {}
    );
    console.log(`Created ${target}`);
    console.log("");
    console.log("Agent setup (recommended for Cursor, Claude Code, Codex):");
    console.log("  npx skills add .");
    console.log("  Enable MCP: add mcp.json from this repo to your Cursor MCP settings");
    console.log("  Docs: docs/using-lip-with-ai.md");
  });

program
  .command("schemas")
  .description("List schemas accepted by lip validate")
  .action(() => {
    console.log(schemaNames().join("\n"));
  });

program
  .command("validate <file>")
  .description("Validate a JSON payload against a LIP schema")
  .requiredOption("-s, --schema <name>", "schema name, for example FoodserviceOrder")
  .action(async (file: string, options: { schema: string }) => {
    const result = await validateFile(file, options.schema);
    if (result.ok) {
      console.log(`[pass] ${result.file} is valid ${result.schema}`);
      return;
    }
    for (const issue of result.issues) {
      console.error(`[fail] ${issue.path} ${issue.message} (${issue.keyword})`);
    }
    process.exitCode = 1;
  });

function addMockCommand(name: "mock" | "quickstart" | "serve", description: string): void {
  program
    .command(name)
    .description(description)
    .option("--host <host>", "listen host", "127.0.0.1")
    .option("-p, --port <port>", "listen port", positiveInteger, 3210)
    .option("-k, --api-key <key>", "Admin/API key for dashboard sign-in and Bearer auth", "lip-dev-key")
    .option("-d, --database <path>", "SQLite state path", process.env.LIP_DATABASE_PATH ?? ".lip/reference.db")
    .option("--reset", "clear persisted state before starting")
    .option("--no-seed", "start without synthetic members and activity")
    .option("--program <path>", "JSON program definition replacing the built-in demo program")
    .option("--rate-limit <requests>", "requests allowed per client window", positiveCount, 120)
    .option("--rate-window-ms <milliseconds>", "rate-limit window in milliseconds", positiveCount, 60_000)
    .option("--no-structured-logs", "disable JSON request logs")
    .action(async (options: {
      host: string;
      port: number;
      apiKey: string;
      database: string;
      reset?: boolean;
      seed: boolean;
      program?: string;
      rateLimit: number;
      rateWindowMs: number;
      structuredLogs: boolean;
    }) => {
      if (options.apiKey.length < 8) throw new Error("API key must contain at least 8 characters");
      await runMockServer({
        host: options.host,
        port: options.port,
        apiKey: options.apiKey,
        databasePath: resolve(options.database),
        ...(options.reset ? { reset: true } : {}),
        seed: options.seed,
        rateLimit: {
          maxRequests: options.rateLimit,
          windowMs: options.rateWindowMs
        },
        structuredLogs: options.structuredLogs,
        ...(options.program ? { programPath: resolve(options.program) } : {})
      });
    });
}

addMockCommand("mock", "Start the stateful LIP reference server");
addMockCommand("quickstart", "Start the local environment and print connection details");
addMockCommand("serve", "Start the local reference API and Admin dashboard");

program
  .command("doctor [url]")
  .description("Check discovery, health, authentication, and capabilities")
  .option("-k, --api-key <key>", "Admin/API key for Bearer auth")
  .action(async (url: string | undefined, options: ConnectionFlags) => {
    const report = await runDoctor(await connection(url, options));
    console.log(formatReport(report));
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("test [url]")
  .description("Run baseline non-destructive HTTP conformance checks")
  .option("-k, --api-key <key>", "Admin/API key for Bearer auth")
  .action(async (url: string | undefined, options: ConnectionFlags) => {
    const report = await runBaselineConformance(await connection(url, options));
    console.log(formatReport(report));
    if (!report.ok) process.exitCode = 1;
  });

await program.parseAsync();
