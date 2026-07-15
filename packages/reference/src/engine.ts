import { createHash, randomUUID } from "node:crypto";
import type {
  AccountMetric,
  AccrualPostRequest,
  Balance,
  EvaluationRequest,
  EvaluationResponse,
  ExpiringBalance,
  IdentityReference,
  LedgerEntry,
  LedgerListRequest,
  LedgerListResponse,
  LedgerResponse,
  Member,
  MemberAccountRequest,
  MemberAccountResponse,
  MemberEnrollRequest,
  MemberEnrollResponse,
  MemberLookupRequest,
  MemberLookupResponse,
  OrderChannel,
  OrderAdjustmentRequest,
  ProgramCatalog,
  ProgramGetRequest,
  ProgramGetResponse,
  RedemptionCaptureRequest,
  RedemptionReservation,
  RedemptionReservationResponse,
  RedemptionReserveRequest,
  RedemptionReverseRequest,
  RequestContext,
  ResponseContext,
  RewardCandidate,
  TierProgress
} from "@loyalty-interchange/protocol";
import {
  ProgramCatalogSchema,
  validate,
  validateFoodserviceOrder,
  validateFundingShares
} from "@loyalty-interchange/protocol";
import type { Clock, IdGenerator, ProgramDefinition, RewardDefinition } from "./config.js";
import { EngineError } from "./errors.js";
import { programConfigurationFor, type ReferenceProgramConfiguration } from "./program-configuration.js";

export interface ReferenceIdempotencyRecord {
  fingerprint: string;
  response: unknown;
}

interface LedgerCursor {
  version: 1;
  query: string;
  entry_id: string;
}

export interface ReferencePointLot {
  entryId: string;
  memberId: string;
  remaining: number;
  expiresAt: string;
}

export interface ReferencePointLotConsumption {
  entryId: string;
  amount: number;
}

interface AccrualRecord {
  entryId: string;
  fingerprint: string;
  multiplierBps: number;
}

interface MutationRecord {
  entryId: string;
  fingerprint: string;
}

interface ReservationRecord {
  reservationId: string;
  fingerprint: string;
}

export interface LoyaltyEngineState {
  version: 1;
  program_id: string;
  program_fingerprint: string;
  saved_at: string;
  members: Array<[string, Member]>;
  identity_index: Array<[string, string]>;
  points: Array<[string, number]>;
  reservations: Array<[string, RedemptionReservation]>;
  ledger: Array<[string, LedgerEntry]>;
  point_lots: Array<[string, ReferencePointLot]>;
  point_lot_consumptions: Array<[string, ReferencePointLotConsumption[]]>;
  idempotency: Array<[string, ReferenceIdempotencyRecord]>;
  accruals_by_order: Array<[string, AccrualRecord]>;
  adjustments: Array<[string, MutationRecord]>;
  reservations_by_redemption: Array<[string, ReservationRecord]>;
}

export interface ReferenceAdminMember {
  member: Member;
  balance: Balance;
  metrics: AccountMetric[];
  expiring_balances: ExpiringBalance[];
  tier_progress?: TierProgress;
  last_activity_at?: string;
}

export interface ReferenceAdminSnapshot {
  generated_at: string;
  program: ProgramCatalog;
  program_configuration: ReferenceProgramConfiguration;
  summary: {
    active_members: number;
    points_outstanding: number;
    points_issued: number;
    points_redeemed: number;
    expiring_points: number;
    ledger_entries: number;
  };
  members: ReferenceAdminMember[];
  ledger: LedgerEntry[];
  reservations: RedemptionReservation[];
}

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdGenerator = (prefix) => `${prefix}_${randomUUID()}`;
const allOrderChannels: OrderChannel[] = [
  "counter",
  "drive_thru",
  "kiosk",
  "web",
  "mobile",
  "pickup",
  "delivery",
  "catering",
  "third_party",
  "other"
];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function idempotencyFingerprint(value: unknown): string {
  if (!value || typeof value !== "object") {
    return fingerprint(value);
  }
  const request = value as Record<string, unknown>;
  if (!request.context || typeof request.context !== "object") {
    return fingerprint(value);
  }
  const { request_id: _requestId, ...context } = request.context as Record<string, unknown>;
  return fingerprint({ ...request, context });
}

