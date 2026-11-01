export type BrowserCapabilityName =
  | "verify_website"
  | "inspect_current_page"
  | "capture_screenshot"
  | "navigate_within_website"
  | "inspect_sections"
  | "inspect_blocks";

export interface BrowserCapability {
  operation: BrowserCapabilityName;
  supported: boolean;
  limitation: string | null;
}

export type BrowserOperationResult<T> =
  | { status: "supported"; data: T }
  | {
      status: "unsupported";
      capability: BrowserCapabilityName;
      reason: string;
    };

export interface BrowserWebsite {
  id: string;
  name: string;
  url: string;
}

export interface BrowserPageInspection {
  title: string;
  url: string;
  buttons: Array<{ text: string; ariaLabel: string | null; disabled: boolean }>;
  links: Array<{ text: string; url: string }>;
  inputs: Array<{
    type: string;
    name: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
    disabled: boolean;
    required: boolean;
  }>;
}

export interface BrowserScreenshotEvidence {
  fileName: string;
  capturedAt: string;
  fullPage: true;
}

export interface BrowserNavigationEvidence {
  title: string;
  url: string;
}

export interface BrowserBlockInspection {
  sectionId: string | null;
  blockId: string | null;
  type: string | null;
  visibleText: string;
  textTruncated: boolean;
}

export interface BrowserSectionInspection {
  sectionId: string | null;
  theme: string | null;
  headings: string[];
  visibleText: string;
  textTruncated: boolean;
  blocksTruncated: boolean;
}

export interface BrowserProvider {
  readonly providerName: string;
  getCapabilities(): BrowserCapability[];
  verifyWebsite(websiteId: string): Promise<BrowserOperationResult<BrowserWebsite>>;
  inspectCurrentPage(websiteId: string): Promise<BrowserOperationResult<BrowserPageInspection>>;
  captureScreenshot(
    websiteId: string,
    fileName?: string,
  ): Promise<BrowserOperationResult<BrowserScreenshotEvidence>>;
  navigateWithinWebsite(
    websiteId: string,
    destination: string,
  ): Promise<BrowserOperationResult<BrowserNavigationEvidence>>;
  inspectSections(
    websiteId: string,
    pageId: string,
  ): Promise<BrowserOperationResult<BrowserSectionInspection[]>>;
  inspectBlocks(
    websiteId: string,
    pageId: string,
  ): Promise<BrowserOperationResult<BrowserBlockInspection[]>>;
}

export function unsupportedBrowserOperation<T>(
  capability: BrowserCapabilityName,
  reason: string,
): BrowserOperationResult<T> {
  return { status: "unsupported", capability, reason };
}
