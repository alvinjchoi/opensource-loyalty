import type { TSchema } from "@sinclair/typebox";
import {
  ProblemDetailsSchema,
  schemaRegistry,
  validate,
  validateFoodserviceOrder,
  type AccrualPostRequest,
  type CapabilitiesDocument,
  type EvaluationRequest,
  type EvaluationResponse,
  type IssuedRewardCancelRequest,
  type IssuedRewardIssueRequest,
  type IssuedRewardListRequest,
  type IssuedRewardListResponse,
  type IssuedRewardResponse,
  type LedgerResponse,
  type LedgerListRequest,
  type LedgerListResponse,
  type ManualAdjustmentRequest,
  type MemberAccountRequest,
  type MemberAccountResponse,
  type MemberEnrollRequest,
  type MemberEnrollResponse,
  type MemberLookupRequest,
  type MemberLookupResponse,
  type OrderAdjustmentRequest,
  type ProblemDetails,
  type ProgramGetRequest,
  type ProgramGetResponse,
  type RedemptionCaptureRequest,
  type RedemptionReservationResponse,
  type RedemptionReserveRequest,
  type RedemptionReverseRequest,
  type RequestContext,
  type WellKnownDocument
} from "@loyalty-interchange/protocol";
import { LipApiError, LipTransportError, LipValidationError } from "./errors.js";
import {
  GeneratedLipClient,
  type GeneratedCallOptions,
  type GeneratedOperation
} from "./generated/client.js";
import type { LipApiKeyProvider } from "./low-level-client.js";

type WithoutContext<T extends { context: unknown }> = Omit<T, "context">;

export interface LipCallOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface LipRetryPolicy {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface LipClientOptions {
  baseUrl: string;
  apiKey: LipApiKeyProvider;
  source?: { system: string; instance?: string };
  fetch?: typeof globalThis.fetch;
  retry?: LipRetryPolicy;
  clock?: () => Date;
  idGenerator?: (prefix: "request" | "idempotency") => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ResolvedRetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

function defaultId(prefix: "request" | "idempotency"): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveRetry(policy: LipRetryPolicy | undefined): ResolvedRetryPolicy {
  const resolved = {
    attempts: policy?.attempts ?? 3,
    baseDelayMs: policy?.baseDelayMs ?? 100,
    maxDelayMs: policy?.maxDelayMs ?? 1000
  };
  if (!Number.isInteger(resolved.attempts) || resolved.attempts < 1 || resolved.attempts > 10) {
    throw new RangeError("retry attempts must be an integer between 1 and 10");
  }
  if (resolved.baseDelayMs < 0 || resolved.maxDelayMs < resolved.baseDelayMs) {
    throw new RangeError("retry delays must be nonnegative and maxDelayMs must not be smaller than baseDelayMs");
  }
  return resolved;
}

function validationIssue(message: string) {
  return [{ path: "/", keyword: "response", message }];
}

export class LipClient {
  private readonly baseUrl: string;
  private readonly apiKey: LipApiKeyProvider;
  private readonly source: RequestContext["source"];
  private readonly fetcher: typeof globalThis.fetch;
  private readonly retry: ResolvedRetryPolicy;
  private readonly clock: () => Date;
  private readonly idGenerator: (prefix: "request" | "idempotency") => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly generated: GeneratedLipClient;

  public readonly members = {
    lookup: (input: WithoutContext<MemberLookupRequest>, options?: LipCallOptions) =>
      this.post<MemberLookupRequest, MemberLookupResponse>(
        input,
        (request, callOptions) => this.generated.lookupMember(request, callOptions),
        options
      ),
    enroll: (input: WithoutContext<MemberEnrollRequest>, options?: LipCallOptions) =>
      this.post<MemberEnrollRequest, MemberEnrollResponse>(
        input,
        (request, callOptions) => this.generated.enrollMember(request, callOptions),
        options
      )
  };

  public readonly programs = {
    get: (input: WithoutContext<ProgramGetRequest>, options?: LipCallOptions) =>
      this.post<ProgramGetRequest, ProgramGetResponse>(
        input,
        (request, callOptions) => this.generated.getProgram(request, callOptions),
        options
      )
  };

  public readonly accounts = {
    get: (input: WithoutContext<MemberAccountRequest>, options?: LipCallOptions) =>
      this.post<MemberAccountRequest, MemberAccountResponse>(
        input,
        (request, callOptions) => this.generated.getMemberAccount(request, callOptions),
        options
      )
  };

