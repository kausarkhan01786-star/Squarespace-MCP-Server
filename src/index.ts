import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logError } from "./utils/logger.js";
import { createMcpClientSession } from "./runtime/mcp-client-session.js";
import { SharedBrowserRuntime } from "./runtime/shared-browser-runtime.js";

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.();
  } catch {
    // .env file is optional
  }
  const runtime = new SharedBrowserRuntime();
  const transport = new StdioServerTransport();
  const session = createMcpClientSession(runtime, transport);
  transport.onclose = () => {
    void session.close()
      .then(() => runtime.shutdown())
      .catch((error: unknown) => logError("stdio_session_close_failed", error));
  };
  await session.server.connect(transport);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    shutdownPromise ??= (async () => {
      await session.close();
      await runtime.shutdown();
    })();
    await shutdownPromise;
  };
  process.once("SIGINT", () => {
    void shutdown().catch((error: unknown) => {
      logError("server_shutdown_failed", error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown().catch((error: unknown) => {
      logError("server_shutdown_failed", error);
      process.exitCode = 1;
    });
  });
}

main().catch((error: unknown) => {
  logError("server_start_failed", error);
  process.exitCode = 1;
});
