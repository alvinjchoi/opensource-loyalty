import type { ProblemDetails, ValidationIssue } from "@loyalty-interchange/protocol";

export class LipValidationError extends Error {
  public readonly phase: "request" | "response";
  public readonly issues: ValidationIssue[];

  public constructor(phase: "request" | "response", issues: ValidationIssue[]) {
    super(`${phase} validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "LipValidationError";
    this.phase = phase;
    this.issues = issues;
  }
}

export class LipApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly problem: ProblemDetails;

  public constructor(status: number, problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = "LipApiError";
    this.status = status;
    this.code = problem.code;
    this.problem = problem;
  }
}

export class LipTransportError extends Error {
  public override readonly cause: unknown;

  public constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "LipTransportError";
    this.cause = cause;
  }
}
