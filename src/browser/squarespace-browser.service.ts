import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { SquarespaceBrowserError } from "./browser-errors.js";
import {
  assertAllowedSquarespaceUrl,
  redactUrl,
  resolveProfileDirectory,
} from "./browser-security.js";

const ACCOUNT_DASHBOARD_URL = "https://account.squarespace.com/";
const LOGIN_URL = "https://login.squarespace.com/";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_LOGIN_TIMEOUT_MS = 10 * 60_000;

export interface SquarespaceBrowserOptions {
  profileDirectory?: string;
  timeoutMs?: number;
  loginTimeoutMs?: number;
}

export interface LoginResult {
  loggedIn: boolean;
  currentUrl: string;
}

export interface WebsiteSummary {
  id: string;
  name: string;
  url: string;
}

export interface PageInspection {
  title: string;
  url: string;
  visibleText: string;
  visibleTextTruncated: boolean;
  buttons: Array<{
    text: string;
    ariaLabel: string | null;
    disabled: boolean;
  }>;
  links: Array<{
    text: string;
    url: string;
  }>;
  inputs: Array<{
    type: string;
    name: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
    disabled: boolean;
    required: boolean;
  }>;
}

type RawPageInspection = PageInspection;

interface DiscoveredWebsite {
  name: string;
  url: string;
}

export class SquarespaceBrowserService {
  private readonly profileDirectory: string;
  private readonly timeoutMs: number;
  private readonly loginTimeoutMs: number;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly websiteDestinations = new Map<string, string>();

