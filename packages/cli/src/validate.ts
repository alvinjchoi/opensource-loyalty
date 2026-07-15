import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { schemaRegistry, validate, type ValidationIssue } from "@loyalty-interchange/protocol";

export interface FileValidationResult {
  ok: boolean;
  schema: string;
  file: string;
  issues: ValidationIssue[];
}

export function schemaNames(): string[] {
  return Object.keys(schemaRegistry).sort();
}

export async function validateFile(file: string, schemaName: string): Promise<FileValidationResult> {
  const schema = schemaRegistry[schemaName as keyof typeof schemaRegistry];
  if (!schema) {
    throw new Error(`Unknown schema ${schemaName}. Run "lip schemas" to list valid names.`);
  }
  const absoluteFile = resolve(file);
  let input: unknown;
  try {
    input = JSON.parse(await readFile(absoluteFile, "utf8")) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        schema: schemaName,
        file: absoluteFile,
        issues: [{ path: "/", keyword: "json", message: error.message }]
      };
    }
    throw error;
  }

  const result = validate(schema, input);
  return {
    ok: result.ok,
    schema: schemaName,
    file: absoluteFile,
    issues: result.ok ? [] : result.issues
  };
}
