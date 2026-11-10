import { basename } from "node:path";
import type { BrowserExecutionContext } from "./browser-execution-context.js";
import { assertAllowedSquarespaceUrl, redactUrl } from "./browser-security.js";
import { SquarespaceBrowserError } from "./browser-errors.js";
import type {
  BrowserBlockInspection,
  BrowserCapability,
  BrowserCapabilityName,
  BrowserNavigationEvidence,
  BrowserOperationResult,
  BrowserPageInspection,
  BrowserProvider,
  BrowserScreenshotEvidence,
  BrowserSectionInspection,
  BrowserWebsite,
} from "./browser-provider.js";
import { unsupportedBrowserOperation } from "./browser-provider.js";
import type { SquarespaceBrowserService } from "./squarespace-browser.service.js";
import type { SquarespacePagesService } from "./squarespace-pages.service.js";

type PlaywrightBrowser = Pick<
  SquarespaceBrowserService,
  "getWebsite" | "inspectCurrentPage" | "captureScreenshot" | "openWebsiteUrl" | "cancelActiveNavigation"
> & Partial<Pick<SquarespaceBrowserService, "verifyWebsiteInAuthenticatedAccount">>;
type PlaywrightPages = Pick<SquarespacePagesService, "inspectPageSections">;

const CAPABILITY_NAMES = [
  "verify_website",
  "inspect_current_page",
  "capture_screenshot",
  "navigate_within_website",
  "inspect_sections",
  "inspect_blocks",
] as const satisfies readonly BrowserCapabilityName[];

const CAPABILITIES: BrowserCapability[] = CAPABILITY_NAMES.map((operation) => ({
  operation,
  supported: true,
  limitation: null,
}));

export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly providerName = "playwright";

  constructor(
    private readonly browser: PlaywrightBrowser,
    private readonly pages: PlaywrightPages,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getCapabilities(): BrowserCapability[] {
    return CAPABILITIES.map((capability) => ({ ...capability }));
  }

  async verifyWebsite(
    websiteId: string,
    execution?: BrowserExecutionContext,
  ): Promise<BrowserOperationResult<BrowserWebsite>> {
    execution?.checkpoint();
    const authorized = this.browser.verifyWebsiteInAuthenticatedAccount
      ? await this.browser.verifyWebsiteInAuthenticatedAccount(websiteId, execution)
      : undefined;
    const website = authorized?.website ?? this.browser.getWebsite(websiteId);
    assertAllowedSquarespaceUrl(website.url);
    return {
      status: "supported",
      data: {
        id: website.id,
        name: sanitizeText(website.name),
        url: redactUrl(website.url),
        ...(authorized ? { sessionContextId: authorized.sessionContextId } : {}),
      },
    };
  }

  async inspectCurrentPage(
    websiteId: string,
    execution?: BrowserExecutionContext,
  ): Promise<BrowserOperationResult<BrowserPageInspection>> {
    const website = await this.requireWebsite(websiteId, execution);
    const inspection = await this.browser.inspectCurrentPage(execution);
    assertSameWebsite(website, inspection.url);
    return {
      status: "supported",
      data: {
        title: sanitizeText(inspection.title),
        url: redactUrl(inspection.url),
        buttons: inspection.buttons.map((button) => ({
          text: sanitizeText(button.text),
          ariaLabel: button.ariaLabel === null ? null : sanitizeText(button.ariaLabel),
          disabled: button.disabled,
        })),
        links: inspection.links.map((link) => ({
          text: sanitizeText(link.text),
          url: redactUrl(link.url),
        })),
        inputs: inspection.inputs.map((input) => ({
          type: input.type,
          name: input.name === null ? null : sanitizeText(input.name),
          placeholder: input.placeholder === null ? null : sanitizeText(input.placeholder),
          ariaLabel: input.ariaLabel === null ? null : sanitizeText(input.ariaLabel),
          disabled: input.disabled,
          required: input.required,
        })),
      },
    };
  }

  async captureScreenshot(
    websiteId: string,
    fileName?: string,
    execution?: BrowserExecutionContext,
  ): Promise<BrowserOperationResult<BrowserScreenshotEvidence>> {
    await this.requireCurrentWebsite(websiteId, execution);
    const screenshotPath = await this.browser.captureScreenshot(fileName, execution);
    return {
      status: "supported",
      data: {
        fileName: basename(screenshotPath),
        capturedAt: this.now().toISOString(),
        fullPage: true,
      },
    };
  }

  async navigateWithinWebsite(
    websiteId: string,
    destination: string,
    execution?: BrowserExecutionContext,
  ): Promise<BrowserOperationResult<BrowserNavigationEvidence>> {
    const website = await this.requireWebsite(websiteId, execution);
    assertSameWebsite(website, destination);
    await this.browser.openWebsiteUrl(websiteId, destination, execution);
    const inspection = await this.browser.inspectCurrentPage(execution);
    assertSameWebsite(website, inspection.url);
    return {
      status: "supported",
      data: { title: sanitizeText(inspection.title), url: redactUrl(inspection.url) },
    };
  }

  async inspectSections(
    websiteId: string,
    pageId: string,
    execution?: BrowserExecutionContext,
  ): Promise<BrowserOperationResult<BrowserSectionInspection[]>> {
    await this.requireWebsite(websiteId, execution);
    const inspection = await this.pages.inspectPageSections(websiteId, pageId);
    return {
      status: "supported",
      data: inspection.sections.map((section) => ({
        sectionId: section.id,
        theme: section.theme,
        headings: section.headings.map(sanitizeText),
        visibleText: sanitizeText(section.visibleText),
        textTruncated: section.textTruncated,
        blocksTruncated: section.blocksTruncated,
      })),
    };
  }

  async inspectBlocks(
    websiteId: string,
    pageId: string,
    execution?: BrowserExecutionContext,
  ): Promise<BrowserOperationResult<BrowserBlockInspection[]>> {
    await this.requireWebsite(websiteId, execution);
    const inspection = await this.pages.inspectPageSections(websiteId, pageId);
    const blocks = inspection.sections.flatMap((section) =>
      section.blocks.map((block) => ({
        sectionId: section.id,
        blockId: block.id,
        type: block.type,
        visibleText: sanitizeText(block.visibleText),
        textTruncated: block.textTruncated,
      })),
    );
    return { status: "supported", data: blocks };
  }

  cancelActiveOperation(): void {
    this.browser.cancelActiveNavigation();
  }

  private async requireWebsite(
    websiteId: string,
    execution?: BrowserExecutionContext,
  ): Promise<BrowserWebsite> {
    const result = await this.verifyWebsite(websiteId, execution);
    if (result.status === "unsupported") {
      throw new Error(result.reason);
    }
    return result.data;
  }

  private async requireCurrentWebsite(
    websiteId: string,
    execution?: BrowserExecutionContext,
  ): Promise<BrowserWebsite> {
    const website = await this.requireWebsite(websiteId, execution);
    const inspection = await this.browser.inspectCurrentPage(execution);
    assertSameWebsite(website, inspection.url);
    return website;
  }
}

