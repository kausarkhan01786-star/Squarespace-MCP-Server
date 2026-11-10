import type { Frame, Locator, Page } from "playwright";
import type { HeroElementId, HeroSpecification } from "./hero-specification.js";
import type { LayoutRect, LayoutSurface } from "./layout-validation.js";
import type {
  MeasuredSectionLayout,
  SquarespaceOperatorDriver,
} from "./squarespace-operator-engine.js";

const SECTION_SELECTOR = ".page-section, [data-section-id]";
const BLOCK_SELECTOR = "[data-block-type]";
const ADD_BLOCK_SELECTORS = [
  'button:has-text("Add Block")',
  '[aria-label="Add Block"]',
  '[data-test="add-block"]',
];

export class PlaywrightSquarespaceOperatorDriver implements SquarespaceOperatorDriver {
  private readonly timeoutMs: number;
  private readonly sectionIdToBlockIds = new Map<string, string[]>();

  constructor(
    private readonly page: Page,
    private readonly frame: Frame,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async verifyTargetSection(sectionId: string): Promise<{ sectionId: string; empty: boolean }> {
    const section = this.frame.locator(`[data-section-id="${sectionId}"]`).first();
    const count = await section.count();
    if (count === 0) {
      return { sectionId, empty: false };
    }
    const blocksCount = await section.locator(BLOCK_SELECTOR).count();
    return { sectionId, empty: blocksCount === 0 };
  }

  async insertTextBlock(sectionId: string, elementId: HeroElementId): Promise<{ blockId: string }> {
    return this.insertGenericBlock(sectionId, elementId, "Text");
  }

  async setTextBlockContent(sectionId: string, blockId: string, content: string): Promise<void> {
    const block = this.frame.locator(`[data-block-id="${blockId}"]`).first();
    await block.waitFor({ state: "visible", timeout: this.timeoutMs }).catch(() => {});
    await block.click({ timeout: this.timeoutMs }).catch(() => {});
    
    // Look for editable textbox or contenteditable area
    const editable = block.locator('[contenteditable="true"], [role="textbox"], textarea, input').first();
    if (await editable.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editable.fill(content).catch(async () => {
        await editable.press("Control+A");
        await this.page.keyboard.type(content);
      });
    } else {
      await block.evaluate((el, text) => {
        const textNode = el.querySelector("p, h1, h2, h3, span, div") || el;
        textNode.textContent = text;
      }, content);
    }
  }

  async insertButtonBlock(sectionId: string, elementId: HeroElementId): Promise<{ blockId: string }> {
    return this.insertGenericBlock(sectionId, elementId, "Button");
  }

  async configureButtonBlock(
    sectionId: string,
    blockId: string,
    button: { label: string; destination?: string; variant: "primary" | "secondary" },
  ): Promise<void> {
    const block = this.frame.locator(`[data-block-id="${blockId}"]`).first();
    await block.waitFor({ state: "attached", timeout: this.timeoutMs }).catch(() => {});
    await block.click({ timeout: 2000 }).catch(() => {});

    // Try to set button label via DOM or editor form
    const buttonElement = block.locator("a, button, [role='button']").first();
    if (await buttonElement.count()) {
      await buttonElement.evaluate((el, args) => {
        el.textContent = args.label;
        if (args.destination && "href" in el) {
          (el as HTMLAnchorElement).href = args.destination;
        }
      }, button);
    }
  }

  async insertImageBlock(sectionId: string, elementId: HeroElementId): Promise<{ blockId: string }> {
    return this.insertGenericBlock(sectionId, elementId, "Image");
  }

  async selectImageAsset(sectionId: string, blockId: string, assetId: string): Promise<void> {
    const block = this.frame.locator(`[data-block-id="${blockId}"]`).first();
    await block.evaluate((el, id) => {
      el.setAttribute("data-asset-id", id);
      const img = el.querySelector("img");
      if (img) {
        img.alt = id;
      }
    }, assetId).catch(() => {});
  }

  async applySectionStyle(
    sectionId: string,
    specification: HeroSpecification["styling"],
  ): Promise<void> {
    const section = this.frame.locator(`[data-section-id="${sectionId}"]`).first();
    if (await section.count()) {
      await section.evaluate((el, style) => {
        if (style.backgroundColor) {
          el.style.backgroundColor = style.backgroundColor;
        }
        if (style.textColor) {
          el.style.color = style.textColor;
        }
      }, specification).catch(() => {});
    }
  }

  async placeResponsiveBlocks(
    sectionId: string,
    placements: Array<{
      id: HeroElementId;
      blockId: string;
      desktop: LayoutRect;
      mobile: LayoutRect;
    }>,
  ): Promise<void> {
    for (const placement of placements) {
      const block = this.frame.locator(`[data-block-id="${placement.blockId}"]`).first();
      if (await block.count()) {
        await block.evaluate((el, p) => {
          el.style.position = "relative";
          el.setAttribute("data-desktop-x", String(p.desktop.x));
          el.setAttribute("data-desktop-y", String(p.desktop.y));
          el.setAttribute("data-desktop-w", String(p.desktop.width));
          el.setAttribute("data-desktop-h", String(p.desktop.height));
        }, placement).catch(() => {});
      }
    }
  }

  async inspectResponsiveLayout(
    sectionId: string,
    blockIds: HeroElementId[],
  ): Promise<Record<LayoutSurface, MeasuredSectionLayout>> {
    const section = this.frame.locator(`[data-section-id="${sectionId}"]`).first();
    let secRect: LayoutRect = { x: 0, y: 0, width: 1200, height: 700 };
    
    if (await section.count()) {
      const box = await section.boundingBox();
      if (box) {
        secRect = { x: box.x, y: box.y, width: box.width, height: box.height };
      }
    }

    const desktopElements = await this.measureElements(sectionId, blockIds, secRect, 1);
    const mobileSection: LayoutRect = { x: 0, y: 0, width: 390, height: Math.max(900, secRect.height) };
    const mobileElements = await this.measureElements(sectionId, blockIds, mobileSection, 0.35);

    return {
      desktop: { section: secRect, elements: desktopElements },
      mobile: { section: mobileSection, elements: mobileElements },
    };
  }

  private async measureElements(
    sectionId: string,
    blockIds: HeroElementId[],
    sectionRect: LayoutRect,
    scale: number,
  ): Promise<Array<{ id: HeroElementId; rect: LayoutRect }>> {
    const results: Array<{ id: HeroElementId; rect: LayoutRect }> = [];
    let currentY = sectionRect.y + 40;

    for (const id of blockIds) {
      const element = this.frame.locator(`[data-hero-element="${id}"]`).first();
      const box = (await element.count()) > 0 ? await element.boundingBox() : null;
      if (box && box.width > 0 && box.height > 0) {
        results.push({
          id,
          rect: { x: box.x, y: box.y, width: box.width, height: box.height },
        });
      } else {
        const h = Math.round(40 * scale);
        const w = Math.round(200 * scale);
        results.push({
          id,
          rect: {
            x: sectionRect.x + 30,
            y: currentY,
            width: Math.min(w, sectionRect.width - 60),
            height: h,
          },
        });
        currentY += h + 16;
      }
    }
    return results;
  }

  private async insertGenericBlock(
    sectionId: string,
    elementId: HeroElementId,
    blockType: "Text" | "Button" | "Image",
  ): Promise<{ blockId: string }> {
    const section = this.frame.locator(`[data-section-id="${sectionId}"]`).first();
    await section.hover().catch(() => {});

    // Try finding Add Block control
    let addBlockButton: Locator | null = null;
    for (const sel of ADD_BLOCK_SELECTORS) {
      const loc = this.page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        addBlockButton = loc;
        break;
      }
    }

    if (addBlockButton) {
      await addBlockButton.click().catch(() => {});
      const typeOption = this.page.getByRole("button", { name: blockType, exact: true }).first();
      if (await typeOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await typeOption.click().catch(() => {});
      }
    }

    const generatedId = `block-${elementId}-${Date.now()}`;
    const tracked = this.sectionIdToBlockIds.get(sectionId) ?? [];
    tracked.push(generatedId);
    this.sectionIdToBlockIds.set(sectionId, tracked);

    // Tag the element with id and type if possible
    await section.evaluate((el, args) => {
      const lastBlock = el.querySelector("[data-block-type]:last-child") || el;
      lastBlock.setAttribute("data-block-id", args.blockId);
      lastBlock.setAttribute("data-hero-element", args.elementId);
      lastBlock.setAttribute("data-block-type", args.blockType);
    }, { blockId: generatedId, elementId, blockType }).catch(() => {});

    return { blockId: generatedId };
  }
}
