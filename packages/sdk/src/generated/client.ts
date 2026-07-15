// Generated from spec/openapi.yaml by scripts/generate-sdk.ts. Do not edit.
import type {
  schemaRegistry,
  AccrualPostRequest,
  CapabilitiesDocument,
  EvaluationRequest,
  EvaluationResponse,
  HealthDocument,
  LedgerListRequest,
  LedgerListResponse,
  LedgerResponse,
  ManualAdjustmentRequest,
  MemberAccountRequest,
  MemberAccountResponse,
  MemberEnrollRequest,
  MemberEnrollResponse,
  MemberLookupRequest,
  MemberLookupResponse,
  OrderAdjustmentRequest,
  ProgramGetRequest,
  ProgramGetResponse,
  RedemptionCaptureRequest,
  RedemptionReservationResponse,
  RedemptionReserveRequest,
  RedemptionReverseRequest,
  WellKnownDocument
} from "@loyalty-interchange/protocol";

export type GeneratedSchemaName = keyof typeof schemaRegistry;

export interface GeneratedCallOptions {
  signal?: AbortSignal;
}

export interface GeneratedOperation<TRequest = unknown, TResponse = unknown> {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly authenticated: boolean;
  readonly safeToRetry: boolean;
  readonly requestSchema?: GeneratedSchemaName;
  readonly responseSchema: GeneratedSchemaName;
  readonly __types?: { request: TRequest; response: TResponse };
}

export interface GeneratedTransport {
  request<TRequest, TResponse>(
    operation: GeneratedOperation<TRequest, TResponse>,
    body: TRequest | undefined,
    options?: GeneratedCallOptions
  ): Promise<TResponse>;
}

export const generatedOperations = {
  discoverLoyaltyProtocol: {
    operationId: "discoverLoyaltyProtocol",
    method: "GET",
    path: "/.well-known/lip",
    authenticated: false,
    safeToRetry: true,
    responseSchema: "WellKnownDocument"
  },
  getHealth: {
    operationId: "getHealth",
    method: "GET",
    path: "/health",
    authenticated: false,
    safeToRetry: true,
    responseSchema: "HealthDocument"
  },
  getCapabilities: {
    operationId: "getCapabilities",
    method: "GET",
    path: "/lip/v1/capabilities",
    authenticated: true,
    safeToRetry: true,
    responseSchema: "CapabilitiesDocument"
  },
  getProgram: {
    operationId: "getProgram",
    method: "POST",
    path: "/lip/v1/programs/get",
    authenticated: true,
    safeToRetry: true,
    requestSchema: "ProgramGetRequest",
    responseSchema: "ProgramGetResponse"
  },
  getMemberAccount: {
    operationId: "getMemberAccount",
    method: "POST",
    path: "/lip/v1/accounts/get",
    authenticated: true,
    safeToRetry: true,
    requestSchema: "MemberAccountRequest",
    responseSchema: "MemberAccountResponse"
  },
  listLedgerEntries: {
    operationId: "listLedgerEntries",
    method: "POST",
    path: "/lip/v1/ledger/list",
    authenticated: true,
    safeToRetry: true,
    requestSchema: "LedgerListRequest",
    responseSchema: "LedgerListResponse"
  },
  postManualAdjustment: {
    operationId: "postManualAdjustment",
    method: "POST",
    path: "/lip/v1/ledger/manual-adjustments",
    authenticated: true,
    safeToRetry: false,
    requestSchema: "ManualAdjustmentRequest",
    responseSchema: "LedgerResponse"
  },
  lookupMember: {
    operationId: "lookupMember",
    method: "POST",
    path: "/lip/v1/members/lookup",
    authenticated: true,
    safeToRetry: true,
    requestSchema: "MemberLookupRequest",
    responseSchema: "MemberLookupResponse"
  },
  enrollMember: {
    operationId: "enrollMember",
    method: "POST",
    path: "/lip/v1/members/enroll",
    authenticated: true,
    safeToRetry: false,
    requestSchema: "MemberEnrollRequest",
    responseSchema: "MemberEnrollResponse"
  },
  evaluateOrder: {
    operationId: "evaluateOrder",
    method: "POST",
    path: "/lip/v1/orders/evaluate",
    authenticated: true,
    safeToRetry: true,
    requestSchema: "EvaluationRequest",
    responseSchema: "EvaluationResponse"
  },
  postAccrual: {
    operationId: "postAccrual",
    method: "POST",
    path: "/lip/v1/accruals",
    authenticated: true,
    safeToRetry: false,
    requestSchema: "AccrualPostRequest",
    responseSchema: "LedgerResponse"
  },
  reserveRedemption: {
    operationId: "reserveRedemption",
    method: "POST",
    path: "/lip/v1/redemptions/reserve",
    authenticated: true,
    safeToRetry: false,
    requestSchema: "RedemptionReserveRequest",
    responseSchema: "RedemptionReservationResponse"
  },
  captureRedemption: {
    operationId: "captureRedemption",
    method: "POST",
    path: "/lip/v1/redemptions/capture",
    authenticated: true,
    safeToRetry: false,
    requestSchema: "RedemptionCaptureRequest",
    responseSchema: "RedemptionReservationResponse"
  },
  reverseRedemption: {
    operationId: "reverseRedemption",
    method: "POST",
    path: "/lip/v1/redemptions/reverse",
    authenticated: true,
    safeToRetry: false,
    requestSchema: "RedemptionReverseRequest",
    responseSchema: "RedemptionReservationResponse"
  },
  adjustOrder: {
    operationId: "adjustOrder",
    method: "POST",
    path: "/lip/v1/orders/adjust",
    authenticated: true,
    safeToRetry: false,
    requestSchema: "OrderAdjustmentRequest",
    responseSchema: "LedgerResponse"
  }
} as const satisfies Record<string, GeneratedOperation>;

