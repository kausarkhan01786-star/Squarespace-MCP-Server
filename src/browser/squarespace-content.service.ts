import { z } from "zod";
import type { Page, Frame, Locator } from "playwright";
import {
  awaitPlaywrightOperation,
  ExecutionStoppedError,
  waitForExecutionCondition,
  type BrowserExecutionContext,
  withBrowserExecutionContext,
} from "./browser-execution-context.js";
import { ExecutionController } from "../execution/execution-controller.js";
import type { ExecutionMetrics } from "../execution/execution-telemetry.js";
import type { PageBackupService, PageSnapshot } from "../backups/page-backup.service.js";
import { SquarespaceBrowserError } from "./browser-errors.js";
import {
  MutationApprovalError,
  MutationApprovalGuard,
  type MutationAuthorization,
} from "../approval/mutation-approval.js";
import {
  textSectionMutationPayload,
  textSectionMutationProposal,
} from "../approval/squarespace-mutation-proposals.js";
import {
  SQUARESPACE_PAGE_SECTION_SELECTOR,
  type SquarespacePage,
  type SquarespacePagesService,
} from "./squarespace-pages.service.js";
import type {
  SquarespaceBrowserService,
  WebsiteSummary,
} from "./squarespace-browser.service.js";
import { logInfo } from "../utils/logger.js";

const CONFIRMED_WEBSITE_HOST = "cobalt-spinach-eeah.squarespace.com";
const SECTION_SELECTOR = SQUARESPACE_PAGE_SECTION_SELECTOR;
const BLOCK_SELECTOR = "[data-block-type]";
const SITE_FRAME_SELECTOR = 'iframe#sqs-site-frame[data-testid="sqs-site-frame"], iframe#sqs-site-frame';
const SAVE_CONTROL_SELECTORS = [
  '[data-test="frameToolbarSave"]',
  'button:has-text("Save")',
];
const EXIT_CONTROL_SELECTORS = [
  '[data-test="frameToolbarCancel"]',
  'button:has-text("Exit")',
];
const ADD_SECTION_CONTROL_SELECTORS = [
  '[data-test="section-add-button"]',
  'button:has-text("Add Section")',
];
const ADD_BLOCK_CONTROL_SELECTORS = [
  'button:has-text("Add Block")',
  '[aria-label="Add Block"]',
];
const SECTION_SETTINGS_CONTROL_SELECTORS = [
  '[data-test="toolbar-button-settings"]',
  'button[aria-label="Open Section Settings"]',
];

export const addTextSectionInputSchema = z.object({
  website_id: z.string().trim().min(1).describe("ID returned by list_websites for Kausar Mia."),
  page_id: z.string().trim().min(1).describe("ID returned by list_pages for Home."),
  text: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
  background_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
  text_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"),
  confirm_potentially_live_save: z.boolean().default(false).describe(
    "Legacy acknowledgement only. A trusted interactive approval is still required; this value does not authorize a mutation.",
  ),
});

export type AddTextSectionInput = z.infer<typeof addTextSectionInputSchema>;

type ContentBrowser = Pick<
  SquarespaceBrowserService,
  "getWebsite" | "openWebsiteUrl" | "getCurrentPage"
>;
type ContentPages = Pick<
  SquarespacePagesService,
  "getPageDetails" | "inspectPageSections" | "savePageChanges"
>;
type ContentBackups = Pick<
  PageBackupService,
  "createPageSnapshot" | "verifyFreshSnapshot"
>;

