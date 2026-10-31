import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Frame, Page } from "playwright";
import { SquarespaceBrowserError } from "./browser-errors.js";
import { assertAllowedSquarespaceUrl } from "./browser-security.js";
import type { SquarespaceBrowserService, WebsiteSummary } from "./squarespace-browser.service.js";

const PAGES_PANEL_SELECTOR = '[data-test="pages-panel"]';
const PAGE_ITEM_SELECTOR = '[data-test="pages-panel-item"]';
const GROUP_SELECTOR = '[data-test="pages-panel-group"]';
const SECTION_SELECTOR = '[data-test="page-section"]';
const MAX_SECTIONS = 50;
const MAX_SECTION_TEXT_LENGTH = 4_000;

export type NavigationGroup = "main_navigation" | "not_linked" | "footer_navigation" | "other";
export type SquarespacePageType = "page" | "folder";
export type SquarespacePageCreationType = "page" | "blog";
export type PageCreationGroup = Exclude<NavigationGroup, "other">;
export type PageVisibilityStatus = "enabled" | "disabled" | "unknown";

export interface SquarespacePage {
  id: string;
  websiteId: string;
  name: string;
  navigationTitle: string;
  type: SquarespacePageType;
  group: NavigationGroup;
  groupLabel: string;
  parentId: string | null;
  parentPath: string[];
  url: string | null;
  visibilityStatus: PageVisibilityStatus;
  enabled: boolean | null;
}

export interface PageNavigationNode extends SquarespacePage {
  children: PageNavigationNode[];
}

export interface PageSection {
  id: string | null;
  headings: string[];
  visibleText: string;
  textTruncated: boolean;
}

export interface RawPagePanelItem {
  index: number;
  name: string;
  groupLabel: string;
  type: SquarespacePageType;
  parentIndex: number | null;
  depth: number;
  isHomePage: boolean;
}

interface PageSettings {
  pageTitle: string | null;
  navigationTitle: string | null;
  slug: string | null;
  enabled: boolean | null;
  isFolder: boolean;
}

interface PageRecordInput extends RawPagePanelItem, PageSettings {}

interface SquarespacePagesBrowser {
  listWebsites(): Promise<WebsiteSummary[]>;
  getWebsite(websiteId: string): WebsiteSummary;
  openWebsitePages(websiteId: string): Promise<void>;
  openWebsiteUrl(websiteId: string, destination: string): Promise<void>;
  getCurrentPage(): Promise<Page>;
  captureScreenshot(fileName?: string): Promise<string>;
}

