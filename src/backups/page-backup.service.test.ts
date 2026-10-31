import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { PageBackupService } from "./page-backup.service.js";
import type { SquarespacePage, PageSection } from "../browser/squarespace-pages.service.js";
import type { WebsiteSummary } from "../browser/squarespace-browser.service.js";

const website: WebsiteSummary = {
  id: "fixture-site",
  name: "Fixture site",
  url: "https://fixture.squarespace.com/config?auth_token=private#account",
};
const pageRecord: SquarespacePage = {
  id: "fixture-page",
  websiteId: website.id,
  name: "Services",
  navigationTitle: "Services",
  type: "page",
  group: "main_navigation",
  groupLabel: "Main Navigation",
  parentId: null,
  parentPath: [],
  url: "https://fixture.squarespace.com/services?session_token=private#account",
  visibilityStatus: "enabled",
  enabled: true,
};
const sections: PageSection[] = [
  {
    id: "section-one",
    theme: "light",
    layout: "fluid_engine",
    headings: ["About"],
    visibleText: "Contact us at owner@example.com or +1 555 123 4567",
    textTruncated: false,
    blocks: [{
      id: "block-one",
      type: "1337",
      definitionName: "website.components.html",
      visibleText: "Bearer abc.def",
      textTruncated: false,
    }],
    blocksTruncated: false,
  },
  {
    id: "section-two",
    theme: "dark",
    layout: "unknown",
    headings: ["Contact"],
    visibleText: "Visible content",
    textTruncated: false,
    blocks: [],
    blocksTruncated: false,
  },
];

test("creates a sanitized JSON snapshot and associated full-page and section screenshots", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = await fixture.backups.createPageSnapshot(website.id, pageRecord.id);
    const snapshotPath = join(fixture.backupDirectory, "snapshots", `${snapshot.snapshotId}.json`);
    const json = JSON.parse(await readFile(snapshotPath, "utf8")) as typeof snapshot;
    assert.deepEqual(json, snapshot);
    assert.equal(snapshot.website.url, "https://fixture.squarespace.com/config");
    assert.equal(snapshot.page.name, pageRecord.name);
    assert.equal(snapshot.pageUrl, "https://fixture.squarespace.com/services");
    assert.doesNotMatch(JSON.stringify(snapshot), /auth_token|session_token|#account/);
    assert.equal(snapshot.sections[0]?.id, "section-one");
    assert.equal(snapshot.sections[0]?.headings[0], "About");
    assert.equal(snapshot.sections[0]?.layout, "fluid_engine");
    assert.equal(snapshot.sections[0]?.theme, "light");
    assert.equal(snapshot.sections[0]?.blocks[0]?.id, "block-one");
    assert.equal(snapshot.sections[0]?.blocks[0]?.type, "1337");
    assert.equal(
      snapshot.sections[0]?.blocks[0]?.definitionName,
      "website.components.html",
    );
    assert.match(snapshot.sections[0]?.visibleText ?? "", /\[REDACTED_EMAIL\]/);
    assert.match(snapshot.sections[0]?.visibleText ?? "", /\[REDACTED_PHONE\]/);
    assert.match(snapshot.sections[0]?.blocks[0]?.visibleText ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(snapshot), /owner@example\.com|555 123 4567|Bearer abc/);

    assert.equal(snapshot.screenshots.length, 3);
    assert.equal(
      new Set(snapshot.screenshots.map((screenshot) => screenshot.id)).size,
      snapshot.screenshots.length,
    );
    assert.equal(snapshot.screenshots[0]?.kind, "full_page");
    assert.equal(snapshot.screenshots[0]?.status, "captured");
    assert.equal(snapshot.screenshots[0]?.sectionId, null);
    assert.ok(snapshot.screenshots.slice(1).every((item) => item.status === "captured"));
    assert.deepEqual(
      snapshot.screenshots.slice(1).map((item) => item.sectionId),
      ["section-one", "section-two"],
    );
    for (const screenshot of snapshot.screenshots) {
      assert.equal(screenshot.snapshotId, snapshot.snapshotId);
      assert.equal(screenshot.websiteId, website.id);
      assert.equal(screenshot.pageId, pageRecord.id);
      assert.equal(screenshot.pageName, pageRecord.name);
      const path = join(fixture.backupDirectory, ...screenshot.path.split("/"));
      assert.ok((await stat(path)).size > 100);
      assert.equal((await readFile(path)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    }

    assert.deepEqual(await fixture.backups.getSnapshot(snapshot.snapshotId), snapshot);
    const listed = await fixture.backups.listSnapshots();
    assert.deepEqual(listed, [{
      snapshotId: snapshot.snapshotId,
      createdAt: snapshot.createdAt,
      websiteName: website.name,
      websiteUrl: "https://fixture.squarespace.com/config",
      pageName: pageRecord.name,
      pageUrl: "https://fixture.squarespace.com/services",
      screenshotCount: 3,
    }]);
  } finally {
    await fixture.close();
  }
});

test("refuses duplicate snapshot filenames without overwriting existing files", async () => {
  const snapshotId = randomUUID();
  const ids = [snapshotId, randomUUID(), randomUUID(), randomUUID(), snapshotId];
  let idIndex = 0;
  const fixture = await createFixture({
    idFactory: () => ids[idIndex++] ?? snapshotId,
  });
  try {
    const snapshot = await fixture.backups.createPageSnapshot(website.id, pageRecord.id);
    const snapshotPath = join(fixture.backupDirectory, "snapshots", `${snapshotId}.json`);
    const original = await readFile(snapshotPath, "utf8");
    await assert.rejects(
      () => fixture.backups.createPageSnapshot(website.id, pageRecord.id),
      { code: "SNAPSHOT_ALREADY_EXISTS" },
    );
    assert.equal(await readFile(snapshotPath, "utf8"), original);
    assert.equal(snapshot.snapshotId, snapshotId);
    assert.equal((await readdir(join(fixture.backupDirectory, "screenshots"))).length, 3);
  } finally {
    await fixture.close();
  }
});

test("reports invalid or missing local snapshots and invalid page input", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      () => fixture.backups.getSnapshot("../../outside"),
      { code: "SNAPSHOT_NOT_FOUND" },
    );
    await assert.rejects(
      () => fixture.backups.getSnapshot(randomUUID()),
      { code: "SNAPSHOT_NOT_FOUND" },
    );
    await assert.rejects(
      () => fixture.backups.createPageSnapshot(website.id, "missing"),
      { code: "PAGE_NOT_FOUND" },
    );
    const badId = randomUUID();
    const snapshotsDir = join(fixture.backupDirectory, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(join(snapshotsDir, `${badId}.json`), "{invalid", { flag: "wx" });
    await assert.rejects(
      () => fixture.backups.getSnapshot(badId),
      { code: "SNAPSHOT_READ_FAILED" },
    );
  } finally {
    await fixture.close();
  }
});

