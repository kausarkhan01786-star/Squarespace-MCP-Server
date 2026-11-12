import { SquarespaceBrowserService } from "../browser/squarespace-browser.service.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";

export interface SharedBrowserRuntimeOptions {
  browser?: SquarespaceBrowserService;
  operationLock?: BrowserOperationLock;
  maxQueuedBrowserOperations?: number;
}

/** Owns the sole browser service and lock shared by all MCP client sessions in this process. */
export class SharedBrowserRuntime {
  readonly browser: SquarespaceBrowserService;
  readonly operationLock: BrowserOperationLock;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: SharedBrowserRuntimeOptions = {}) {
    this.browser = options.browser ?? new SquarespaceBrowserService();
    this.operationLock = options.operationLock ?? new BrowserOperationLock(
      30_000,
      options.maxQueuedBrowserOperations ?? 32,
    );
  }

  /** Only the process that created this runtime may call shutdown. */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      const current = this.operationLock.runExclusive(() => this.browser.close());
      this.shutdownPromise = current;
      void current.catch(() => {
        if (this.shutdownPromise === current) this.shutdownPromise = undefined;
      });
    }
    return this.shutdownPromise;
  }
}
