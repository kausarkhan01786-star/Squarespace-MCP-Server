import { SquarespaceBrowserService, type SquarespaceBrowserOptions } from "../browser/squarespace-browser.service.js";
import { BrowserProfileOwnership } from "../browser/browser-profile-ownership.js";
import { resolveProfileDirectory } from "../browser/browser-security.js";
import { logInfo } from "../utils/logger.js";

export interface SharedBrowserRuntimeOptions extends SquarespaceBrowserOptions {
  simulateShutdownFailure?: boolean | undefined;
}

export class SharedBrowserRuntime {
  public readonly browserService: SquarespaceBrowserService;
  public readonly profileDirectory: string;
  public isShutDown = false;
  public constructedAt = new Date();

  constructor(private readonly options: SharedBrowserRuntimeOptions = {}) {
    this.profileDirectory = resolveProfileDirectory(options.profileDirectory);
    this.browserService = new SquarespaceBrowserService(options);
    logInfo("shared_browser_runtime_constructed", {
      profileDirectory: this.profileDirectory,
    });
  }

  async initialize(): Promise<void> {
    if (this.isShutDown) {
      throw new Error("Cannot initialize a shut down SharedBrowserRuntime.");
    }
    // Record profile ownership marker
    await BrowserProfileOwnership.writeMarker(this.profileDirectory);
  }

  async shutdown(): Promise<void> {
    if (this.isShutDown) {
      return;
    }

    if (this.options.simulateShutdownFailure) {
      throw new Error("Simulated browser runtime shutdown failure.");
    }

    try {
      await this.browserService.close();
      await BrowserProfileOwnership.removeMarker(this.profileDirectory);
      this.isShutDown = true;
      logInfo("shared_browser_runtime_shutdown_success", {
        profileDirectory: this.profileDirectory,
      });
    } catch (error) {
      // Do not remove profile marker if shutdown fails
      throw error;
    }
  }
}
