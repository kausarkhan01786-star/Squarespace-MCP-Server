export type BrowserErrorCode =
  | "BROWSER_LAUNCH_FAILED"
  | "BROWSER_CLOSED"
  | "NAVIGATION_FAILED"
  | "LOGIN_TIMEOUT"
  | "NOT_LOGGED_IN"
  | "INVALID_URL"
  | "INVALID_SCREENSHOT_NAME"
  | "WEBSITE_NOT_FOUND"
  | "PAGE_NOT_FOUND"
  | "PAGE_CREATION_FAILED"
  | "PAGE_DUPLICATION_FAILED"
  | "PAGE_UPDATE_FAILED"
  | "PAGE_URL_UPDATE_FAILED"
  | "PAGES_PANEL_NOT_FOUND"
  | "PAGE_SETTINGS_FAILED"
  | "SECTIONS_NOT_AVAILABLE"
  | "SCREENSHOT_FAILED"
  | "PROFILE_DIRECTORY_UNSAFE";

export class SquarespaceBrowserError extends Error {
  constructor(
    public readonly code: BrowserErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SquarespaceBrowserError";
  }
}
