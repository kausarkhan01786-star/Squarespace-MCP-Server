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
  private readonly websiteDestinations = new Map<string, WebsiteSummary>();

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
    if (new URL(page.url()).origin !== new URL(ACCOUNT_DASHBOARD_URL).origin) {
      await this.navigate(page, ACCOUNT_DASHBOARD_URL);
    }
    if (!(await this.isDashboardAuthenticated(page))) {
      throw new SquarespaceBrowserError(
        "NOT_LOGGED_IN",
        "The visible browser is open at the Squarespace dashboard or login page. Complete sign-in manually, then call list_websites again.",
      );
    }

    // tsx injects a __name helper that is unavailable inside Playwright's page context.
    const discovered = await page.evaluate<DiscoveredWebsite[], void>(
      `(() => {
        const cards = Array.from(document.querySelectorAll('[data-test="websiteCard"]'));
        const cardSites = cards.map((card) => {
          const link = card.querySelector('a[aria-label^="Go to website:"]');
          if (!link || !(link instanceof HTMLAnchorElement)) return null;
          const url = link.href;
          const hostname = new URL(url).hostname;
          const lines = (card.innerText || '').split(/\\n+/).map((line) => line.trim()).filter(Boolean);
          const name = lines.find((line) =>
            line.toLowerCase() !== 'go to website' &&
            !line.toLowerCase().includes(hostname.toLowerCase()) &&
            !/website trial|trial expired|^website selling$/i.test(line)
          );
          return { name: name || hostname, url };
        }).filter((site) => site !== null);
        if (cardSites.length > 0) return cardSites;
        return Array.from(document.querySelectorAll('a'))
          .filter((anchor) => anchor instanceof HTMLAnchorElement &&
            new URL(anchor.href).hostname !== 'account.squarespace.com' &&
            /\\/(?:websites|config)(?:\\/|$)/.test(new URL(anchor.href).pathname))
          .map((anchor) => {
            const element = anchor;
            return {
              name: element.innerText.trim() || element.getAttribute('aria-label') || new URL(element.href).hostname,
              url: element.href
            };
          });
      })()`,
      undefined,
    );

    this.websiteDestinations.clear();
    const uniqueSites = new Map<string, WebsiteSummary>();
    for (const website of discovered) {
      if (!isSquarespaceUrl(website.url)) {
        continue;
      }
      const canonicalUrl = new URL(website.url);
      canonicalUrl.search = "";
      canonicalUrl.hash = "";
      const id = createHash("sha256").update(canonicalUrl.toString()).digest("hex").slice(0, 16);
      if (!uniqueSites.has(id)) {
        const summary = {
          id,
          name: website.name,
          url: redactUrl(canonicalUrl.toString()),
        };
        this.websiteDestinations.set(id, summary);
        uniqueSites.set(id, summary);
      }
    }

    return [...uniqueSites.values()];
  }

  async switchWebsite(websiteId: string): Promise<void> {
    const website = this.websiteDestinations.get(websiteId);
    if (!website) {
      throw new SquarespaceBrowserError(
        "WEBSITE_NOT_FOUND",
        "That website is not in the latest listWebsites() result. Refresh the website list and select a returned ID.",
      );
    }
    await this.navigate(await this.getPage(), website.url);
  }

  getWebsite(websiteId: string): WebsiteSummary {
    const website = this.websiteDestinations.get(websiteId);
    if (!website) {
      throw new SquarespaceBrowserError(
        "WEBSITE_NOT_FOUND",
        "That website is not in the latest listWebsites() result. Call list_websites first and use a returned ID.",
      );
    }
    return website;
  }

  async openWebsitePages(websiteId: string): Promise<void> {
    const website = this.getWebsite(websiteId);
    const pagesUrl = new URL("/config/pages", website.url);
    await this.navigate(await this.getPage(), pagesUrl.toString());
  }

  async openWebsiteUrl(websiteId: string, destination: string): Promise<void> {
    const website = this.getWebsite(websiteId);
    const target = assertAllowedSquarespaceUrl(destination);
    const siteOrigin = new URL(website.url).origin;
    if (target.origin !== siteOrigin) {
      throw new SquarespaceBrowserError(
        "INVALID_URL",
        "Page navigation must stay on the selected Squarespace website.",
      );
    }
    await this.navigate(await this.getPage(), target.toString());
  }

  async getCurrentPage(): Promise<Page> {
    return this.getPage();
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
