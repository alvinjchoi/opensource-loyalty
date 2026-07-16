import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Member } from "@loyalty-interchange/protocol";
import type { LoyaltyEngine } from "@loyalty-interchange/reference";
import { EngineError } from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import type { CampaignService } from "./campaigns.js";

export interface MessagingConnector {
  connector_id: string;
  name: string;
  type: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface StoredMessagingConnector extends MessagingConnector {
  configuration: Record<string, unknown>;
  secret?: string;
}

export interface MessageDelivery {
  delivery_id: string;
  member_id: string;
  status: "pending" | "delivered" | "failed" | "skipped";
  attempts: number;
  next_attempt_at?: string;
  delivered_at?: string;
  error?: string;
}

export interface MessageJob {
  job_id: string;
  idempotency_key: string;
  connector_id: string;
  segment_id: string;
  template_id: string;
  content: Record<string, unknown>;
  purpose: "marketing" | "transactional";
  status: "queued" | "running" | "completed" | "partial" | "failed";
  created_at: string;
  completed_at?: string;
  deliveries: MessageDelivery[];
}

interface EngagementState {
  version: 1;
  connectors: StoredMessagingConnector[];
  jobs: MessageJob[];
}

export interface EngagementSnapshot {
  connectors: Array<MessagingConnector & {
    configuration: Record<string, unknown>;
    secret_configured: boolean;
  }>;
  jobs: MessageJob[];
}

export interface ConnectorDelivery {
  message_id: string;
  member: Member;
  template_id: string;
  content: Record<string, unknown>;
  purpose: MessageJob["purpose"];
  occurred_at: string;
}

export interface MessagingConnectorAdapter {
  type: string;
  deliver(input: {
    connector: MessagingConnector;
    configuration: Record<string, unknown>;
    secret?: string;
    delivery: ConnectorDelivery;
  }): Promise<void>;
}

export interface EngagementAnalytics {
  generated_at: string;
  members: {
    total: number;
    active: number;
    marketing_consented: number;
  };
  balances: Array<{
    unit: string;
    outstanding: number;
    reserved: number;
  }>;
  ledger_by_day: Array<{
    date: string;
    unit: string;
    earned: number;
    redeemed: number;
    expired: number;
  }>;
  rewards: Array<{
    reward_id: string;
    reserved: number;
    captured: number;
    reversed: number;
  }>;
  campaigns: {
    configured: number;
    runs: number;
    members_targeted: number;
    rewards_issued: number;
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new EngineError("validation_failed", "Connector URL is required", 422);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EngineError("validation_failed", "Connector URL is invalid", 422);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new EngineError("validation_failed", "Connector URL must use HTTP or HTTPS", 422);
  }
  return url.toString();
}

export class WebhookMessagingAdapter implements MessagingConnectorAdapter {
  public readonly type = "webhook";
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  public async deliver(input: {
    configuration: Record<string, unknown>;
    secret?: string;
    delivery: ConnectorDelivery;
  }): Promise<void> {
    const url = validateUrl(input.configuration["url"]);
    if (!input.secret) {
      throw new EngineError("invalid_state", "Webhook connector secret is not configured", 422);
    }
    const body = JSON.stringify(input.delivery);
    const occurredAt = timestamp();
    const signature = createHmac("sha256", input.secret)
      .update(`${occurredAt}.${body}`)
      .digest("hex");
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lip-message-id": input.delivery.message_id,
        "x-lip-message-timestamp": occurredAt,
        "x-lip-message-signature": `v1=${signature}`
      },
      body,
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      throw new Error(`Connector returned HTTP ${response.status}`);
    }
  }
}

export class EngagementService {
  private readonly store: SqliteStateStore<EngagementState>;
  private readonly engine: LoyaltyEngine;
  private readonly campaigns: CampaignService;
  private readonly adapters = new Map<string, MessagingConnectorAdapter>();
  private readonly scheduler: NodeJS.Timeout | undefined;
  private state: EngagementState;
  private running = false;

