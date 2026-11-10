import { z } from "zod";
import type { Frame } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import type { SquarespaceBrowserService } from "../browser/squarespace-browser.service.js";
import type { SquarespacePagesService } from "../browser/squarespace-pages.service.js";
import { PlaywrightSquarespaceOperatorDriver } from "../workflow/playwright-squarespace-operator.driver.js";
import {
  heroPlanningInputSchema,
  planSquarespaceHero,
} from "../workflow/squarespace-hero-builder.js";
import {
  createSquarespaceHeroOperatorPlan,
  executeSquarespaceHeroPlan,
  squarespaceHeroOperatorPlanInputSchema,
} from "../workflow/squarespace-operator-engine.js";
import { outputSchema, readOnlyAnnotations, runTool } from "./tool-helpers.js";

export const buildSquarespaceHeroInputSchema = z.object({
  website_id: z.string().trim().min(1).describe("Website ID from list_websites."),
  page_id: z.string().trim().min(1).describe("Page ID from list_pages."),
  specification: z.unknown().describe("Structured Hero specification with content, styling, and layout."),
  section_id: z.string().trim().optional().describe("Optional existing target section ID. If omitted, targets the last section on the page."),
  auto_save: z.boolean().default(true).describe("Whether to save page changes after building the Hero section."),
});

export function registerHeroTools(
  server: McpServer,
  browser?: SquarespaceBrowserService,
  pages?: SquarespacePagesService,
  browserOperationLock?: BrowserOperationLock,
): void {
  server.registerTool(
    "plan_squarespace_hero",
    {
      description: "Validate a structured Squarespace Hero specification and return a staged, evidence-aware plan. Planning only: it does not inspect or control any browser, alter website content, save, or publish. Unverified editor operations remain unsupported.",
      inputSchema: heroPlanningInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runTool("plan_squarespace_hero", async () => planSquarespaceHero(input)),
  );
  server.registerTool(
    "plan_squarespace_hero_operator",
    {
      description: "Create a deterministic, section-ID-bound native Text/Button/Image block plan with an action budget below 40. Planning only; it does not control a browser or save/publish website changes.",
      inputSchema: squarespaceHeroOperatorPlanInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runTool("plan_squarespace_hero_operator", async () =>
        createSquarespaceHeroOperatorPlan(input)),
  );

  if (browser && pages && browserOperationLock) {
    server.registerTool(
      "build_squarespace_hero",
      {
        description: "Autonomously build and layout a complete native Squarespace Hero section (eyebrow, heading, description, buttons, image, layout) using Playwright browser automation and save changes.",
        inputSchema: buildSquarespaceHeroInputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) =>
        runTool(
          "build_squarespace_hero",
          async () => {
            const website = browser.getWebsite(input.website_id);
            const editorUrl = new URL("/config/website", website.url).toString();
            await browser.openWebsiteUrl(input.website_id, editorUrl);
            const browserPage = await browser.getCurrentPage();

            // Enter edit mode
            const editButton = browserPage.getByRole("button", { name: "Edit", exact: true }).first();
            if (await editButton.isVisible({ timeout: 5000 }).catch(() => false)) {
              await editButton.click().catch(() => {});
            }

            // Find content frame
            let frame: Frame | null = null;
            const siteFrameElement = browserPage.locator('iframe#sqs-site-frame, iframe[data-testid="sqs-site-frame"]').first();
            if ((await siteFrameElement.count()) > 0) {
              const siteFrame = await siteFrameElement.elementHandle();
              frame = siteFrame ? await siteFrame.contentFrame() : null;
            }
            if (!frame) {
              frame = browserPage.frames().find((f) => {
                try {
                  const u = new URL(f.url());
                  return u.origin === new URL(website.url).origin;
                } catch {
                  return false;
                }
              }) ?? null;
            }
            if (!frame) {
              throw new Error("Could not locate the Squarespace page editor frame.");
            }

            // Determine target section
            let targetSectionId = input.section_id;
            if (!targetSectionId) {
              const sections = frame.locator("[data-section-id]");
              const count = await sections.count();
              if (count > 0) {
                targetSectionId = (await sections.last().getAttribute("data-section-id")) ?? "section-hero";
              } else {
                targetSectionId = "section-hero";
              }
            }

            const plan = createSquarespaceHeroOperatorPlan({
              specification: input.specification,
              section_id: targetSectionId,
              max_browser_actions: 39,
            });

            const driver = new PlaywrightSquarespaceOperatorDriver(browserPage, frame);
            const report = await executeSquarespaceHeroPlan(plan, driver);

            let saved = false;
            if (input.auto_save) {
              try {
                await pages.savePageChanges(input.website_id, false);
                saved = true;
              } catch {
                const saveBtn = browserPage.locator('[data-test="frameToolbarSave"], button:has-text("Save")').first();
                if (await saveBtn.isVisible().catch(() => false)) {
                  await saveBtn.click().catch(() => {});
                  saved = true;
                }
              }
            }

            return {
              ...report,
              saved,
            };
          },
          browserOperationLock,
        ),
    );
  }
}
