import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LoyaltyEventType } from "@loyalty-interchange/protocol";
import {
  LoyaltyEngine,
  type LoyaltyEngineState,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import { SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { createDemoProgram, seedDemoData } from "./demo.js";
import { EventedLoyaltyEngine } from "./evented-engine.js";
import { SqliteWebhookOutbox } from "./webhook-outbox.js";
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
  webhooks?: WebhookDispatcher;
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
  const program = options.program ?? createDemoProgram();
  const store = new SqliteStateStore<LoyaltyEngineState>({
    path: options.databasePath,
    key: program.program_id
  });
  let webhookOutbox: SqliteWebhookOutbox | undefined;
  try {
    if (options.reset) store.clear();
    const state = store.load();
    const subscriptions = options.webhooks ?? webhookSubscriptionsFromEnv();
    webhookOutbox =
      subscriptions.length > 0
        ? new SqliteWebhookOutbox({
            path: options.databasePath,
            key: `${program.program_id}:webhook-outbox`
          })
        : undefined;
    if (options.reset) webhookOutbox?.clear();
    const dispatcher =
      subscriptions.length > 0
        ? new WebhookDispatcher({
            subscriptions,
            ...(webhookOutbox ? { outbox: webhookOutbox } : {}),
            onError: (message) => console.error(`[lip] ${message}`)
          })
        : undefined;
    // Demo seeding replays synthetic history; suppress emissions until it is done.
    let armed = false;
    const engine = dispatcher
      ? new EventedLoyaltyEngine(program, {
          ...(state ? { state } : {}),
          emit: (event) => {
            if (armed) dispatcher.emit(event);
          }
        })
      : new LoyaltyEngine(program, state ? { state } : {});
    if (!state && options.seed !== false && !options.program) seedDemoData(engine);
    armed = true;
    dispatcher?.resumePending();
    store.save(engine.exportState());
    const adminAssetRoot = options.adminAssetRoot ?? discoverAdminAssetRoot();
    return {
      engine,
      store,
      ...(adminAssetRoot ? { adminAssetRoot } : {}),
      ...(dispatcher ? { webhooks: dispatcher } : {}),
      close: () => {
        store.close();
        if (!webhookOutbox) return;
        const outboxToClose = webhookOutbox;
        if (!dispatcher || dispatcher.inFlightDeliveries() === 0) {
          outboxToClose.close();
          return;
        }
        void dispatcher.flush().finally(() => outboxToClose.close());
      }
    };
  } catch (error) {
    webhookOutbox?.close();
    store.close();
    throw error;
  }
}