  public readonly ledger = {
    list: (input: WithoutContext<LedgerListRequest>, options?: LipCallOptions) =>
      this.post<LedgerListRequest, LedgerListResponse>(
        input,
        (request, callOptions) => this.generated.listLedgerEntries(request, callOptions),
        options
      ),
    adjust: (input: WithoutContext<ManualAdjustmentRequest>, options?: LipCallOptions) =>
      this.post<ManualAdjustmentRequest, LedgerResponse>(
        input,
        (request, callOptions) => this.generated.postManualAdjustment(request, callOptions),
        options
      )
  };

  public readonly issuedRewards = {
    list: (input: WithoutContext<IssuedRewardListRequest>, options?: LipCallOptions) =>
      this.post<IssuedRewardListRequest, IssuedRewardListResponse>(
        input,
        (request, callOptions) => this.generated.listIssuedRewards(request, callOptions),
        options
      ),
    issue: (input: WithoutContext<IssuedRewardIssueRequest>, options?: LipCallOptions) =>
      this.post<IssuedRewardIssueRequest, IssuedRewardResponse>(
        input,
        (request, callOptions) => this.generated.issueReward(request, callOptions),
        options
      ),
    cancel: (input: WithoutContext<IssuedRewardCancelRequest>, options?: LipCallOptions) =>
      this.post<IssuedRewardCancelRequest, IssuedRewardResponse>(
        input,
        (request, callOptions) => this.generated.cancelIssuedReward(request, callOptions),
        options
      )
  };

  public readonly orders = {
    evaluate: async (input: WithoutContext<EvaluationRequest>, options?: LipCallOptions) => {
      this.assertOrder(input.order);
      return this.post<EvaluationRequest, EvaluationResponse>(
        input,
        (request, callOptions) => this.generated.evaluateOrder(request, callOptions),
        options
      );
    },
    adjust: (input: WithoutContext<OrderAdjustmentRequest>, options?: LipCallOptions) =>
      this.post<OrderAdjustmentRequest, LedgerResponse>(
        input,
        (request, callOptions) => this.generated.adjustOrder(request, callOptions),
        options
      )
  };

  public readonly accruals = {
    post: async (input: WithoutContext<AccrualPostRequest>, options?: LipCallOptions) => {
      this.assertOrder(input.order);
      return this.post<AccrualPostRequest, LedgerResponse>(
        input,
        (request, callOptions) => this.generated.postAccrual(request, callOptions),
        options
      );
    }
  };

  public readonly redemptions = {
    reserve: async (input: WithoutContext<RedemptionReserveRequest>, options?: LipCallOptions) => {
      this.assertOrder(input.order);
      return this.post<RedemptionReserveRequest, RedemptionReservationResponse>(
        input,
        (request, callOptions) => this.generated.reserveRedemption(request, callOptions),
        options
      );
    },
    capture: (input: WithoutContext<RedemptionCaptureRequest>, options?: LipCallOptions) =>
      this.post<RedemptionCaptureRequest, RedemptionReservationResponse>(
        input,
        (request, callOptions) => this.generated.captureRedemption(request, callOptions),
        options
      ),
    reverse: (input: WithoutContext<RedemptionReverseRequest>, options?: LipCallOptions) =>
      this.post<RedemptionReverseRequest, RedemptionReservationResponse>(
        input,
        (request, callOptions) => this.generated.reverseRedemption(request, callOptions),
        options
      )
  };

  public constructor(options: LipClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.source = {
      system: options.source?.system ?? "lip-sdk",
      ...(options.source?.instance ? { instance: options.source.instance } : {})
    };
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.retry = resolveRetry(options.retry);
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? defaultId;
    this.sleep = options.sleep ?? defaultSleep;
    this.generated = new GeneratedLipClient({
      request: (operation, body, callOptions) =>
        this.executeGenerated(operation, body, callOptions)
    });
  }

  public discover(options?: { signal?: AbortSignal }): Promise<WellKnownDocument> {
    return this.generated.discoverLoyaltyProtocol(options);
  }

  public capabilities(options?: { signal?: AbortSignal }): Promise<CapabilitiesDocument> {
    return this.generated.getCapabilities(options);
  }