export class SquarespacePagesService {
  constructor(
    private readonly browser: SquarespacePagesBrowser,
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer in milliseconds.");
    }
  }

  async listWebsites(): Promise<WebsiteSummary[]> {
    return this.browser.listWebsites();
  }

  async createPage(
    websiteId: string,
    title: string,
    pageType: SquarespacePageCreationType,
    group: PageCreationGroup,
  ): Promise<{
    success: true;
    saved: true;
    pageType: SquarespacePageCreationType;
    page: SquarespacePage;
    screenshots: { before: string; after: string };
  }> {
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0 || normalizedTitle.length > 100) {
      throw new SquarespaceBrowserError(
        "PAGE_CREATION_FAILED",
        "Page titles must contain between 1 and 100 characters.",
      );
    }

    const website = this.browser.getWebsite(websiteId);
    await this.browser.openWebsitePages(websiteId);
    const page = await this.browser.getCurrentPage();
    await this.waitForPagesPanel(page);
    const initialItems = await this.readPanelItems(page);
    const screenshotId = randomUUID();
    const beforeScreenshot = await this.browser.captureScreenshot(
      `create-page-before-${screenshotId}.png`,
    );
    const afterScreenshotName = `create-page-after-${screenshotId}.png`;
    let creationAttempted = false;
    let afterScreenshotAttempted = false;

    try {
      const groupLabel = navigationGroupLabel(group);
      const addButtons = page.locator('button[title^="Add a new page to the"]');
      const matchingAddButtonIndices = await addButtons.evaluateAll(
        (buttons, expectedGroup) =>
          buttons.flatMap((button, index) =>
            (button.getAttribute("title") ?? "").includes(`"${expectedGroup}"`)
              ? [index]
              : [],
          ),
        groupLabel,
      );
      if (matchingAddButtonIndices.length !== 1) {
        throw new SquarespaceBrowserError(
          "PAGE_CREATION_FAILED",
          `Squarespace did not expose one unambiguous Add Page control for ${groupLabel}.`,
        );
      }

      await addButtons.nth(matchingAddButtonIndices[0]!).click();
      const catalog = page.locator('[data-test="catalog-dialog"]');
      await catalog.waitFor({ state: "visible", timeout: this.timeoutMs });
      await catalog.locator('[data-test="add-blank-options-button"]').click();

      const blankOption = page.locator(`[data-test="blank-${pageType}-option"]`);
      await blankOption.waitFor({ state: "visible", timeout: this.timeoutMs });
      creationAttempted = true;
      await blankOption.click();

      const createdItem = await this.waitForNewPage(page, initialItems, groupLabel);
      const createdRow = page.locator(PAGE_ITEM_SELECTOR).nth(createdItem.index);
      const settingsButton = createdRow.locator('button[aria-label^="Page settings "]');
      await settingsButton.click();

      const dialog = page.locator('[role="dialog"]').last();
      await dialog.waitFor({ state: "visible", timeout: this.timeoutMs });
      const titleField = dialog.getByRole("textbox", { name: "Page Title" });
      const navigationTitleField = dialog.getByRole("textbox", { name: "Navigation Title" });
      if ((await titleField.count()) !== 1 || (await navigationTitleField.count()) !== 1) {
        throw new SquarespaceBrowserError(
          "PAGE_CREATION_FAILED",
          "The new page did not expose the observed Page Title and Navigation Title fields.",
        );
      }

      await titleField.fill(normalizedTitle);
      await navigationTitleField.fill(normalizedTitle);
      await navigationTitleField.press("Tab");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden", timeout: this.timeoutMs });

      const finalItems = await this.readPanelItems(page);
      const matchingItems = finalItems.filter(
        (item) => item.groupLabel === groupLabel && item.name === normalizedTitle,
      );
      if (matchingItems.length !== 1) {
        throw new SquarespaceBrowserError(
          "PAGE_CREATION_FAILED",
          "Squarespace did not show one unambiguous page row with the requested title after creation.",
        );
      }

      const finalRow = page.locator(PAGE_ITEM_SELECTOR).nth(matchingItems[0]!.index);
      const savedSettings = await this.readPageSettings(page, finalRow, "page");
      if (
        savedSettings.pageTitle !== normalizedTitle ||
        savedSettings.navigationTitle !== normalizedTitle
      ) {
        throw new SquarespaceBrowserError(
          "PAGE_CREATION_FAILED",
          "Squarespace did not confirm that the requested page title and navigation title were saved.",
        );
      }

      const [createdPage] = createPageRecords(websiteId, website.url, [
        { ...matchingItems[0]!, ...savedSettings },
      ]);
      if (!createdPage) {
        throw new SquarespaceBrowserError(
          "PAGE_CREATION_FAILED",
          "Squarespace showed the new page, but the service could not construct its verified page record.",
        );
      }

      afterScreenshotAttempted = true;
      const afterScreenshot = await this.browser.captureScreenshot(afterScreenshotName);
      return {
        success: true,
        saved: true,
        pageType,
        page: createdPage,
        screenshots: { before: beforeScreenshot, after: afterScreenshot },
      };
    } catch (error) {
      if (creationAttempted && !afterScreenshotAttempted) {
        afterScreenshotAttempted = true;
        try {
          await this.browser.captureScreenshot(afterScreenshotName);
        } catch (screenshotError) {
          throw new SquarespaceBrowserError(
            "SCREENSHOT_FAILED",
            "Page creation was not confirmed, and the post-operation screenshot also failed.",
            { cause: new AggregateError([error, screenshotError]) },
          );
        }
      }

      if (error instanceof SquarespaceBrowserError) {
        throw error;
      }
      throw new SquarespaceBrowserError(
        "PAGE_CREATION_FAILED",
        "Squarespace did not confirm that the requested page was created and saved.",
        { cause: error },
      );
    }
  }

  async updatePageTitle(
    websiteId: string,
    pageId: string,
    title: string,
  ): Promise<{
    success: true;
    saved: true;
    previousPageId: string;
    page: SquarespacePage;
    screenshots: { before: string; after: string };
  }> {
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0 || normalizedTitle.length > 100) {
      throw new SquarespaceBrowserError(
        "PAGE_UPDATE_FAILED",
        "Page titles must contain between 1 and 100 characters.",
      );
    }

    const website = this.browser.getWebsite(websiteId);
    const initialPages = await this.readWebsitePages(websiteId);
    const targetIndex = initialPages.findIndex((candidate) => candidate.id === pageId);
    const target = initialPages[targetIndex];
    if (!target) {
      throw new SquarespaceBrowserError(
        "PAGE_NOT_FOUND",
        "The requested page ID was not found on this website. Refresh list_pages and use a returned page ID.",
      );
    }

    const page = await this.browser.getCurrentPage();
    await this.waitForPagesPanel(page);
    const screenshotId = randomUUID();
    const beforeScreenshot = await this.browser.captureScreenshot(
      `update-page-title-before-${screenshotId}.png`,
    );
    const afterScreenshotName = `update-page-title-after-${screenshotId}.png`;
    const expandedFolderKeys: string[] = [];
    let updateAttempted = false;
    let afterScreenshotAttempted = false;

    try {
      await this.expandCollapsedFolders(page, expandedFolderKeys);
      const currentItems = await this.readPanelItems(page);
      const targetKey = pageItemKeys(currentItems)[targetIndex];
      const expectedKey = JSON.stringify({
        group: target.groupLabel,
        path: [...target.parentPath, target.navigationTitle],
      });
      if (!currentItems[targetIndex] || targetKey !== expectedKey) {
        throw new SquarespaceBrowserError(
          "PAGE_NOT_FOUND",
          "The selected page no longer matches its ID in the Pages panel. Refresh list_pages and retry.",
        );
      }

      const row = page.locator(PAGE_ITEM_SELECTOR).nth(targetIndex);
      await row.locator('button[aria-label^="Page settings "]').click();
      const dialog = page.locator('[role="dialog"]').last();
      await dialog.waitFor({ state: "visible", timeout: this.timeoutMs });
      const titleField = dialog.getByRole("textbox", { name: "Page Title" });
      if ((await titleField.count()) !== 1) {
        throw new SquarespaceBrowserError(
          "PAGE_UPDATE_FAILED",
          "The selected page did not expose the observed Page Title field.",
        );
      }

      updateAttempted = true;
      await titleField.fill(normalizedTitle);
      await titleField.press("Tab");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden", timeout: this.timeoutMs });

      const savedSettings = await this.readPageSettings(page, row, target.type);
      if (savedSettings.pageTitle !== normalizedTitle) {
        throw new SquarespaceBrowserError(
          "PAGE_UPDATE_FAILED",
          "Squarespace did not confirm that the requested page title was saved.",
        );
      }

      await this.restoreCollapsedFolders(page, expandedFolderKeys);
      expandedFolderKeys.length = 0;

      const updatedPages = await this.readWebsitePages(websiteId);
      const matchingPages = updatedPages.filter(
        (candidate) =>
          candidate.name === normalizedTitle &&
          candidate.groupLabel === target.groupLabel &&
          candidate.parentPath.length === target.parentPath.length &&
          candidate.parentPath.every(
            (segment, index) => segment === target.parentPath[index],
          ),
      );
      if (matchingPages.length !== 1) {
        throw new SquarespaceBrowserError(
          "PAGE_UPDATE_FAILED",
          "Squarespace settings showed the new title, but the updated page could not be identified unambiguously in the Pages panel.",
        );
      }

      afterScreenshotAttempted = true;
      const afterScreenshot = await this.browser.captureScreenshot(afterScreenshotName);
      return {
        success: true,
        saved: true,
        previousPageId: pageId,
        page: matchingPages[0]!,
        screenshots: { before: beforeScreenshot, after: afterScreenshot },
      };
    } catch (error) {
      if (updateAttempted && !afterScreenshotAttempted) {
        afterScreenshotAttempted = true;
        try {
          await this.browser.captureScreenshot(afterScreenshotName);
        } catch (screenshotError) {
          throw new SquarespaceBrowserError(
            "SCREENSHOT_FAILED",
            "The title update was not confirmed, and the post-operation screenshot also failed.",
            { cause: new AggregateError([error, screenshotError]) },
          );
        }
      }

      if (error instanceof SquarespaceBrowserError) {
        throw error;
      }
      throw new SquarespaceBrowserError(
        "PAGE_UPDATE_FAILED",
        "Squarespace did not confirm that the requested page title was updated and saved.",
        { cause: error },
      );
    } finally {
      await this.restoreCollapsedFolders(page, expandedFolderKeys);
    }
  }

  async listPages(
    websiteId: string,
    group?: NavigationGroup,
  ): Promise<SquarespacePage[]> {
    const pages = await this.readWebsitePages(websiteId);
    return group ? pages.filter((page) => page.group === group) : pages;
  }

  async getPageDetails(websiteId: string, pageId: string): Promise<SquarespacePage> {
    const page = (await this.readWebsitePages(websiteId)).find((candidate) => candidate.id === pageId);
    if (!page) {
      throw new SquarespaceBrowserError(
        "PAGE_NOT_FOUND",
        "The requested page ID was not found on this website. Refresh list_pages and use a returned page ID.",
      );
    }
    return page;
  }

  async getPageUrl(
    websiteId: string,
    pageId: string,
  ): Promise<{ websiteId: string; pageId: string; url: string | null }> {
    const page = await this.getPageDetails(websiteId, pageId);
    return { websiteId, pageId, url: page.url };
  }

  async getNavigationStructure(
    websiteId: string,
  ): Promise<{ websiteId: string; groups: Array<{ group: NavigationGroup; label: string; pages: PageNavigationNode[] }> }> {
    const pages = await this.readWebsitePages(websiteId);
    const groupLabels = await this.readGroupLabels(websiteId);
    return {
      websiteId,
      groups: (["main_navigation", "footer_navigation", "not_linked", "other"] as const).map(
        (group) => {
          return {
            group,
            label: groupLabels[group] ?? defaultGroupLabel(group),
            pages: buildNavigationTree(pages.filter((page) => page.group === group)),
          };
        },
      ),
    };
  }

  async listNotLinkedPages(websiteId: string): Promise<SquarespacePage[]> {
    return this.listPages(websiteId, "not_linked");
  }

  async inspectPageSections(
    websiteId: string,
    pageId: string,
  ): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    sections: PageSection[];
    sectionsTruncated: boolean;
  }> {
    const pageRecord = await this.getPageDetails(websiteId, pageId);
    if (!pageRecord.url || pageRecord.type === "folder") {
      throw new SquarespaceBrowserError(
        "SECTIONS_NOT_AVAILABLE",
        "Sections can only be inspected for a page with a Squarespace URL.",
      );
    }

    const targetUrl = assertAllowedSquarespaceUrl(pageRecord.url);
    const website = this.browser.getWebsite(websiteId);
    if (targetUrl.origin !== new URL(website.url).origin) {
      throw new SquarespaceBrowserError(
        "INVALID_URL",
        "Page section inspection is restricted to the selected Squarespace website.",
      );
    }

    await this.browser.openWebsiteUrl(websiteId, targetUrl.toString());
    const page = await this.browser.getCurrentPage();
    const frame = await this.waitForPageFrame(page, targetUrl);
    const sectionResult = await frame.locator(SECTION_SELECTOR).evaluateAll(
      (
        elements: HTMLElement[],
        limits: { maxTextLength: number; maxSections: number },
      ) => ({
        totalCount: elements.length,
        sections: elements.slice(0, limits.maxSections).map((section) => {
          const style = window.getComputedStyle(section);
          const rect = section.getBoundingClientRect();
          const visible =
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;
          const text = visible ? (section.innerText || "").trim() : "";
          return {
            id: section.getAttribute("data-section-id"),
            headings: Array.from(section.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"))
              .filter((heading) => {
                const headingStyle = window.getComputedStyle(heading);
                const headingRect = heading.getBoundingClientRect();
                return (
                  headingStyle.display !== "none" &&
                  headingStyle.visibility !== "hidden" &&
                  headingRect.width > 0 &&
                  headingRect.height > 0
                );
              })
              .map((heading) => (heading.innerText || "").trim())
              .filter(Boolean)
              .slice(0, 20),
            visibleText: text.slice(0, limits.maxTextLength),
            textTruncated: text.length > limits.maxTextLength,
          };
        }),
      }),
      { maxTextLength: MAX_SECTION_TEXT_LENGTH, maxSections: MAX_SECTIONS },
    );

    return {
      websiteId,
      pageId,
      url: targetUrl.toString(),
      sections: sectionResult.sections,
      sectionsTruncated: sectionResult.totalCount > sectionResult.sections.length,
    };
  }

  private async readWebsitePages(websiteId: string): Promise<SquarespacePage[]> {
    const website = this.browser.getWebsite(websiteId);
    await this.browser.openWebsitePages(websiteId);
    const page = await this.browser.getCurrentPage();
    await this.waitForPagesPanel(page);

    const collapsedFolderKeys: string[] = [];
    try {
      await this.expandCollapsedFolders(page, collapsedFolderKeys);
      const rawItems = await this.readPanelItems(page);
      const records: PageRecordInput[] = [];
      for (const item of rawItems) {
        const row = page.locator(PAGE_ITEM_SELECTOR).nth(item.index);
        const settings = await this.readPageSettings(page, row, item.type);
        records.push({ ...item, ...settings });
      }
      return createPageRecords(websiteId, website.url, records);
    } finally {
      await this.restoreCollapsedFolders(page, collapsedFolderKeys);
    }
  }

  private async readGroupLabels(
    websiteId: string,
  ): Promise<Partial<Record<NavigationGroup, string>>> {
    await this.browser.openWebsitePages(websiteId);
    const page = await this.browser.getCurrentPage();
    await this.waitForPagesPanel(page);
    const labels = await page.locator(`${GROUP_SELECTOR} h2`).allTextContents();
    const result: Partial<Record<NavigationGroup, string>> = {};
    for (const label of labels) {
      result[toNavigationGroup(label)] = label.trim();
    }
    return result;
  }

  private async waitForPagesPanel(page: Page): Promise<void> {
    try {
      await page.locator(PAGES_PANEL_SELECTOR).waitFor({
        state: "visible",
        timeout: this.timeoutMs,
      });
      await page.locator(`${GROUP_SELECTOR} h2`).first().waitFor({
        state: "visible",
        timeout: this.timeoutMs,
      });
    } catch (error) {
      throw new SquarespaceBrowserError(
        "PAGES_PANEL_NOT_FOUND",
        "The Squarespace Pages panel did not finish loading. Confirm that the selected website is accessible and retry.",
        { cause: error },
      );
    }
  }

  private async readPanelItems(page: Page): Promise<RawPagePanelItem[]> {
    const rows = await page.evaluate<RawPagePanelItem[], void>(
      `(() => {
        const panel = document.querySelector('${PAGES_PANEL_SELECTOR}');
        if (!panel) return [];
        const items = Array.from(panel.querySelectorAll('${PAGE_ITEM_SELECTOR}'));
        const groupFor = (item) => {
          let current = item.parentElement;
          while (current && current !== panel) {
            const headings = Array.from(current.querySelectorAll('${GROUP_SELECTOR} h2'));
            if (headings.length === 1 && current.querySelectorAll('${PAGE_ITEM_SELECTOR}').length > 0) {
              return headings[0].innerText.trim();
            }
            current = current.parentElement;
          }
          return '';
        };
        return items.map((item, index) => {
          const settingsButton = item.querySelector('button[aria-label^="Page settings "]');
          const settingsLabel = settingsButton?.getAttribute('aria-label') || '';
          const name = settingsLabel.startsWith('Page settings ')
            ? settingsLabel.slice('Page settings '.length).trim()
            : (item.innerText || '').trim().split(/\\n+/)[0].trim();
          const folderButton = item.querySelector('button[aria-label^="Expand child pages "], button[aria-label^="Collapse child pages "]');
          const isHomePage = Array.from(item.querySelectorAll('button'))
            .some(button => (button.getAttribute('aria-label') || '').startsWith('Home Page settings '));
          let depth = 0;
          let current = item;
          while (current && current !== panel) {
            depth++;
            current = current.parentElement;
          }
          return {
            index,
            name,
            groupLabel: groupFor(item),
            type: folderButton ? 'folder' : 'page',
            parentIndex: null,
            depth,
            isHomePage
          };
        }).filter(item => item.name.length > 0 && item.groupLabel.length > 0);
      })()`,
      undefined,
    );
    return assignParentIndices(rows);
  }

  private async waitForNewPage(
    page: Page,
    initialItems: RawPagePanelItem[],
    groupLabel: string,
  ): Promise<RawPagePanelItem> {
    const initialKeys = pageItemKeys(initialItems);
    const initialCounts = countKeys(initialKeys);
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const currentItems = await this.readPanelItems(page);
      const currentKeys = pageItemKeys(currentItems);
      const currentCounts = countKeys(currentKeys);
      const newKeys = new Set(
        currentItems.flatMap((item, index) => {
          const key = currentKeys[index];
          return item.groupLabel === groupLabel &&
            key !== undefined &&
            (currentCounts.get(key) ?? 0) > (initialCounts.get(key) ?? 0)
            ? [key]
            : [];
        }),
      );

      if (newKeys.size > 0) {
        if (newKeys.size !== 1) {
          throw new SquarespaceBrowserError(
            "PAGE_CREATION_FAILED",
            "More than one new page row appeared; the service will not guess which one to rename.",
          );
        }
        const [newKey] = newKeys;
        if (!newKey || (initialCounts.get(newKey) ?? 0) > 0) {
          throw new SquarespaceBrowserError(
            "PAGE_CREATION_FAILED",
            "The new page row is indistinguishable from an existing page; the service will not risk renaming the wrong page.",
          );
        }
        const matchingIndices = currentKeys.flatMap((key, index) =>
          key === newKey ? [index] : [],
        );
        if (matchingIndices.length !== 1) {
          throw new SquarespaceBrowserError(
            "PAGE_CREATION_FAILED",
            "The new page row could not be identified unambiguously.",
          );
        }
        const createdItem = currentItems[matchingIndices[0]!];
        if (createdItem) {
          return createdItem;
        }
      }

      await delay(150);
    }

    throw new SquarespaceBrowserError(
      "PAGE_CREATION_FAILED",
      "Squarespace did not confirm a new page row before the operation timed out.",
    );
  }

  private async expandCollapsedFolders(page: Page, expandedKeys: string[]): Promise<void> {
    const selector =
      `${PAGE_ITEM_SELECTOR} button[aria-label^="Expand child pages "]:not([aria-expanded="true"])`;
    const deadline = Date.now() + this.timeoutMs;

    while (true) {
      const collapsedButtons = page.locator(selector);
      if ((await collapsedButtons.count()) === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new SquarespaceBrowserError(
          "PAGES_PANEL_NOT_FOUND",
          "Timed out while expanding collapsed page folders for read-only inspection.",
        );
      }

      const button = collapsedButtons.first();
      const label = await button.getAttribute("aria-label");
      if (!label) {
        throw new SquarespaceBrowserError(
          "PAGES_PANEL_NOT_FOUND",
          "A collapsed folder control did not expose its accessible label.",
        );
      }
      const rowIndex = await button.evaluate((element, selector) => {
        const row = element.closest(selector);
        return row
          ? Array.from(element.ownerDocument.querySelectorAll(selector)).indexOf(row)
          : -1;
      },
        PAGE_ITEM_SELECTOR,
      );
      const currentItems = await this.readPanelItems(page);
      const identity = pageItemKeys(currentItems)[rowIndex];
      if (rowIndex < 0 || !identity) {
        throw new SquarespaceBrowserError(
          "PAGES_PANEL_NOT_FOUND",
          `Could not identify folder ${label} without changing website content (row ${rowIndex}, items ${currentItems.length}).`,
        );
      }
      expandedKeys.push(identity);
      const matchingButtons = page.locator(`button[aria-label=${JSON.stringify(label)}]`);
      const beforeCount = await matchingButtons.evaluateAll((buttons) =>
        buttons.filter((candidate) => candidate.getAttribute("aria-expanded") !== "true").length,
      );
      await button.click();
      await this.waitForCollapsedCount(page, label, beforeCount - 1, deadline);
    }
  }

  private async restoreCollapsedFolders(page: Page, expandedKeys: string[]): Promise<void> {
    if (expandedKeys.length === 0) {
      return;
    }

    const rows = await this.readPanelItems(page);
    const currentKeys = pageItemKeys(rows);
    for (const key of [...expandedKeys].reverse()) {
      const rowIndex = currentKeys.indexOf(key);
      if (rowIndex < 0) {
        throw new SquarespaceBrowserError(
          "PAGES_PANEL_NOT_FOUND",
          "Could not restore a folder's original collapsed state after inspection.",
        );
      }
      const row = page.locator(PAGE_ITEM_SELECTOR).nth(rowIndex);
      const button = row.locator('button[aria-label^="Expand child pages "], button[aria-label^="Collapse child pages "]').first();
      if ((await button.getAttribute("aria-expanded")) !== "true") {
        continue;
      }
      const label = await button.getAttribute("aria-label");
      if (!label) {
        throw new SquarespaceBrowserError(
          "PAGES_PANEL_NOT_FOUND",
          "A folder control did not expose its accessible label during state restoration.",
        );
      }
      await button.click();
      const collapsed = page.locator(
        `button[aria-label=${JSON.stringify(label)}][aria-expanded="false"]`,
      );
      await collapsed.first().waitFor({ state: "attached", timeout: this.timeoutMs });
    }
  }

  private async waitForCollapsedCount(
    page: Page,
    label: string,
    expected: number,
    deadline: number,
  ): Promise<void> {
    const selector = `button[aria-label=${JSON.stringify(label)}]`;
    while (Date.now() < deadline) {
      const collapsedCount = await page.locator(selector).evaluateAll((buttons) =>
        buttons.filter((candidate) => candidate.getAttribute("aria-expanded") !== "true").length,
      );
      if (collapsedCount <= expected) {
        return;
      }
      await delay(100);
    }
    throw new SquarespaceBrowserError(
      "PAGES_PANEL_NOT_FOUND",
      `The folder ${label} did not finish expanding in time.`,
    );
  }

  private async readPageSettings(
    page: Page,
    row: ReturnType<Page["locator"]>,
    rowType: SquarespacePageType,
  ): Promise<PageSettings> {
    const settingsButton = row.locator('button[aria-label^="Page settings "]').first();
    if ((await settingsButton.count()) === 0) {
      throw new SquarespaceBrowserError(
        "PAGE_SETTINGS_FAILED",
        "A page row did not expose the observed Page settings control; no page data was changed.",
      );
    }

    await settingsButton.click();
    const dialog = page.locator('[role="dialog"]').last();
    try {
      await dialog.waitFor({ state: "visible", timeout: this.timeoutMs });
      const modalHeading = await dialog.locator("h1, h2").allTextContents();
      const pageTitle = await readTextbox(dialog, "Page Title");
      const navigationTitle = await readTextbox(dialog, "Navigation Title");
      const slug = await readTextbox(dialog, "URL Slug");
      const enabledCheckbox = dialog.getByRole("checkbox", { name: "Enable Page" });
      const enabled = (await enabledCheckbox.count()) > 0
        ? await enabledCheckbox.isChecked()
        : null;

      return {
        pageTitle,
        navigationTitle,
        slug,
        enabled,
        isFolder:
          rowType === "folder" ||
          modalHeading.some((heading) => /configure dropdown/i.test(heading)),
      };
    } catch (error) {
      throw new SquarespaceBrowserError(
        "PAGE_SETTINGS_FAILED",
        "Could not read the selected page's visible settings. The service does not save or alter those settings.",
        { cause: error },
      );
    } finally {
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden", timeout: this.timeoutMs });
    }
  }

  private async waitForPageFrame(page: Page, targetUrl: URL): Promise<Frame> {
    const targetPath = normalizePath(targetUrl.pathname);
    const deadline = Date.now() + this.timeoutMs;
    let matchingFrame: Frame | undefined;

    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        let frameUrl: URL;
        try {
          frameUrl = new URL(frame.url());
        } catch {
          continue;
        }
        if (
          frameUrl.origin === targetUrl.origin &&
          normalizePath(frameUrl.pathname) === targetPath
        ) {
          matchingFrame = frame;
          if ((await frame.locator(SECTION_SELECTOR).count()) > 0) {
            return frame;
          }
        }
      }
      await delay(200);
    }

    if (matchingFrame) {
      throw new SquarespaceBrowserError(
        "SECTIONS_NOT_AVAILABLE",
        "The page loaded, but no visible Squarespace page sections were found using the observed Pages-panel preview selector.",
      );
    }
    throw new SquarespaceBrowserError(
      "SECTIONS_NOT_AVAILABLE",
      "The requested page preview did not load within the timeout.",
    );
  }
}