  public constructor(options: {
    path: string;
    engine: LoyaltyEngine;
    campaigns: CampaignService;
    reset?: boolean;
    schedulerIntervalMs?: number | false;
    adapters?: MessagingConnectorAdapter[];
  }) {
    this.store = new SqliteStateStore({
      path: options.path,
      key: `${options.engine.getProgramDefinition().program_id}:engagement`
    });
    if (options.reset) this.store.clear();
    this.engine = options.engine;
    this.campaigns = options.campaigns;
    for (const adapter of [new WebhookMessagingAdapter(), ...(options.adapters ?? [])]) {
      this.adapters.set(adapter.type, adapter);
    }
    this.state = this.store.load() ?? { version: 1, connectors: [], jobs: [] };
    if (this.state.version !== 1) {
      this.store.close();
      throw new EngineError("invalid_state", "Stored engagement state is incompatible", 500);
    }
    if (options.schedulerIntervalMs !== false) {
      this.scheduler = setInterval(
        () => void this.runDueJobs().catch(() => undefined),
        options.schedulerIntervalMs ?? 30_000
      );
      this.scheduler.unref();
    }
  }

  public snapshot(): EngagementSnapshot {
    return {
      connectors: this.state.connectors.map(({ secret, ...connector }) => ({
        ...structuredClone(connector),
        secret_configured: Boolean(secret)
      })),
      jobs: structuredClone(this.state.jobs)
    };
  }

