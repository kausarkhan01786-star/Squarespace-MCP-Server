import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Page } from "playwright";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import {
  SQUARESPACE_PAGE_SECTION_SELECTOR,
  type PageSection,
  type SquarespacePage,
  type SquarespacePagesService,
} from "../browser/squarespace-pages.service.js";
import type {
  SquarespaceBrowserService,
  WebsiteSummary,
} from "../browser/squarespace-browser.service.js";

const SECTION_SELECTOR = SQUARESPACE_PAGE_SECTION_SELECTOR;
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pageInspectionSchema = z.object({
  id: z.string(),
  websiteId: z.string(),
  name: z.string(),
  navigationTitle: z.string(),
  type: z.enum(["page", "folder"]),
  group: z.enum(["main_navigation", "not_linked", "footer_navigation", "other"]),
  groupLabel: z.string(),
  parentId: z.string().nullable(),
  parentPath: z.array(z.string()),
  url: z.string().nullable(),
  visibilityStatus: z.enum(["enabled", "disabled", "unknown"]),
  enabled: z.boolean().nullable(),
  identity: z.object({
    kind: z.enum(["native", "synthetic"]),
    native_id: z.string().nullable(),
    synthetic_id: z.string().nullable(),
    title: z.string(),
    slug: z.string().nullable(),
    is_homepage: z.boolean(),
  }).optional(),
});
const pageSectionSchema = z.object({
  id: z.string().nullable(),
  theme: z.string().nullable(),
  layout: z.enum(["fluid_engine", "unknown"]),
  headings: z.array(z.string()),
  visibleText: z.string(),
  textTruncated: z.boolean(),
  blocks: z.array(z.object({
    id: z.string().nullable(),
    type: z.string().nullable(),
    definitionName: z.string().nullable().optional(),
    visibleText: z.string(),
    textTruncated: z.boolean(),
  })),
  blocksTruncated: z.boolean(),
});
const screenshotSchema = z.object({
  id: z.string().uuid(),
  snapshotId: z.string().uuid(),
  websiteId: z.string(),
  pageId: z.string(),
  pageName: z.string(),
  sectionId: z.string().nullable(),
  kind: z.enum(["full_page", "section"]),
  status: z.enum(["captured", "unavailable"]),
  path: z.string(),
  error: z.string().optional(),
});
const snapshotSchema = z.object({
  snapshotId: z.string().uuid(),
  createdAt: z.string().datetime(),
  website: z.object({
    id: z.string(),
    name: z.string(),
    url: z.string().url(),
  }),
  page: pageInspectionSchema,
  pageUrl: z.string().url(),
  sections: z.array(pageSectionSchema),
  sectionsTruncated: z.boolean(),
  screenshots: z.array(screenshotSchema),
});

export type PageSnapshot = z.infer<typeof snapshotSchema>;
export type PageSnapshotScreenshot = z.infer<typeof screenshotSchema>;

export interface PageBackupServiceOptions {
  backupDirectory?: string;
  idFactory?: () => string;
  now?: () => Date;
}

interface PageBackupBrowser {
  getWebsite(websiteId: string): WebsiteSummary;
  openWebsiteUrl(websiteId: string, destination: string): Promise<void>;
  getCurrentPage(): Promise<Page>;
}

type PageBackupInspector = Pick<
  SquarespacePagesService,
  "getPageDetails" | "inspectPageSections"
>;

