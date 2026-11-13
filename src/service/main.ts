import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { BrowserProfileOwnership } from "../browser/browser-profile-ownership.js";
import { resolveProfileDirectory } from "../browser/browser-security.js";
import {
  type InstanceOwnershipLease,
  type InstanceOwnershipProvider,
} from "../instance-ownership/instance-ownership.types.js";
import { NativeWindowsInstanceOwnershipProvider } from "../instance-ownership/native-instance-ownership.js";
import { SharedBrowserRuntime, type SharedBrowserRuntimeOptions } from "../runtime/shared-browser-runtime.js";
import { McpClientSession } from "../runtime/mcp-client-session.js";
import { StreamableHttpGateway, type StreamableHttpGatewayOptions } from "../http/streamable-http-gateway.js";
import { logError, logInfo } from "../utils/logger.js";

export type ServiceStatus = "unstarted" | "running" | "shutting_down" | "shutdown_failed" | "stopped";

export interface ServiceOptions {
  ownershipIdentity?: string | undefined;
  profileDirectory?: string | undefined;
  ownershipProvider?: InstanceOwnershipProvider | undefined;
  browserRuntimeFactory?: ((options: SharedBrowserRuntimeOptions) => SharedBrowserRuntime) | undefined;
  gatewayFactory?: ((options: StreamableHttpGatewayOptions) => StreamableHttpGateway) | undefined;
  browserOptions?: Partial<SharedBrowserRuntimeOptions> | undefined;
  gatewayOptions?: Partial<StreamableHttpGatewayOptions> | undefined;
  simulateRuntimeShutdownFailure?: boolean | undefined;
  simulateGatewayShutdownFailure?: boolean | undefined;
  operationLock?: BrowserOperationLock | undefined;
}

export class ServiceLifecycleCoordinator {
  private lease: InstanceOwnershipLease | undefined = undefined;
  private runtime: SharedBrowserRuntime | undefined = undefined;
  private gateway: StreamableHttpGateway | undefined = undefined;
  private status: ServiceStatus = "unstarted";
  private shutdownPromise: Promise<void> | undefined = undefined;

  constructor(private readonly options: ServiceOptions = {}) {}

  getStatus(): ServiceStatus {
    return this.status;
  }

  getLease(): InstanceOwnershipLease | undefined {
    return this.lease;
  }

  getRuntime(): SharedBrowserRuntime | undefined {
    return this.runtime;
  }

  getGateway(): StreamableHttpGateway | undefined {
    return this.gateway;
  }

  async start(): Promise<void> {
    if (this.status !== "unstarted") {
      throw new Error(`Cannot start service: current status is '${this.status}'.`);
    }

    const ownershipProvider =
      this.options.ownershipProvider ?? new NativeWindowsInstanceOwnershipProvider();

    // 1. Acquire native single-instance ownership lease FIRST
    // If acquisition fails, startup aborts immediately before any runtime construction.
    this.lease = await ownershipProvider.acquire(this.options.ownershipIdentity);

    try {
      // 2. Validate browser profile ownership marker
      const profileDir = resolveProfileDirectory(this.options.profileDirectory);
      await BrowserProfileOwnership.assertProfileAvailable(profileDir);

      // 3. Construct SharedBrowserRuntime AFTER ownership lease is acquired
      const runtimeOptions: SharedBrowserRuntimeOptions = {
        profileDirectory: profileDir,
        simulateShutdownFailure: this.options.simulateRuntimeShutdownFailure,
        ...this.options.browserOptions,
      };

      this.runtime = this.options.browserRuntimeFactory
        ? this.options.browserRuntimeFactory(runtimeOptions)
        : new SharedBrowserRuntime(runtimeOptions);
      await this.runtime.initialize();

      // 4. Construct and start HTTP MCP Gateway
      const gatewayOptions: StreamableHttpGatewayOptions = {
        simulateShutdownFailure: this.options.simulateGatewayShutdownFailure,
        ...this.options.gatewayOptions,
      };

      const operationLock = this.options.operationLock ?? new BrowserOperationLock();
      const sharedRuntime = this.runtime;

      this.gateway = this.options.gatewayFactory
        ? this.options.gatewayFactory(gatewayOptions)
        : new StreamableHttpGateway({
            ...gatewayOptions,
            sessionFactory: async () => {
              return new McpClientSession({
                sharedRuntime,
                operationLock,
              });
            },
          });

      // Ensure session factory is attached if gateway supports it and was not explicitly configured
      if (
        this.gateway &&
        typeof (this.gateway as any).setSessionFactory === "function" &&
        !this.options.gatewayOptions?.sessionFactory
      ) {
        this.gateway.setSessionFactory(async () => {
          return new McpClientSession({
            sharedRuntime,
            operationLock,
          });
        });
      }

      await this.gateway.start();

      this.status = "running";
      logInfo("squarespace_service_started", {
        ownershipIdentity: this.lease.identity,
        pipeName: this.lease.pipeName,
      });
    } catch (startupError) {
      // Startup failed after lease acquisition: release lease cleanly
      if (this.lease) {
        try {
          await this.lease.release();
        } catch {
          // ignore lease release errors on failed startup
        }
        this.lease = undefined;
      }
      this.status = "stopped";
      throw startupError;
    }
  }