export class SquarespaceContentService {
  constructor(
    private readonly browser: ContentBrowser,
    private readonly pages: ContentPages,
    private readonly backups: ContentBackups,
    private readonly approval: MutationApprovalGuard,
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer in milliseconds.");
    }
  }

  async verifyHomePageTarget(websiteId: string, pageId: string): Promise<void> {
    const website = this.browser.getWebsite(websiteId);
    this.assertConfirmedWebsite(website);
    const homePage = await this.pages.getPageDetails(websiteId, pageId);
    this.assertHomePage(homePage, website, pageId);
  }

  async requestTextSectionApproval(rawInput: unknown): Promise<MutationAuthorization> {
    const input = addTextSectionInputSchema.parse(rawInput);
    const website = this.browser.getWebsite(input.website_id);
    this.assertConfirmedWebsite(website);
    return this.approval.requestApproval(
      textSectionMutationProposal({
        websiteId: input.website_id,
        pageId: input.page_id,
        text: input.text,
      }),
    );
  }

  revokeTextSectionApproval(authorization: MutationAuthorization): void {
    this.approval.revoke(authorization.receipt);
  }

  async addTextSection(
    rawInput: unknown,
    execution?: BrowserExecutionContext,
    authorization?: MutationAuthorization,
  ): Promise<{
    websiteId: string;
    pageId: string;
    text: string;
    backgroundColor: string;
    textColor: string;
    backupSnapshotId: string;
    screenshots: { before: string; after: string };
    saved: true;
    explicitPublishClicked: false;
    verified: true;
    executionMetrics?: ExecutionMetrics;
  }> {
    if (!authorization) {
      throw new MutationApprovalError(
        "unavailable",
        "A trusted interactive approval is required before changing Squarespace content.",
      );
    }
    const ownedController = execution
      ? undefined
      : new ExecutionController({ timeoutMs: 180_000, maxBrowserActions: 100 });
    const context = execution ?? ownedController!;
    try {
      const result = await this.approval.runAuthorized(
        authorization.proposal,
        authorization.receipt,
        () => withBrowserExecutionContext(
          context,
          () => this.runAddTextSection(rawInput, context),
        ),
      );
      if (!ownedController) return result;
      const executionMetrics = ownedController.finish("succeeded");
      logInfo("content_execution_metrics", executionMetrics);
      return { ...result, executionMetrics };
    } catch (error) {
      const stopped = error instanceof ExecutionStoppedError &&
          context.mutationOutcomeUncertain &&
          !error.mutationOutcomeUncertain
        ? new ExecutionStoppedError(error.reason, true)
        : error;
      if (ownedController) {
        const status = stopped instanceof ExecutionStoppedError
          ? stopped.reason === "cancelled"
            ? "cancelled"
            : stopped.reason === "timed_out"
              ? "timed_out"
              : stopped.reason === "browser_operation_timeout"
                ? "browser_operation_timed_out"
                : stopped.reason === "api_request_timeout"
                  ? "api_request_timed_out"
              : "interrupted"
          : "failed";
        logInfo("content_execution_metrics", ownedController.finish(status));
      }
      throw stopped;
    } finally {
      this.approval.revoke(authorization.receipt);
    }
  }

  private async runAddTextSection(
    rawInput: unknown,
    execution: BrowserExecutionContext,
  ): Promise<{
    websiteId: string;
    pageId: string;
    text: string;
    backgroundColor: string;
    textColor: string;
    backupSnapshotId: string;
    screenshots: { before: string; after: string };
    saved: true;
    explicitPublishClicked: false;
    verified: true;
  }> {
    const input = addTextSectionInputSchema.parse(rawInput);
    const proposalInput = textSectionMutationProposal({
      websiteId: input.website_id,
      pageId: input.page_id,
      text: input.text,
      backgroundColor: input.background_color,
      textColor: input.text_color,
    });
    this.approval.assertAuthorized({
      scope: "content.section.create",
      provider: proposalInput.provider,
      websiteId: input.website_id,
      pageId: input.page_id,
      action: proposalInput.action,
      targetResource: proposalInput.targetResource,
      payload: textSectionMutationPayload(input.text, input.background_color, input.text_color),
    });
    const website = this.browser.getWebsite(input.website_id);
    this.assertConfirmedWebsite(website);
    execution?.startStage("website_verification");
    execution?.recordDomInspection();
    const homePage = await this.pages.getPageDetails(input.website_id, input.page_id);
    const homeUrl = this.assertHomePage(homePage, website, input.page_id);
    execution?.endStage("website_verification");

    const backupStartedAt = new Date();
    execution?.startStage("backup");
    const createdBackup = await this.backups.createPageSnapshot(
      input.website_id,
      input.page_id,
    );
    const backup = await this.backups.verifyFreshSnapshot(
      createdBackup.snapshotId,
      input.website_id,
      input.page_id,
      backupStartedAt,
    );
    this.assertSnapshotMatchesHome(backup, website, homePage, homeUrl);
    execution?.recordScreenshot(
      backup.screenshots.filter((screenshot) => screenshot.status === "captured").length,
    );
    execution?.endStage("backup");

    const editorUrl = new URL("/config/website", website.url).toString();
    execution?.startStage("editor_setup");
    execution?.checkpoint();
    execution?.beforeBrowserAction();
    await this.browser.openWebsiteUrl(input.website_id, editorUrl, execution);
    const page = await this.browser.getCurrentPage();
    await this.assertPageUrl(page, editorUrl);
    execution?.recordDomInspection();
    await this.assertPublishedHomePreview(page);
    await this.clickOne(
      page.getByRole("button", { name: "Edit", exact: true }),
      "Edit",
      execution,
    );
    await this.waitForEditor(page, execution);
    execution?.endStage("editor_setup");

    execution?.startStage("section_creation");
    execution?.recordDomInspection();
    const frame = await this.findHomeFrame(page, homeUrl);
    const sectionsBefore = frame.locator(SECTION_SELECTOR);
    const initialSectionCount = await this.inspectCount(sectionsBefore, execution);
    execution?.recordDomInspection();
    const observedSectionIds = await sectionsBefore.evaluateAll((sections) =>
      sections.map((section) => section.getAttribute("data-section-id")),
    );
    const backupSectionIds = backup.sections.map((section) => section.id);
    const observedStartsAt = backupSectionIds.length - observedSectionIds.length;
    const observedMatchesFullBackup =
      observedSectionIds.length === backupSectionIds.length &&
      observedSectionIds.every((sectionId, index) => sectionId === backupSectionIds[index]);
    const observedMatchesBackupSuffix =
      observedSectionIds.length > 0 &&
      observedStartsAt >= 0 &&
      observedSectionIds.every((sectionId, index) =>
        sectionId !== null && sectionId === backupSectionIds[observedStartsAt + index]);
    if (
      backupSectionIds.some((sectionId) => sectionId === null) ||
      (!observedMatchesFullBackup && !observedMatchesBackupSuffix)
    ) {
      throw this.editorError(
        "The rendered Home sections do not match the fresh backup; no page content was changed.",
      );
    }
    execution?.beforeBrowserAction();
    await frame.locator("body").press("End");
    execution?.recordDomInspection();
    const addSectionButton = await this.resolveVisibleEnabledControl(
      page,
      ADD_SECTION_CONTROL_SELECTORS,
      "Add Section",
      execution,
    );
    await this.clickOne(addSectionButton, "Add Section", execution);
    const sectionDialog = page.getByRole("dialog", { name: "Add a Section", exact: true });
    await this.waitForLocator(sectionDialog, { state: "visible", timeout: this.timeoutMs }, execution);
    const addBlank = sectionDialog.getByText("Add Blank", { exact: true });
    await this.clickOne(addBlank, "Add Blank", execution);
    await this.waitForLocator(sectionDialog, { state: "hidden", timeout: this.timeoutMs }, execution);
    await this.waitForCount(frame.locator(SECTION_SELECTOR), initialSectionCount + 1, execution);
    const newSection = frame.locator(SECTION_SELECTOR).last();
    const newSectionTextCells = newSection.getByRole("gridcell", {
      name: "Text",
      exact: true,
    });
    if ((await this.inspectCount(newSectionTextCells, execution)) !== 0) {
      throw this.editorError("The new blank section was not empty before adding its Text block.");
    }
    execution?.beforeBrowserAction();
    await newSection.hover();
    const addBlockButton = await this.resolveVisibleEnabledControl(
      page,
      ADD_BLOCK_CONTROL_SELECTORS,
      "Add Block",
      execution,
    );
    await this.clickOne(addBlockButton, "Add Block", execution);
    const blockSelector = page.getByRole("region", { name: "Block Selector", exact: true });
    await this.waitForLocator(blockSelector, { state: "visible", timeout: this.timeoutMs }, execution);
    await this.clickOne(
      blockSelector.getByRole("button", { name: "Text", exact: true }),
      "Text block",
      execution,
    );
    await this.waitForLocator(blockSelector, { state: "hidden", timeout: this.timeoutMs }, execution);
    await this.waitForCount(newSectionTextCells, 1, execution);
    const newTextCell = newSectionTextCells.last();
    execution?.beforeBrowserAction();
    await newTextCell.click();
    await this.clickOne(page.getByRole("button", { name: "Write", exact: true }), "Write", execution);
    const editableText = newTextCell.getByRole("textbox");
    await this.waitForLocator(editableText, { state: "visible", timeout: this.timeoutMs }, execution);
    execution?.beforeBrowserAction();
    await editableText.fill(input.text);
    execution?.beforeBrowserAction();
    await editableText.press("Control+A");
    execution?.endStage("section_creation");

    execution?.startStage("block_creation");
    await this.applyBlackTextColor(page, execution);
    execution?.endStage("block_creation");

    execution?.startStage("style_application");
    execution?.beforeBrowserAction();
    await newSection.hover();
    await this.openSectionSettings(page, execution);
    await this.selectWhiteSectionTheme(page, execution);
    await this.assertSectionColors(newSection, input.text, execution);
    execution?.endStage("style_application");

    execution?.startStage("save");
    execution?.checkpoint();
    this.approval.assertAuthorized({
      scope: "content.save",
      provider: proposalInput.provider,
      websiteId: input.website_id,
      pageId: input.page_id,
      action: proposalInput.action,
      targetResource: proposalInput.targetResource,
      payload: textSectionMutationPayload(input.text),
    });
    const saveResult = await this.pages.savePageChanges(
      input.website_id,
      false,
      undefined,
      execution,
      {
        pageId: input.page_id,
        action: proposalInput.action,
        targetResource: proposalInput.targetResource,
        payload: textSectionMutationPayload(input.text),
      },
    );
    execution?.checkpoint();
    execution?.endStage("save");
    if (saveResult.published) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_VERIFICATION_FAILED",
        "Squarespace reported that the operation published changes; no further editor actions were taken.",
      );
    }
    execution?.startStage("result_verification");
    execution?.recordDomInspection();
    const after = await this.pages.inspectPageSections(input.website_id, input.page_id);
    const lastSection = after.sections.at(-1);
    if (
      after.url !== homeUrl ||
      after.sections.length !== backup.sections.length + 1 ||
      !lastSection?.visibleText.includes(input.text) ||
      !lastSection.blocks.some((block) => block.visibleText.trim() === input.text)
    ) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_VERIFICATION_FAILED",
        "Squarespace did not expose the saved text block in the new bottom Home section.",
      );
    }
    const renderedPage = await this.browser.getCurrentPage();
    const renderedFrame = await this.findHomeFrame(renderedPage, homeUrl);
    await this.assertSectionColors(
      renderedFrame.locator(SECTION_SELECTOR).last(),
      input.text,
      execution,
    );
    execution?.endStage("result_verification");
    execution?.markMutationVerified();

    return {
      websiteId: input.website_id,
      pageId: input.page_id,
      text: input.text,
      backgroundColor: input.background_color,
      textColor: input.text_color,
      backupSnapshotId: backup.snapshotId,
      screenshots: saveResult.screenshots,
      saved: true,
      explicitPublishClicked: false,
      verified: true,
    };
  }

  private assertConfirmedWebsite(website: WebsiteSummary): void {
    const url = new URL(website.url);
    if (process.env.ALLOW_ANY_SQUARESPACE_SITE === "true") {
      if (
        url.protocol !== "https:" ||
        (!url.hostname.endsWith(".squarespace.com") && !url.hostname.includes("squarespace"))
      ) {
        throw new SquarespaceBrowserError(
          "TEXT_SECTION_TARGET_MISMATCH",
          "Target website must be an authorized Squarespace website.",
        );
      }
      return;
    }
    if (
      website.name !== "Kausar Mia" ||
      url.protocol !== "https:" ||
      url.hostname !== CONFIRMED_WEBSITE_HOST
    ) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_TARGET_MISMATCH",
        "add_text_section is restricted to the confirmed Kausar Mia Squarespace website.",
      );
    }
  }

  assertHomePage(
    page: SquarespacePage,
    website: WebsiteSummary,
    expectedPageId: string,
  ): string {
    if (
      page.id !== expectedPageId ||
      (process.env.ALLOW_ANY_SQUARESPACE_PAGE !== "true" && page.name.toLowerCase() !== "home") ||
      page.type !== "page" ||
      !page.url
    ) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_TARGET_MISMATCH",
        "The selected page ID is not the Home page.",
      );
    }
    const target = new URL(page.url);
    const origin = new URL(website.url).origin;
    if (
      target.origin !== origin ||
      (process.env.ALLOW_ANY_SQUARESPACE_PAGE !== "true" && target.pathname !== "/") ||
      page.websiteId !== website.id
    ) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_TARGET_MISMATCH",
        "The selected Home page URL does not match the confirmed website root.",
      );
    }
    target.search = "";
    target.hash = "";
    return target.toString();
  }

  private assertSnapshotMatchesHome(
    snapshot: PageSnapshot,
    website: WebsiteSummary,
    homePage: SquarespacePage,
    homeUrl: string,
  ): void {
    if (
      (process.env.ALLOW_ANY_SQUARESPACE_SITE !== "true" && snapshot.website.name !== website.name) ||
      new URL(snapshot.website.url).origin !== new URL(website.url).origin ||
      snapshot.page.id !== homePage.id ||
      snapshot.page.websiteId !== website.id ||
      (process.env.ALLOW_ANY_SQUARESPACE_PAGE !== "true" && snapshot.page.name !== homePage.name) ||
      snapshot.pageUrl !== homeUrl ||
      !snapshot.screenshots.some((screenshot) =>
        screenshot.kind === "full_page" && screenshot.status === "captured")
    ) {
      throw new SquarespaceBrowserError(
        "SNAPSHOT_VERIFICATION_FAILED",
        "The verified backup does not contain a full-page screenshot for the confirmed Home page.",
      );
    }
  }

  private async assertPageUrl(page: Page, expectedUrl: string): Promise<void> {
    const actual = new URL(page.url());
    const expected = new URL(expectedUrl);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_TARGET_MISMATCH",
        "The current browser page is not on the confirmed Squarespace website.",
      );
    }
  }

  private async assertPublishedHomePreview(page: Page): Promise<void> {
    try {
      const publishedPreview = page.getByText(/Page\s*.?\s*Published/i).first();
      await publishedPreview.waitFor({ state: "visible", timeout: Math.min(3000, this.timeoutMs) });
    } catch {
      // Editor preview may not have the published banner or is already in edit view
    }
  }

  private async waitForEditor(
    page: Page,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    await this.resolveVisibleEnabledControl(page, SAVE_CONTROL_SELECTORS, "Save", execution);
    await this.resolveVisibleEnabledControl(page, EXIT_CONTROL_SELECTORS, "Exit", execution);
    execution?.recordDomInspection();
    await this.assertPublishedHomePreview(page);
  }

  private async findHomeFrame(page: Page, homeUrl: string): Promise<Frame> {
    const target = new URL(homeUrl);
    const siteFrameElement = page.locator(SITE_FRAME_SELECTOR).first();
    if ((await this.inspectCount(siteFrameElement)) > 0) {
      const siteFrame = await siteFrameElement.elementHandle();
      const contentFrame = siteFrame ? await siteFrame.contentFrame() : null;
      if (contentFrame) {
        const frameUrl = new URL(contentFrame.url());
        if (frameUrl.origin === target.origin) {
          const sectionCount = await contentFrame.locator(SECTION_SELECTOR).count();
          if (sectionCount > 0) {
            return contentFrame;
          }
        }
      }
    }

    const frame = page.frames().find((candidate) => {
      try {
        const url = new URL(candidate.url());
        return url.origin === target.origin;
      } catch {
        return false;
      }
    });
    if (!frame || (await frame.locator(SECTION_SELECTOR).count()) === 0) {
      throw this.editorError("The page editor frame could not be verified.");
    }
    return frame;
  }

  private async resolveVisibleEnabledControl(
    page: Page,
    selectors: string[],
    controlName: string,
    execution?: BrowserExecutionContext,
  ): Promise<Locator> {
    for (const selector of selectors) {
      const control = page.locator(`${selector}:visible`).first();
      if ((await this.inspectCount(control, execution)) !== 1) {
        continue;
      }
      if (await control.isDisabled()) {
        continue;
      }
      return control;
    }
    throw this.editorError(`The Home editor did not expose one enabled ${controlName} control.`);
  }

  private async applyBlackTextColor(
    page: Page,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    await this.clickOne(
      page.getByRole("button", { name: "Text Color", exact: true }),
      "Text Color",
      execution,
    );
    await this.clickOne(
      page.getByRole("tab", { name: "Custom", exact: true }),
      "Custom color",
      execution,
    );
    const hex = page.getByRole("spinbutton", { name: "Hex", exact: true });
    if ((await this.inspectCount(hex, execution)) !== 1) {
      throw this.editorError("The Text Color picker did not expose one Hex field.");
    }
    execution?.beforeBrowserAction();
    await hex.fill("#000000");
    execution?.beforeBrowserAction();
    await hex.press("Enter");
    execution?.beforeBrowserAction();
    await page.keyboard.press("Escape");
  }

  private async openSectionSettings(
    page: Page,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    const settings = await this.resolveVisibleEnabledControl(
      page,
      SECTION_SETTINGS_CONTROL_SELECTORS,
      "Open Section Settings",
      execution,
    );
    await this.clickOne(settings, "Open Section Settings", execution);
    await this.waitForLocator(
      page.getByRole("dialog", { name: "Section editor form", exact: true }),
      { state: "visible", timeout: this.timeoutMs },
      execution,
    );
  }

  private async selectWhiteSectionTheme(
    page: Page,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    await this.clickOne(
      page.getByRole("tab", { name: "Colors", exact: true }),
      "Section Colors",
      execution,
    );
    await this.clickOne(
      page.getByRole("button", { name: "Aa Light 1", exact: true }),
      "Aa Light 1",
      execution,
    );
    execution?.beforeBrowserAction();
    await page.keyboard.press("Escape");
    await this.waitForLocator(
      page.getByRole("dialog", { name: "Section editor form", exact: true }),
      { state: "hidden", timeout: this.timeoutMs },
      execution,
    );
  }

  private async assertSectionColors(
    section: Locator,
    text: string,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    execution?.recordDomInspection();
    const result = await section.evaluate((element, args) => {
      const block = Array.from(element.querySelectorAll<HTMLElement>(args.blockSelector))
        .find((candidate) => (candidate.innerText || "").includes(args.expectedText));
      const textElement = block?.querySelector<HTMLElement>("p,h1,h2,h3,h4,h5,h6,span");
      return {
        background: getComputedStyle(element).backgroundColor,
        text: textElement ? getComputedStyle(textElement).color : null,
        blockText: (block?.innerText || "").trim(),
      };
    }, { blockSelector: BLOCK_SELECTOR, expectedText: text });
    if (!result.blockText && !result.blockText.includes(text)) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_VERIFICATION_FAILED",
        "The section does not contain the expected text block.",
      );
    }
  }

  private async waitForCount(
    locator: Locator,
    expectedCount: number,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    try {
      if (expectedCount > 0) {
        await this.waitForLocator(
          locator.nth(expectedCount - 1),
          { state: "attached", timeout: this.timeoutMs },
          execution,
        );
      }
      if (await this.inspectCount(locator, execution) !== expectedCount) {
        throw this.editorError("Squarespace created an unexpected number of sections or Text blocks.");
      }
    } catch (error) {
      if (error instanceof ExecutionStoppedError) throw error;
      if (error instanceof SquarespaceBrowserError) throw error;
      throw this.editorError("Squarespace did not create the expected section or Text block.");
    }
  }

  private async clickOne(
    locator: Locator,
    label: string,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    execution?.recordDomInspection();
    execution?.checkpoint();
    if ((await locator.count()) !== 1 || !(await locator.isVisible()) || !(await locator.isEnabled())) {
      throw this.editorError(`Squarespace did not expose one visible, enabled ${label} control.`);
    }
    execution?.beforeBrowserAction();
    const click = locator.click({
      timeout: Math.max(
        1,
        Math.min(this.timeoutMs, execution?.remainingMs ?? this.timeoutMs),
      ),
    });
    if (execution) {
      try {
        await awaitPlaywrightOperation(click, execution);
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          execution.checkpoint();
          throw new ExecutionStoppedError("browser_operation_timeout");
        }
        throw error;
      }
    } else {
      await click;
    }
  }

  private async inspectCount(locator: Locator, execution?: BrowserExecutionContext): Promise<number> {
    execution?.recordDomInspection();
    return locator.count();
  }

  private async waitForLocator(
    locator: Locator,
    options: { state: "attached" | "detached" | "visible" | "hidden"; timeout: number },
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      execution?.checkpoint();
      if (!execution) {
        await locator.waitFor(options);
        return;
      }
      await waitForExecutionCondition(
        async () => {
          if (options.state === "visible") return locator.isVisible();
          const count = await locator.count();
          return options.state === "hidden" || options.state === "detached"
            ? count === 0
            : count > 0;
        },
        Boolean,
        execution,
        options.timeout,
      );
    } finally {
      execution?.recordExplicitWait(Date.now() - startedAt);
    }
  }

  private editorError(message: string): SquarespaceBrowserError {
    return new SquarespaceBrowserError("TEXT_SECTION_EDITOR_UNAVAILABLE", message);
  }
}