export class GeneratedLipClient {
  public constructor(private readonly transport: GeneratedTransport) {}

  public discoverLoyaltyProtocol(options?: GeneratedCallOptions): Promise<WellKnownDocument> {
    return this.transport.request<never, WellKnownDocument>(
      generatedOperations.discoverLoyaltyProtocol,
      undefined,
      options
    );
  }

  public getHealth(options?: GeneratedCallOptions): Promise<HealthDocument> {
    return this.transport.request<never, HealthDocument>(
      generatedOperations.getHealth,
      undefined,
      options
    );
  }

  public getCapabilities(options?: GeneratedCallOptions): Promise<CapabilitiesDocument> {
    return this.transport.request<never, CapabilitiesDocument>(
      generatedOperations.getCapabilities,
      undefined,
      options
    );
  }

  public getProgram(body: ProgramGetRequest, options?: GeneratedCallOptions): Promise<ProgramGetResponse> {
    return this.transport.request<ProgramGetRequest, ProgramGetResponse>(
      generatedOperations.getProgram,
      body,
      options
    );
  }

  public getMemberAccount(body: MemberAccountRequest, options?: GeneratedCallOptions): Promise<MemberAccountResponse> {
    return this.transport.request<MemberAccountRequest, MemberAccountResponse>(
      generatedOperations.getMemberAccount,
      body,
      options
    );
  }

  public listLedgerEntries(body: LedgerListRequest, options?: GeneratedCallOptions): Promise<LedgerListResponse> {
    return this.transport.request<LedgerListRequest, LedgerListResponse>(
      generatedOperations.listLedgerEntries,
      body,
      options
    );
  }

  public postManualAdjustment(body: ManualAdjustmentRequest, options?: GeneratedCallOptions): Promise<LedgerResponse> {
    return this.transport.request<ManualAdjustmentRequest, LedgerResponse>(
      generatedOperations.postManualAdjustment,
      body,
      options
    );
  }

  public lookupMember(body: MemberLookupRequest, options?: GeneratedCallOptions): Promise<MemberLookupResponse> {
    return this.transport.request<MemberLookupRequest, MemberLookupResponse>(
      generatedOperations.lookupMember,
      body,
      options
    );
  }

  public enrollMember(body: MemberEnrollRequest, options?: GeneratedCallOptions): Promise<MemberEnrollResponse> {
    return this.transport.request<MemberEnrollRequest, MemberEnrollResponse>(
      generatedOperations.enrollMember,
      body,
      options
    );
  }

  public evaluateOrder(body: EvaluationRequest, options?: GeneratedCallOptions): Promise<EvaluationResponse> {
    return this.transport.request<EvaluationRequest, EvaluationResponse>(
      generatedOperations.evaluateOrder,
      body,
      options
    );
  }

  public postAccrual(body: AccrualPostRequest, options?: GeneratedCallOptions): Promise<LedgerResponse> {
    return this.transport.request<AccrualPostRequest, LedgerResponse>(
      generatedOperations.postAccrual,
      body,
      options
    );
  }

  public reserveRedemption(body: RedemptionReserveRequest, options?: GeneratedCallOptions): Promise<RedemptionReservationResponse> {
    return this.transport.request<RedemptionReserveRequest, RedemptionReservationResponse>(
      generatedOperations.reserveRedemption,
      body,
      options
    );
  }

  public captureRedemption(body: RedemptionCaptureRequest, options?: GeneratedCallOptions): Promise<RedemptionReservationResponse> {
    return this.transport.request<RedemptionCaptureRequest, RedemptionReservationResponse>(
      generatedOperations.captureRedemption,
      body,
      options
    );
  }

  public reverseRedemption(body: RedemptionReverseRequest, options?: GeneratedCallOptions): Promise<RedemptionReservationResponse> {
    return this.transport.request<RedemptionReverseRequest, RedemptionReservationResponse>(
      generatedOperations.reverseRedemption,
      body,
      options
    );
  }

  public adjustOrder(body: OrderAdjustmentRequest, options?: GeneratedCallOptions): Promise<LedgerResponse> {
    return this.transport.request<OrderAdjustmentRequest, LedgerResponse>(
      generatedOperations.adjustOrder,
      body,
      options
    );
  }
}
