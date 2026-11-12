import { pathToFileURL } from "node:url";
import { GatewaySecurity } from "../http/gateway-security.js";
import { StreamableHttpGateway } from "../http/streamable-http-gateway.js";
import { SharedBrowserRuntime } from "../runtime/shared-browser-runtime.js";
import { InstanceLock, type InstanceLockCoordinator } from "./instance-lock.js";

export interface ServiceGateway {
  start(): Promise<string>;
  close(): Promise<void>;
}

export interface ServiceFactories {
  createInstanceLock(): InstanceLockCoordinator;
  createRuntime(): SharedBrowserRuntime;
  createSecurity(): GatewaySecurity;
  createGateway(runtime: SharedBrowserRuntime, security: GatewaySecurity, port: number): ServiceGateway;
}

export interface StartServiceOptions {
  factories?: ServiceFactories;
  port?: number;
  installSignalHandlers?: boolean;
  onReady?: (url: string) => void;
  onShutdownError?: (error: unknown) => void;
}

export interface RunningService {
  readonly instanceLock: InstanceLockCoordinator;
  readonly runtime: SharedBrowserRuntime;
  readonly security: GatewaySecurity;
  readonly gateway: ServiceGateway;
  readonly url: string;
  shutdown(): Promise<void>;
}

export class ServiceStartupCleanupError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly retryCleanup: () => Promise<void>,
    options?: ErrorOptions,
  ) {
    super(errors, "Service startup failed and ownership cleanup is incomplete.", options);
    this.name = "ServiceStartupCleanupError";
  }
}

const defaultFactories: ServiceFactories = {
  createInstanceLock: () => new InstanceLock(),
  createRuntime: () => new SharedBrowserRuntime(),
  createSecurity: () => new GatewaySecurity(),
  createGateway: (runtime, security, port) => new StreamableHttpGateway({ runtime, security, port }),
};

export const DEFAULT_SERVICE_PORT = 8765;

/** Builds and starts the one-process HTTP service. Importing this module does not start it. */
export async function startService(options: StartServiceOptions = {}): Promise<RunningService> {
  const factories = options.factories ?? defaultFactories;
  let instanceLock: InstanceLockCoordinator | undefined;
  let lockAcquired = false;
  let runtime: SharedBrowserRuntime | undefined;
  let security: GatewaySecurity | undefined;
  let gateway: ServiceGateway | undefined;

  try {
    // This must precede every owner resource, especially SharedBrowserRuntime.
    instanceLock = factories.createInstanceLock();
    await instanceLock.acquire();
    lockAcquired = true;
    runtime = factories.createRuntime();
    security = factories.createSecurity();
    const port = options.port ?? DEFAULT_SERVICE_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new RangeError("Service port must be an integer between 1 and 65535.");
    }
    gateway = factories.createGateway(runtime, security, port);
    const url = await gateway.start();

    let shutdownPromise: Promise<void> | undefined;
    const keepAliveTimer = setInterval(() => {}, 2_147_000_000);
    keepAliveTimer.unref();
    const detachSignalHandlers = (): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    const shutdown = (): Promise<void> => {
      if (!shutdownPromise) {
        const current = closeResources(gateway!, runtime!, instanceLock!);
        shutdownPromise = current;
        void current.then(
          () => {
            clearInterval(keepAliveTimer);
            detachSignalHandlers();
          },
          () => {
            // Keep this process alive and keep receiving shutdown signals while ownership is retained.
            keepAliveTimer.ref();
            if (shutdownPromise === current) shutdownPromise = undefined;
          },
        );
      }
      return shutdownPromise;
    };
    const onSignal = (): void => {
      void shutdown().catch((error: unknown) => options.onShutdownError?.(error));
    };

    if (options.installSignalHandlers ?? true) {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    }
    options.onReady?.(url);
    return { instanceLock, runtime, security, gateway, url, shutdown };
  } catch (startupError) {
    if (!instanceLock || !lockAcquired) throw startupError;
    const retryCleanup = createStartupCleanup(gateway, runtime, instanceLock);
    try {
      await retryCleanup();
    } catch (cleanupError) {
      const startupCleanupError = new ServiceStartupCleanupError(
        [startupError, cleanupError],
        retryCleanup,
        { cause: startupError },
      );
      if (options.installSignalHandlers ?? true) {
        retainStartupOwnershipForRetry(startupCleanupError, options.onShutdownError);
      }
      throw startupCleanupError;
    }
    throw startupError;
  }
}

async function closeResources(
  gateway: ServiceGateway,
  runtime: SharedBrowserRuntime,
  instanceLock: InstanceLockCoordinator,
): Promise<void> {
  await gateway.close();
  await runtime.shutdown();
  await instanceLock.release();
}

function createStartupCleanup(
  gateway: ServiceGateway | undefined,
  runtime: SharedBrowserRuntime | undefined,
  instanceLock: InstanceLockCoordinator,
): () => Promise<void> {
  return async () => {
    if (gateway) await gateway.close();
    if (runtime) await runtime.shutdown();
    await instanceLock.release();
  };
}

function retainStartupOwnershipForRetry(
  startupError: ServiceStartupCleanupError,
  onShutdownError?: (error: unknown) => void,
): void {
  const keepAliveTimer = setInterval(() => {}, 2_147_000_000);
  let retryPromise: Promise<void> | undefined;
  const retry = (): void => {
    if (retryPromise) return;
    const current = startupError.retryCleanup();
    retryPromise = current;
    void current.then(
      () => {
        clearInterval(keepAliveTimer);
        process.removeListener("SIGINT", retry);
        process.removeListener("SIGTERM", retry);
      },
      (error: unknown) => {
        retryPromise = undefined;
        onShutdownError?.(error);
      },
    );
  };
  process.on("SIGINT", retry);
  process.on("SIGTERM", retry);
}

export async function main(): Promise<void> {
  await startService({
    onReady: (url) => process.stdout.write(`Squarespace MCP HTTP service listening at ${url}\n`),
    onShutdownError: (error) => process.stderr.write(`Service shutdown failed: ${formatError(error)}\n`),
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Service startup failed: ${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
