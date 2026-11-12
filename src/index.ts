import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpClientSession, type McpClientSession } from "./runtime/mcp-client-session.js";
import { SharedBrowserRuntime } from "./runtime/shared-browser-runtime.js";
import { logError } from "./utils/logger.js";

export interface StdioFactories {
  createRuntime(): SharedBrowserRuntime;
  createTransport(): StdioServerTransport;
  createSession(runtime: SharedBrowserRuntime, transport: StdioServerTransport): McpClientSession;
}

export interface StartStdioOptions {
  factories?: StdioFactories;
  installSignalHandlers?: boolean;
  loadEnvFile?: boolean;
}

const defaultFactories: StdioFactories = {
  createRuntime: () => new SharedBrowserRuntime(),
  createTransport: () => new StdioServerTransport(),
  createSession: (runtime, transport) => createMcpClientSession(runtime, transport),
};

/** Starts the legacy stdio composition. This remains an explicit, backward-compatible entry point. */
export async function startStdioServer(options: StartStdioOptions = {}): Promise<{
  runtime: SharedBrowserRuntime;
  transport: StdioServerTransport;
  session: McpClientSession;
  shutdown(): Promise<void>;
}> {
  if (options.loadEnvFile ?? true) {
    try {
      process.loadEnvFile?.();
    } catch {
      // .env file is optional for the legacy stdio host.
    }
  }
  const factories = options.factories ?? defaultFactories;
  const runtime = factories.createRuntime();
  const transport = factories.createTransport();
  const session = factories.createSession(runtime, transport);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      const current = session.close().then(() => runtime.shutdown());
      shutdownPromise = current;
      void current.catch(() => {
        if (shutdownPromise === current) shutdownPromise = undefined;
      });
    }
    return shutdownPromise;
  };
  transport.onclose = () => {
    void shutdown().catch((error: unknown) => logError("stdio_session_close_failed", error));
  };
  await session.server.connect(transport);

  if (options.installSignalHandlers ?? true) {
    const onSignal = (): void => {
      void shutdown().catch((error: unknown) => {
        logError("server_shutdown_failed", error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  return { runtime, transport, session, shutdown };
}

async function main(): Promise<void> {
  await startStdioServer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    logError("server_start_failed", error);
    process.exitCode = 1;
  });
}