function countKeys(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function navigationGroupLabel(group: PageCreationGroup): string {
  switch (group) {
    case "main_navigation":
      return "Main Navigation";
    case "not_linked":
      return "Not Linked";
    case "footer_navigation":
      return "Footer Navigation";
  }
}

export function createPageRecords(
  websiteId: string,
  websiteUrl: string,
  items: PageRecordInput[],
): SquarespacePage[] {
  const origin = new URL(websiteUrl).origin;
  const ids = new Map<number, string>();
  const paths = new Map<number, string[]>();
  const usedIds = new Set<string>();

  for (const item of items) {
    const parentPath = item.parentIndex === null
      ? []
      : [...(paths.get(item.parentIndex) ?? [])];
    parentPath.push(item.name);
    paths.set(item.index, parentPath);

    const group = toNavigationGroup(item.groupLabel);
    const pathKey = `${group}|${parentPath.join("/")}`;
    const hash = createHash("sha256").update(`${websiteId}|${pathKey}`).digest("hex").slice(0, 16);
    let id = hash;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${hash}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    ids.set(item.index, id);
  }

  return items.map((item) => {
    const parentPath = item.parentIndex === null ? [] : paths.get(item.parentIndex) ?? [];
    const pageType: SquarespacePageType = item.isFolder || item.type === "folder"
      ? "folder"
      : "page";
    const slug = item.slug?.trim();
    let url: string | null = null;
    const isHomePage =
      item.isHomePage ||
      (item.name.toLowerCase() === "home" &&
        item.groupLabel.trim().toLowerCase() === "main navigation" &&
        item.parentIndex === null);
    if (isHomePage) {
      url = `${origin}/`;
    } else if (slug !== undefined && slug.length > 0) {
      const path = slug.startsWith("/") ? slug : `/${slug}`;
      const resolved = new URL(path, origin);
      if (resolved.origin === origin) {
        url = resolved.toString();
      }
    }
    const enabled = item.enabled;
    const id = ids.get(item.index);
    if (!id) {
      throw new SquarespaceBrowserError(
        "PAGES_PANEL_NOT_FOUND",
        "A page record could not be assigned a stable ID.",
      );
    }
    return {
      id,
      websiteId,
      name: item.pageTitle?.trim() || item.name,
      navigationTitle: item.navigationTitle?.trim() || item.name,
      type: pageType,
      group: toNavigationGroup(item.groupLabel),
      groupLabel: item.groupLabel.trim(),
      parentId: item.parentIndex === null ? null : ids.get(item.parentIndex) ?? null,
      parentPath,
      url,
      visibilityStatus: enabled === null ? "unknown" : enabled ? "enabled" : "disabled",
      enabled,
    };
  });
}

export function buildNavigationTree(
  pages: SquarespacePage[],
): PageNavigationNode[] {
  const byId = new Map<string, PageNavigationNode>();
  for (const page of pages) {
    byId.set(page.id, { ...page, children: [] });
  }
  const roots: PageNavigationNode[] = [];
  for (const page of pages) {
    const node = byId.get(page.id);
    if (!node) {
      continue;
    }
    const parent = page.parentId ? byId.get(page.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

async function readTextbox(
  dialog: ReturnType<Page["locator"]>,
  accessibleName: string,
): Promise<string | null> {
  const textbox = dialog.getByRole("textbox", { name: accessibleName });
  if ((await textbox.count()) === 0) {
    return null;
  }
  return (await textbox.inputValue()).trim();
}

function toNavigationGroup(label: string): NavigationGroup {
  const normalized = label.trim().toLowerCase();
  if (normalized === "main navigation") {
    return "main_navigation";
  }
  if (normalized === "not linked") {
    return "not_linked";
  }
  if (normalized === "footer navigation") {
    return "footer_navigation";
  }
  return "other";
}

function defaultGroupLabel(group: NavigationGroup): string {
  switch (group) {
    case "main_navigation":
      return "Main Navigation";
    case "not_linked":
      return "Not Linked";
    case "footer_navigation":
      return "Footer Navigation";
    case "other":
      return "Other";
  }
}

function pageItemKeys(items: RawPagePanelItem[]): string[] {
  const paths = new Map<number, string[]>();
  return items.map((item) => {
    const path = item.parentIndex === null
      ? []
      : [...(paths.get(item.parentIndex) ?? [])];
    path.push(item.name);
    paths.set(item.index, path);
    return JSON.stringify({ group: item.groupLabel, path });
  });
}

function assignParentIndices(items: RawPagePanelItem[]): RawPagePanelItem[] {
  const stacks = new Map<string, Array<{ index: number; depth: number }>>();
  return items.map((item) => {
    const stack = stacks.get(item.groupLabel) ?? [];
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= item.depth) {
      stack.pop();
    }
    const parentIndex = stack[stack.length - 1]?.index ?? null;
    if (item.type === "folder") {
      stack.push({ index: item.index, depth: item.depth });
    }
    stacks.set(item.groupLabel, stack);
    return { ...item, parentIndex };
  });
}

function normalizePath(path: string): string {
  if (path === "/") {
    return "/";
  }
  return `/${path.replace(/^\/+|\/+$/g, "")}`;
}