  public upsertConnector(input: {
    connector_id?: string;
    name: string;
    type: string;
    active?: boolean;
    configuration: Record<string, unknown>;
    secret?: string;
  }): MessagingConnector {
    if (!input.name.trim()) {
      throw new EngineError("validation_failed", "Connector name is required", 422);
    }
    if (!this.adapters.has(input.type)) {
      throw new EngineError("validation_failed", `Connector type ${input.type} is not registered`, 422);
    }
    if (input.type === "webhook") validateUrl(input.configuration["url"]);
    if (input.secret !== undefined && input.secret.length < 16) {
      throw new EngineError("validation_failed", "Connector secret must contain at least 16 characters", 422);
    }
    const existing = input.connector_id
      ? this.state.connectors.find(({ connector_id }) => connector_id === input.connector_id)
      : undefined;
    if (!existing && !input.secret) {
      throw new EngineError("validation_failed", "A secret is required for a new connector", 422);
    }
    const now = timestamp();
    const connector: StoredMessagingConnector = {
      connector_id: existing?.connector_id ?? input.connector_id ?? `connector_${randomUUID()}`,
      name: input.name.trim(),
      type: input.type,
      active: input.active ?? existing?.active ?? true,
      configuration: structuredClone(input.configuration),
      ...(input.secret ? { secret: input.secret } : existing?.secret ? { secret: existing.secret } : {}),
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    if (existing) Object.assign(existing, connector);
    else this.state.connectors.push(connector);
    this.save();
    return {
      connector_id: connector.connector_id,
      name: connector.name,
      type: connector.type,
      active: connector.active,
      created_at: connector.created_at,
      updated_at: connector.updated_at
    };
  }

  public removeConnector(connectorId: string): boolean {
    if (this.state.jobs.some((job) =>
      job.connector_id === connectorId && ["queued", "running", "partial"].includes(job.status)
    )) {
      throw new EngineError("conflict", "Connector has unfinished message jobs", 409);
    }
    const before = this.state.connectors.length;
    this.state.connectors = this.state.connectors.filter(
      ({ connector_id }) => connector_id !== connectorId
    );
    if (this.state.connectors.length === before) return false;
    this.save();
    return true;
  }

  public enqueue(input: {
    idempotency_key: string;
    connector_id: string;
    segment_id: string;
    template_id: string;
    content: Record<string, unknown>;
    purpose?: MessageJob["purpose"];
  }): MessageJob {
    if (!input.idempotency_key.trim() || !input.template_id.trim()) {
      throw new EngineError("validation_failed", "Idempotency key and template id are required", 422);
    }
    const prior = this.state.jobs.find(({ idempotency_key }) =>
      idempotency_key === input.idempotency_key
    );
    if (prior) {
      const priorFacts = {
        connector_id: prior.connector_id,
        segment_id: prior.segment_id,
        template_id: prior.template_id,
        content: prior.content,
        purpose: prior.purpose
      };
      const nextFacts = {
        connector_id: input.connector_id,
        segment_id: input.segment_id,
        template_id: input.template_id,
        content: input.content,
        purpose: input.purpose ?? "marketing"
      };
      if (fingerprint(priorFacts) !== fingerprint(nextFacts)) {
        throw new EngineError("conflict", "Message idempotency key has different facts", 409);
      }
      return structuredClone(prior);
    }
    const connector = this.state.connectors.find(
      ({ connector_id }) => connector_id === input.connector_id
    );
    if (!connector?.active) {
      throw new EngineError("not_found", "Active connector was not found", 404);
    }
    const purpose = input.purpose ?? "marketing";
    const members = this.campaigns.membersForSegment(input.segment_id);
    const memberSnapshots = new Map(
      this.engine.inspectAdmin().members.map(({ member }) => [member.member_id, member])
    );
    const deliveries: MessageDelivery[] = members.map((memberId) => {
      const member = memberSnapshots.get(memberId);
      const consented = member?.attributes?.["marketing_consent"] === true;
      return {
        delivery_id: `message_${randomUUID()}`,
        member_id: memberId,
        status: purpose === "marketing" && !consented ? "skipped" : "pending",
        attempts: 0,
        ...(purpose === "marketing" && !consented ? { error: "marketing_consent_required" } : {})
      };
    });
    const job: MessageJob = {
      job_id: `message_job_${randomUUID()}`,
      idempotency_key: input.idempotency_key,
      connector_id: input.connector_id,
      segment_id: input.segment_id,
      template_id: input.template_id,
      content: structuredClone(input.content),
      purpose,
      status: deliveries.every(({ status }) => status === "skipped") ? "completed" : "queued",
      created_at: timestamp(),
      ...(deliveries.every(({ status }) => status === "skipped")
        ? { completed_at: timestamp() }
        : {}),
      deliveries
    };
    this.state.jobs.unshift(job);
    this.state.jobs = this.state.jobs.slice(0, 200);
    this.save();
    return structuredClone(job);
  }

  public async runJob(jobId: string): Promise<MessageJob> {
    const job = this.state.jobs.find(({ job_id }) => job_id === jobId);
    if (!job) throw new EngineError("not_found", `Message job ${jobId} was not found`, 404);
    const connector = this.state.connectors.find(
      ({ connector_id }) => connector_id === job.connector_id
    );
    if (!connector?.active) {
      throw new EngineError("invalid_state", "Message connector is inactive", 409);
    }
    const adapter = this.adapters.get(connector.type);
    if (!adapter) throw new EngineError("invalid_state", "Message connector adapter is unavailable", 500);
    job.status = "running";
    this.save();
    const members = new Map(
      this.engine.inspectAdmin().members.map(({ member }) => [member.member_id, member])
    );
    const now = Date.now();
    for (const delivery of job.deliveries) {
      if (
        delivery.status === "delivered" ||
        delivery.status === "skipped" ||
        delivery.attempts >= 5 ||
        (delivery.next_attempt_at && Date.parse(delivery.next_attempt_at) > now)
      ) continue;
      const member = members.get(delivery.member_id);
      if (!member) {
        delivery.status = "skipped";
        delivery.error = "member_not_found";
        continue;
      }
      delivery.attempts += 1;
      try {
        await adapter.deliver({
          connector,
          configuration: connector.configuration,
          ...(connector.secret ? { secret: connector.secret } : {}),
          delivery: {
            message_id: delivery.delivery_id,
            member: structuredClone(member),
            template_id: job.template_id,
            content: structuredClone(job.content),
            purpose: job.purpose,
            occurred_at: timestamp()
          }
        });
        delivery.status = "delivered";
        delivery.delivered_at = timestamp();
        delete delivery.next_attempt_at;
        delete delivery.error;
      } catch (error) {
        delivery.status = "failed";
        delivery.error = error instanceof Error ? error.message.slice(0, 500) : "delivery_failed";
        delivery.next_attempt_at = new Date(
          Date.now() + Math.min(60_000, 1_000 * 2 ** (delivery.attempts - 1))
        ).toISOString();
      }
      this.save();
    }
    const actionable = job.deliveries.filter(({ status }) => status !== "skipped");
    if (actionable.every(({ status }) => status === "delivered")) {
      job.status = "completed";
      job.completed_at = timestamp();
    } else if (actionable.some(({ status }) => status === "delivered")) {
      job.status = "partial";
    } else if (actionable.every(({ attempts }) => attempts >= 5)) {
      job.status = "failed";
      job.completed_at = timestamp();
    } else {
      job.status = "queued";
    }
    this.save();
    return structuredClone(job);
  }

  public async runDueJobs(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = this.state.jobs.filter((job) =>
        ["queued", "partial"].includes(job.status) &&
        job.deliveries.some((delivery) =>
          ["pending", "failed"].includes(delivery.status) &&
          delivery.attempts < 5 &&
          (!delivery.next_attempt_at || Date.parse(delivery.next_attempt_at) <= Date.now())
        )
      );
      for (const job of due) await this.runJob(job.job_id);
      return due.length;
    } finally {
      this.running = false;
    }
  }

