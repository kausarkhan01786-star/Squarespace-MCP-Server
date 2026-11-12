import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import {
  isAuthenticatedSquarespaceDashboard,
  SquarespaceBrowserService,
  type AuthenticationSignals,
} from "./squarespace-browser.service.js";

function signals(
  overrides: Partial<AuthenticationSignals> = {},
): AuthenticationSignals {
  return {
    hostname: "account.squarespace.com",
    pathname: "/",
    loginFormVisible: false,
    dashboardEvidenceVisible: false,
    dashboardMarkerPresent: false,
    websiteCardCount: 0,
    ...overrides,
  };
}

test("detects an authenticated dashboard from visible website cards", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(signals({ websiteCardCount: 2 })),
    true,
  );
});

test("detects an authenticated dashboard from the observed dashboard marker", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ dashboardMarkerPresent: true }),
    ),
    true,
  );
});

test("does not mistake generic dashboard text during loading for authentication", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ dashboardEvidenceVisible: true }),
    ),
    false,
  );
});

test("rejects login forms and sign-in URLs as unauthenticated", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ loginFormVisible: true, websiteCardCount: 1 }),
    ),
    false,
  );
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ pathname: "/login", dashboardMarkerPresent: true }),
    ),
    false,
  );
});

test("rejects unrelated hosts and pages without dashboard evidence", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ hostname: "example.com", websiteCardCount: 1 }),
    ),
    false,
  );
  assert.equal(isAuthenticatedSquarespaceDashboard(signals()), false);
});

function fakePage(url = "about:blank"): Page & { markClosed(): void } {
  let closed = false;
  let currentUrl = url;
  return {
    isClosed: () => closed,
    markClosed: () => { closed = true; },
    url: () => currentUrl,
    goto: async (destination: string) => { currentUrl = destination; },
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
  } as unknown as Page & { markClosed(): void };
}

function fakeContext(initialPages: Array<Page & { markClosed(): void }> = []): BrowserContext & { closeUnexpectedly(): void } {
  const pages: Array<Page & { markClosed(): void }> = [...initialPages];
  const closeListeners: Array<() => void> = [];
  let closed = false;
  const context = {
    pages: () => pages.filter((page) => !page.isClosed()),
    newPage: async () => {
      if (closed) throw new Error("context is closed");
      const page = fakePage();
      pages.push(page);
      return page;
    },
    on: (event: string, listener: () => void) => {
      if (event === "close") closeListeners.push(listener);
      return context;
    },
    close: async () => {
      closed = true;
      pages.forEach((page) => page.markClosed());
      closeListeners.forEach((listener) => listener());
    },
    closeUnexpectedly: () => {
      closed = true;
      pages.forEach((page) => page.markClosed());
      closeListeners.forEach((listener) => listener());
    },
  };
  return context as unknown as BrowserContext & { closeUnexpectedly(): void };
}

test("reuses one context for concurrent calls and safely reacquires ownership after context closure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-browser-lifecycle-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const contexts: Array<BrowserContext & { closeUnexpectedly(): void }> = [];
  const service = new SquarespaceBrowserService({
    profileDirectory: join(root, "profile"),
    launchPersistentContext: async () => {
      const context = fakeContext();
      contexts.push(context);
      return context;
    },
  });

  const [firstPage, secondPage] = await Promise.all([
    service.getCurrentPage(),
    service.getCurrentPage(),
  ]);
  assert.equal(firstPage, secondPage);
  assert.equal(contexts.length, 1);

  contexts[0]!.closeUnexpectedly();
  const recoveredPage = await service.getCurrentPage();
  assert.ok(recoveredPage);
  assert.equal(contexts.length, 2);
  await service.close();
});

test("separate MCP service instances cannot launch against the same profile concurrently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-browser-owner-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profileDirectory = join(root, "profile");
  let secondLaunchCount = 0;
  const first = new SquarespaceBrowserService({
    profileDirectory,
    launchPersistentContext: async () => fakeContext(),
  });
  const second = new SquarespaceBrowserService({
    profileDirectory,
    launchPersistentContext: async () => { secondLaunchCount++; return fakeContext(); },
  });

  await first.getCurrentPage();
  await assert.rejects(second.getCurrentPage(), { code: "BROWSER_PROFILE_IN_USE" });
  assert.equal(secondLaunchCount, 0);
  await first.close();
  await second.getCurrentPage();
  assert.equal(secondLaunchCount, 1);
  await second.close();
});

test("a failed context close retains profile ownership until a later close succeeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-browser-close-retry-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profileDirectory = join(root, "profile");
  const context = fakeContext();
  const closeNormally = context.close.bind(context);
  let failClose = true;
  let closeAttempts = 0;
  (context as unknown as { close(): Promise<void> }).close = async () => {
    closeAttempts += 1;
    if (failClose) throw new Error("synthetic context close failure");
    await closeNormally();
  };
  const first = new SquarespaceBrowserService({
    profileDirectory,
    launchPersistentContext: async () => context,
  });
  let secondLaunchCount = 0;
  const second = new SquarespaceBrowserService({
    profileDirectory,
    launchPersistentContext: async () => { secondLaunchCount += 1; return fakeContext(); },
  });

  await first.getCurrentPage();
  await assert.rejects(first.close(), /synthetic context close failure/);
  await assert.rejects(second.getCurrentPage(), { code: "BROWSER_PROFILE_IN_USE" });
  assert.equal(secondLaunchCount, 0);

  failClose = false;
  await first.close();
  assert.equal(closeAttempts, 2);
  await second.getCurrentPage();
  assert.equal(secondLaunchCount, 1);
  await second.close();
});

