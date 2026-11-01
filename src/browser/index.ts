export { SquarespaceBrowserError } from "./browser-errors.js";
export type { BrowserErrorCode } from "./browser-errors.js";
export { SquarespaceBrowserService } from "./squarespace-browser.service.js";
export type {
  BrowserCapability,
  BrowserCapabilityName,
  BrowserOperationResult,
  BrowserProvider,
} from "./browser-provider.js";
export { PlaywrightBrowserProvider, UnsupportedBrowserProvider } from "./playwright-browser.provider.js";
export { SquarespacePagesService } from "./squarespace-pages.service.js";
export type {
  LoginResult,
  PageInspection,
  SquarespaceBrowserOptions,
  WebsiteSummary,
} from "./squarespace-browser.service.js";
export type {
  NavigationGroup,
  PageNavigationNode,
  PageSection,
  PageVisibilityStatus,
  SquarespacePage,
  SquarespacePageType,
} from "./squarespace-pages.service.js";
export {
  assertAllowedSquarespaceUrl,
  isAllowedSquarespaceUrl,
  redactUrl,
} from "./browser-security.js";