  public close(): void {
    if (this.scheduler) clearInterval(this.scheduler);
    this.store.close();
  }

  private save(): void {
    this.store.save(this.state);
  }
}

export function engagementAnalytics(
  engine: LoyaltyEngine,
  campaigns: CampaignService
): EngagementAnalytics {
  const snapshot = engine.inspectAdmin();
  const campaignSnapshot = campaigns.snapshot();
  const balances = new Map<string, { outstanding: number; reserved: number }>();
  for (const member of snapshot.members) {
    for (const balance of member.balances ?? [member.balance]) {
      const aggregate = balances.get(balance.unit) ?? { outstanding: 0, reserved: 0 };
      aggregate.outstanding += balance.amount;
      aggregate.reserved += balance.reserved;
      balances.set(balance.unit, aggregate);
    }
  }
  const days = new Map<string, EngagementAnalytics["ledger_by_day"][number]>();
  for (const entry of snapshot.ledger) {
    const date = entry.occurred_at.slice(0, 10);
    const key = `${date}:${entry.unit}`;
    const aggregate = days.get(key) ?? {
      date,
      unit: entry.unit,
      earned: 0,
      redeemed: 0,
      expired: 0
    };
    if (["accrual", "manual", "adjustment"].includes(entry.operation) && entry.amount > 0) {
      aggregate.earned += entry.amount;
    }
    if (entry.operation === "redemption") aggregate.redeemed += Math.abs(entry.amount);
    if (entry.operation === "expiration") aggregate.expired += Math.abs(entry.amount);
    days.set(key, aggregate);
  }
  const rewards = new Map<string, EngagementAnalytics["rewards"][number]>();
  for (const reservation of snapshot.reservations) {
    const aggregate = rewards.get(reservation.reward_id) ?? {
      reward_id: reservation.reward_id,
      reserved: 0,
      captured: 0,
      reversed: 0
    };
    if (reservation.status === "reserved") aggregate.reserved += 1;
    if (reservation.status === "captured") aggregate.captured += 1;
    if (reservation.status === "reversed") aggregate.reversed += 1;
    rewards.set(reservation.reward_id, aggregate);
  }
  return {
    generated_at: timestamp(),
    members: {
      total: snapshot.members.length,
      active: snapshot.members.filter(({ member }) => member.status === "active").length,
      marketing_consented: snapshot.members.filter(
        ({ member }) => member.attributes?.["marketing_consent"] === true
      ).length
    },
    balances: [...balances.entries()].map(([unit, values]) => ({ unit, ...values })),
    ledger_by_day: [...days.values()].sort((left, right) =>
      right.date.localeCompare(left.date) || left.unit.localeCompare(right.unit)
    ),
    rewards: [...rewards.values()].sort((left, right) =>
      left.reward_id.localeCompare(right.reward_id)
    ),
    campaigns: {
      configured: campaignSnapshot.campaigns.length,
      runs: campaignSnapshot.runs.length,
      members_targeted: campaignSnapshot.runs.reduce(
        (sum, run) => sum + run.outcomes.length,
        0
      ),
      rewards_issued: campaignSnapshot.runs.reduce((sum, run) => sum + run.issued, 0)
    }
  };
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export function memberExport(
  engine: LoyaltyEngine,
  options: { marketingOnly?: boolean; format: "json" | "csv" }
): string | unknown[] {
  const rows = engine.inspectAdmin().members
    .filter(({ member }) =>
      !options.marketingOnly || member.attributes?.["marketing_consent"] === true
    )
    .map(({ member, balances }) => ({
      member_id: member.member_id,
      status: member.status,
      joined_at: member.joined_at,
      tier_id: member.tier_id ?? "",
      email: typeof member.attributes?.["email"] === "string" ? member.attributes["email"] : "",
      phone: typeof member.attributes?.["phone"] === "string" ? member.attributes["phone"] : "",
      marketing_consent: member.attributes?.["marketing_consent"] === true,
      balances: Object.fromEntries(balances.map(({ unit, available }) => [unit, available]))
    }));
  if (options.format === "json") return rows;
  const columns = [
    "member_id",
    "status",
    "joined_at",
    "tier_id",
    "email",
    "phone",
    "marketing_consent",
    "balances"
  ] as const;
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) =>
      csvCell(column === "balances" ? JSON.stringify(row[column]) : row[column])
    ).join(","))
  ].join("\n");
}