  constructor(options: SquarespaceBrowserOptions = {}) {
    this.profileDirectory = resolveProfileDirectory(
      options.profileDirectory?.trim() ||
        process.env.SQUARESPACE_BROWSER_PROFILE_DIR?.trim() ||
        undefined,
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.validateTimeout(this.timeoutMs, "timeoutMs");
    this.validateTimeout(this.loginTimeoutMs, "loginTimeoutMs");
    if (this.loginTimeoutMs > MAX_LOGIN_TIMEOUT_MS) {
      throw new RangeError(`loginTimeoutMs cannot exceed ${MAX_LOGIN_TIMEOUT_MS} milliseconds.`);
    }
  }

  async openLoginPage(): Promise<void> {
    const page = await this.getPage();
    await this.navigate(page, LOGIN_URL);
  }

  async waitForManualLogin(timeoutMs = this.loginTimeoutMs): Promise<LoginResult> {
    this.validateTimeout(timeoutMs, "timeoutMs");
    if (timeoutMs > MAX_LOGIN_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs cannot exceed ${MAX_LOGIN_TIMEOUT_MS} milliseconds.`);
    }
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const page = await this.getPage();
      if (await this.isDashboardAuthenticated(page)) {
        return { loggedIn: true, currentUrl: redactUrl(page.url()) };
      }
      await delay(Math.min(1_000, Math.max(1, deadline - Date.now())));
    }

    throw new SquarespaceBrowserError(
      "LOGIN_TIMEOUT",
      `Manual login was not detected within ${timeoutMs} milliseconds. The browser remains open so you can finish signing in and retry.`,
    );
  }

  async isLoggedIn(): Promise<boolean> {
    const page = await this.getPage();
    if (new URL(page.url()).origin !== new URL(ACCOUNT_DASHBOARD_URL).origin) {
      await this.navigate(page, ACCOUNT_DASHBOARD_URL);
    }
    return this.isDashboardAuthenticated(page);
  }

  async openAccountDashboard(): Promise<LoginResult> {
    const page = await this.getPage();
    await this.navigate(page, ACCOUNT_DASHBOARD_URL);
    return {
      loggedIn: await this.isDashboardAuthenticated(page),
      currentUrl: redactUrl(page.url()),
    };
  }

  async recoverSession(): Promise<LoginResult> {
    const page = await this.getPage();
    await this.navigate(page, ACCOUNT_DASHBOARD_URL);
    return {
      loggedIn: await this.isDashboardAuthenticated(page),
      currentUrl: redactUrl(page.url()),
    };
  }

  async listWebsites(): Promise<WebsiteSummary[]> {
    const page = await this.getPage();
    if (!(await this.isDashboardAuthenticated(page))) {
      throw new SquarespaceBrowserError(
        "NOT_LOGGED_IN",
        "A logged-in Squarespace dashboard is required before listing websites. Open the dashboard and complete manual login first.",
      );
    }

    // tsx injects a __name helper that is unavailable inside Playwright's page context.
    const discovered = await page.evaluate<DiscoveredWebsite[], void>(
      `(${collectWebsiteLinks.toString()})()`,
      undefined,
    );

    this.websiteDestinations.clear();
    const uniqueSites = new Map<string, WebsiteSummary>();
    for (const website of discovered) {
      if (!isSquarespaceUrl(website.url)) {
        continue;
      }
      const id = createHash("sha256").update(website.url).digest("hex").slice(0, 16);
      if (!uniqueSites.has(id)) {
        this.websiteDestinations.set(id, website.url);
        uniqueSites.set(id, {
          id,
          name: website.name,
          url: redactUrl(website.url),
        });
      }
    }

    return [...uniqueSites.values()];
  }

  async switchWebsite(websiteId: string): Promise<void> {
    const destination = this.websiteDestinations.get(websiteId);
    if (!destination) {
      throw new SquarespaceBrowserError(
        "WEBSITE_NOT_FOUND",
        "That website is not in the latest listWebsites() result. Refresh the website list and select a returned ID.",
      );
    }
    await this.navigate(await this.getPage(), destination);
  }

  async inspectCurrentPage(): Promise<PageInspection> {
    const page = await this.getPage();
    const details = await page.evaluate<RawPageInspection, void>(
      `(${collectPageDetails.toString()})()`,
      undefined,
    );

    return {
      ...details,
      url: redactUrl(details.url),
      links: details.links.map((link) => ({ ...link, url: redactUrl(link.url) })),
    };
  }

  async captureScreenshot(fileName?: string): Promise<string> {
    const page = await this.getPage();
    const safeFileName = this.validateScreenshotFileName(fileName);
    const screenshotsDirectory = join(this.profileDirectory, "screenshots");
    await mkdir(screenshotsDirectory, { recursive: true, mode: 0o700 });
    const screenshotPath = resolve(screenshotsDirectory, safeFileName);

    try {
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: this.timeoutMs });
      return screenshotPath;
    } catch (error) {
      throw new SquarespaceBrowserError(
        "SCREENSHOT_FAILED",
        "Could not capture the current page screenshot.",
        { cause: error },
      );
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.websiteDestinations.clear();

    if (context) {
      await context.close();
    }
  }

  private async getPage(): Promise<Page> {
    if (this.context?.pages().length && !this.context.pages()[0]?.isClosed()) {
      const openPage = this.context.pages()[0];
      if (openPage) {
        this.page = openPage;
        return openPage;
      }
    }

    if (this.context) {
      const existingPage = this.context.pages().find((candidate) => !candidate.isClosed());
      if (existingPage) {
        this.page = existingPage;
        return existingPage;
      }
    }

    let context = this.context;
    if (!context) {
      await this.launchContext();
      context = this.context;
    }

    if (!context) {
      throw new SquarespaceBrowserError(
        "BROWSER_CLOSED",
        "Chromium closed before a page could be created. Call recoverSession() to reopen the saved profile.",
      );
    }

    try {
      this.page = await context.newPage();
      this.page.setDefaultTimeout(this.timeoutMs);
      this.page.setDefaultNavigationTimeout(this.timeoutMs);
      return this.page;
    } catch (error) {
      this.context = undefined;
      this.page = undefined;
      throw new SquarespaceBrowserError(
        "BROWSER_CLOSED",
        "The persistent browser session closed unexpectedly. Call recoverSession() to reopen the saved profile.",
        { cause: error },
      );
    }
  }

  private async launchContext(): Promise<void> {
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });

    try {
      const context = await chromium.launchPersistentContext(this.profileDirectory, {
        headless: false,
        acceptDownloads: false,
        timeout: this.timeoutMs,
      });
      this.context = context;
      context.on("close", () => {
        if (this.context === context) {
          this.context = undefined;
          this.page = undefined;
          this.websiteDestinations.clear();
        }
      });
    } catch (error) {
      throw new SquarespaceBrowserError(
        "BROWSER_LAUNCH_FAILED",
        "Could not launch visible Chromium with the persistent profile. If another browser is using this profile, close it before retrying. Do not delete the profile to recover a session.",
        { cause: error },
      );
    }
  }

  private async navigate(page: Page, destination: string): Promise<void> {
    const url = assertAllowedSquarespaceUrl(destination);
    try {
      await page.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
    } catch (error) {
      throw new SquarespaceBrowserError(
        "NAVIGATION_FAILED",
        `Could not open ${url.origin}${url.pathname}. Check connectivity and retry.`,
        { cause: error },
      );
    }
  }

  private async isDashboardAuthenticated(page: Page): Promise<boolean> {
    const currentUrl = new URL(page.url());
    if (
      currentUrl.hostname !== "account.squarespace.com" ||
      /login|sign.?in/i.test(currentUrl.pathname)
    ) {
      return false;
    }

    const loginFormVisible = await page
      .locator('input[type="password"], form[action*="login"], form[action*="sign-in"]')
      .first()
      .isVisible();
    if (loginFormVisible) {
      return false;
    }

    const dashboardEvidence = await page
      .getByText(/websites|domains|billing/i)
      .first()
      .isVisible();
    return dashboardEvidence;
  }

  private validateTimeout(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer in milliseconds.`);
    }
  }

