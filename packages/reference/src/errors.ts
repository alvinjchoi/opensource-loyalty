export type EngineErrorCode =
  | "conflict"
  | "currency_mismatch"
  | "expired"
  | "idempotency_conflict"
  | "insufficient_balance"
  | "invalid_order"
  | "invalid_cursor"
  | "invalid_program"
  | "invalid_state"
  | "member_not_found"
  | "member_not_active"
  | "not_found"
  | "reward_not_available"
  | "reward_not_found";

export class EngineError extends Error {
  public readonly code: EngineErrorCode;
  public readonly status: number;

  public constructor(code: EngineErrorCode, message: string, status = 409) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.status = status;
  }
}
