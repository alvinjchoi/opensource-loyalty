import { IdSchema, validate } from "@loyalty-interchange/protocol";
import { EngineError } from "@loyalty-interchange/reference";

/**
 * Asserts that a location identifier satisfies the protocol `Id` constraints
 * (alphanumeric start, then letters/digits/`._:-`, at most 128 characters).
 * Registry rows and allowed-location scopes reuse the protocol schema so the
 * same ids are valid on orders, ledger entries, and Admin state.
 */
export function assertLocationId(value: string, field: string): string {
  const result = validate(IdSchema, value);
  if (!result.ok) {
    throw new EngineError(
      "validation_failed",
      `${field} must match the protocol id format ` +
        "(start with a letter or digit, use only letters, digits, '.', '_', ':', '-', max 128 characters)",
      422
    );
  }
  return value;
}
