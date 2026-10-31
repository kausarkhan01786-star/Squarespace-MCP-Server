import type { Frame, Page } from "playwright";
import { SquarespaceBrowserError } from "./browser-errors.js";
import { assertAllowedSquarespaceUrl } from "./browser-security.js";
import {
  SQUARESPACE_CONTENT_BLOCK_SELECTOR,
  SQUARESPACE_PAGE_SECTION_SELECTOR,
  type SquarespacePagesService,
} from "./squarespace-pages.service.js";
import type { WebsiteSummary } from "./squarespace-browser.service.js";

const STYLES_BUTTON_SELECTOR = '[data-test="frameToolbarSiteStyles"]';
const STYLES_LOADING_SELECTOR = '[data-test="loading-spinner"]';
const MAX_STYLE_SAMPLES = 100;
const MAX_BLOCKS = 500;

interface DesignBrowser {
  getWebsite(websiteId: string): WebsiteSummary;
  openWebsitePages(websiteId: string): Promise<void>;
  getCurrentPage(): Promise<Page>;
}

type DesignPageInspector = Pick<
  SquarespacePagesService,
  "inspectPageSections"
>;

interface RenderedPage {
  frame: Frame;
  inspection: Awaited<ReturnType<SquarespacePagesService["inspectPageSections"]>>;
}