export class PageBackupService {
  private readonly backupDirectory: string;
  private readonly snapshotsDirectory: string;
  private readonly screenshotsDirectory: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly pages: PageBackupInspector,
    private readonly browser: PageBackupBrowser,
    options: PageBackupServiceOptions = {},
  ) {
    this.backupDirectory = resolve(options.backupDirectory ?? join(process.cwd(), "backups"));
    this.snapshotsDirectory = join(this.backupDirectory, "snapshots");
    this.screenshotsDirectory = join(this.backupDirectory, "screenshots");
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async createPageSnapshot(
    websiteId: string,
    pageId: string,
  ): Promise<PageSnapshot> {
    const website = this.browser.getWebsite(websiteId);
    const page = await this.pages.getPageDetails(websiteId, pageId);
    if (!page.url || page.type === "folder") {
      throw new SquarespaceBrowserError(
        "SECTIONS_NOT_AVAILABLE",
        "A page snapshot requires a Squarespace page URL.",
      );
    }

    const safeWebsiteUrl = safePublicUrl(website.url);
    const safePageUrl = safePublicUrl(page.url);
    if (new URL(safeWebsiteUrl).origin !== new URL(safePageUrl).origin) {
      throw new SquarespaceBrowserError(
        "INVALID_URL",
        "A page snapshot is restricted to the selected Squarespace website.",
      );
    }

    const inspection = await this.pages.inspectPageSections(websiteId, pageId);
    const snapshotId = this.idFactory();
    if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
      throw new SquarespaceBrowserError(
        "SNAPSHOT_WRITE_FAILED",
        "The generated snapshot ID was not a valid UUID.",
      );
    }
    const snapshotPath = this.snapshotPath(snapshotId);
    const lockPath = join(this.snapshotsDirectory, `.${snapshotId}.lock`);
    const screenshotPaths: string[] = [];
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    let lockAcquired = false;
    let snapshotCreated = false;

    try {
      await this.ensureDirectories();
      lockHandle = await open(lockPath, "wx");
      lockAcquired = true;
      const currentPage = await this.browser.getCurrentPage();
      const frame = await this.findPageFrame(currentPage, safePageUrl);
      const screenshots: PageSnapshotScreenshot[] = [];
      const sensitiveSectionIndices = inspection.sections.flatMap((section, index) =>
        sectionHasSensitiveText(section) ? [index] : []);
      const fullPageMasks = sensitiveSectionIndices.map((index) =>
        frame.locator(SECTION_SELECTOR).nth(index));

      const pageScreenshot = await frame.locator("body").screenshot({
        type: "png",
        mask: fullPageMasks,
      });
      const pageScreenshotPath = this.screenshotPath(snapshotId, "page.png");
      await this.writeNewFile(pageScreenshotPath, pageScreenshot);
      screenshotPaths.push(pageScreenshotPath);
      screenshots.push({
        id: this.idFactory(),
        snapshotId,
        websiteId,
        pageId,
        pageName: sanitizeText(page.name),
        sectionId: null,
        kind: "full_page",
        status: "captured",
        path: this.relativeBackupPath(pageScreenshotPath),
      });

      const currentSectionIds = await frame.locator(SECTION_SELECTOR).evaluateAll(
        (sections: HTMLElement[]) =>
          sections.map((section) => section.getAttribute("data-section-id")),
      );
      if (currentSectionIds.length !== inspection.sections.length ||
        inspection.sections.some((section, index) =>
          section.id !== currentSectionIds[index])) {
        throw new SquarespaceBrowserError(
          "SNAPSHOT_CAPTURE_FAILED",
          "The rendered sections changed during inspection; screenshot associations could not be verified.",
        );
      }

      for (const [index, section] of inspection.sections.entries()) {
        const screenshotId = this.idFactory();
        const fileName = sectionScreenshotFileName(index, section.id);
        const sectionPath = this.screenshotPath(snapshotId, fileName);
        const sectionLocator = frame.locator(SECTION_SELECTOR).nth(index);
        let image: Buffer;
        try {
          image = await sectionLocator.screenshot({
            type: "png",
            mask: sectionHasSensitiveText(section) ? [sectionLocator] : [],
          });
        } catch {
          screenshots.push({
            id: screenshotId,
            snapshotId,
            websiteId,
            pageId,
            pageName: sanitizeText(page.name),
            sectionId: section.id,
            kind: "section",
            status: "unavailable",
            path: this.relativeBackupPath(sectionPath),
            error: "Squarespace did not expose this section for an individual screenshot.",
          });
          continue;
        }
        await this.writeNewFile(sectionPath, image);
        screenshotPaths.push(sectionPath);
        screenshots.push({
          id: screenshotId,
          snapshotId,
          websiteId,
          pageId,
          pageName: sanitizeText(page.name),
          sectionId: section.id,
          kind: "section",
          status: "captured",
          path: this.relativeBackupPath(sectionPath),
        });
      }

      const snapshot = snapshotSchema.parse({
        snapshotId,
        createdAt: this.now().toISOString(),
        website: {
          id: website.id,
          name: sanitizeText(website.name),
          url: safeWebsiteUrl,
        },
        page: sanitizePage(page),
        pageUrl: safePageUrl,
        sections: inspection.sections.map(sanitizeSection),
        sectionsTruncated: inspection.sectionsTruncated,
        screenshots,
      });

      const snapshotHandle = await open(snapshotPath, "wx");
      snapshotCreated = true;
      try {
        await snapshotHandle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      } finally {
        await snapshotHandle.close();
      }
      return snapshot;
    } catch (error) {
      for (const path of screenshotPaths) {
        await unlink(path).catch(() => undefined);
      }
      if (snapshotCreated) {
        await unlink(snapshotPath).catch(() => undefined);
      }
      if (error instanceof SquarespaceBrowserError) {
        throw error;
      }
      if (isAlreadyExistsError(error)) {
        throw new SquarespaceBrowserError(
          "SNAPSHOT_ALREADY_EXISTS",
          "A backup with this ID or one of its screenshot filenames already exists; no existing backup was overwritten.",
          { cause: error },
        );
      }
      throw new SquarespaceBrowserError(
        "SNAPSHOT_WRITE_FAILED",
        "The page snapshot or its local screenshots could not be saved.",
        { cause: error },
      );
    } finally {
      await lockHandle?.close().catch(() => undefined);
      if (lockAcquired) {
        await unlink(lockPath).catch(() => undefined);
      }
    }
  }

  async listSnapshots(): Promise<Array<{
    snapshotId: string;
    createdAt: string;
    websiteName: string;
    websiteUrl: string;
    pageName: string;
    pageUrl: string;
    screenshotCount: number;
  }>> {
    await this.ensureDirectories();
    const entries = await readdir(this.snapshotsDirectory, { withFileTypes: true });
    const snapshotFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
    const snapshots = await Promise.all(snapshotFiles.map((fileName) =>
      this.readSnapshot(fileName.slice(0, -".json".length))));
    return snapshots.map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      createdAt: snapshot.createdAt,
      websiteName: snapshot.website.name,
      websiteUrl: snapshot.website.url,
      pageName: snapshot.page.name,
      pageUrl: snapshot.pageUrl,
      screenshotCount: snapshot.screenshots.filter(
        (screenshot) => screenshot.status === "captured",
      ).length,
    }));
  }

  async getSnapshot(snapshotId: string): Promise<PageSnapshot> {
    return this.readSnapshot(snapshotId);
  }

  async verifyFreshSnapshot(
    snapshotId: string,
    websiteId: string,
    pageId: string,
    createdAfter: Date,
  ): Promise<PageSnapshot> {
    const snapshot = await this.getSnapshot(snapshotId);
    const createdAt = Date.parse(snapshot.createdAt);
    if (
      snapshot.website.id !== websiteId ||
      snapshot.page.id !== pageId ||
      !Number.isFinite(createdAt) ||
      createdAt < createdAfter.getTime() ||
      createdAt > this.now().getTime()
    ) {
      throw new SquarespaceBrowserError(
        "SNAPSHOT_VERIFICATION_FAILED",
        "The backup is stale or does not match the requested website and page.",
      );
    }

    const capturedScreenshots = snapshot.screenshots.filter(
      (screenshot) => screenshot.status === "captured",
    );
    if (!capturedScreenshots.some((screenshot) => screenshot.kind === "full_page")) {
      throw new SquarespaceBrowserError(
        "SNAPSHOT_VERIFICATION_FAILED",
        "The fresh backup does not include a captured full-page screenshot.",
      );
    }

    for (const screenshot of capturedScreenshots) {
      const screenshotPath = resolve(this.backupDirectory, screenshot.path);
      const relativePath = relative(this.backupDirectory, screenshotPath);
      if (
        isAbsolute(relativePath) ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`)
      ) {
        throw new SquarespaceBrowserError(
          "SNAPSHOT_VERIFICATION_FAILED",
          "A backup screenshot path escaped the configured backup directory.",
        );
      }
      try {
        await access(screenshotPath);
        const screenshotStat = await stat(screenshotPath);
        if (!screenshotStat.isFile() || screenshotStat.size === 0) {
          throw new Error("The screenshot file is empty or not a regular file.");
        }
      } catch (error) {
        throw new SquarespaceBrowserError(
          "SNAPSHOT_VERIFICATION_FAILED",
          "A screenshot referenced by the fresh backup is missing or unreadable.",
          { cause: error },
        );
      }
    }

    return snapshot;
  }

  private async readSnapshot(snapshotId: string): Promise<PageSnapshot> {
    if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
      throw new SquarespaceBrowserError(
        "SNAPSHOT_NOT_FOUND",
        "Provide a snapshot UUID returned by create_page_snapshot or list_snapshots.",
      );
    }
    try {
      const contents = await readFile(this.snapshotPath(snapshotId), "utf8");
      return snapshotSchema.parse(JSON.parse(contents));
    } catch (error) {
      if (isMissingError(error)) {
        throw new SquarespaceBrowserError(
          "SNAPSHOT_NOT_FOUND",
          "The requested local snapshot does not exist.",
          { cause: error },
        );
      }
      throw new SquarespaceBrowserError(
        "SNAPSHOT_READ_FAILED",
        "The local snapshot could not be parsed or validated.",
        { cause: error },
      );
    }
  }

  private async findPageFrame(page: Page, pageUrl: string) {
    const target = new URL(pageUrl);
    const expectedPath = normalizePath(target.pathname);
    const frame = page.frames().find((candidate) => {
      try {
        const candidateUrl = new URL(candidate.url());
        return candidateUrl.origin === target.origin &&
          normalizePath(candidateUrl.pathname) === expectedPath;
      } catch {
        return false;
      }
    });
    if (!frame) {
      throw new SquarespaceBrowserError(
        "SNAPSHOT_CAPTURE_FAILED",
        "The public page frame was not found for screenshot capture.",
      );
    }
    return frame;
  }

  private async writeNewFile(path: string, contents: Buffer): Promise<void> {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(contents);
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.snapshotsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.screenshotsDirectory, { recursive: true, mode: 0o700 }),
    ]);
  }

  private snapshotPath(snapshotId: string): string {
    return join(this.snapshotsDirectory, `${snapshotId}.json`);
  }

  private screenshotPath(snapshotId: string, fileName: string): string {
    return join(this.screenshotsDirectory, `${snapshotId}-${fileName}`);
  }

  private relativeBackupPath(path: string): string {
    const relativePath = path.slice(this.backupDirectory.length + 1);
    return relativePath.split(sep).join("/");
  }
}

function safePublicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new SquarespaceBrowserError(
      "INVALID_URL",
      "Snapshots can only include credential-free HTTPS URLs.",
    );
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b(password|passcode|token|secret|api[_ -]?key|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, "[REDACTED_PHONE]");
}

function sanitizePage(page: SquarespacePage): SquarespacePage {
  return {
    ...page,
    name: sanitizeText(page.name),
    navigationTitle: sanitizeText(page.navigationTitle),
    groupLabel: sanitizeText(page.groupLabel),
    parentPath: page.parentPath.map(sanitizeText),
    url: page.url ? safePublicUrl(page.url) : null,
  };
}

function sanitizeSection(section: PageSection): PageSection {
  return {
    ...section,
    headings: section.headings.map(sanitizeText),
    visibleText: sanitizeText(section.visibleText),
    blocks: section.blocks.map((block) => ({
      ...block,
      visibleText: sanitizeText(block.visibleText),
    })),
  };
}

function sectionHasSensitiveText(section: PageSection): boolean {
  return sanitizeText([
    ...section.headings,
    section.visibleText,
    ...section.blocks.map((block) => block.visibleText),
  ].join("\n")) !== [
    ...section.headings,
    section.visibleText,
    ...section.blocks.map((block) => block.visibleText),
  ].join("\n");
}

function sectionScreenshotFileName(index: number, sectionId: string | null): string {
  const safeId = (sectionId ?? "no-id").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return `section-${String(index + 1).padStart(2, "0")}-${safeId}.png`;
}

function normalizePath(path: string): string {
  if (path === "/") {
    return path;
  }
  return path.replace(/\/+$/, "");
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isMissingError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
