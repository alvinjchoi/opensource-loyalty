import {
  createDemoPlatform,
  startReferenceServer,
  type RunningServer
} from "@loyalty-interchange/server";

export interface MockOptions {
  host: string;
  port: number;
  apiKey: string;
  databasePath?: string;
  reset?: boolean;
  seed?: boolean;
}

export async function startMockServer(options: MockOptions): Promise<RunningServer> {
  const platform = createDemoPlatform({
    databasePath: options.databasePath ?? ":memory:",
    ...(options.reset ? { reset: true } : {}),
    ...(options.seed === false ? { seed: false } : {})
  });
  const running = await startReferenceServer(platform.engine, {
    host: options.host,
    port: options.port,
    apiKey: options.apiKey,
    reservationTtlSeconds: 120,
    persistState: (state) => platform.store.save(state),
    admin: {
      ...(platform.adminAssetRoot ? { assetRoot: platform.adminAssetRoot } : {}),
      storage: platform.store.status
    }
  });
  return {
    ...running,
    close: async () => {
      await running.close();
      platform.close();
    }
  };
}

export async function runMockServer(
  options: MockOptions,
  output: (message: string) => void = console.log
): Promise<void> {
  const running = await startMockServer(options);
  const displayHost = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
  const port = new URL(running.url).port;
  output(`LIP mock server: http://${displayHost}:${port}`);
  output(`Bearer token: ${options.apiKey}`);
  output(`Discovery: http://${displayHost}:${port}/.well-known/lip`);
  output(`Admin: http://${displayHost}:${port}/admin/`);
  output(`State: ${options.databasePath ?? ":memory:"}`);
  output("");
  output("Next:");
  output(`  curl http://${displayHost}:${port}/health`);
  output("  npm run lip -- doctor");
  output("  npm run example:sdk");

  await new Promise<void>((resolve) => {
    const close = (): void => {
      void running.close().then(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}
