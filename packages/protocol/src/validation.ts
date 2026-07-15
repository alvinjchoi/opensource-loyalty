import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { Static, TSchema } from "@sinclair/typebox";
import type { FundingShare, Money } from "./primitives.js";
import { FoodserviceOrderSchema, type FoodserviceOrder } from "./order.js";

export interface ValidationIssue {
  path: string;
  message: string;
  keyword: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
});
ajv.addFormat("uri-reference", { type: "string", validate: (value: string) => /^\S+$/.test(value) });
const validators = new WeakMap<TSchema, ValidateFunction>();

function issuesFor(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    message: error.message ?? "is invalid",
    keyword: error.keyword
  }));
}

export function validate<T extends TSchema>(
  schema: T,
  input: unknown
): ValidationResult<Static<T>> {
  let validator = validators.get(schema);
  if (!validator) {
    validator = ajv.compile(schema);
    validators.set(schema, validator);
  }

  if (validator(input)) {
    return { ok: true, value: input as Static<T> };
  }

  return { ok: false, issues: issuesFor(validator.errors) };
}

export class ProtocolValidationError extends Error {
  public readonly issues: ValidationIssue[];

  public constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
    this.name = "ProtocolValidationError";
    this.issues = issues;
  }
}

export function assertValid<T extends TSchema>(schema: T, input: unknown): Static<T> {
  const result = validate(schema, input);
  if (!result.ok) {
    throw new ProtocolValidationError(result.issues);
  }
  return result.value;
}

function moneyFields(order: FoodserviceOrder): Money[] {
  return [
    ...order.lines.flatMap((line) => [line.unit_price, line.subtotal, line.discount, line.tax]),
    ...Object.values(order.totals),
    ...(order.tenders?.map((tender) => tender.amount) ?? [])
  ];
}

export function validateFoodserviceOrder(input: unknown): ValidationResult<FoodserviceOrder> {
  const structural = validate(FoodserviceOrderSchema, input);
  if (!structural.ok) {
    return structural;
  }

  const order = structural.value;
  const issues: ValidationIssue[] = [];
  const currency = order.totals.total.currency;

  if (moneyFields(order).some((money) => money.currency !== currency)) {
    issues.push({ path: "/", message: "all monetary values must use one currency", keyword: "currency" });
  }

  const expectedTotal =
    order.totals.subtotal.amount -
    order.totals.discount.amount +
    order.totals.tax.amount +
    order.totals.tip.amount +
    order.totals.service_charge.amount;
  if (expectedTotal !== order.totals.total.amount) {
    issues.push({ path: "/totals/total/amount", message: "does not reconcile", keyword: "reconciliation" });
  }

  const lineIds = new Set<string>();
  for (const line of order.lines) {
    if (lineIds.has(line.line_id)) {
      issues.push({ path: "/lines", message: `duplicate line_id ${line.line_id}`, keyword: "unique" });
    }
    lineIds.add(line.line_id);
    if (line.subtotal.amount !== line.unit_price.amount * line.quantity) {
      issues.push({ path: `/lines/${line.line_id}/subtotal/amount`, message: "must equal unit_price times quantity", keyword: "reconciliation" });
    }
    if ([line.unit_price, line.subtotal, line.discount, line.tax].some((money) => money.amount < 0)) {
      issues.push({ path: `/lines/${line.line_id}`, message: "sale amounts must not be negative", keyword: "minimum" });
    }
    if (line.discount.amount > line.subtotal.amount) {
      issues.push({ path: `/lines/${line.line_id}/discount/amount`, message: "must not exceed line subtotal", keyword: "maximum" });
    }
  }

  const lineSubtotal = order.lines.reduce((sum, line) => sum + line.subtotal.amount, 0);
  const lineDiscount = order.lines.reduce((sum, line) => sum + line.discount.amount, 0);
  const lineTax = order.lines.reduce((sum, line) => sum + line.tax.amount, 0);
  for (const [field, actual, expected] of [
    ["subtotal", order.totals.subtotal.amount, lineSubtotal],
    ["discount", order.totals.discount.amount, lineDiscount],
    ["tax", order.totals.tax.amount, lineTax]
  ] as const) {
    if (actual !== expected) {
      issues.push({ path: `/totals/${field}/amount`, message: `must equal allocated line ${field}`, keyword: "reconciliation" });
    }
  }

  if (Object.values(order.totals).some((money) => money.amount < 0)) {
    issues.push({ path: "/totals", message: "sale totals must not be negative", keyword: "minimum" });
  }
  if (order.tenders?.some((tender) => tender.amount.amount < 0)) {
    issues.push({ path: "/tenders", message: "tender amounts must not be negative", keyword: "minimum" });
  }

  for (const line of order.lines) {
    if (line.parent_line_id && !lineIds.has(line.parent_line_id)) {
      issues.push({ path: `/lines/${line.line_id}/parent_line_id`, message: "must reference another order line", keyword: "reference" });
    }
    if (line.parent_line_id === line.line_id) {
      issues.push({ path: `/lines/${line.line_id}/parent_line_id`, message: "cannot reference itself", keyword: "reference" });
    }
  }

  if (order.status === "paid" && order.tenders) {
    const tenderTotal = order.tenders.reduce((sum, tender) => sum + tender.amount.amount, 0);
    if (tenderTotal !== order.totals.total.amount) {
      issues.push({ path: "/tenders", message: "paid order tenders must equal total", keyword: "reconciliation" });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: order };
}

export function validateFundingShares(shares: FundingShare[]): ValidationResult<FundingShare[]> {
  const total = shares.reduce((sum, share) => sum + share.share_bps, 0);
  if (total !== 10_000) {
    return {
      ok: false,
      issues: [{ path: "/funding", message: "shares must total 10000 basis points", keyword: "reconciliation" }]
    };
  }
  return { ok: true, value: shares };
}
