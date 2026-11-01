import { z } from "zod";
import type { Page, Frame, Locator } from "playwright";
import type { PageBackupService, PageSnapshot } from "../backups/page-backup.service.js";
import { SquarespaceBrowserError } from "./browser-errors.js";
import {
  SQUARESPACE_PAGE_SECTION_SELECTOR,
  type SquarespacePage,
  type SquarespacePagesService,
} from "./squarespace-pages.service.js";
import type {
  SquarespaceBrowserService,
  WebsiteSummary,
} from "./squarespace-browser.service.js";

const CONFIRMED_WEBSITE_HOST = "cobalt-spinach-eeah.squarespace.com";
const SECTION_SELECTOR = SQUARESPACE_PAGE_SECTION_SELECTOR;
const BLOCK_SELECTOR = "[data-block-type]";

export const addTextSectionInputSchema = z.object({
  website_id: z.string().trim().min(1).describe("ID returned by list_websites for Kausar Mia."),
  page_id: z.string().trim().min(1).describe("ID returned by list_pages for Home."),
  text: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
  background_color: z.literal("#FFFFFF"),
  text_color: z.literal("#000000"),
  confirm_potentially_live_save: z.boolean().default(false).describe(
    "Required explicit approval because Squarespace Save has not been verified as draft-only.",
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
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer in milliseconds.");
    }
  }

  async addTextSection(rawInput: unknown): Promise<{
    websiteId: string;
    pageId: string;
    text: string;
    backgroundColor: "#FFFFFF";
    textColor: "#000000";
    backupSnapshotId: string;
    screenshots: { before: string; after: string };
    saved: true;
    explicitPublishClicked: false;
    verified: true;
  }> {
    const input = addTextSectionInputSchema.parse(rawInput);
    if (!input.confirm_potentially_live_save) {
      throw new SquarespaceBrowserError(
        "CONFIRMATION_REQUIRED",
        "Squarespace Save has not been verified as draft-only. Explicitly approve a potentially live save before any page-editor changes are made.",
      );
    }

    const website = this.browser.getWebsite(input.website_id);
    this.assertConfirmedWebsite(website);
    const homePage = await this.pages.getPageDetails(input.website_id, input.page_id);
    const homeUrl = this.assertHomePage(homePage, website, input.page_id);

    const backupStartedAt = new Date();
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

    const editorUrl = new URL("/config/website", website.url).toString();
    await this.browser.openWebsiteUrl(input.website_id, editorUrl);
    const page = await this.browser.getCurrentPage();
    await this.assertPageUrl(page, editorUrl);
    await this.assertPublishedHomePreview(page);
    await this.clickOne(page.getByRole("button", { name: "Edit", exact: true }), "Edit");
    await this.waitForEditor(page);

    const frame = await this.findHomeFrame(page, homeUrl);
    const sectionsBefore = frame.locator(SECTION_SELECTOR);
    const initialSectionCount = await sectionsBefore.count();
    if (initialSectionCount !== backup.sections.length) {
      throw this.editorError(
        "The rendered Home section count does not match the fresh backup; no page content was changed.",
      );
    }
    const observedSectionIds = await sectionsBefore.evaluateAll((sections) =>
      sections.map((section) => section.getAttribute("data-section-id")),
    );
    if (
      backup.sections.some((section) => section.id === null) ||
      observedSectionIds.some((sectionId, index) =>
        sectionId === null || sectionId !== backup.sections[index]?.id)
    ) {
      throw this.editorError(
        "The rendered Home sections do not match the fresh backup; no page content was changed.",
      );
    }
    await frame.locator("body").press("End");
    const addSectionButtons = page.getByRole("button", {
      name: "Add Section",
      exact: true,
    });
    const addSectionCount = await addSectionButtons.count();
    if (addSectionCount < 1 || !(await addSectionButtons.last().isVisible())) {
      throw this.editorError("The Home editor did not expose an Add Section control.");
    }
    await addSectionButtons.last().click();
    const sectionDialog = page.getByRole("dialog", { name: "Add a Section", exact: true });
    await sectionDialog.waitFor({ state: "visible", timeout: this.timeoutMs });
    const addBlank = sectionDialog.getByText("Add Blank", { exact: true });
    await this.clickOne(addBlank, "Add Blank");
    await sectionDialog.waitFor({ state: "hidden", timeout: this.timeoutMs });
    await this.waitForCount(frame.locator(SECTION_SELECTOR), initialSectionCount + 1);
    const newSection = frame.locator(SECTION_SELECTOR).last();
    const newSectionTextCells = newSection.getByRole("gridcell", {
      name: "Text",
      exact: true,
    });
    if ((await newSectionTextCells.count()) !== 0) {
      throw this.editorError("The new blank section was not empty before adding its Text block.");
    }

    await newSection.hover();
    await this.clickOne(
      page.getByRole("button", { name: "Add Block", exact: true }),
      "Add Block",
    );
    const blockSelector = page.getByRole("region", { name: "Block Selector", exact: true });
    await blockSelector.waitFor({ state: "visible", timeout: this.timeoutMs });
    await this.clickOne(
      blockSelector.getByRole("button", { name: "Text", exact: true }),
      "Text block",
    );
    await blockSelector.waitFor({ state: "hidden", timeout: this.timeoutMs });
    await this.waitForCount(newSectionTextCells, 1);
    const newTextCell = newSectionTextCells.last();
    await newTextCell.click();
    await this.clickOne(page.getByRole("button", { name: "Write", exact: true }), "Write");
    const editableText = newTextCell.getByRole("textbox");
    await editableText.waitFor({ state: "visible", timeout: this.timeoutMs });
    await editableText.fill(input.text);
    await editableText.press("Control+A");
    await this.applyBlackTextColor(page);

    await newSection.hover();
    await this.openSectionSettings(page);
    await this.selectWhiteSectionTheme(page);
    await this.assertSectionColors(newSection, input.text);

    const saveResult = await this.pages.savePageChanges(input.website_id);
    if (saveResult.published) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_VERIFICATION_FAILED",
        "Squarespace reported that the operation published changes; no further editor actions were taken.",
      );
    }
    const after = await this.pages.inspectPageSections(input.website_id, input.page_id);
    const lastSection = after.sections.at(-1);
    if (
      after.url !== homeUrl ||
      after.sections.length !== initialSectionCount + 1 ||
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
    await this.assertSectionColors(renderedFrame.locator(SECTION_SELECTOR).last(), input.text);

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

  private assertHomePage(
    page: SquarespacePage,
    website: WebsiteSummary,
    expectedPageId: string,
  ): string {
    if (
      page.id !== expectedPageId ||
      page.name !== "Home" ||
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
      target.pathname !== "/" ||
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
      snapshot.website.name !== website.name ||
      new URL(snapshot.website.url).origin !== new URL(website.url).origin ||
      snapshot.page.id !== homePage.id ||
      snapshot.page.websiteId !== website.id ||
      snapshot.page.name !== homePage.name ||
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
    const homeLabel = page.getByText("Home", { exact: true });
    const publishedLabel = page.getByText("Page · Published", { exact: true });
    if (
      (await homeLabel.count()) === 0 ||
      (await publishedLabel.count()) !== 1 ||
      !(await publishedLabel.isVisible())
    ) {
      throw this.editorError(
        "The editor did not identify a published Home page; no page content was changed.",
      );
    }
  }

  private async waitForEditor(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Save", exact: true })
      .waitFor({ state: "visible", timeout: this.timeoutMs });
    await page.getByRole("button", { name: "Exit", exact: true })
      .waitFor({ state: "visible", timeout: this.timeoutMs });
    await this.assertPublishedHomePreview(page);
  }

  private async findHomeFrame(page: Page, homeUrl: string): Promise<Frame> {
    const target = new URL(homeUrl);
    const frame = page.frames().find((candidate) => {
      try {
        const url = new URL(candidate.url());
        return url.origin === target.origin && url.pathname === "/";
      } catch {
        return false;
      }
    });
    if (!frame) {
      throw this.editorError("The Home page editor frame could not be verified.");
    }
    return frame;
  }

  private async applyBlackTextColor(page: Page): Promise<void> {
    await this.clickOne(
      page.getByRole("button", { name: "Text Color", exact: true }),
      "Text Color",
    );
    await this.clickOne(page.getByRole("tab", { name: "Custom", exact: true }), "Custom color");
    const hex = page.getByRole("spinbutton", { name: "Hex", exact: true });
    if ((await hex.count()) !== 1) {
      throw this.editorError("The Text Color picker did not expose one Hex field.");
    }
    await hex.fill("#000000");
    await hex.press("Enter");
    await page.keyboard.press("Escape");
  }

  private async openSectionSettings(page: Page): Promise<void> {
    const settings = page.locator('button[aria-label="Open Section Settings"]:visible');
    await this.clickOne(settings, "Open Section Settings");
    await page.getByRole("dialog", { name: "Section editor form", exact: true })
      .waitFor({ state: "visible", timeout: this.timeoutMs });
  }

  private async selectWhiteSectionTheme(page: Page): Promise<void> {
    await this.clickOne(
      page.getByRole("tab", { name: "Colors", exact: true }),
      "Section Colors",
    );
    await this.clickOne(
      page.getByRole("button", { name: "Aa Light 1", exact: true }),
      "Aa Light 1",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Section editor form", exact: true })
      .waitFor({ state: "hidden", timeout: this.timeoutMs });
  }

  private async assertSectionColors(section: Locator, text: string): Promise<void> {
    const colors = await section.evaluate((element, args) => {
      const block = Array.from(element.querySelectorAll<HTMLElement>(args.blockSelector))
        .find((candidate) => (candidate.innerText || "").trim() === args.expectedText);
      const textElement = block?.querySelector<HTMLElement>("p,h1,h2,h3,h4,h5,h6,span");
      return {
        background: getComputedStyle(element).backgroundColor,
        text: textElement ? getComputedStyle(textElement).color : null,
        blockText: (block?.innerText || "").trim(),
      };
    }, { blockSelector: BLOCK_SELECTOR, expectedText: text });
    if (
      colors.background !== "rgb(255, 255, 255)" ||
      colors.text !== "rgb(0, 0, 0)" ||
      colors.blockText !== text
    ) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_VERIFICATION_FAILED",
        "The section background or text color did not match pure white and pure black.",
      );
    }
  }

  private async waitForCount(locator: Locator, expectedCount: number): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (await locator.count() === expectedCount) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw this.editorError("Squarespace did not create the expected section or Text block.");
  }

  private async clickOne(locator: Locator, label: string): Promise<void> {
    if ((await locator.count()) !== 1 || !(await locator.isVisible()) || !(await locator.isEnabled())) {
      throw this.editorError(`Squarespace did not expose one visible, enabled ${label} control.`);
    }
    await locator.click();
  }

  private editorError(message: string): SquarespaceBrowserError {
    return new SquarespaceBrowserError("TEXT_SECTION_EDITOR_UNAVAILABLE", message);
  }
}
