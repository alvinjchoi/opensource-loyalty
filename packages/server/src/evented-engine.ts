import {
  LoyaltyEngine,
  type Clock,
  type IdGenerator,
  type LoyaltyEngineState,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import type {
  AccrualPostRequest,
  LedgerEntry,
  LedgerResponse,
  LoyaltyEvent,
  LoyaltyEventType,
  IssuedReward,
  IssuedRewardCancelRequest,
  IssuedRewardIssueRequest,
  IssuedRewardResponse,
  ManualAdjustmentRequest,
  Member,
  MemberEnrollRequest,
  MemberEnrollResponse,
  OrderAdjustmentRequest,
  RedemptionCaptureRequest,
  RedemptionReservation,
  RedemptionReservationResponse,
  RedemptionReserveRequest,
  RedemptionReverseRequest
} from "@loyalty-interchange/protocol";

export type LoyaltyEventEmitter = (event: LoyaltyEvent) => void;

export interface EventedLoyaltyEngineOptions {
  clock?: Clock;
  ids?: IdGenerator;
  state?: LoyaltyEngineState;
  emit: LoyaltyEventEmitter;
}

/**
 * A LoyaltyEngine that emits CloudEvents after successful mutations. Event ids
 * are derived from the underlying resource ids so idempotent request replays
 * produce byte-identical event identity, letting receivers deduplicate on
 * CloudEvent `source` + `id` as the spec requires.
 */
export class EventedLoyaltyEngine extends LoyaltyEngine {
  private readonly emitEvent: LoyaltyEventEmitter;
  private readonly eventClock: Clock;
  private readonly eventSource: string;

  public constructor(program: ProgramDefinition, options: EventedLoyaltyEngineOptions) {
    const { emit, ...engineOptions } = options;
    super(program, engineOptions);
    this.emitEvent = emit;
    this.eventClock = options.clock ?? { now: () => new Date() };
    this.eventSource = `urn:lip:program:${program.program_id}`;
  }

  public override enroll(request: MemberEnrollRequest): MemberEnrollResponse {
    const response = super.enroll(request);
    this.publishMember("org.loyalty-interchange.member.enrolled.v1", "enrolled", response.member);
    return response;
  }

  public override postAccrual(request: AccrualPostRequest): LedgerResponse {
    const response = super.postAccrual(request);
    this.publishEntry("org.loyalty-interchange.order.accrued.v1", "accrued", response.entry);
    return response;
  }

  public override adjustOrder(request: OrderAdjustmentRequest): LedgerResponse {
    const response = super.adjustOrder(request);
    this.publishEntry("org.loyalty-interchange.order.adjusted.v1", "adjusted", response.entry);
    return response;
  }

  public override postManualAdjustment(request: ManualAdjustmentRequest): LedgerResponse {
    const response = super.postManualAdjustment(request);
    this.publishEntry("org.loyalty-interchange.balance.changed.v1", "manual", response.entry);
    return response;
  }

  public override issueReward(request: IssuedRewardIssueRequest): IssuedRewardResponse {
    const response = super.issueReward(request);
    this.publishIssuedReward(
      "org.loyalty-interchange.issued-reward.issued.v1",
      "issued",
      response.issued_reward
    );
    return response;
  }

  public override cancelIssuedReward(request: IssuedRewardCancelRequest): IssuedRewardResponse {
    const response = super.cancelIssuedReward(request);
    this.publishIssuedReward(
      "org.loyalty-interchange.issued-reward.cancelled.v1",
      "cancelled",
      response.issued_reward
    );
    return response;
  }

  public override reserve(request: RedemptionReserveRequest): RedemptionReservationResponse {
    const response = super.reserve(request);
    this.publishReservation("org.loyalty-interchange.redemption.reserved.v1", "reserved", response.reservation);
    return response;
  }

  public override capture(request: RedemptionCaptureRequest): RedemptionReservationResponse {
    const response = super.capture(request);
    this.publishReservation("org.loyalty-interchange.redemption.captured.v1", "captured", response.reservation);
    this.publishReservationIssuedReward(response.reservation, "redeemed");
    return response;
  }

  public override reverse(request: RedemptionReverseRequest): RedemptionReservationResponse {
    const response = super.reverse(request);
    this.publishReservation("org.loyalty-interchange.redemption.reversed.v1", "reversed", response.reservation);
    this.publishReservationIssuedReward(response.reservation, "restored");
    return response;
  }

  private publishMember(type: LoyaltyEventType, action: string, member: Member): void {
    this.publish(type, `evt-${action}-${member.member_id}`, member.member_id, { member });
  }

  private publishEntry(type: LoyaltyEventType, action: string, entry: LedgerEntry): void {
    this.publish(type, `evt-${action}-${entry.entry_id}`, entry.member_id, { entry });
  }

  private publishReservation(
    type: LoyaltyEventType,
    action: string,
    reservation: RedemptionReservation
  ): void {
    this.publish(type, `evt-${action}-${reservation.reservation_id}`, reservation.member_id, {
      reservation
    });
  }

  private publishReservationIssuedReward(
    reservation: RedemptionReservation,
    action: "redeemed" | "restored"
  ): void {
    if (!reservation.issued_reward_id) return;
    const issuedReward = this.inspectAdmin().issued_rewards.find((candidate) =>
      candidate.issued_reward_id === reservation.issued_reward_id
    );
    if (!issuedReward) return;
    const type: LoyaltyEventType = action === "redeemed"
      ? "org.loyalty-interchange.issued-reward.redeemed.v1"
      : "org.loyalty-interchange.issued-reward.restored.v1";
    this.publishIssuedReward(type, action, issuedReward);
  }

  private publishIssuedReward(
    type: LoyaltyEventType,
    action: string,
    issuedReward: IssuedReward
  ): void {
    this.publish(
      type,
      `evt-${action}-${issuedReward.issued_reward_id}`,
      issuedReward.member_id,
      { issued_reward: issuedReward }
    );
  }

  private publish(
    type: LoyaltyEventType,
    id: string,
    subject: string,
    data: LoyaltyEvent["data"]
  ): void {
    this.emitEvent({
      specversion: "1.0",
      id,
      source: this.eventSource,
      type,
      subject,
      time: this.eventClock.now().toISOString(),
      datacontenttype: "application/json",
      lipversion: "1.0",
      data
    });
  }
}
