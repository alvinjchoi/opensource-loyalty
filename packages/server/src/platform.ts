import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LoyaltyEventType } from "@loyalty-interchange/protocol";
import {
  LoyaltyEngine,
  programDefinitionFingerprint,
  retargetProgramState,
  type LoyaltyEngineState,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { createDemoProgram, seedDemoData } from "./demo.js";
import { CampaignService } from "./campaigns.js";
import { MembershipService } from "./memberships.js";
import { EventedLoyaltyEngine } from "./evented-engine.js";
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
  close(): void;
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

export function createDemoPlatform(options: DemoPlatformOptions): DemoPlatform {
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
    memberships = new MembershipService({
      path: options.databasePath,
      engine,
      persistEngine: (nextState) => store.save(nextState),
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
      close: () => {
        campaigns?.close();
        memberships?.close();
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
    memberships?.close();
    programs.close();
    store.close();
    throw error;
  }
}