export class UnsupportedBrowserProvider implements BrowserProvider {
  readonly providerName: string;

  constructor(
    private readonly reason: string,
    providerName = "unsupported",
  ) {
    this.providerName = providerName;
  }

  getCapabilities(): BrowserCapability[] {
    return CAPABILITY_NAMES.map((operation) => ({
      operation,
      supported: false,
      limitation: this.reason,
    }));
  }

  verifyWebsite(): Promise<BrowserOperationResult<BrowserWebsite>> {
    return Promise.resolve(unsupportedBrowserOperation("verify_website", this.reason));
  }

  inspectCurrentPage(): Promise<BrowserOperationResult<BrowserPageInspection>> {
    return Promise.resolve(unsupportedBrowserOperation("inspect_current_page", this.reason));
  }

  captureScreenshot(): Promise<BrowserOperationResult<BrowserScreenshotEvidence>> {
    return Promise.resolve(unsupportedBrowserOperation("capture_screenshot", this.reason));
  }

  navigateWithinWebsite(): Promise<BrowserOperationResult<BrowserNavigationEvidence>> {
    return Promise.resolve(unsupportedBrowserOperation("navigate_within_website", this.reason));
  }

  inspectSections(): Promise<BrowserOperationResult<BrowserSectionInspection[]>> {
    return Promise.resolve(unsupportedBrowserOperation("inspect_sections", this.reason));
  }

  inspectBlocks(): Promise<BrowserOperationResult<BrowserBlockInspection[]>> {
    return Promise.resolve(unsupportedBrowserOperation("inspect_blocks", this.reason));
  }
}

function assertSameWebsite(website: BrowserWebsite, destination: string): void {
  const target = assertAllowedSquarespaceUrl(destination);
  if (target.origin !== new URL(website.url).origin) {
    throw new SquarespaceBrowserError(
      "INVALID_URL",
      "Browser navigation and inspection must stay on the selected website.",
    );
  }
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")
    .slice(0, 1_000);
}