export class SquarespaceDesignService {
  constructor(
    private readonly browser: DesignBrowser,
    private readonly pages: DesignPageInspector,
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer in milliseconds.");
    }
  }

  async inspectDesignSettings(websiteId: string): Promise<never> {
    await this.openStylesPanel(websiteId);
    throw new SquarespaceBrowserError(
      "DESIGN_PANEL_NOT_AVAILABLE",
      "Squarespace opened Site Styles, but no verified design-setting controls were exposed.",
    );
  }

  async inspectSiteStyles(websiteId: string): Promise<never> {
    await this.openStylesPanel(websiteId);
    throw new SquarespaceBrowserError(
      "DESIGN_PANEL_NOT_AVAILABLE",
      "Squarespace opened Site Styles, but its settings interface did not expose inspectable style controls.",
    );
  }

  async inspectTypography(websiteId: string, pageId: string): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    source: "rendered_page_computed_styles";
    complete: boolean;
    samples: Array<{
      sectionId: string | null;
      tag: string;
      fontFamily: string;
      fontSize: string;
      fontWeight: string;
      lineHeight: string;
      letterSpacing: string;
      textTransform: string;
      color: string;
    }>;
  }> {
    const { frame, inspection } = await this.getRenderedPage(websiteId, pageId);
    const samples = await frame.locator(
      "h1,h2,h3,h4,h5,h6,p,blockquote",
    ).evaluateAll((elements, maxSamples) => elements.flatMap((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return [];
      }
      const section = element.closest<HTMLElement>('[data-test="page-section"]');
      return [{
        sectionId: section?.getAttribute("data-section-id") ?? null,
        tag: element.tagName.toLowerCase(),
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textTransform: style.textTransform,
        color: style.color,
      }];
    }).slice(0, maxSamples), MAX_STYLE_SAMPLES);

    return {
      websiteId,
      pageId,
      url: inspection.url,
      source: "rendered_page_computed_styles",
      complete: samples.length < MAX_STYLE_SAMPLES,
      samples,
    };
  }

  async inspectColorThemes(websiteId: string, pageId: string): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    source: "rendered_section_theme_and_computed_colors";
    sections: Array<{
      sectionId: string | null;
      theme: string | null;
      backgroundColor: string;
      textColor: string;
      backgroundImagePresent: boolean;
    }>;
  }> {
    const { frame, inspection } = await this.getRenderedPage(websiteId, pageId);
    const sections = await frame.locator(SQUARESPACE_PAGE_SECTION_SELECTOR)
      .evaluateAll((elements) => elements.map((element) => {
        const style = window.getComputedStyle(element);
        return {
          sectionId: element.getAttribute("data-section-id"),
          theme: element.getAttribute("data-section-theme"),
          backgroundColor: style.backgroundColor,
          textColor: style.color,
          backgroundImagePresent: style.backgroundImage !== "none",
        };
      }));

    return {
      websiteId,
      pageId,
      url: inspection.url,
      source: "rendered_section_theme_and_computed_colors",
      sections,
    };
  }

  async inspectButtonStyles(websiteId: string, pageId: string): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    source: "rendered_semantic_buttons";
    complete: false;
    buttons: Array<{
      sectionId: string | null;
      tag: string;
      role: string | null;
      backgroundColor: string;
      color: string;
      borderColor: string;
      borderRadius: string;
      fontFamily: string;
      fontSize: string;
      fontWeight: string;
      padding: string;
    }>;
    limitation: string;
  }> {
    const { frame, inspection } = await this.getRenderedPage(websiteId, pageId);
    const buttons = await frame.locator(
      'button,[role="button"],input[type="button"],input[type="submit"]',
    ).evaluateAll((elements, maxSamples) => elements.flatMap((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return [];
      }
      const section = element.closest<HTMLElement>('[data-test="page-section"]');
      return [{
        sectionId: section?.getAttribute("data-section-id") ?? null,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        padding: style.padding,
      }];
    }).slice(0, maxSamples), MAX_STYLE_SAMPLES);

    return {
      websiteId,
      pageId,
      url: inspection.url,
      source: "rendered_semantic_buttons",
      complete: false,
      buttons,
      limitation: "Only visible semantic buttons are included; styled links without button semantics and site-wide button presets are not inferred.",
    };
  }

  async inspectSectionSettings(
    websiteId: string,
    pageId: string,
    sectionId: string,
  ): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    source: "rendered_section";
    section: {
      id: string;
      theme: string | null;
      layout: "fluid_engine" | "unknown";
      fluidEngine: boolean;
      className: string;
      width: number;
      height: number;
      backgroundColor: string;
      textColor: string;
      backgroundImagePresent: boolean;
      padding: string;
    };
  }> {
    const rendered = await this.getRenderedPage(websiteId, pageId);
    const metadata = rendered.inspection.sections.find((section) => section.id === sectionId);
    if (!metadata) {
      throw new SquarespaceBrowserError(
        "SECTION_NOT_FOUND",
        "The requested section was not found on this page. Refresh list_page_sections and use a returned section ID.",
      );
    }
    const section = await rendered.frame.locator(SQUARESPACE_PAGE_SECTION_SELECTOR)
      .evaluateAll((elements, targetId) => {
        const element = elements.find(
          (candidate) => candidate.getAttribute("data-section-id") === targetId,
        );
        if (!element) {
          return null;
        }
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          id: targetId,
          theme: element.getAttribute("data-section-theme"),
          layout: element.hasAttribute("data-fluid-engine-section")
            ? "fluid_engine" as const
            : "unknown" as const,
          fluidEngine: element.hasAttribute("data-fluid-engine-section"),
          className: typeof element.className === "string" ? element.className : "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          backgroundColor: style.backgroundColor,
          textColor: style.color,
          backgroundImagePresent: style.backgroundImage !== "none",
          padding: style.padding,
        };
      }, sectionId);

    if (!section) {
      throw new SquarespaceBrowserError(
        "SECTION_NOT_FOUND",
        "The selected section disappeared during inspection. Retry with a current section ID.",
      );
    }

    return {
      websiteId,
      pageId,
      url: rendered.inspection.url,
      source: "rendered_section",
      section: { ...section, theme: metadata.theme, layout: metadata.layout },
    };
  }

  async listContentBlocks(websiteId: string, pageId: string): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    blocks: Array<{
      sectionId: string | null;
      id: string | null;
      type: string | null;
      definitionName: string | null;
      visibleText: string;
      textTruncated: boolean;
    }>;
    complete: boolean;
  }> {
    const inspection = await this.pages.inspectPageSections(websiteId, pageId);
    const blocks = inspection.sections.flatMap((section) =>
      section.blocks.map((block) => ({
        sectionId: section.id,
        id: block.id,
        type: block.type,
        definitionName: block.definitionName ?? null,
        visibleText: block.visibleText,
        textTruncated: block.textTruncated,
      })),
    ).slice(0, MAX_BLOCKS);

    return {
      websiteId,
      pageId,
      url: inspection.url,
      blocks,
      complete: !inspection.sectionsTruncated &&
        inspection.sections.every((section) => !section.blocksTruncated) &&
        blocks.length < MAX_BLOCKS,
    };
  }

  async inspectContentBlock(
    websiteId: string,
    pageId: string,
    blockId: string,
  ): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    sectionId: string;
    block: {
      id: string;
      type: string | null;
      definitionName: string | null;
      visibleText: string;
      textTruncated: boolean;
    };
  }> {
    const normalizedBlockId = blockId.trim();
    if (!normalizedBlockId) {
      throw new SquarespaceBrowserError(
        "CONTENT_BLOCK_NOT_FOUND",
        "A non-empty block ID is required.",
      );
    }
    const inspection = await this.pages.inspectPageSections(websiteId, pageId);
    const matches = inspection.sections.flatMap((section) =>
      section.blocks
        .filter((block) => block.id === normalizedBlockId)
        .map((block) => ({ sectionId: section.id, block })),
    );
    if (matches.length === 0) {
      throw new SquarespaceBrowserError(
        "CONTENT_BLOCK_NOT_FOUND",
        "The requested block was not found on this page. Refresh list_content_blocks and use a returned block ID.",
      );
    }
    if (matches.length !== 1 || !matches[0]?.sectionId) {
      throw new SquarespaceBrowserError(
        "CONTENT_BLOCK_AMBIGUOUS",
        "The selected block ID does not identify exactly one section. Refresh list_content_blocks before retrying.",
      );
    }
    const { sectionId, block } = matches[0];
    return {
      websiteId,
      pageId,
      url: inspection.url,
      sectionId,
      block: {
        id: normalizedBlockId,
        type: block.type,
        definitionName: block.definitionName ?? null,
        visibleText: block.visibleText,
        textTruncated: block.textTruncated,
      },
    };
  }

  async getBlockEditSchema(
    websiteId: string,
    pageId: string,
    blockId: string,
  ): Promise<never> {
    await this.inspectContentBlock(websiteId, pageId, blockId);
    throw new SquarespaceBrowserError(
      "BLOCK_EDITOR_NOT_AVAILABLE",
      "The rendered block is identifiable, but its editing interface and input schema have not been verified. No editor controls were opened or changed.",
    );
  }

  async listAvailableBlockTypes(websiteId: string, pageId: string): Promise<{
    websiteId: string;
    pageId: string;
    url: string;
    source: "currently_rendered_page";
    complete: false;
    types: Array<{
      type: string | null;
      definitionName: string | null;
    }>;
    limitation: string;
  }> {
    const { frame, inspection } = await this.getRenderedPage(websiteId, pageId);
    const types = await frame.locator(SQUARESPACE_CONTENT_BLOCK_SELECTOR)
      .evaluateAll((elements) => {
        const unique = new Map<string, { type: string | null; definitionName: string | null }>();
        for (const element of elements) {
          const type = element.getAttribute("data-block-type");
          const definitionName = element.getAttribute("data-definition-name");
          const key = `${type ?? ""}\u0000${definitionName ?? ""}`;
          if (!unique.has(key)) {
            unique.set(key, { type, definitionName });
          }
        }
        return [...unique.values()];
      });

    return {
      websiteId,
      pageId,
      url: inspection.url,
      source: "currently_rendered_page",
      complete: false,
      types,
      limitation: "These are block types observed on this page, not an exhaustive Squarespace add-block catalog.",
    };
  }

  private async getRenderedPage(
    websiteId: string,
    pageId: string,
  ): Promise<RenderedPage> {
    const website = this.browser.getWebsite(websiteId);
    const inspection = await this.pages.inspectPageSections(websiteId, pageId);
    const targetUrl = assertAllowedSquarespaceUrl(inspection.url);
    if (targetUrl.origin !== new URL(website.url).origin) {
      throw new SquarespaceBrowserError(
        "INVALID_URL",
        "Design inspection is restricted to the selected Squarespace website.",
      );
    }
    const page = await this.browser.getCurrentPage();
    const targetPath = normalizePath(targetUrl.pathname);
    const frame = page.frames().find((candidate) => {
      try {
        const frameUrl = new URL(candidate.url());
        return frameUrl.origin === targetUrl.origin &&
          normalizePath(frameUrl.pathname) === targetPath;
      } catch {
        return false;
      }
    });
    if (!frame) {
      throw new SquarespaceBrowserError(
        "SECTIONS_NOT_AVAILABLE",
        "The rendered page frame could not be matched to the inspected Squarespace page.",
      );
    }
    return { frame, inspection };
  }

  private async openStylesPanel(websiteId: string): Promise<void> {
    const website = this.browser.getWebsite(websiteId);
    const websiteOrigin = new URL(website.url).origin;
    await this.browser.openWebsitePages(websiteId);
    const page = await this.browser.getCurrentPage();
    const button = page.locator(STYLES_BUTTON_SELECTOR);
    try {
      await button.waitFor({ state: "visible", timeout: this.timeoutMs });
      if (await button.count() !== 1) {
        throw new SquarespaceBrowserError(
          "DESIGN_PANEL_NOT_AVAILABLE",
          "Squarespace did not expose one unambiguous Site Styles control.",
        );
      }
      await button.click();
      await page.waitForURL(
        (url) => url.origin === websiteOrigin &&
          url.pathname.endsWith("/config/site-styles"),
        { timeout: this.timeoutMs },
      );
      await page.waitForFunction(
        (selector) => !Array.from(document.querySelectorAll(selector)).some((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;
        }),
        STYLES_LOADING_SELECTOR,
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      if (error instanceof SquarespaceBrowserError) {
        throw error;
      }
      throw new SquarespaceBrowserError(
        "DESIGN_PANEL_NOT_AVAILABLE",
        "Squarespace's Site Styles screen did not expose inspectable controls; its observed loading indicator remained visible or the screen did not open.",
        { cause: error },
      );
    }
  }
}

function normalizePath(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}
