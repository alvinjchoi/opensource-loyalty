import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LoyaltyEvent, LoyaltyEventType } from "@loyalty-interchange/protocol";
import {
  LoyaltyEngine,
  programDefinitionFingerprint,
  retargetProgramState,
  type LoyaltyEngineState,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import { AsyncSqliteStateStore, SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { PostgresEngineRepository } from "@loyalty-interchange/storage-postgres";
import { createDemoProgram, seedDemoData } from "./demo.js";
import { CampaignService } from "./campaigns.js";
import { MembershipService, type MembershipAuditState } from "./memberships.js";
import { AccessControlService } from "./access-control.js";
import { EventedLoyaltyEngine } from "./evented-engine.js";
import { EngagementService } from "./engagement.js";
import { ProgramManagementService } from "./program-management.js";
import { SqliteWebhookOutbox } from "./webhook-outbox.js";
import { SqliteWebhookHistoryStore } from "./webhook-history.js";
import { SqliteWebhookSubscriptionStore } from "./webhook-subscriptions.js";
import { WebhookDispatcher, type WebhookSubscription } from "./webhooks.js";

export interface DemoPlatformOptions {
  databasePath: string;
  reset?: boolean;
  seed?: boolean;
  adminAssetRoot?: string;
  /**
   * Custom program definition. When provided it replaces the built-in demo
   * program and demo seeding is skipped, because the synthetic members and
   * activity are only valid against the demo program.
   */
  program?: ProgramDefinition;
  /**
   * Webhook subscriptions to deliver CloudEvents to. When omitted, a single
   * subscription is read from LIP_WEBHOOK_URL / LIP_WEBHOOK_SECRET (and
   * optionally LIP_WEBHOOK_EVENTS, a comma-separated event-type allowlist).
   */
  webhooks?: WebhookSubscription[];
}

export interface DemoPlatform {
  engine: LoyaltyEngine;
  store: SqliteStateStore<LoyaltyEngineState>;
  adminAssetRoot?: string;
  webhooks: WebhookDispatcher;
  programs: ProgramManagementService;
  campaigns: CampaignService;
  memberships: MembershipService;
  access: AccessControlService;
  engagement: EngagementService;
  close(): Promise<void>;
}

export interface PostgresProtocolPlatform {
  engine: LoyaltyEngine;
  store: PostgresEngineRepository;
  adminAssetRoot?: string;
  webhooks: WebhookDispatcher;
  executeEngineOperation<T>(operation: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresProtocolPlatformOptions {
  connectionString: string;
  tenantId?: string;
  reset?: boolean;
  seed?: boolean;
  adminAssetRoot?: string;
  program?: ProgramDefinition;
  webhooks?: WebhookSubscription[];
}

export function webhookSubscriptionsFromEnv(
  env: Record<string, string | undefined> = process.env
): WebhookSubscription[] {
  const url = env["LIP_WEBHOOK_URL"];
  if (!url) return [];
  const secret = env["LIP_WEBHOOK_SECRET"];
  if (!secret) {
    throw new Error("LIP_WEBHOOK_SECRET is required when LIP_WEBHOOK_URL is set");
  }
  const events = env["LIP_WEBHOOK_EVENTS"]
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) as LoyaltyEventType[] | undefined;
  return [{ url, secret, ...(events && events.length > 0 ? { events } : {}) }];
}

function discoverAdminAssetRoot(): string | undefined {
  const candidates = [
    fileURLToPath(new URL("./admin/", import.meta.url)),
    fileURLToPath(new URL("../dist/admin/", import.meta.url)),
    fileURLToPath(new URL("../../../apps/admin/dist/", import.meta.url))
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export async function createDemoPlatform(options: DemoPlatformOptions): Promise<DemoPlatform> {
  const configuredProgram = options.program ?? createDemoProgram();
  const programs = new ProgramManagementService({
    path: options.databasePath,
    initialProgram: configuredProgram,
    ...(options.reset ? { reset: true } : {})
  });
  const program = programs.activeProgram();
  const store = new SqliteStateStore<LoyaltyEngineState>({
    path: options.databasePath,
    key: program.program_id
  });
  let webhookOutbox: SqliteWebhookOutbox | undefined;
  let webhookHistory: SqliteWebhookHistoryStore | undefined;
  let webhookSubscriptionStore: SqliteWebhookSubscriptionStore | undefined;
  let campaigns: CampaignService | undefined;
  let memberships: MembershipService | undefined;
  let access: AccessControlService | undefined;
  let engagement: EngagementService | undefined;
  try {
    if (options.reset) store.clear();
    let state = store.load();
    if (state && state.program_fingerprint !== programDefinitionFingerprint(program)) {
      const previousProgram = programs.programForFingerprint(state.program_fingerprint);
      if (previousProgram) {
        state = retargetProgramState(state, previousProgram, program);
        store.save(state);
      }
    }
    webhookSubscriptionStore = new SqliteWebhookSubscriptionStore({
      path: options.databasePath,
      key: `${program.program_id}:webhook-subscriptions`
    });
    if (options.reset) webhookSubscriptionStore.clear();
    const subscriptions =
      webhookSubscriptionStore.load() ??
      options.webhooks ??
      webhookSubscriptionsFromEnv();
    webhookOutbox = new SqliteWebhookOutbox({
      path: options.databasePath,
      key: `${program.program_id}:webhook-outbox`
    });
    if (options.reset) webhookOutbox.clear();
    webhookHistory = new SqliteWebhookHistoryStore({
      path: options.databasePath,
      key: `${program.program_id}:webhook-history`
    });
    if (options.reset) webhookHistory.clear();
    const dispatcher = new WebhookDispatcher({
      subscriptions,
      outbox: webhookOutbox,
      historyStore: webhookHistory,
      onSubscriptionsChanged: (next) => webhookSubscriptionStore!.save(next),
      onError: (message) => console.error(`[lip] ${message}`)
    });
    // Demo seeding replays synthetic history; suppress emissions until it is done.
    let armed = false;
    const engine = new EventedLoyaltyEngine(program, {
      ...(state ? { state } : {}),
      emit: (event) => {
        if (armed) dispatcher.emit(event);
      }
    });
    if (!state && options.seed !== false && !options.program) seedDemoData(engine);
    armed = true;
    campaigns = new CampaignService({
      path: options.databasePath,
      engine,
      persistEngine: (nextState) => store.save(nextState),
      schedulerIntervalMs: 30_000,
      ...(options.reset ? { reset: true } : {})
    });
    memberships = await MembershipService.create({
      store: new AsyncSqliteStateStore<MembershipAuditState>({
        path: options.databasePath,
        key: `${program.program_id}:memberships`
      }),
      engine,
      persistEngine: (nextState) => store.save(nextState),
      schedulerIntervalMs: 30_000,
      ...(options.reset ? { reset: true } : {})
    });
    access = new AccessControlService({
      path: options.databasePath,
      tenantId: program.program_id,
      tenantName: program.name ?? program.program_id,
      ...(options.reset ? { reset: true } : {})
    });
    engagement = new EngagementService({
      path: options.databasePath,
      engine,
      campaigns,
      schedulerIntervalMs: 30_000,
      ...(options.reset ? { reset: true } : {})
    });
    programs.bindPublisher((nextProgram) => {
      const previousProgram = engine.getProgramDefinition();
      try {
        campaigns?.assertCompatibleProgram(nextProgram);
        memberships?.assertCompatibleProgram(
          nextProgram.membership_policy?.plans.map((plan) => plan.plan_id) ?? []
        );
        engine.reconfigureProgram(nextProgram);
        store.save(engine.exportState());
      } catch (error) {
        engine.reconfigureProgram(previousProgram);
        throw error;
      }
    });
    dispatcher.resumePending();
    store.save(engine.exportState());
    const adminAssetRoot = options.adminAssetRoot ?? discoverAdminAssetRoot();
    return {
      engine,
      store,
      ...(adminAssetRoot ? { adminAssetRoot } : {}),
      webhooks: dispatcher,
      programs,
      campaigns,
      memberships,
      access,
      engagement,
      close: async () => {
        campaigns?.close();
        await memberships?.close();
        access?.close();
        engagement?.close();
        programs.close();
        store.close();
        webhookSubscriptionStore?.close();
        webhookHistory?.close();
        if (!webhookOutbox) return;
        const outboxToClose = webhookOutbox;
        if (dispatcher.inFlightDeliveries() === 0) {
          outboxToClose.close();
          return;
        }
        void dispatcher.flush().finally(() => outboxToClose.close());
      }
    };
  } catch (error) {
    webhookOutbox?.close();
    webhookHistory?.close();
    webhookSubscriptionStore?.close();
    campaigns?.close();
    await memberships?.close();
    access?.close();
    engagement?.close();
    programs.close();
    store.close();
    throw error;
  }
}

export async function createPostgresProtocolPlatform(
  options: PostgresProtocolPlatformOptions
): Promise<PostgresProtocolPlatform> {
  const program = options.program ?? createDemoProgram();
  const tenantId = options.tenantId ?? program.program_id;
  const store = new PostgresEngineRepository({
    connectionString: options.connectionString,
    tenantId,
    programId: program.program_id
  });
  await store.migrate();
  if (options.reset) await store.clear();
  const stored = await store.load();
  if (
    stored &&
    stored.state.program_fingerprint !== programDefinitionFingerprint(program)
  ) {
    await store.close();
    throw new Error(
      "Postgres engine state uses a different program definition; publish a compatible migration or reset explicitly"
    );
  }
  const dispatcher = new WebhookDispatcher({
    subscriptions: options.webhooks ?? webhookSubscriptionsFromEnv(),
    onError: (message) => console.error(`[lip] ${message}`)
  });
  let armed = false;
  let transactionEvents: LoyaltyEvent[] | undefined;
  const engine = new EventedLoyaltyEngine(program, {
    ...(stored ? { state: stored.state } : {}),
    emit: (event) => {
      if (!armed) return;
      if (transactionEvents) transactionEvents.push(event);
      else dispatcher.emit(event);
    }
  });
  if (!stored && options.seed !== false && !options.program) seedDemoData(engine);
  armed = true;
  if (!stored) {
    try {
      await store.save(engine.exportState(), 0);
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  const adminAssetRoot = options.adminAssetRoot ?? discoverAdminAssetRoot();
  return {
    engine,
    store,
    ...(adminAssetRoot ? { adminAssetRoot } : {}),
    webhooks: dispatcher,
    executeEngineOperation: async (operation) => {
      const committed = await store.mutate(engine, async () => {
        const events: LoyaltyEvent[] = [];
        transactionEvents = events;
        try {
          return { result: await operation(), events };
        } finally {
          transactionEvents = undefined;
        }
      });
      for (const event of committed.events) dispatcher.emit(event);
      return committed.result;
    },
    close: async () => {
      await dispatcher.flush();
      await store.close();
    }
  };
}