function identityKey(programId: string, identity: IdentityReference): string {
  return [programId, identity.type, identity.issuer ?? "", identity.value].join("|");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class LoyaltyEngine {
  private readonly program: ProgramDefinition;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly members = new Map<string, Member>();
  private readonly identityIndex = new Map<string, string>();
  private readonly points = new Map<string, number>();
  private readonly reservations = new Map<string, RedemptionReservation>();
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly pointLots = new Map<string, ReferencePointLot>();
  private readonly pointLotConsumptions = new Map<string, ReferencePointLotConsumption[]>();
  private readonly idempotency = new Map<string, ReferenceIdempotencyRecord>();
  private readonly accrualsByOrder = new Map<string, AccrualRecord>();
  private readonly adjustments = new Map<string, MutationRecord>();
  private readonly reservationsByRedemption = new Map<string, ReservationRecord>();

  public constructor(
    program: ProgramDefinition,
    options: { clock?: Clock; ids?: IdGenerator; state?: LoyaltyEngineState } = {}
  ) {
    this.assertProgram(program);
    this.program = clone(program);
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? systemIds;
    const catalogValidation = validate(ProgramCatalogSchema, this.programCatalog());
    if (!catalogValidation.ok) {
      throw new EngineError(
        "invalid_program",
        catalogValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
        400
      );
    }
    if (options.state) this.hydrate(options.state);
  }

  public lookup(request: MemberLookupRequest): MemberLookupResponse {
    this.assertProgramId(request.program_id);
    return this.once("member.lookup", request.context, request, () => {
      const memberId = this.identityIndex.get(identityKey(request.program_id, request.identity));
      const member = memberId ? this.members.get(memberId) ?? null : null;
      return {
        context: this.responseContext(request.context),
        member: member ? this.memberSnapshot(member) : null,
        balances: member ? [this.balance(member.member_id)] : []
      };
    });
  }

  public enroll(request: MemberEnrollRequest): MemberEnrollResponse {
    this.assertProgramId(request.program_id);
    return this.once("member.enroll", request.context, request, () => {
      const key = identityKey(request.program_id, request.identity);
      const existingId = this.identityIndex.get(key);
      if (existingId) {
        const existing = this.members.get(existingId);
        if (!existing) {
          throw new EngineError("not_found", "Identity index references a missing member", 500);
        }
        return {
          context: this.responseContext(request.context),
          member: this.memberSnapshot(existing),
          balances: [this.balance(existing.member_id)]
        };
      }

      const memberId = request.member_id ?? this.ids("member");
      if (this.members.has(memberId)) {
        throw new EngineError("conflict", `Member ${memberId} already exists`);
      }
      const baseTierId = this.baseTierId();
      const member: Member = {
        member_id: memberId,
        program_id: request.program_id,
        status: "active",
        joined_at: this.isoNow(),
        ...(baseTierId ? { tier_id: baseTierId } : {}),
        identities: [clone(request.identity)],
        ...(request.attributes ? { attributes: clone(request.attributes) } : {})
      };
      this.members.set(memberId, member);
      this.identityIndex.set(key, memberId);
      this.points.set(memberId, 0);
      return {
        context: this.responseContext(request.context),
        member: this.memberSnapshot(member),
        balances: [this.balance(memberId)]
      };
    });
  }

  public getProgram(request: ProgramGetRequest): ProgramGetResponse {
    this.assertProgramId(request.program_id);
    return this.once("program.get", request.context, request, () => ({
      context: this.responseContext(request.context),
      program: this.programCatalog()
    }));
  }

  public getAccount(request: MemberAccountRequest): MemberAccountResponse {
    this.assertProgramId(request.program_id);
    return this.once("account.get", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.expirePointLots(request.member_id);
      const metrics = this.accountMetrics(request.member_id);
      const tierProgress = this.tierProgress(metrics);
      return {
        context: this.responseContext(request.context),
        member: this.memberSnapshot(member),
        balances: [this.balance(request.member_id)],
        metrics,
        expiring_balances: this.expiringBalances(request.member_id),
        ...(tierProgress ? { tier_progress: tierProgress } : {})
      };
    });
  }

  public listLedger(request: LedgerListRequest): LedgerListResponse {
    this.assertProgramId(request.program_id);
    return this.once("ledger.list", request.context, request, () => {
      this.activeMember(request.member_id);
      this.expirePointLots(request.member_id);
      const query = this.ledgerQueryFingerprint(request);
      const entries = [...this.ledger.values()]
        .filter((entry) => this.matchesLedgerQuery(entry, request))
        .sort((left, right) => {
          const occurred = Date.parse(right.occurred_at) - Date.parse(left.occurred_at);
          return occurred !== 0 ? occurred : right.entry_id.localeCompare(left.entry_id);
        });
      const start = request.cursor ? this.cursorStart(request.cursor, query, entries) : 0;
      const limit = request.limit ?? 50;
      const page = entries.slice(start, start + limit);
      const hasMore = start + page.length < entries.length;
      const last = page.at(-1);
      return {
        context: this.responseContext(request.context),
        entries: page.map(clone),
        ...(hasMore && last ? { next_cursor: this.encodeCursor({
          version: 1,
          query,
          entry_id: last.entry_id
        }) } : {})
      };
    });
  }

  public evaluate(request: EvaluationRequest): EvaluationResponse {
    return this.once("order.evaluate", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.assertOrder(request.order, member);
      const rewards = this.program.rewards.map((reward) => this.rewardCandidate(reward, request.member_id));
      const multiplierBps = this.tierMultiplierBps(request.member_id);
      return {
        context: this.responseContext(request.context),
        evaluation_id: this.ids("eval"),
        member_id: request.member_id,
        order_id: request.order.order_id,
        estimated_accrual: {
          unit: "points",
          amount: this.accrualPoints(request.order, multiplierBps)
        },
        rewards,
        balances: [this.balance(request.member_id)],
        expires_at: this.futureIso(this.program.evaluation_ttl_seconds)
      };
    });
  }

  public postAccrual(request: AccrualPostRequest): LedgerResponse {
    return this.once("accrual.post", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.assertOrder(request.order, member);
      if (request.order.status !== "paid") {
        throw new EngineError("invalid_state", "Accrual requires a paid order");
      }

      const businessFingerprint = fingerprint({ member_id: request.member_id, order: request.order });
      const existingAccrual = this.accrualsByOrder.get(request.order.order_id);
      if (existingAccrual) {
        if (existingAccrual.fingerprint !== businessFingerprint) {
          throw new EngineError("conflict", "Order id was already accrued with different facts");
        }
        const existingEntry = this.ledger.get(existingAccrual.entryId);
        if (!existingEntry || existingEntry.member_id !== request.member_id) {
          throw new EngineError("conflict", "Order was accrued to a different member");
        }
        return this.ledgerResponse(request.context, existingEntry);
      }

      const multiplierBps = this.tierMultiplierBps(request.member_id);
      const amount = this.accrualPoints(request.order, multiplierBps);
      const entry = this.addLedger({
        member_id: request.member_id,
        operation: "accrual",
        amount,
        order_id: request.order.order_id,
        ...(amount > 0 && this.program.point_expiration ? {
          expires_at: this.pointExpirationIso(),
          create_point_lot: true
        } : {})
      });
      this.accrualsByOrder.set(request.order.order_id, {
        entryId: entry.entry_id,
        fingerprint: businessFingerprint,
        multiplierBps
      });
      return this.ledgerResponse(request.context, entry);
    });
  }

  public reserve(request: RedemptionReserveRequest): RedemptionReservationResponse {
    return this.once("redemption.reserve", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.assertOrder(request.order, member);
      const businessFingerprint = fingerprint({
        member_id: request.member_id,
        reward_id: request.reward_id,
        order: request.order
      });
      const existingReservation = this.reservationsByRedemption.get(request.redemption_id);
      if (existingReservation) {
        if (existingReservation.fingerprint !== businessFingerprint) {
          throw new EngineError("conflict", "Redemption id was already used with different facts");
        }
        return this.reservationResponse(
          request.context,
          this.getReservation(existingReservation.reservationId)
        );
      }
      const reward = this.program.rewards.find((candidate) => candidate.reward_id === request.reward_id);
      if (!reward) {
        throw new EngineError("reward_not_found", `Reward ${request.reward_id} was not found`, 404);
      }
      if (this.balance(request.member_id).available < reward.points_cost) {
        throw new EngineError("insufficient_balance", "Member does not have enough available points");
      }

      const now = this.isoNow();
      const reservation: RedemptionReservation = {
        reservation_id: this.ids("reservation"),
        redemption_id: request.redemption_id,
        member_id: request.member_id,
        reward_id: reward.reward_id,
        order_id: request.order.order_id,
        status: "reserved",
        cost: { unit: "points", amount: reward.points_cost },
        effect: clone(reward.effect),
        funding: this.fundingAllocations(reward),
        created_at: now,
        expires_at: this.futureIso(this.program.reservation_ttl_seconds)
      };
      this.reservations.set(reservation.reservation_id, reservation);
      this.reservationsByRedemption.set(request.redemption_id, {
        reservationId: reservation.reservation_id,
        fingerprint: businessFingerprint
      });
      return this.reservationResponse(request.context, reservation);
    });
  }

  public capture(request: RedemptionCaptureRequest): RedemptionReservationResponse {
    return this.once("redemption.capture", request.context, request, () => {
      const reservation = this.getReservation(request.reservation_id);
      this.expireReservation(reservation);
      if (reservation.order_id !== request.order_id) {
        throw new EngineError("conflict", "Reservation belongs to a different order");
      }
      if (reservation.status === "captured") {
        return this.reservationResponse(request.context, reservation);
      }
      if (reservation.status === "expired") {
        throw new EngineError("expired", "Reservation has expired");
      }
      if (reservation.status !== "reserved") {
        throw new EngineError("invalid_state", `Cannot capture a ${reservation.status} reservation`);
      }

      const balance = this.balance(reservation.member_id);
      if (balance.amount < reservation.cost.amount) {
        throw new EngineError("insufficient_balance", "Member no longer has enough points");
      }
      this.consumePointLots(
        reservation.member_id,
        reservation.cost.amount,
        reservation.reservation_id
      );
      this.addLedger({
        member_id: reservation.member_id,
        operation: "redemption",
        amount: -reservation.cost.amount,
        order_id: reservation.order_id,
        reservation_id: reservation.reservation_id
      });
      reservation.status = "captured";
      reservation.captured_at = this.isoNow();
      return this.reservationResponse(request.context, reservation);
    });
  }

  public reverse(request: RedemptionReverseRequest): RedemptionReservationResponse {
    return this.once("redemption.reverse", request.context, request, () => {
      const reservation = this.getReservation(request.reservation_id);
      this.expireReservation(reservation);
      if (reservation.status === "reversed") {
        return this.reservationResponse(request.context, reservation);
      }
      if (reservation.status === "expired") {
        throw new EngineError("expired", "Reservation has expired");
      }
      if (reservation.status === "captured") {
        this.restorePointLots(reservation.reservation_id);
        this.addLedger({
          member_id: reservation.member_id,
          operation: "reversal",
          amount: reservation.cost.amount,
          order_id: reservation.order_id,
          reservation_id: reservation.reservation_id
        });
        this.expirePointLots(reservation.member_id);
      }
      reservation.status = "reversed";
      reservation.reversed_at = this.isoNow();
      return this.reservationResponse(request.context, reservation);
    });
  }

  public adjustOrder(request: OrderAdjustmentRequest): LedgerResponse {
    this.assertProgramId(request.program_id);
    return this.once("order.adjust", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.expirePointLots(request.member_id);
      const adjustment = request.adjustment;
      if (adjustment.eligible_spend_delta.currency !== this.program.currency) {
        throw new EngineError("currency_mismatch", "Adjustment currency does not match the program");
      }
      const adjustmentMoney = [
        adjustment.order_total_delta,
        adjustment.eligible_spend_delta,
        ...(adjustment.lines?.map((line) => line.subtotal_delta) ?? [])
      ];
      if (adjustmentMoney.some((money) => money.currency !== this.program.currency)) {
        throw new EngineError("currency_mismatch", "All adjustment amounts must use the program currency");
      }
      if (
        adjustment.type !== "correction" &&
        (adjustment.order_total_delta.amount > 0 || adjustment.eligible_spend_delta.amount > 0)
      ) {
        throw new EngineError("invalid_state", "Refund and void adjustments must not increase spend");
      }
      const businessFingerprint = fingerprint({
        member_id: request.member_id,
        program_id: request.program_id,
        adjustment
      });
      const existingAdjustment = this.adjustments.get(adjustment.adjustment_id);
      if (existingAdjustment) {
        if (existingAdjustment.fingerprint !== businessFingerprint) {
          throw new EngineError("conflict", "Adjustment id was already used with different facts");
        }
        const existing = this.ledger.get(existingAdjustment.entryId);
        if (!existing) {
          throw new EngineError("not_found", "Adjustment references a missing ledger entry", 500);
        }
        return this.ledgerResponse(request.context, existing);
      }

      const originalAccrual = this.accrualsByOrder.get(adjustment.original_order_id);
      const multiplierBps = originalAccrual?.multiplierBps ?? this.tierMultiplierBps(member.member_id);
      const amount = this.pointsForSignedSpend(adjustment.eligible_spend_delta.amount, multiplierBps);
      if (amount < 0) this.consumePointLots(request.member_id, -amount);
      const entry = this.addLedger({
        member_id: request.member_id,
        operation: "adjustment",
        amount,
        order_id: adjustment.original_order_id,
        adjustment_id: adjustment.adjustment_id,
        ...(amount > 0 && this.program.point_expiration ? {
          expires_at: this.pointExpirationIso(),
          create_point_lot: true
        } : {})
      });
      this.adjustments.set(adjustment.adjustment_id, {
        entryId: entry.entry_id,
        fingerprint: businessFingerprint
      });
      return this.ledgerResponse(request.context, entry);
    });
  }

  public getLedger(): LedgerEntry[] {
    this.expirePointLots();
    return [...this.ledger.values()].map(clone);
  }

  public exportState(): LoyaltyEngineState {
    return clone({
      version: 1,
      program_id: this.program.program_id,
      program_fingerprint: fingerprint(this.program),
      saved_at: this.isoNow(),
      members: [...this.members.entries()],
      identity_index: [...this.identityIndex.entries()],
      points: [...this.points.entries()],
      reservations: [...this.reservations.entries()],
      ledger: [...this.ledger.entries()],
      point_lots: [...this.pointLots.entries()],
      point_lot_consumptions: [...this.pointLotConsumptions.entries()],
      idempotency: [...this.idempotency.entries()],
      accruals_by_order: [...this.accrualsByOrder.entries()],
      adjustments: [...this.adjustments.entries()],
      reservations_by_redemption: [...this.reservationsByRedemption.entries()]
    });
  }

  public inspectAdmin(): ReferenceAdminSnapshot {
    this.expireAllReservations();
    this.expirePointLots();
    const ledger = [...this.ledger.values()]
      .sort((left, right) => {
        const occurred = Date.parse(right.occurred_at) - Date.parse(left.occurred_at);
        return occurred !== 0 ? occurred : right.entry_id.localeCompare(left.entry_id);
      })
      .map(clone);
    const members = [...this.members.values()]
      .map((member): ReferenceAdminMember => {
        const metrics = this.accountMetrics(member.member_id);
        const tierProgress = this.tierProgress(metrics);
        const lastActivity = ledger.find((entry) => entry.member_id === member.member_id)?.occurred_at;
        return {
          member: this.memberSnapshot(member),
          balance: this.balance(member.member_id),
          metrics,
          expiring_balances: this.expiringBalances(member.member_id),
          ...(tierProgress ? { tier_progress: tierProgress } : {}),
          ...(lastActivity ? { last_activity_at: lastActivity } : {})
        };
      })
      .sort((left, right) =>
        (right.last_activity_at ?? right.member.joined_at)
          .localeCompare(left.last_activity_at ?? left.member.joined_at)
      );
    const pointsIssued = ledger
      .filter((entry) => entry.amount > 0)
      .reduce((sum, entry) => sum + entry.amount, 0);
    const pointsRedeemed = ledger
      .filter((entry) => entry.operation === "redemption")
      .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);

    return {
      generated_at: this.isoNow(),
      program: this.programCatalog(),
      program_configuration: programConfigurationFor(this.program),
      summary: {
        active_members: members.filter(({ member }) => member.status === "active").length,
        points_outstanding: members.reduce((sum, { balance }) => sum + balance.amount, 0),
        points_issued: pointsIssued,
        points_redeemed: pointsRedeemed,
        expiring_points: members.reduce(
          (sum, member) => sum + member.expiring_balances.reduce(
            (memberSum, balance) => memberSum + balance.amount,
            0
          ),
          0
        ),
        ledger_entries: ledger.length
      },
      members,
      ledger,
      reservations: [...this.reservations.values()].map(clone)
    };
  }

  private hydrate(state: LoyaltyEngineState): void {
    if (
      !state ||
      state.version !== 1 ||
      state.program_id !== this.program.program_id ||
      state.program_fingerprint !== fingerprint(this.program)
    ) {
      throw new EngineError(
        "invalid_state",
        "Stored engine state is incompatible with the configured program",
        500
      );
    }

    this.restoreMap(this.members, state.members, "members");
    this.restoreMap(this.identityIndex, state.identity_index, "identity index");
    this.restoreMap(this.points, state.points, "points");
    this.restoreMap(this.reservations, state.reservations, "reservations");
    this.restoreMap(this.ledger, state.ledger, "ledger");
    this.restoreMap(this.pointLots, state.point_lots, "point lots");
    this.restoreMap(
      this.pointLotConsumptions,
      state.point_lot_consumptions,
      "point-lot consumptions"
    );
    this.restoreMap(this.idempotency, state.idempotency, "idempotency records");
    this.restoreMap(this.accrualsByOrder, state.accruals_by_order, "order accruals");
    this.restoreMap(this.adjustments, state.adjustments, "order adjustments");
    this.restoreMap(
      this.reservationsByRedemption,
      state.reservations_by_redemption,
      "redemption reservations"
    );

    for (const [memberId, member] of this.members) {
      if (member.member_id !== memberId || !this.points.has(memberId)) {
        throw new EngineError("invalid_state", "Stored member state is internally inconsistent", 500);
      }
    }
  }

  private restoreMap<K, V>(target: Map<K, V>, entries: Array<[K, V]>, name: string): void {
    if (!Array.isArray(entries)) {
      throw new EngineError("invalid_state", `Stored ${name} are invalid`, 500);
    }
    const restored = new Map(entries);
    if (restored.size !== entries.length) {
      throw new EngineError("invalid_state", `Stored ${name} contain duplicate keys`, 500);
    }
    for (const [key, value] of restored) target.set(clone(key), clone(value));
  }

  private assertProgram(program: ProgramDefinition): void {
    if (!program.program_id || !/^[A-Z]{3}$/.test(program.currency)) {
      throw new EngineError("invalid_program", "Program id and ISO currency are required", 400);
    }
    if (
      !Number.isInteger(program.earn_rate.points) ||
      program.earn_rate.points < 0 ||
      !Number.isInteger(program.earn_rate.spend_minor_units) ||
      program.earn_rate.spend_minor_units <= 0
    ) {
      throw new EngineError("invalid_program", "Earn rate must use non-negative integer points and positive spend", 400);
    }
    if (program.evaluation_ttl_seconds <= 0 || program.reservation_ttl_seconds <= 0) {
      throw new EngineError("invalid_program", "TTL values must be positive", 400);
    }
    const earning = program.earning_policy;
    if (
      earning?.minimum_eligible_spend_minor_units !== undefined &&
      (!Number.isInteger(earning.minimum_eligible_spend_minor_units) ||
        earning.minimum_eligible_spend_minor_units < 0)
    ) {
      throw new EngineError("invalid_program", "Minimum eligible spend must be a non-negative integer", 400);
    }
    if (earning?.eligible_channels && (
      earning.eligible_channels.length === 0 ||
      new Set(earning.eligible_channels).size !== earning.eligible_channels.length
    )) {
      throw new EngineError("invalid_program", "Eligible channels must be non-empty and unique", 400);
    }
    const expiration = program.point_expiration;
    if (expiration && (
      !Number.isInteger(expiration.days) ||
      expiration.days <= 0 ||
      !Array.isArray(expiration.warning_days) ||
      expiration.warning_days.some((days) =>
        !Number.isInteger(days) || days <= 0 || days >= expiration.days
      )
    )) {
      throw new EngineError("invalid_program", "Point expiration and warnings are invalid", 400);
    }
    const accounts = program.accounts ?? [{ unit: "points", unit_label: "points", is_primary: true }];
    if (
      accounts.length !== 1 ||
      accounts[0]?.unit !== "points" ||
      accounts.filter((account) => account.is_primary).length !== 1
    ) {
      throw new EngineError(
        "invalid_program",
        "The reference engine requires one primary points account",
        400
      );
    }
    const metricIds = new Set<string>();
    for (const metric of program.metrics ?? []) {
      if (
        metricIds.has(metric.metric_id) ||
        metric.unit !== "points" ||
        !["current_balance", "lifetime_earned", "qualification_earned"].includes(metric.source)
      ) {
        throw new EngineError("invalid_program", "Metrics need unique ids and points units", 400);
      }
      metricIds.add(metric.metric_id);
    }
    const tiers = [...(program.tiers ?? [])].sort((left, right) => left.minimum - right.minimum);
    if (tiers.length > 0) {
      const tierIds = new Set<string>();
      const qualificationMetric = tiers[0]!.qualification_metric_id;
      if (tiers[0]!.minimum !== 0 || !metricIds.has(qualificationMetric)) {
        throw new EngineError(
          "invalid_program",
          "Tier ladders must start at zero and reference a configured metric",
          400
        );
      }
      for (const [index, tier] of tiers.entries()) {
        const previous = tiers[index - 1];
        if (
          tierIds.has(tier.tier_id) ||
          tier.qualification_metric_id !== qualificationMetric ||
          (previous && previous.minimum === tier.minimum)
        ) {
          throw new EngineError(
            "invalid_program",
            "Tiers need unique ids, thresholds, and one qualification metric",
            400
          );
        }
        tierIds.add(tier.tier_id);
      }
    }
    const tierPolicy = program.tier_policy;
    if (tierPolicy) {
      const qualificationMetric = tiers[0]?.qualification_metric_id;
      if (
        tierPolicy.metric_id !== qualificationMetric ||
        !metricIds.has(tierPolicy.metric_id)
      ) {
        throw new EngineError("invalid_program", "Tier policy must reference the tier qualification metric", 400);
      }
      const testDate = new Date(Date.UTC(
        2024,
        tierPolicy.period.starts_month - 1,
        tierPolicy.period.starts_day
      ));
      if (
        testDate.getUTCMonth() !== tierPolicy.period.starts_month - 1 ||
        testDate.getUTCDate() !== tierPolicy.period.starts_day
      ) {
        throw new EngineError("invalid_program", "Tier policy start date is invalid", 400);
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tierPolicy.period.time_zone }).format();
      } catch {
        throw new EngineError("invalid_program", "Tier policy time zone is invalid", 400);
      }
    }
    if (
      (program.metrics ?? []).some((metric) => metric.source === "qualification_earned") &&
      !tierPolicy
    ) {
      throw new EngineError("invalid_program", "Qualification metrics require a tier policy", 400);
    }
    const rewardIds = new Set<string>();
    for (const reward of program.rewards) {
      if (rewardIds.has(reward.reward_id) || reward.points_cost < 0 || !Number.isInteger(reward.points_cost)) {
        throw new EngineError("invalid_program", "Rewards need unique ids and non-negative integer costs", 400);
      }
      rewardIds.add(reward.reward_id);
      if (!validateFundingShares(reward.funding).ok) {
        throw new EngineError("invalid_program", `Funding for ${reward.reward_id} must total 10000 basis points`, 400);
      }
      const effectMoney = reward.effect.type === "discount"
        ? [reward.effect.amount, ...reward.effect.allocations.map((allocation) => allocation.amount)]
        : reward.effect.type === "free_item"
          ? [reward.effect.max_value]
          : [];
      if (effectMoney.some((money) => money.currency !== program.currency || money.amount < 0)) {
        throw new EngineError("invalid_program", `Reward ${reward.reward_id} has invalid money`, 400);
      }
      if (
        reward.effect.type === "discount" &&
        reward.effect.allocations.reduce((sum, allocation) => sum + allocation.amount.amount, 0) !== reward.effect.amount.amount
      ) {
        throw new EngineError("invalid_program", `Reward ${reward.reward_id} allocations do not reconcile`, 400);
      }
      if (
        reward.available_from &&
        reward.available_until &&
        Date.parse(reward.available_from) > Date.parse(reward.available_until)
      ) {
        throw new EngineError("invalid_program", `Reward ${reward.reward_id} availability is inverted`, 400);
      }
    }
  }

  private assertProgramId(programId: string): void {
    if (programId !== this.program.program_id) {
      throw new EngineError("invalid_program", `Program ${programId} is not served here`, 404);
    }
  }

  private activeMember(memberId: string): Member {
    const member = this.members.get(memberId);
    if (!member) {
      throw new EngineError("member_not_found", `Member ${memberId} was not found`, 404);
    }
    if (member.status !== "active") {
      throw new EngineError("member_not_active", `Member ${memberId} is ${member.status}`);
    }
    return member;
  }

  private memberSnapshot(member: Member): Member {
    const snapshot = clone(member);
    const progress = this.tierProgress(this.accountMetrics(member.member_id));
    if (progress) snapshot.tier_id = progress.current_tier_id;
    return snapshot;
  }

  private baseTierId(): string | undefined {
    return [...(this.program.tiers ?? [])]
      .sort((left, right) => left.minimum - right.minimum)[0]?.tier_id;
  }

  private programCatalog(): ProgramCatalog {
    return {
      program_id: this.program.program_id,
      name: this.program.name ?? this.program.program_id,
      ...(this.program.description ? { description: this.program.description } : {}),
      currency: this.program.currency,
      earning: {
        rate: {
          unit: "points",
          amount: this.program.earn_rate.points,
          spend: {
            amount: this.program.earn_rate.spend_minor_units,
            currency: this.program.currency
          }
        },
        minimum_eligible_spend: {
          amount: this.program.earning_policy?.minimum_eligible_spend_minor_units ?? 0,
          currency: this.program.currency
        },
        eligible_channels: clone(this.program.earning_policy?.eligible_channels ?? allOrderChannels),
        rounding: "after_transaction",
        exclusions: {
          product_ids: clone(this.program.earning_policy?.excluded_product_ids ?? []),
          category_ids: clone(this.program.earning_policy?.excluded_category_ids ?? []),
          tags: clone(this.program.earning_policy?.excluded_tags ?? []),
          line_kinds: clone(this.program.earning_policy?.excluded_line_kinds ?? [])
        }
      },
      accounts: clone(this.program.accounts ?? [
        { unit: "points", unit_label: "points", is_primary: true }
      ]),
      metrics: (this.program.metrics ?? []).map(({ source: _source, ...metric }) => clone(metric)),
      tiers: clone(this.program.tiers ?? []),
      ...(this.program.tier_policy ? { tier_policy: clone(this.program.tier_policy) } : {}),
      ...(this.program.point_expiration ? {
        point_expiration: clone(this.program.point_expiration)
      } : {}),
      rewards: this.program.rewards.map((reward) => ({
        reward_id: reward.reward_id,
        name: reward.name ?? reward.reward_id,
        ...(reward.description ? { description: reward.description } : {}),
        ...(reward.image_url ? { image_url: reward.image_url } : {}),
        cost: { unit: "points", amount: reward.points_cost },
        effect: clone(reward.effect),
        funding: clone(reward.funding),
        ...(reward.available_from ? { available_from: reward.available_from } : {}),
        ...(reward.available_until ? { available_until: reward.available_until } : {}),
        ...(reward.metadata ? { metadata: clone(reward.metadata) } : {})
      })),
      ...(this.program.metadata ? { metadata: clone(this.program.metadata) } : {})
    };
  }

  private accountMetrics(memberId: string): AccountMetric[] {
    const asOf = this.isoNow();
    return (this.program.metrics ?? []).map((metric) => ({
      metric_id: metric.metric_id,
      unit: metric.unit,
      amount: metric.source === "current_balance"
        ? this.points.get(memberId) ?? 0
        : [...this.ledger.values()]
            .filter((entry) =>
              entry.member_id === memberId &&
              ["accrual", "adjustment", "manual"].includes(entry.operation) &&
              (metric.source !== "qualification_earned" ||
                this.isInCurrentQualificationPeriod(entry.occurred_at))
            )
            .reduce((sum, entry) => sum + entry.amount, 0),
      as_of: asOf
    }));
  }

  private isInCurrentQualificationPeriod(occurredAt: string): boolean {
    const policy = this.program.tier_policy;
    if (!policy) return false;
    const occurred = new Date(occurredAt);
    const now = this.clock.now();
    if (this.qualificationPeriodKey(occurred) !== this.qualificationPeriodKey(now)) return false;
    return !policy.effective_from ||
      this.businessDateInZone(occurred, policy.period.time_zone) >= policy.effective_from;
  }

  private qualificationPeriodKey(date: Date): number {
    const policy = this.program.tier_policy;
    if (!policy) return 0;
    const local = this.localDateParts(date, policy.period.time_zone);
    const afterStart = local.month > policy.period.starts_month ||
      (local.month === policy.period.starts_month && local.day >= policy.period.starts_day);
    return afterStart ? local.year : local.year - 1;
  }

  private businessDateInZone(date: Date, timeZone: string): string {
    const local = this.localDateParts(date, timeZone);
    return `${local.year.toString().padStart(4, "0")}-${local.month.toString().padStart(2, "0")}-${local.day.toString().padStart(2, "0")}`;
  }

  private localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date).map((part) => [part.type, part.value])
    );
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day)
    };
  }

  private tierProgress(metrics: AccountMetric[]): TierProgress | undefined {
    const tiers = [...(this.program.tiers ?? [])].sort((left, right) => left.minimum - right.minimum);
    if (tiers.length === 0) return undefined;
    const metricId = tiers[0]!.qualification_metric_id;
    const amount = Math.max(0, metrics.find((metric) => metric.metric_id === metricId)?.amount ?? 0);
    let currentIndex = 0;
    for (const [index, tier] of tiers.entries()) {
      if (tier.minimum <= amount) currentIndex = index;
    }
    const current = tiers[currentIndex]!;
    const next = tiers[currentIndex + 1];
    if (!next) {
      return {
        current_tier_id: current.tier_id,
        qualification_metric_id: metricId,
        current_amount: amount,
        progress_bps: 10_000,
        is_top_tier: true
      };
    }
    const span = next.minimum - current.minimum;
    return {
      current_tier_id: current.tier_id,
      qualification_metric_id: metricId,
      current_amount: amount,
      next_tier_id: next.tier_id,
      remaining_to_next: Math.max(0, next.minimum - amount),
      progress_bps: Math.min(10_000, Math.floor((amount - current.minimum) * 10_000 / span)),
      is_top_tier: false
    };
  }

  private tierMultiplierBps(memberId: string): number {
    const progress = this.tierProgress(this.accountMetrics(memberId));
    if (!progress) return 10_000;
    return this.program.tiers?.find((tier) => tier.tier_id === progress.current_tier_id)
      ?.earn_multiplier_bps ?? 10_000;
  }

  private matchesLedgerQuery(entry: LedgerEntry, request: LedgerListRequest): boolean {
    return entry.member_id === request.member_id &&
      entry.program_id === request.program_id &&
      (!request.account_id || entry.account_id === request.account_id) &&
      (!request.operations || request.operations.includes(entry.operation)) &&
      (!request.occurred_from || entry.occurred_at >= request.occurred_from) &&
      (!request.occurred_until || entry.occurred_at <= request.occurred_until);
  }

  private ledgerQueryFingerprint(request: LedgerListRequest): string {
    return fingerprint({
      member_id: request.member_id,
      program_id: request.program_id,
      account_id: request.account_id,
      operations: request.operations ? [...request.operations].sort() : undefined,
      occurred_from: request.occurred_from,
      occurred_until: request.occurred_until
    });
  }

  private encodeCursor(cursor: LedgerCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString("base64url");
  }

  private cursorStart(cursorValue: string, query: string, entries: LedgerEntry[]): number {
    let cursor: LedgerCursor;
    try {
      cursor = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8")) as LedgerCursor;
    } catch {
      throw new EngineError("invalid_cursor", "Ledger cursor is malformed", 400);
    }
    if (cursor.version !== 1 || cursor.query !== query || typeof cursor.entry_id !== "string") {
      throw new EngineError("invalid_cursor", "Ledger cursor does not match this query", 400);
    }
    const index = entries.findIndex((entry) => entry.entry_id === cursor.entry_id);
    if (index < 0) {
      throw new EngineError("invalid_cursor", "Ledger cursor no longer identifies an entry", 400);
    }
    return index + 1;
  }

  private assertOrder(order: EvaluationRequest["order"], member: Member): void {
    const result = validateFoodserviceOrder(order);
    if (!result.ok) {
      throw new EngineError(
        "invalid_order",
        result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
        422
      );
    }
    this.assertProgramId(order.scope.program_id);
    if (order.scope.program_id !== member.program_id) {
      throw new EngineError("conflict", "Order and member belong to different programs");
    }
    if (order.member_id && order.member_id !== member.member_id) {
      throw new EngineError("conflict", "Order is assigned to a different member");
    }
    if (order.totals.total.currency !== this.program.currency) {
      throw new EngineError("currency_mismatch", "Order currency does not match the program");
    }
  }

  private eligibleSpend(order: EvaluationRequest["order"]): number {
    return order.lines
      .filter((line) => this.isEligibleLine(line))
      .reduce((total, line) => total + line.subtotal.amount - line.discount.amount, 0);
  }

  private isEligibleLine(line: EvaluationRequest["order"]["lines"][number]): boolean {
    if (line.loyalty_eligible === false) return false;
    const policy = this.program.earning_policy;
    if (!policy) return true;
    if (policy.excluded_product_ids?.includes(line.product_id)) return false;
    if (policy.excluded_line_kinds?.includes(line.kind)) return false;
    if (line.category_ids?.some((id) => policy.excluded_category_ids?.includes(id))) return false;
    if (line.tags?.some((tag) => policy.excluded_tags?.includes(tag))) return false;
    return true;
  }

  private accrualPoints(order: EvaluationRequest["order"], multiplierBps: number): number {
    const channels = this.program.earning_policy?.eligible_channels ?? allOrderChannels;
    if (!channels.includes(order.channel)) return 0;
    const spend = this.eligibleSpend(order);
    if (spend < (this.program.earning_policy?.minimum_eligible_spend_minor_units ?? 0)) return 0;
    return this.pointsForSpend(spend, multiplierBps);
  }

  private pointsForSpend(minorUnits: number, multiplierBps = 10_000): number {
    const numerator = BigInt(Math.max(0, minorUnits)) *
      BigInt(this.program.earn_rate.points) *
      BigInt(multiplierBps);
    const denominator = BigInt(this.program.earn_rate.spend_minor_units) * 10_000n;
    const amount = Number(numerator / denominator);
    if (!Number.isSafeInteger(amount)) {
      throw new EngineError("invalid_state", "Calculated points exceed the safe integer range", 422);
    }
    return amount;
  }

  private pointsForSignedSpend(minorUnits: number, multiplierBps = 10_000): number {
    const magnitude = this.pointsForSpend(Math.abs(minorUnits), multiplierBps);
    return minorUnits < 0 ? -magnitude : magnitude;
  }

  private rewardCandidate(reward: RewardDefinition, memberId: string): RewardCandidate {
    const available = this.balance(memberId).available >= reward.points_cost;
    return {
      reward_id: reward.reward_id,
      ...(reward.name ? { name: reward.name } : {}),
      status: available ? "available" : "unavailable",
      ...(!available ? { unavailable_reasons: ["insufficient_balance"] } : {}),
      cost: { unit: "points", amount: reward.points_cost },
      effect: clone(reward.effect),
      funding: this.fundingAllocations(reward)
    };
  }

  private fundingAllocations(reward: RewardDefinition): RewardCandidate["funding"] {
    const value = reward.effect.type === "discount"
      ? reward.effect.amount
      : reward.effect.type === "free_item"
        ? reward.effect.max_value
        : undefined;
    if (!value) {
      return clone(reward.funding);
    }

    const denominator = 10_000n;
    const allocations = reward.funding.map((share, index) => {
      const product = BigInt(value.amount) * BigInt(share.share_bps);
      return {
        index,
        amount: product / denominator,
        remainder: product % denominator,
        tieBreak: `${share.party_type}:${share.party_id}`
      };
    });
    let unallocated = BigInt(value.amount) - allocations.reduce((sum, item) => sum + item.amount, 0n);
    const ranked = [...allocations].sort((left, right) => {
      if (left.remainder !== right.remainder) {
        return left.remainder > right.remainder ? -1 : 1;
      }
      return left.tieBreak.localeCompare(right.tieBreak);
    });
    for (const allocation of ranked) {
      if (unallocated === 0n) break;
      allocation.amount += 1n;
      unallocated -= 1n;
    }

    return reward.funding.map((share, index) => ({
      party_id: share.party_id,
      party_type: share.party_type,
      share_bps: share.share_bps,
      amount: { amount: Number(allocations[index]!.amount), currency: value.currency }
    }));
  }

  private addLedger(input: {
    member_id: string;
    operation: LedgerEntry["operation"];
    amount: number;
    expires_at?: string;
    related_entry_id?: string;
    order_id?: string;
    adjustment_id?: string;
    reservation_id?: string;
    create_point_lot?: boolean;
  }): LedgerEntry {
    const entry: LedgerEntry = {
      entry_id: this.ids("ledger"),
      member_id: input.member_id,
      program_id: this.program.program_id,
      account_id: `points:${input.member_id}`,
      operation: input.operation,
      unit: "points",
      amount: input.amount,
      occurred_at: this.isoNow(),
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(input.related_entry_id ? { related_entry_id: input.related_entry_id } : {}),
      ...(input.order_id ? { order_id: input.order_id } : {}),
      ...(input.adjustment_id ? { adjustment_id: input.adjustment_id } : {}),
      ...(input.reservation_id ? { reservation_id: input.reservation_id } : {})
    };
    this.ledger.set(entry.entry_id, entry);
    this.points.set(input.member_id, (this.points.get(input.member_id) ?? 0) + input.amount);
    if (input.create_point_lot && input.expires_at && input.amount > 0) {
      this.pointLots.set(entry.entry_id, {
        entryId: entry.entry_id,
        memberId: input.member_id,
        remaining: input.amount,
        expiresAt: input.expires_at
      });
    }
    return entry;
  }

  private balance(memberId: string): Balance {
    this.expireAllReservations();
    this.expirePointLots(memberId);
    const amount = this.points.get(memberId) ?? 0;
    const reserved = [...this.reservations.values()]
      .filter((reservation) => reservation.member_id === memberId && reservation.status === "reserved")
      .reduce((sum, reservation) => sum + reservation.cost.amount, 0);
    return {
      account_id: `points:${memberId}`,
      member_id: memberId,
      program_id: this.program.program_id,
      unit: "points",
      amount,
      reserved,
      available: amount - reserved,
      as_of: this.isoNow()
    };
  }

  private expiringBalances(memberId: string): ExpiringBalance[] {
    this.expirePointLots(memberId);
    const grouped = new Map<string, number>();
    for (const lot of this.pointLots.values()) {
      if (lot.memberId === memberId && lot.remaining > 0) {
        grouped.set(lot.expiresAt, (grouped.get(lot.expiresAt) ?? 0) + lot.remaining);
      }
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([expiresAt, amount]) => ({
        account_id: `points:${memberId}`,
        unit: "points",
        amount,
        expires_at: expiresAt
      }));
  }

  private consumePointLots(memberId: string, amount: number, consumptionId?: string): void {
    let remaining = amount;
    const consumed: ReferencePointLotConsumption[] = [];
    const lots = [...this.pointLots.values()]
      .filter((lot) => lot.memberId === memberId && lot.remaining > 0)
      .sort((left, right) =>
        left.expiresAt.localeCompare(right.expiresAt) || left.entryId.localeCompare(right.entryId)
      );
    for (const lot of lots) {
      if (remaining === 0) break;
      const consumedAmount = Math.min(lot.remaining, remaining);
      lot.remaining -= consumedAmount;
      remaining -= consumedAmount;
      consumed.push({ entryId: lot.entryId, amount: consumedAmount });
    }
    if (consumptionId && consumed.length > 0) {
      this.pointLotConsumptions.set(consumptionId, consumed);
    }
  }

  private restorePointLots(consumptionId: string): void {
    const consumed = this.pointLotConsumptions.get(consumptionId) ?? [];
    for (const item of consumed) {
      const lot = this.pointLots.get(item.entryId);
      if (!lot) {
        throw new EngineError("not_found", "Point-lot consumption references a missing lot", 500);
      }
      lot.remaining += item.amount;
    }
    this.pointLotConsumptions.delete(consumptionId);
  }

  private expirePointLots(memberId?: string): void {
    const now = this.clock.now().getTime();
    const lots = [...this.pointLots.values()]
      .filter((lot) =>
        lot.remaining > 0 &&
        (!memberId || lot.memberId === memberId) &&
        Date.parse(lot.expiresAt) <= now
      )
      .sort((left, right) =>
        left.expiresAt.localeCompare(right.expiresAt) || left.entryId.localeCompare(right.entryId)
      );
    for (const lot of lots) {
      const amount = lot.remaining;
      lot.remaining = 0;
      this.addLedger({
        member_id: lot.memberId,
        operation: "expiration",
        amount: -amount,
        related_entry_id: lot.entryId
      });
    }
  }

  private getReservation(reservationId: string): RedemptionReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new EngineError("not_found", `Reservation ${reservationId} was not found`, 404);
    }
    return reservation;
  }

  private expireAllReservations(): void {
    for (const reservation of this.reservations.values()) {
      this.expireReservation(reservation);
    }
  }

  private expireReservation(reservation: RedemptionReservation): void {
    if (reservation.status === "reserved" && Date.parse(reservation.expires_at) <= this.clock.now().getTime()) {
      reservation.status = "expired";
    }
  }

  private ledgerResponse(context: RequestContext, entry: LedgerEntry): LedgerResponse {
    return {
      context: this.responseContext(context),
      entry: clone(entry),
      balances: [this.balance(entry.member_id)]
    };
  }

  private reservationResponse(
    context: RequestContext,
    reservation: RedemptionReservation
  ): RedemptionReservationResponse {
    return {
      context: this.responseContext(context),
      reservation: clone(reservation),
      balances: [this.balance(reservation.member_id)]
    };
  }

  private responseContext(context: RequestContext): ResponseContext {
    return {
      protocol_version: "1.0",
      profile: "foodservice/1.0",
      request_id: context.request_id,
      processed_at: this.isoNow()
    };
  }

  private isoNow(): string {
    return this.clock.now().toISOString();
  }

  private futureIso(seconds: number): string {
    return new Date(this.clock.now().getTime() + seconds * 1000).toISOString();
  }

  private pointExpirationIso(): string {
    const days = this.program.point_expiration?.days;
    if (!days) throw new EngineError("invalid_program", "Point expiration is not configured", 500);
    return new Date(this.clock.now().getTime() + days * 86_400_000).toISOString();
  }

  private once<T>(
    operation: string,
    context: RequestContext,
    request: unknown,
    run: () => T
  ): T {
    const key = `${context.source.system}|${operation}|${context.idempotency_key}`;
    const requestFingerprint = idempotencyFingerprint(request);
    const prior = this.idempotency.get(key);
    if (prior) {
      if (prior.fingerprint !== requestFingerprint) {
        throw new EngineError(
          "idempotency_conflict",
          "Idempotency key was already used with a different request"
        );
      }
      return clone(prior.response as T);
    }

    const response = run();
    this.idempotency.set(key, { fingerprint: requestFingerprint, response: clone(response) });
    return response;
  }
}