  async shutdown(): Promise<void> {
    if (this.status === "stopped") {
      return; // Idempotent shutdown
    }
    if (this.status === "unstarted") {
      throw new Error("Cannot shut down an unstarted service.");
    }

    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.status = "shutting_down";

    this.shutdownPromise = (async () => {
      try {
        // 1. Gateway shutdown: stop accepting work, drain in-flight, close MCP sessions
        if (this.gateway && !this.gateway.isStopped) {
          await this.gateway.stop();
        }

        // 2. Browser runtime shutdown: close browser, remove profile marker
        if (this.runtime && !this.runtime.isShutDown) {
          await this.runtime.shutdown();
        }

        // 3. ONLY after BOTH gateway and runtime shutdown succeed:
        // Notice: Do NOT release in a finally block!
        if (this.lease) {
          await this.lease.release();
          this.lease = undefined;
        }

        this.status = "stopped";
        logInfo("squarespace_service_shutdown_clean");
      } catch (error) {
        // Retain ownership when either shutdown operation fails!
        this.status = "shutdown_failed";
        logError("squarespace_service_shutdown_failed", error);
        throw error;
      } finally {
        this.shutdownPromise = undefined;
      }
    })();

    return this.shutdownPromise;
  }

  async retryShutdown(options?: {
    fixGatewayFailure?: boolean | undefined;
    fixRuntimeFailure?: boolean | undefined;
  }): Promise<void> {
    if (this.status !== "shutdown_failed") {
      return;
    }

    if (options?.fixGatewayFailure && this.gateway) {
      (this.gateway as any).options.simulateShutdownFailure = false;
    }
    if (options?.fixRuntimeFailure && this.runtime) {
      (this.runtime as any).options.simulateShutdownFailure = false;
    }

    await this.shutdown();
  }
}

export interface ProductionServiceOptions extends ServiceOptions {
  installSignalHandlers?: boolean | undefined;
}

export async function createProductionService(
  options: ProductionServiceOptions = {},
): Promise<ServiceLifecycleCoordinator> {
  const coordinator = new ServiceLifecycleCoordinator({
    ...options,
    // Production requires real native ownership - no silent fallback
    ownershipProvider: options.ownershipProvider ?? new NativeWindowsInstanceOwnershipProvider(),
  });

  await coordinator.start();
  return coordinator;
}

export async function runService(
  options: ProductionServiceOptions = {},
): Promise<ServiceLifecycleCoordinator> {
  try {
    process.loadEnvFile?.();
  } catch {
    // .env is optional
  }

  logInfo("squarespace_production_service_starting");
  const coordinator = await createProductionService(options);

  if (options.installSignalHandlers !== false) {
    let isShuttingDown = false;
    const handleSignal = async (signal: string) => {
      if (isShuttingDown) {
        logInfo("service_shutdown_already_in_progress", { signal });
        return;
      }
      isShuttingDown = true;
      logInfo("service_shutdown_signal_received", { signal });

      try {
        await coordinator.shutdown();
        logInfo("service_shutdown_complete");
        process.exit(0);
      } catch (error) {
        logError("service_shutdown_failed", error);
        console.error(
          "FATAL: Service shutdown failed. Native instance ownership remains retained to prevent profile corruption.",
        );
        process.exitCode = 1;
      }
    };

    process.once("SIGINT", () => void handleSignal("SIGINT"));
    process.once("SIGTERM", () => void handleSignal("SIGTERM"));
  }

  return coordinator;
}

function isExecutedDirectly(): boolean {
  try {
    if (!process.argv[1]) return false;
    const entryPath = resolve(process.argv[1]);
    const currentPath = fileURLToPath(import.meta.url);
    // Compare the resolved argv[1] against this exact file (source or compiled).
    // The loose "endsWith" fallback is intentionally omitted to prevent false positives
    // when any other file named main.js is on the argv.
    return (
      entryPath === currentPath ||
      entryPath === currentPath.replace(/\.ts$/, ".js")
    );
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  runService().catch((error: unknown) => {
    logError("service_startup_fatal", error);
    process.exit(1);
  });
}
