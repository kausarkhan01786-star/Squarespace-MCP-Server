import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Frame, Locator, Page } from "playwright";
import {
  awaitPlaywrightOperation,
  ExecutionStoppedError,
  currentBrowserExecutionContext,
  waitForExecutionDelay,
  waitForLocatorState,
  type BrowserExecutionContext,
} from "./browser-execution-context.js";
import { SquarespaceBrowserError } from "./browser-errors.js";
import {
  MutationApprovalError,
  MutationApprovalGuard,
  type MutationPermissionScope,
} from "../approval/mutation-approval.js";
import { assertAllowedSquarespaceUrl } from "./browser-security.js";
import type { SquarespaceBrowserService, WebsiteSummary } from "./squarespace-browser.service.js";

const PAGES_PANEL_SELECTOR = '[data-test="pages-panel"]';
const PAGE_ITEM_SELECTOR = '[data-test="pages-panel-item"]';
const GROUP_SELECTOR = '[data-test="pages-panel-group"]';
export const SQUARESPACE_PAGE_SECTION_SELECTOR = '[data-test="page-section"]';
export const SQUARESPACE_CONTENT_BLOCK_SELECTOR = "[data-block-type]";
const SECTION_SELECTOR = SQUARESPACE_PAGE_SECTION_SELECTOR;
const EDITOR_ACTION_SELECTOR = 'button, [role="button"]';
const MAX_SECTIONS = 50;
const MAX_SECTION_TEXT_LENGTH = 4_000;
const MAX_BLOCKS_PER_SECTION = 100;
const MAX_BLOCK_TEXT_LENGTH = 1_000;

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
  theme: string | null;
  layout: "fluid_engine" | "unknown";
  headings: string[];
  visibleText: string;
  textTruncated: boolean;
  blocks: PageSectionBlock[];
  blocksTruncated: boolean;
}

export interface PageSectionBlock {
  id: string | null;
  type: string | null;
  definitionName?: string | null;
  visibleText: string;
  textTruncated: boolean;
}

export interface PageSeoSettings {
  websiteId: string;
  pageId: string;
  pageName: string;
  pageTitle: string | null;
  slug: string | null;
  isHomepage: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  seoFieldsAvailable: boolean;
  hiddenFromSearchResults: boolean | null;
  socialImageUploadAvailable: boolean;
  socialImagePreviewCount: number;
  source: "squarespace_page_settings";
}