  private async post<TRequest extends { context: unknown }, TResponse>(
    input: WithoutContext<TRequest>,
    operation: (request: TRequest, options?: GeneratedCallOptions) => Promise<TResponse>,
    options?: LipCallOptions
  ): Promise<TResponse> {
    const context = this.context(options?.idempotencyKey);
    const request = { ...input, context } as TRequest;
    return operation(request, options?.signal ? { signal: options.signal } : undefined);
  }

  private executeGenerated<TRequest, TResponse>(
    operation: GeneratedOperation<TRequest, TResponse>,
    body: TRequest | undefined,
    options?: GeneratedCallOptions
  ): Promise<TResponse> {
    if (operation.requestSchema) {
      const requestValidation = validate(schemaRegistry[operation.requestSchema], body);
      if (!requestValidation.ok) {
        throw new LipValidationError("request", requestValidation.issues);
      }
    }
    const requestId = (body as { context?: { request_id?: string } } | undefined)
      ?.context?.request_id;
    return this.execute<TResponse>({
      path: operation.path,
      responseSchema: schemaRegistry[operation.responseSchema],
      safeToRetry: operation.safeToRetry,
      authenticated: operation.authenticated,
      ...(requestId ? { requestId } : {}),
      request: {
        method: operation.method,
        ...(body === undefined ? {} : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" }
        }),
        ...(options?.signal ? { signal: options.signal } : {})
      }
    });
  }

  private async execute<TResponse>(input: {
    path: string;
    responseSchema: TSchema;
    safeToRetry: boolean;
    request: RequestInit;
    authenticated?: boolean;
    requestId?: string;
  }): Promise<TResponse> {
    const attempts = input.safeToRetry ? this.retry.attempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        const headers = new Headers(input.request.headers);
        if (input.authenticated !== false) {
          headers.set("authorization", `Bearer ${await this.resolveApiKey()}`);
        }
        response = await this.fetcher(`${this.baseUrl}${input.path}`, {
          ...input.request,
          headers
        });
      } catch (error: unknown) {
        if (input.safeToRetry && attempt < attempts && !input.request.signal?.aborted) {
          await this.retryDelay(attempt);
          continue;
        }
        throw new LipTransportError(`request to ${input.path} failed`, error);
      }

      const responseBody = await this.readJson(response);
      if (response.ok) {
        const validation = validate(input.responseSchema, responseBody);
        if (!validation.ok) throw new LipValidationError("response", validation.issues);
        if (input.requestId) {
          const actualRequestId = (responseBody as { context?: { request_id?: unknown } }).context?.request_id;
          if (actualRequestId !== input.requestId) {
            throw new LipValidationError("response", validationIssue("response request_id does not match the request"));
          }
        }
        return responseBody as TResponse;
      }

      if (input.safeToRetry && this.retryableStatus(response.status) && attempt < attempts) {
        await this.retryDelay(attempt);
        continue;
      }
      throw new LipApiError(response.status, this.problem(response.status, responseBody));
    }
    throw new LipTransportError(`request to ${input.path} exhausted retries`, undefined);
  }

  private context(idempotencyKey?: string): RequestContext {
    return {
      protocol_version: "1.0",
      profile: "foodservice/1.0",
      request_id: this.idGenerator("request"),
      idempotency_key: idempotencyKey ?? this.idGenerator("idempotency"),
      occurred_at: this.clock().toISOString(),
      source: structuredClone(this.source)
    };
  }

  private assertOrder(order: EvaluationRequest["order"]): void {
    const validation = validateFoodserviceOrder(order);
    if (!validation.ok) throw new LipValidationError("request", validation.issues);
  }

  private async resolveApiKey(): Promise<string> {
    return typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json() as unknown;
    } catch {
      throw new LipValidationError("response", validationIssue("response body is not valid JSON"));
    }
  }

  private problem(status: number, body: unknown): ProblemDetails {
    const validation = validate(ProblemDetailsSchema, body);
    if (validation.ok) return validation.value;
    return {
      type: "about:blank",
      title: `HTTP ${status}`,
      status,
      detail: "Server returned an invalid problem-details response"
    };
  }

  private retryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private retryDelay(attempt: number): Promise<void> {
    const milliseconds = Math.min(
      this.retry.maxDelayMs,
      this.retry.baseDelayMs * 2 ** (attempt - 1)
    );
    return this.sleep(milliseconds);
  }
}