async function createFixture(options: {
  idFactory?: () => string;
} = {}): Promise<{
  browser: Browser;
  page: Page;
  backups: PageBackupService;
  backupDirectory: string;
  close(): Promise<void>;
}> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route("https://fixture.squarespace.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body>
          <section data-test="page-section" data-section-id="section-one" data-section-theme="light" data-fluid-engine-section>
            <h1>About</h1><div id="block-one" data-block-type="2">Visible section one</div>
          </section>
          <section data-test="page-section" data-section-id="section-two" data-section-theme="dark">
            <h2>Contact</h2><div id="block-two" data-block-type="4">Visible section two</div>
          </section>
        </body></html>`,
    });
  });
  const backupDirectory = await mkdtemp(join(tmpdir(), "squarespace-backup-test-"));
  const pages = {
    async getPageDetails(_websiteId: string, pageId: string) {
      if (pageId !== pageRecord.id) {
        const error = new Error("Page not found.") as Error & { code: string };
        error.code = "PAGE_NOT_FOUND";
        throw error;
      }
      return pageRecord;
    },
    async inspectPageSections() {
      await page.goto(pageRecord.url!);
      return {
        websiteId: website.id,
        pageId: pageRecord.id,
        url: pageRecord.url!,
        sections,
        sectionsTruncated: false,
      };
    },
  };
  const browserService = {
    getWebsite(websiteId: string) {
      if (websiteId !== website.id) throw new Error("Unknown website.");
      return website;
    },
    async openWebsiteUrl(_websiteId: string, url: string) {
      await page.goto(url);
    },
    async getCurrentPage() {
      return page;
    },
  };
  const backups = new PageBackupService(pages, browserService, {
    backupDirectory,
    idFactory: options.idFactory,
    now: () => new Date("2026-10-31T12:00:00.000Z"),
  });
  return {
    browser,
    page,
    backups,
    backupDirectory,
    async close() {
      await browser.close();
      await rm(backupDirectory, { recursive: true, force: true });
    },
  };
}