test("keeps browser launch failures distinct from authentication outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-browser-launch-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const service = new SquarespaceBrowserService({
    profileDirectory: join(root, "profile"),
    launchPersistentContext: async () => { throw new Error("synthetic launch failure"); },
  });
  await assert.rejects(service.getCurrentPage(), { code: "BROWSER_LAUNCH_FAILED" });
  await service.close();
});

test("keeps dashboard navigation failures distinct from authentication outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-navigation-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const page = fakePage("about:blank");
  (page as unknown as { goto(): Promise<void> }).goto = async () => { throw new Error("synthetic navigation failure"); };
  const service = new SquarespaceBrowserService({
    profileDirectory: join(root, "profile"),
    launchPersistentContext: async () => fakeContext([page]),
  });
  await assert.rejects(service.listWebsites(), { code: "NAVIGATION_FAILED" });
  await service.close();
});

test("repeated listWebsites calls retain authenticated context classification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-authenticated-list-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let signalReads = 0;
  const service = new SquarespaceBrowserService({
    profileDirectory: join(root, "profile"),
    authenticationCheckTimeoutMs: 50,
    authenticationPollIntervalMs: 1,
    launchPersistentContext: async () => {
      const page = fakePage("https://account.squarespace.com/");
      const context = fakeContext();
      return {
        ...context,
        pages: () => [page],
      } as unknown as BrowserContext;
    },
  });
  const serviceInternals = service as unknown as {
    getAuthenticationSignals(page: Page): Promise<AuthenticationSignals>;
  };
  serviceInternals.getAuthenticationSignals = async () => {
    signalReads++;
    return signalReads === 1
      ? signals()
      : signals({ dashboardMarkerPresent: true });
  };
  const pageInternals = service as unknown as {
    getPage(): Promise<Page>;
  };
  const page = await pageInternals.getPage();
  (page as unknown as { locator: (selector: string) => { count: () => Promise<number> }; evaluate: () => Promise<unknown> }).locator = () => ({ count: async () => 1 });
  (page as unknown as { evaluate: () => Promise<unknown> }).evaluate = async () => [{
    name: "Kausar",
    url: "https://cobalt-bobcat-6afd.squarespace.com/",
  }];

  const first = await service.listWebsites();
  const second = await service.listWebsites();
  assert.equal(first[0]?.name, "Kausar");
  assert.equal(second[0]?.id, first[0]?.id);
  assert.equal(signalReads, 3);
  await service.close();
});

test("listWebsites normalizes an account subroute to the dashboard before checking authentication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-dashboard-route-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const page = fakePage("https://account.squarespace.com/websites");
  const service = new SquarespaceBrowserService({
    profileDirectory: join(root, "profile"),
    launchPersistentContext: async () => fakeContext([page]),
  });
  const internals = service as unknown as {
    getAuthenticationSignals(page: Page): Promise<AuthenticationSignals>;
  };
  internals.getAuthenticationSignals = async () => new URL(page.url()).pathname === "/"
    ? signals({ websiteCardCount: 1 })
    : signals();
  const pageForMock = page as unknown as {
    locator: (selector: string) => { count: () => Promise<number> };
    evaluate: () => Promise<unknown>;
  };
  pageForMock.locator = () => ({ count: async () => 1 });
  pageForMock.evaluate = async () => [{ name: "Kausar", url: "https://cobalt-bobcat-6afd.squarespace.com/" }];

  const websites = await service.listWebsites();
  assert.equal(page.url(), "https://account.squarespace.com/");
  assert.equal(websites[0]?.name, "Kausar");
  await service.close();
});

test("listWebsites distinguishes a confirmed login page from an unresolved dashboard", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-auth-state-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  for (const [authSignals, expectedCode] of [
    [signals({ loginFormVisible: true }), "NOT_LOGGED_IN"],
    [signals(), "AUTH_CHECK_PENDING"],
  ] as const) {
    const page = fakePage("https://account.squarespace.com/");
    const service = new SquarespaceBrowserService({
      profileDirectory: join(root, expectedCode),
      authenticationCheckTimeoutMs: 5,
      authenticationPollIntervalMs: 1,
      launchPersistentContext: async () => fakeContext([page]),
    });
    const internals = service as unknown as {
      getAuthenticationSignals(page: Page): Promise<AuthenticationSignals>;
    };
    internals.getAuthenticationSignals = async () => authSignals;
    await assert.rejects(service.listWebsites(), { code: expectedCode });
    await service.close();
  }
});