export interface ResponsivePageInspection {
  viewportWidth: number;
  documentWidth: number;
  horizontalOverflow: boolean;
  sections: Array<{
    id: string | null;
    width: number;
    contentWidth: number;
    horizontalOverflow: boolean;
  }>;
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

interface EditorControl {
  index: number;
  text: string;
  ariaLabel: string | null;
  disabled: boolean;
}

interface EditorInspection {
  controls: EditorControl[];
  visibleText: string;
  url: string;
}

interface PageTextSettingUpdateOptions {
  websiteId: string;
  pageId: string;
  fieldName: "Page Title" | "URL Slug";
  value: string;
  screenshotPrefix: string;
  errorCode: "PAGE_UPDATE_FAILED" | "PAGE_URL_UPDATE_FAILED";
  findUpdatedPages: (
    target: SquarespacePage,
    updatedPages: SquarespacePage[],
  ) => SquarespacePage[];
  validateTarget?: (target: SquarespacePage, website: WebsiteSummary) => void;
}

export interface PageSaveAuthorizationExpectation {
  pageId: string;
  action: string;
  targetResource: string;
  payload: Record<string, unknown>;
}

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
    private readonly approval: MutationApprovalGuard,
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer in milliseconds.");
    }
  }

  async listWebsites(): Promise<WebsiteSummary[]> {
    return this.browser.listWebsites();
  }

  private assertMutationAuthorized(input: {
    scope: MutationPermissionScope;
    websiteId: string;
    pageId?: string;
    action: string;
    targetResource: string;
    payload: Record<string, unknown>;
  }): void {
    this.approval.assertAuthorized({
      scope: input.scope,
      provider: "squarespace",
      websiteId: input.websiteId,
      ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
      action: input.action,
      targetResource: input.targetResource,
      payload: input.payload,
    });
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
    this.assertMutationAuthorized({
      scope: "page.create",
      websiteId,
      action: "page.create",
      targetResource: `website:${websiteId}:page-list:${group}`,
      payload: { title: normalizedTitle, pageType, group },
    });

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

  async duplicatePage(
    websiteId: string,
    pageId: string,
  ): Promise<{
    success: true;
    saved: true;
    sourcePageId: string;
    page: SquarespacePage;
    screenshots: { before: string; after: string };
  }> {
    this.assertMutationAuthorized({
      scope: "page.create",
      websiteId,
      pageId,
      action: "page.duplicate",
      targetResource: `page:${pageId}`,
      payload: { pageId },
    });
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
    if (target.type === "folder") {
      throw new SquarespaceBrowserError(
        "PAGE_DUPLICATION_FAILED",
        "Folder duplication is not supported; select a Squarespace page instead.",
      );
    }
    const page = await this.browser.getCurrentPage();
    await this.waitForPagesPanel(page);
    const screenshotId = randomUUID();
    const beforeScreenshot = await this.browser.captureScreenshot(
      `duplicate-page-before-${screenshotId}.png`,
    );
    const afterScreenshotName = `duplicate-page-after-${screenshotId}.png`;
    const expandedFolderKeys: string[] = [];
    let duplicateAttempted = false;
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
      const duplicateButton = dialog.locator('[data-test="duplicate-page"]');
      if ((await duplicateButton.count()) !== 1 || !(await duplicateButton.isEnabled())) {
        throw new SquarespaceBrowserError(
          "PAGE_DUPLICATION_FAILED",
          "The selected page did not expose one enabled Duplicate Page control.",
        );
      }

      duplicateAttempted = true;
      await duplicateButton.click();
      const createdItem = await this.waitForNewPage(page, currentItems);
      await this.restoreCollapsedFolders(page, expandedFolderKeys);
      expandedFolderKeys.length = 0;

      const updatedPages = await this.readWebsitePages(websiteId);
      const matchingPages = updatedPages.filter(
        (candidate) =>
          candidate.type !== "folder" &&
          candidate.groupLabel === createdItem.groupLabel &&
          candidate.navigationTitle === createdItem.name &&
          candidate.parentPath.length === target.parentPath.length &&
          candidate.parentPath.every(
            (segment, index) => segment === target.parentPath[index],
          ),
      );
      if (matchingPages.length !== 1) {
        throw new SquarespaceBrowserError(
          "PAGE_DUPLICATION_FAILED",
          "Squarespace did not confirm one uniquely identifiable duplicate in the Pages panel.",
        );
      }

      afterScreenshotAttempted = true;
      const afterScreenshot = await this.browser.captureScreenshot(afterScreenshotName);
      return {
        success: true,
        saved: true,
        sourcePageId: pageId,
        page: matchingPages[0]!,
        screenshots: { before: beforeScreenshot, after: afterScreenshot },
      };
    } catch (error) {
      if (duplicateAttempted && !afterScreenshotAttempted) {
        afterScreenshotAttempted = true;
        try {
          await this.browser.captureScreenshot(afterScreenshotName);
        } catch (screenshotError) {
          throw new SquarespaceBrowserError(
            "SCREENSHOT_FAILED",
            "Duplication was not confirmed, and the post-operation screenshot also failed.",
            { cause: new AggregateError([error, screenshotError]) },
          );
        }
      }

      if (error instanceof SquarespaceBrowserError) {
        throw error;
      }
      throw new SquarespaceBrowserError(
        "PAGE_DUPLICATION_FAILED",
        "Squarespace did not confirm that the page was duplicated and saved.",
        { cause: error },
      );
    } finally {
      await this.restoreCollapsedFolders(page, expandedFolderKeys);
    }
  }

  async movePage(
    websiteId: string,
    pageId: string,
    destinationGroup: PageCreationGroup,
    destinationFolderId?: string,
  ): Promise<{
    success: true;
    saved: true;
    previousPageId: string;
    page: SquarespacePage;
    screenshots: { before: string; after: string };
  }> {
    this.assertMutationAuthorized({
      scope: "navigation.update",
      websiteId,
      pageId,
      action: "page.move",
      targetResource: `page:${pageId}`,
      payload: {
        pageId,
        destinationGroup,
        destinationFolderId: destinationFolderId ?? null,
      },
    });
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
    if (target.type === "folder") {
      throw new SquarespaceBrowserError(
        "PAGE_MOVE_FAILED",
        "Folder movement is not supported by this tool; select a page instead.",
      );
    }

    const destinationFolder = destinationFolderId
      ? initialPages.find((candidate) => candidate.id === destinationFolderId)
      : undefined;
    if (destinationFolderId && !destinationFolder) {
      throw new SquarespaceBrowserError(
        "PAGE_NOT_FOUND",
        "The destination folder ID was not found. Refresh list_pages and use a returned folder ID.",
      );
    }
    if (destinationFolder && destinationFolder.type !== "folder") {
      throw new SquarespaceBrowserError(
        "PAGE_MOVE_FAILED",
        "The destination_page_id must identify a Squarespace folder.",
      );
    }
    if (destinationFolder && destinationFolder.group !== destinationGroup) {
      throw new SquarespaceBrowserError(
        "PAGE_MOVE_FAILED",
        "The destination folder must belong to the requested navigation group.",
      );
    }

    const destinationParentPath = destinationFolder
      ? [...destinationFolder.parentPath, destinationFolder.navigationTitle]
      : [];
    if (
      target.group === destinationGroup &&
      target.parentPath.length === destinationParentPath.length &&
      target.parentPath.every(
        (segment, index) => segment === destinationParentPath[index],
      )
    ) {
      throw new SquarespaceBrowserError(
        "PAGE_MOVE_FAILED",
        "The page is already in that location. Reordering within the same location is not supported.",
      );
    }
    const page = await this.browser.getCurrentPage();
    await this.waitForPagesPanel(page);
    const screenshotId = randomUUID();
    const beforeScreenshot = await this.browser.captureScreenshot(
      `move-page-before-${screenshotId}.png`,
    );
    const afterScreenshotName = `move-page-after-${screenshotId}.png`;
    const expandedFolderKeys: string[] = [];
    let moveAttempted = false;
    let afterScreenshotAttempted = false;

    try {
      await this.expandCollapsedFolders(page, expandedFolderKeys);
      const currentItems = await this.readPanelItems(page);
      const sourceItem = currentItems[targetIndex];
      const sourceKey = pageItemKeys(currentItems)[targetIndex];
      const expectedSourceKey = JSON.stringify({
        group: target.groupLabel,
        path: [...target.parentPath, target.navigationTitle],
      });
      if (!sourceItem || sourceKey !== expectedSourceKey) {
        throw new SquarespaceBrowserError(
          "PAGE_NOT_FOUND",
          "The selected page no longer matches its ID in the Pages panel. Refresh list_pages and retry.",
        );
      }

      const sourceHandle = page
        .locator(PAGE_ITEM_SELECTOR)
        .nth(targetIndex)
        .locator('[tabindex="0"]')
        .first();
      let destination: ReturnType<Page["locator"]>;
      if (destinationFolder) {
        const folderIndex = initialPages.findIndex(
          (candidate) => candidate.id === destinationFolder.id,
        );
        destination = page
          .locator(PAGE_ITEM_SELECTOR)
          .nth(folderIndex)
          .locator('[tabindex="0"]')
          .first();
      } else {
        const groupLabel = navigationGroupLabel(destinationGroup);
        const headings = page.locator(`${GROUP_SELECTOR} h2`);
        const matchingHeadingIndices = await headings.evaluateAll(
          (elements, expectedLabel) =>
            elements.flatMap((heading, index) =>
              (heading.textContent || "").trim() === expectedLabel ? [index] : [],
            ),
          groupLabel,
        );
        if (matchingHeadingIndices.length !== 1) {
          throw new SquarespaceBrowserError(
            "PAGE_MOVE_FAILED",
            `Squarespace did not expose one unambiguous ${groupLabel} drop target.`,
          );
        }
        destination = headings.nth(matchingHeadingIndices[0]!);
      }
      if ((await sourceHandle.count()) !== 1 || (await destination.count()) !== 1) {
        throw new SquarespaceBrowserError(
          "PAGE_MOVE_FAILED",
          "Squarespace did not expose unambiguous source and destination controls for this move.",
        );
      }

      moveAttempted = true;
      await sourceHandle.dragTo(destination, { steps: 10 });
      const expectedGroupLabel = navigationGroupLabel(destinationGroup);
      const expectedPath = [...destinationParentPath, sourceItem.name];
      await this.waitForPageAtPath(
        page,
        expectedGroupLabel,
        expectedPath,
        target.groupLabel,
        [...target.parentPath, sourceItem.name],
      );

      await this.restoreCollapsedFolders(page, expandedFolderKeys);
      expandedFolderKeys.length = 0;
      const updatedPages = await this.readWebsitePages(websiteId);
      const matchingPages = updatedPages.filter(
        (candidate) =>
          candidate.type !== "folder" &&
          candidate.groupLabel === expectedGroupLabel &&
          candidate.navigationTitle === sourceItem.name &&
          candidate.parentPath.length === destinationParentPath.length &&
          candidate.parentPath.every(
            (segment, index) => segment === destinationParentPath[index],
          ),
      );
      if (
        matchingPages.length !== 1 ||
        updatedPages.some((candidate) => candidate.id === pageId)
      ) {
        throw new SquarespaceBrowserError(
          "PAGE_MOVE_FAILED",
          "Squarespace did not confirm that the original page was moved to one unique destination.",
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
      if (moveAttempted && !afterScreenshotAttempted) {
        afterScreenshotAttempted = true;
        try {
          await this.browser.captureScreenshot(afterScreenshotName);
        } catch (screenshotError) {
          throw new SquarespaceBrowserError(
            "SCREENSHOT_FAILED",
            "The move was not confirmed, and the post-operation screenshot also failed.",
            { cause: new AggregateError([error, screenshotError]) },
          );
        }
      }

      if (error instanceof SquarespaceBrowserError) {
        throw error;
      }
      throw new SquarespaceBrowserError(
        "PAGE_MOVE_FAILED",
        "Squarespace did not confirm that the page was moved and saved.",
        { cause: error },
      );
    } finally {
      await this.restoreCollapsedFolders(page, expandedFolderKeys);
    }
  }

  async deletePage(
    websiteId: string,
    pageId: string,
    confirmation: "DELETE",
  ): Promise<{
    success: true;
    saved: true;
    deletedPageId: string;
    screenshots: { before: string; after: string };
  }> {
    if (confirmation !== "DELETE") {
      throw new SquarespaceBrowserError(
        "CONFIRMATION_REQUIRED",
        "Deleting a page requires the explicit DELETE confirmation.",
      );
    }

    this.assertMutationAuthorized({
      scope: "page.delete",
      websiteId,
      pageId,
      action: "page.delete",
      targetResource: `page:${pageId}`,
      payload: { pageId },
    });
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
    if (target.type === "folder") {
      throw new SquarespaceBrowserError(
        "PAGE_DELETE_FAILED",
        "Deleting folders is not supported because it may also remove nested pages.",
      );
    }
    if (target.url && new URL(target.url).pathname === "/") {
      throw new SquarespaceBrowserError(
        "PAGE_DELETE_FAILED",
        "The Squarespace homepage cannot be deleted while it is assigned as the homepage.",
      );
    }
    const page = await this.browser.getCurrentPage();
    await this.waitForPagesPanel(page);
    const screenshotId = randomUUID();
    const beforeScreenshot = await this.browser.captureScreenshot(
      `delete-page-before-${screenshotId}.png`,
    );
    const afterScreenshotName = `delete-page-after-${screenshotId}.png`;
    const expandedFolderKeys: string[] = [];
    let deleteAttempted = false;
    let afterScreenshotAttempted = false;

    try {
      await this.expandCollapsedFolders(page, expandedFolderKeys);
      const currentItems = await this.readPanelItems(page);
      const currentKeys = pageItemKeys(currentItems);
      const targetKey = currentKeys[targetIndex];
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
      if (currentKeys.filter((key) => key === targetKey).length !== 1) {
        throw new SquarespaceBrowserError(
          "PAGE_DELETE_FAILED",
          "The selected page is indistinguishable from another Pages-panel item; deletion was not attempted.",
        );
      }

      const row = page.locator(PAGE_ITEM_SELECTOR).nth(targetIndex);
      const deleteButton = row.locator('button[data-test="delete-item"]');
      if ((await deleteButton.count()) !== 1 || !(await deleteButton.isEnabled())) {
        throw new SquarespaceBrowserError(
          "PAGE_DELETE_FAILED",
          "The selected page did not expose one enabled observed Delete Page control.",
        );
      }

      deleteAttempted = true;
      page.once("dialog", async (dialog) => {
        if (dialog.type() === "confirm") {
          await dialog.accept();
        } else {
          await dialog.dismiss();
        }
      });
      await deleteButton.click();

      const confirmationDialog = page.getByRole("dialog").last();
      const dialogAppeared = await confirmationDialog
        .waitFor({ state: "visible", timeout: Math.min(2_000, this.timeoutMs) })
        .then(() => true)
        .catch(() => false);
      if (dialogAppeared) {
        const confirmButton = confirmationDialog.getByRole("button", {
          name: "Delete",
          exact: true,
        });
        if ((await confirmButton.count()) !== 1 || !(await confirmButton.isEnabled())) {
          throw new SquarespaceBrowserError(
            "PAGE_DELETE_FAILED",
            "Squarespace opened a delete confirmation that did not expose one unambiguous enabled Delete button.",
          );
        }
        await confirmButton.click();
        await confirmationDialog.waitFor({ state: "hidden", timeout: this.timeoutMs });
      }

      await this.waitForDeletedPage(page, targetKey);
      const updatedPages = await this.readWebsitePages(websiteId);
      if (updatedPages.some((candidate) => candidate.id === pageId)) {
        throw new SquarespaceBrowserError(
          "PAGE_DELETE_FAILED",
          "Squarespace did not confirm that the selected page was removed from the Pages panel.",
        );
      }

      afterScreenshotAttempted = true;
      const afterScreenshot = await this.browser.captureScreenshot(afterScreenshotName);
      return {
        success: true,
        saved: true,
        deletedPageId: pageId,
        screenshots: { before: beforeScreenshot, after: afterScreenshot },
      };
    } catch (error) {
      if (deleteAttempted && !afterScreenshotAttempted) {
        afterScreenshotAttempted = true;
        try {
          await this.browser.captureScreenshot(afterScreenshotName);
        } catch (screenshotError) {
          throw new SquarespaceBrowserError(
            "SCREENSHOT_FAILED",
            "Deletion was not confirmed, and the post-operation screenshot also failed.",
            { cause: new AggregateError([error, screenshotError]) },
          );
        }
      }

      if (error instanceof SquarespaceBrowserError) {
        throw error;
      }
      throw new SquarespaceBrowserError(
        "PAGE_DELETE_FAILED",
        "Squarespace did not confirm that the page was deleted.",
        { cause: error },
      );
    } finally {
      await this.restoreCollapsedFolders(page, expandedFolderKeys);
    }
  }

  async savePageChanges(
    websiteId: string,
    publish = false,
    confirmation?: "PUBLISH",
    execution?: BrowserExecutionContext,
    authorization?: PageSaveAuthorizationExpectation,
  ): Promise<{
    success: true;
    saved: true;
    published: boolean;
    action: "saved" | "published" | "already_saved";
    screenshots: { before: string; after: string };
    inspection: { before: EditorInspection; after: EditorInspection };
  }> {
    if (!authorization) {
      throw new MutationApprovalError(
        "unavailable",
        "A proposal-specific approval is required at the page save boundary.",
      );
    }
    this.assertMutationAuthorized({
      scope: publish ? "content.publish" : "content.save",
      websiteId,
      pageId: authorization.pageId,
      action: authorization.action,
      targetResource: authorization.targetResource,
      payload: authorization.payload,
    });
    const website = this.browser.getWebsite(websiteId);
    const page = await this.browser.getCurrentPage();
    this.assertCurrentPageBelongsToWebsite(page, website);
    if (publish && confirmation !== "PUBLISH") {
      throw new SquarespaceBrowserError(
        "CONFIRMATION_REQUIRED",
        "Publishing changes requires the explicit PUBLISH confirmation.",
      );
    }

    const screenshotId = randomUUID();
    execution?.recordDomInspection();
    const beforeInspection = await this.inspectEditor(page);
    const beforeScreenshot = await this.browser.captureScreenshot(
      `save-page-changes-before-${screenshotId}.png`,
    );
    execution?.recordScreenshot();
    const afterScreenshotName = `save-page-changes-after-${screenshotId}.png`;
    let actionAttempted = false;
    let afterScreenshotAttempted = false;

    try {
      if (publish) {
        const publishControl = findOneEditorControl(beforeInspection, /^publish$/i);
        if (!publishControl) {
          throw new SquarespaceBrowserError(
            "PAGE_SAVE_FAILED",
            "The editor did not expose one enabled visible Publish control.",
          );
        }

        execution?.beforeBrowserAction();
        actionAttempted = true;
        execution?.markMutationStarted();
        const publishClick = page.locator(EDITOR_ACTION_SELECTOR).nth(publishControl.index).click({
          timeout: Math.max(1, Math.min(this.timeoutMs, execution?.remainingMs ?? this.timeoutMs)),
        });
        if (execution) await awaitPlaywrightOperation(publishClick, execution);
        else await publishClick;
        await this.confirmPublishIfPrompted(page);
        await this.waitForEditorConfirmation(page, "published");
      } else {
        const saveControl = findOneEditorControl(beforeInspection, /^(save|save changes|done)$/i);
        if (!saveControl) {
          if (hasEditorConfirmation(beforeInspection, "saved")) {
            afterScreenshotAttempted = true;
            const afterScreenshot = await this.browser.captureScreenshot(afterScreenshotName);
            execution?.recordScreenshot();
            execution?.recordDomInspection();
            const afterInspection = await this.inspectEditor(page);
            return {
              success: true,
              saved: true,
              published: false,
              action: "already_saved",
              screenshots: { before: beforeScreenshot, after: afterScreenshot },
              inspection: { before: beforeInspection, after: afterInspection },
            };
          }
          throw new SquarespaceBrowserError(
            "PAGE_SAVE_FAILED",
            "The editor did not expose one enabled visible Save or Done control, and no saved confirmation was visible.",
          );
        }

        execution?.beforeBrowserAction();
        actionAttempted = true;
        execution?.markMutationStarted();
        const saveClick = page.locator(EDITOR_ACTION_SELECTOR).nth(saveControl.index).click({
          timeout: Math.max(1, Math.min(this.timeoutMs, execution?.remainingMs ?? this.timeoutMs)),
        });
        if (execution) await awaitPlaywrightOperation(saveClick, execution);
        else await saveClick;
        await this.waitForEditorConfirmation(page, "saved", execution);
      }

      execution?.recordDomInspection();
      const afterInspection = await this.inspectEditor(page);
      if (!hasEditorConfirmation(afterInspection, publish ? "published" : "saved")) {
        throw new SquarespaceBrowserError(
          "PAGE_SAVE_FAILED",
          "Squarespace did not expose a visible confirmation that the changes were saved.",
        );
      }

      afterScreenshotAttempted = true;
      const afterScreenshot = await this.browser.captureScreenshot(afterScreenshotName);
      execution?.recordScreenshot();
      return {
        success: true,
        saved: true,
        published: publish,
        action: publish ? "published" : "saved",
        screenshots: { before: beforeScreenshot, after: afterScreenshot },
        inspection: { before: beforeInspection, after: afterInspection },
      };
    } catch (error) {
      if (error instanceof ExecutionStoppedError) {
        throw actionAttempted && !error.mutationOutcomeUncertain
          ? new ExecutionStoppedError(error.reason, true)
          : error;
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ExecutionStoppedError("browser_operation_timeout", actionAttempted);
      }
      if (actionAttempted && !afterScreenshotAttempted) {
        afterScreenshotAttempted = true;
        try {
          await this.browser.captureScreenshot(afterScreenshotName);
          execution?.recordScreenshot();
        } catch (screenshotError) {
          throw new SquarespaceBrowserError(
            "SCREENSHOT_FAILED",
            "Saving was not confirmed, and the post-operation screenshot also failed.",
            { cause: new AggregateError([error, screenshotError]) },
          );
        }
      }

      if (error instanceof SquarespaceBrowserError) {
        throw error;
      }
      throw new SquarespaceBrowserError(
        "PAGE_SAVE_FAILED",
        "Squarespace did not confirm that the page changes were saved.",
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
    this.assertMutationAuthorized({
      scope: "page.update",
      websiteId,
      pageId,
      action: "page.update_title",
      targetResource: `page:${pageId}:settings`,
      payload: { pageId, field: "Page Title", value: normalizedTitle },
    });

    return this.updatePageTextSetting({
      websiteId,
      pageId,
      fieldName: "Page Title",
      value: normalizedTitle,
      screenshotPrefix: "update-page-title",
      errorCode: "PAGE_UPDATE_FAILED",
      findUpdatedPages: (target, updatedPages) =>
        updatedPages.filter(
          (candidate) =>
            candidate.name === normalizedTitle &&
            candidate.groupLabel === target.groupLabel &&
            candidate.parentPath.length === target.parentPath.length &&
            candidate.parentPath.every(
              (segment, index) => segment === target.parentPath[index],
            ),
        ),
    });
  }

  async updatePageUrl(
    websiteId: string,
    pageId: string,
    urlSlug: string,
  ): Promise<{
    success: true;
    saved: true;
    previousPageId: string;
    page: SquarespacePage;
    screenshots: { before: string; after: string };
  }> {
    const trimmedSlug = urlSlug.trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(trimmedSlug)) {
      throw new SquarespaceBrowserError(
        "PAGE_URL_UPDATE_FAILED",
        "URL slugs must be a single path segment containing letters, numbers, underscores, or hyphens.",
      );
    }
    const normalizedSlug = trimmedSlug.toLowerCase();
    this.assertMutationAuthorized({
      scope: "page.update",
      websiteId,
      pageId,
      action: "page.update_url",
      targetResource: `page:${pageId}:settings`,
      payload: { pageId, field: "URL Slug", value: normalizedSlug },
    });

    return this.updatePageTextSetting({
      websiteId,
      pageId,
      fieldName: "URL Slug",
      value: normalizedSlug,
      screenshotPrefix: "update-page-url",
      errorCode: "PAGE_URL_UPDATE_FAILED",
      validateTarget: (target, website) => {
        if (!target.url || new URL(target.url).pathname === "/") {
          throw new SquarespaceBrowserError(
            "PAGE_URL_UPDATE_FAILED",
            "Squarespace's homepage has a fixed root URL, or this page does not expose a changeable URL slug.",
          );
        }
        const websiteOrigin = new URL(website.url).origin;
        if (new URL(target.url).origin !== websiteOrigin) {
          throw new SquarespaceBrowserError(
            "INVALID_URL",
            "The selected page URL does not belong to the requested Squarespace website.",
          );
        }
      },
      findUpdatedPages: (target, updatedPages) => {
        const expectedUrl = new URL(
          `/${normalizedSlug}`,
          new URL(this.browser.getWebsite(websiteId).url).origin,
        ).toString();
        return updatedPages.filter(
          (candidate) => candidate.id === target.id && candidate.url === expectedUrl,
        );
      },
    });
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

  async inspectPageSeoSettings(
    websiteId: string,
    pageId: string,
  ): Promise<PageSeoSettings> {
    const target = await this.getPageDetails(websiteId, pageId);
    if (target.type === "folder") {
      throw new SquarespaceBrowserError(
        "PAGE_SETTINGS_FAILED",
        "SEO settings are only available for pages, not navigation folders.",
      );
    }

    const initialPages = await this.readWebsitePages(websiteId);
    const targetIndex = initialPages.findIndex((candidate) => candidate.id === pageId);
    if (targetIndex < 0) {
      throw new SquarespaceBrowserError(
        "PAGE_NOT_FOUND",
        "The requested page was not found on this website. Refresh list_pages and use a returned page ID.",
      );
    }

    this.browser.getWebsite(websiteId);
    await this.browser.openWebsitePages(websiteId);
    const page = await this.browser.getCurrentPage();
    await this.waitForPagesPanel(page);
    const expandedFolderKeys: string[] = [];

    try {
      await this.expandCollapsedFolders(page, expandedFolderKeys);
      const items = await this.readPanelItems(page);
      if (targetIndex >= items.length) {
        throw new SquarespaceBrowserError(
          "PAGE_SETTINGS_FAILED",
          "The selected page could not be matched to its visible Pages panel row.",
        );
      }

      const row = page.locator(PAGE_ITEM_SELECTOR).nth(targetIndex);
      const settingsButton = row.locator('button[aria-label^="Page settings "]');
      if (await settingsButton.count() !== 1) {
        throw new SquarespaceBrowserError(
          "PAGE_SETTINGS_FAILED",
          "The selected page did not expose one unambiguous Page Settings control.",
        );
      }
      await settingsButton.click();
      const dialog = page.locator('[role="dialog"]').last();
      await dialog.waitFor({ state: "visible", timeout: this.timeoutMs });

      const pageTitle = await readTextbox(dialog, "Page Title");
      const slug = await readTextbox(dialog, "URL Slug");
      const seoTab = dialog.locator('input[aria-label="SEO"]');
      if (await seoTab.count() !== 1) {
        throw new SquarespaceBrowserError(
          "SEO_SETTINGS_NOT_AVAILABLE",
          "Squarespace did not expose one unambiguous SEO tab for this page.",
        );
      }
      await seoTab.evaluate((element) => (element as HTMLInputElement).click());
      await waitForExecutionDelay(100);

      const seoTitleField = dialog.locator('textarea[aria-label="SEO Title (Optional)"]');
      const seoDescriptionField = dialog.locator(
        'textarea[aria-label="SEO Description (Optional)"]',
      );
      const indexingCheckbox = dialog.locator(
        'input[aria-label="Hide Page from Search Results"]',
      );
      const seoTitleCount = await seoTitleField.count();
      const seoDescriptionCount = await seoDescriptionField.count();
      const indexingCount = await indexingCheckbox.count();
      if (seoTitleCount > 1 || seoDescriptionCount > 1 || indexingCount > 1) {
        throw new SquarespaceBrowserError(
          "SEO_SETTINGS_NOT_AVAILABLE",
          "Squarespace exposed ambiguous SEO controls; the service did not choose between them.",
        );
      }

      const seoTitle = seoTitleCount === 1
        ? await seoTitleField.inputValue()
        : null;
      const seoDescription = seoDescriptionCount === 1
        ? await seoDescriptionField.inputValue()
        : null;
      const hiddenFromSearchResults = indexingCount === 1
        ? await indexingCheckbox.isChecked()
        : null;
      const seoFieldsAvailable = seoTitleCount === 1 && seoDescriptionCount === 1;

      const socialImageTab = dialog.locator('input[aria-label="Social Image"]');
      if (await socialImageTab.count() !== 1) {
        throw new SquarespaceBrowserError(
          "SEO_SETTINGS_NOT_AVAILABLE",
          "Squarespace did not expose the observed Social Image tab for this page.",
        );
      }
      await socialImageTab.evaluate((element) => (element as HTMLInputElement).click());
      await waitForExecutionDelay(100);
      const socialImageUploadAvailable =
        (await dialog.locator('input[type="file"]').count()) > 0;
      const socialImagePreviewCount = await dialog.locator("img").evaluateAll(
        (images) => images.filter((image) => {
          const style = window.getComputedStyle(image);
          const rect = image.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;
        }).length,
      );

      return {
        websiteId,
        pageId,
        pageName: target.name,
        pageTitle,
        slug,
        isHomepage: target.url !== null && new URL(target.url).pathname === "/",
        seoTitle,
        seoDescription,
        seoFieldsAvailable,
        hiddenFromSearchResults,
        socialImageUploadAvailable,
        socialImagePreviewCount,
        source: "squarespace_page_settings",
      };
    } finally {
      const dialog = page.locator('[role="dialog"]').last();
      if (await dialog.isVisible().catch(() => false)) {
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "hidden", timeout: this.timeoutMs });
      }
      await this.restoreCollapsedFolders(page, expandedFolderKeys);
    }
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
        limits: {
          blockSelector: string;
          maxTextLength: number;
          maxSections: number;
          maxBlocksPerSection: number;
          maxBlockTextLength: number;
        },
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
          const allBlocks = Array.from(
            section.querySelectorAll<HTMLElement>(limits.blockSelector),
          );
          return {
            id: section.getAttribute("data-section-id"),
            theme: section.getAttribute("data-section-theme"),
            layout: section.hasAttribute("data-fluid-engine-section")
              ? "fluid_engine" as const
              : "unknown" as const,
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
            blocks: allBlocks.slice(0, limits.maxBlocksPerSection).map((block) => {
              const blockText = visible ? (block.innerText || "").trim() : "";
              return {
                id: block.getAttribute("id"),
                type: block.getAttribute("data-block-type"),
                definitionName: block.getAttribute("data-definition-name"),
                visibleText: blockText.slice(0, limits.maxBlockTextLength),
                textTruncated: blockText.length > limits.maxBlockTextLength,
              };
            }),
            blocksTruncated: allBlocks.length > limits.maxBlocksPerSection,
          };
        }),
      }),
      {
        blockSelector: SQUARESPACE_CONTENT_BLOCK_SELECTOR,
        maxTextLength: MAX_SECTION_TEXT_LENGTH,
        maxSections: MAX_SECTIONS,
        maxBlocksPerSection: MAX_BLOCKS_PER_SECTION,
        maxBlockTextLength: MAX_BLOCK_TEXT_LENGTH,
      },
    );

    return {
      websiteId,
      pageId,
      url: targetUrl.toString(),
      sections: sectionResult.sections,
      sectionsTruncated: sectionResult.totalCount > sectionResult.sections.length,
    };
  }

  async listPageSections(
    websiteId: string,
    pageId: string,
  ): Promise<Awaited<ReturnType<SquarespacePagesService["inspectPageSections"]>>> {
    return this.inspectPageSections(websiteId, pageId);
  }

  async inspectSection(
    websiteId: string,
    pageId: string,
    sectionId: string,
  ): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    section: PageSection;
  }> {
    const normalizedSectionId = sectionId.trim();
    if (!normalizedSectionId) {
      throw new SquarespaceBrowserError(
        "SECTION_NOT_FOUND",
        "A non-empty section ID is required.",
      );
    }
    const result = await this.inspectPageSections(websiteId, pageId);
    const section = result.sections.find((candidate) => candidate.id === normalizedSectionId);
    if (!section) {
      throw new SquarespaceBrowserError(
        "SECTION_NOT_FOUND",
        "The requested section was not found on this page. Refresh list_page_sections and use a returned section ID.",
      );
    }
    return {
      websiteId: result.websiteId,
      pageId: result.pageId,
      url: result.url,
      section,
    };
  }

  async inspectMobileResponsive(
    websiteId: string,
    pageId: string,
  ): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    desktop: ResponsivePageInspection;
    mobile: ResponsivePageInspection;
    mobileViewport: { width: number; height: number };
  }> {
    const pageRecord = await this.getPageDetails(websiteId, pageId);
    if (!pageRecord.url || pageRecord.type === "folder") {
      throw new SquarespaceBrowserError(
        "SECTIONS_NOT_AVAILABLE",
        "Responsive inspection requires a page with a Squarespace URL.",
      );
    }

    const targetUrl = assertAllowedSquarespaceUrl(pageRecord.url);
    const website = this.browser.getWebsite(websiteId);
    if (targetUrl.origin !== new URL(website.url).origin) {
      throw new SquarespaceBrowserError(
        "INVALID_URL",
        "Responsive inspection is restricted to the selected Squarespace website.",
      );
    }

    await this.browser.openWebsiteUrl(websiteId, targetUrl.toString());
    const page = await this.browser.getCurrentPage();
    const frame = await this.waitForPageFrame(page, targetUrl);
    const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const mobileViewport = { width: 390, height: 844 };
    const desktop = await this.inspectResponsiveFrame(frame);
    let mobile: ResponsivePageInspection;
    try {
      await page.setViewportSize(mobileViewport);
      await waitForExecutionDelay(100);
      mobile = await this.inspectResponsiveFrame(frame);
    } finally {
      await page.setViewportSize(originalViewport);
    }

    return {
      websiteId,
      pageId,
      url: targetUrl.toString(),
      desktop,
      mobile,
      mobileViewport,
    };
  }

  private async updatePageTextSetting(
    options: PageTextSettingUpdateOptions,
  ): Promise<{
    success: true;
    saved: true;
    previousPageId: string;
    page: SquarespacePage;
    screenshots: { before: string; after: string };
  }> {
    const website = this.browser.getWebsite(options.websiteId);
    const initialPages = await this.readWebsitePages(options.websiteId);
    const targetIndex = initialPages.findIndex((candidate) => candidate.id === options.pageId);
    const target = initialPages[targetIndex];
    if (!target) {
      throw new SquarespaceBrowserError(
        "PAGE_NOT_FOUND",
        "The requested page ID was not found on this website. Refresh list_pages and use a returned page ID.",
      );
    }
    options.validateTarget?.(target, website);

    const page = await this.browser.getCurrentPage();
    await this.waitForPagesPanel(page);
    const screenshotId = randomUUID();
    const beforeScreenshot = await this.browser.captureScreenshot(
      `${options.screenshotPrefix}-before-${screenshotId}.png`,
    );
    const afterScreenshotName = `${options.screenshotPrefix}-after-${screenshotId}.png`;
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
      const field = dialog.getByRole("textbox", { name: options.fieldName });
      if ((await field.count()) !== 1) {
        throw new SquarespaceBrowserError(
          options.errorCode,
          `The selected page did not expose the observed ${options.fieldName} field.`,
        );
      }

      updateAttempted = true;
      await field.fill(options.value);
      await field.press("Tab");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden", timeout: this.timeoutMs });

      const savedSettings = await this.readPageSettings(page, row, target.type);
      const savedValue = options.fieldName === "Page Title"
        ? savedSettings.pageTitle
        : savedSettings.slug;
      if (savedValue !== options.value) {
        throw new SquarespaceBrowserError(
          options.errorCode,
          `Squarespace did not confirm that the requested ${options.fieldName} was saved.`,
        );
      }

      await this.restoreCollapsedFolders(page, expandedFolderKeys);
      expandedFolderKeys.length = 0;

      const updatedPages = await this.readWebsitePages(options.websiteId);
      const matchingPages = options.findUpdatedPages(target, updatedPages);
      if (matchingPages.length !== 1) {
        throw new SquarespaceBrowserError(
          options.errorCode,
          `Squarespace settings showed the new ${options.fieldName}, but the updated page could not be identified unambiguously in the Pages panel.`,
        );
      }

      afterScreenshotAttempted = true;
      const afterScreenshot = await this.browser.captureScreenshot(afterScreenshotName);
      return {
        success: true,
        saved: true,
        previousPageId: options.pageId,
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
            `The ${options.fieldName} update was not confirmed, and the post-operation screenshot also failed.`,
            { cause: new AggregateError([error, screenshotError]) },
          );
        }
      }

      if (error instanceof SquarespaceBrowserError) {
        throw error;
      }
      throw new SquarespaceBrowserError(
        options.errorCode,
        `Squarespace did not confirm that the requested ${options.fieldName} was updated and saved.`,
        { cause: error },
      );
    } finally {
      await this.restoreCollapsedFolders(page, expandedFolderKeys);
    }
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

  private assertCurrentPageBelongsToWebsite(page: Page, website: WebsiteSummary): void {
    const currentUrl = page.url();
    if (currentUrl === "about:blank") {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch (error) {
      throw new SquarespaceBrowserError(
        "INVALID_URL",
        "The current editor URL could not be verified before saving.",
        { cause: error },
      );
    }
    if (parsed.origin !== new URL(website.url).origin) {
      throw new SquarespaceBrowserError(
        "INVALID_URL",
        "The current editor does not belong to the selected Squarespace website.",
      );
    }
  }

  private async inspectEditor(page: Page): Promise<EditorInspection> {
    return page.evaluate<EditorInspection, void>(
      `(() => {
        const selector = ${JSON.stringify(EDITOR_ACTION_SELECTOR)};
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const controls = Array.from(document.querySelectorAll(selector))
          .map((element, index) => {
            const disabled =
              element.hasAttribute("disabled") ||
              element.getAttribute("aria-disabled") === "true" ||
              (element instanceof HTMLButtonElement && element.disabled);
            return {
              index,
              text: (element.innerText || element.textContent || "").trim(),
              ariaLabel: element.getAttribute("aria-label"),
              disabled,
              visible: isVisible(element),
            };
          })
          .filter((control) => control.visible)
          .map(({ visible: _visible, ...control }) => control);
        return {
          controls,
          visibleText: (document.body?.innerText || "").slice(0, 20_000),
          url: window.location.href,
        };
      })()`,
      undefined,
    );
  }

  private async confirmPublishIfPrompted(page: Page): Promise<void> {
    const dialog = page.getByRole("dialog").last();
    const dialogAppeared = await dialog
      .waitFor({ state: "visible", timeout: Math.min(2_000, this.timeoutMs) })
      .then(() => true)
      .catch(() => false);
    if (!dialogAppeared) {
      return;
    }
    const publishButton = dialog.getByRole("button", { name: "Publish", exact: true });
    if ((await publishButton.count()) !== 1 || !(await publishButton.isEnabled())) {
      throw new SquarespaceBrowserError(
        "PAGE_SAVE_FAILED",
        "Squarespace opened a publish confirmation without one unambiguous enabled Publish button.",
      );
    }
    await publishButton.click();
    await dialog.waitFor({ state: "hidden", timeout: this.timeoutMs });
  }

  private async waitForEditorConfirmation(
    page: Page,
    expected: "saved" | "published",
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    const startedAt = Date.now();
    const deadline = Date.now() + Math.min(this.timeoutMs, execution?.remainingMs ?? this.timeoutMs);
    try {
      while (Date.now() < deadline) {
        execution?.checkpoint();
        execution?.recordDomInspection();
        if (hasEditorConfirmation(await this.inspectEditor(page), expected)) {
          return;
        }
        await waitForExecutionDelay(150, execution);
      }

      execution?.checkpoint();
      if (execution) {
        throw new ExecutionStoppedError("browser_operation_timeout", expected === "saved");
      }
      throw new SquarespaceBrowserError(
        "PAGE_SAVE_FAILED",
        `Squarespace did not confirm that the changes were ${expected} before the operation timed out.`,
      );
    } finally {
      execution?.recordExplicitWait(Date.now() - startedAt);
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
      await this.waitForLocator(page.locator(PAGES_PANEL_SELECTOR), "visible");
      await this.waitForLocator(page.locator(`${GROUP_SELECTOR} h2`).first(), "visible");
    } catch (error) {
      if (error instanceof ExecutionStoppedError) throw error;
      throw new SquarespaceBrowserError(
        "PAGES_PANEL_NOT_FOUND",
        "The Squarespace Pages panel did not finish loading. Confirm that the selected website is accessible and retry.",
        { cause: error },
      );
    }
  }

  private async waitForLocator(
    locator: Locator,
    state: "visible" | "attached",
  ): Promise<void> {
    await waitForLocatorState(
      locator,
      state,
      this.timeoutMs,
      currentBrowserExecutionContext(),
    );
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
    groupLabel?: string,
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
          return (groupLabel === undefined || item.groupLabel === groupLabel) &&
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

  private async waitForPageAtPath(
    page: Page,
    destinationGroup: string,
    destinationPath: string[],
    sourceGroup: string,
    sourcePath: string[],
  ): Promise<void> {
    const destinationKey = JSON.stringify({
      group: destinationGroup,
      path: destinationPath,
    });
    const sourceKey = JSON.stringify({ group: sourceGroup, path: sourcePath });
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const currentKeys = pageItemKeys(await this.readPanelItems(page));
      const destinationCount = currentKeys.filter((key) => key === destinationKey).length;
      const sourceCount = currentKeys.filter((key) => key === sourceKey).length;
      if (destinationCount > 1) {
        throw new SquarespaceBrowserError(
          "PAGE_MOVE_FAILED",
          "The destination already contains an indistinguishable page; the move cannot be verified safely.",
        );
      }
      if (destinationCount === 1 && sourceCount === 0) {
        return;
      }
      await delay(150);
    }

    throw new SquarespaceBrowserError(
      "PAGE_MOVE_FAILED",
      "The page did not appear at the requested destination before the operation timed out.",
    );
  }

  private async waitForDeletedPage(page: Page, expectedKey: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const currentKeys = pageItemKeys(await this.readPanelItems(page));
      if (!currentKeys.includes(expectedKey)) {
        return;
      }
      await delay(150);
    }

    throw new SquarespaceBrowserError(
      "PAGE_DELETE_FAILED",
      "The deleted page remained in the Pages panel after the operation timed out.",
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

  private async inspectResponsiveFrame(
    frame: Frame,
  ): Promise<ResponsivePageInspection> {
    return frame.evaluate((options) => {
      const documentWidth = document.documentElement.scrollWidth;
      const viewportWidth = window.innerWidth;
      const sections = Array.from(
        document.querySelectorAll<HTMLElement>(options.selector),
      ).slice(0, options.maxSections).map((section) => ({
        id: section.getAttribute("data-section-id"),
        width: Math.round(section.getBoundingClientRect().width),
        contentWidth: section.scrollWidth,
        horizontalOverflow: section.scrollWidth > section.clientWidth + 1,
      }));
      return {
        viewportWidth,
        documentWidth,
        horizontalOverflow: documentWidth > viewportWidth + 1 ||
          sections.some((section) => section.horizontalOverflow),
        sections,
      };
    }, { selector: SECTION_SELECTOR, maxSections: MAX_SECTIONS });
  }

  private async waitForPageFrame(page: Page, targetUrl: URL): Promise<Frame> {
    const targetPath = normalizePath(targetUrl.pathname);
    const execution = currentBrowserExecutionContext();
    const deadline = Math.min(
      Date.now() + this.timeoutMs,
      execution?.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    let matchingFrame: Frame | undefined;

    while (Date.now() < deadline) {
      execution?.checkpoint();
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
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }

    execution?.checkpoint();
    if (execution) throw new ExecutionStoppedError("browser_operation_timeout");
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

function findOneEditorControl(
  inspection: EditorInspection,
  pattern: RegExp,
): EditorControl | null {
  const matches = inspection.controls.filter((control) => {
    if (control.disabled) {
      return false;
    }
    const label = normalizeEditorText(control.ariaLabel || control.text);
    return pattern.test(label);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function hasEditorConfirmation(
  inspection: EditorInspection,
  expected: "saved" | "published",
): boolean {
  const haystack = normalizeEditorText(
    [
      inspection.visibleText,
      ...inspection.controls.map((control) => `${control.text} ${control.ariaLabel ?? ""}`),
    ].join(" "),
  );
  if (expected === "published") {
    return /\b(published|site published|changes published)\b/i.test(haystack);
  }
  return /\b(saved|all changes saved|changes saved|saved successfully)\b/i.test(haystack);
}

function normalizeEditorText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