  private validateScreenshotFileName(fileName?: string): string {
    if (!fileName) {
      return `squarespace-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    }

    if (
      basename(fileName) !== fileName ||
      extname(fileName).toLowerCase() !== ".png" ||
      fileName === "." ||
      fileName === ".."
    ) {
      throw new SquarespaceBrowserError(
        "INVALID_SCREENSHOT_NAME",
        "Screenshot names must be a plain .png filename without directory components.",
      );
    }
    return fileName;
  }
}

function isSquarespaceUrl(value: string): boolean {
  try {
    assertAllowedSquarespaceUrl(value);
    return true;
  } catch {
    return false;
  }
}

function collectWebsiteLinks(): DiscoveredWebsite[] {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
  return anchors
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const path = new URL(element.href).pathname;
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        /\/(?:websites|config)(?:\/|$)/.test(path)
      );
    })
    .map((element) => ({
      name: element.innerText.trim() || element.getAttribute("aria-label") || "",
      url: element.href,
    }))
    .filter((website) => website.name.length > 0);
}

function collectPageDetails(): RawPageInspection {
  const maxTextLength = 20_000;
  const visibleText = document.body?.innerText ?? "";
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button, input[type="button"], input[type="submit"]',
    ),
  )
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    })
    .map((button) => ({
      text: (button.innerText || button.getAttribute("value") || "").trim(),
      ariaLabel: button.getAttribute("aria-label"),
      disabled: button.hasAttribute("disabled"),
    }));
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    })
    .map((link) => ({
      text: link.innerText.trim() || link.getAttribute("aria-label") || "",
      url: link.href,
    }));
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    ),
  )
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    })
    .map((input) => ({
      type: input instanceof HTMLInputElement ? input.type : input.tagName.toLowerCase(),
      name: input.getAttribute("name"),
      placeholder: input.getAttribute("placeholder"),
      ariaLabel: input.getAttribute("aria-label"),
      disabled: input.disabled,
      required: input.required,
    }));

  return {
    title: document.title,
    url: window.location.href,
    visibleText: visibleText.slice(0, maxTextLength),
    visibleTextTruncated: visibleText.length > maxTextLength,
    buttons,
    links,
    inputs,
  };
}
