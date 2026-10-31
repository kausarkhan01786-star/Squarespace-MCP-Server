export type BrowserErrorCode =
  | "BROWSER_LAUNCH_FAILED"
  | "BROWSER_CLOSED"
  | "NAVIGATION_FAILED"
  | "LOGIN_TIMEOUT"
  | "NOT_LOGGED_IN"
  | "INVALID_URL"
  | "INVALID_SCREENSHOT_NAME"
  | "WEBSITE_NOT_FOUND"
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
