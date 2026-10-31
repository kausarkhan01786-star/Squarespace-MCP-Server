import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SquarespaceDesignService } from "../browser/squarespace-design.service.js";
import { outputSchema, readOnlyAnnotations, runTool } from "./tool-helpers.js";

const websiteInput = z.object({
  website_id: z.string().trim().min(1).describe("ID returned by list_websites."),
});
const pageInput = websiteInput.extend({
  page_id: z.string().trim().min(1).describe("ID returned by list_pages."),
});
const sectionInput = pageInput.extend({
  section_id: z.string().trim().min(1).describe("Section ID returned by list_page_sections."),
});
const blockInput = pageInput.extend({
  block_id: z.string().trim().min(1).describe("Block ID returned by list_content_blocks."),
});

export function registerDesignTools(
  server: McpServer,
  design: SquarespaceDesignService,
): void {
  server.registerTool(
    "inspect_design_settings",
    {
      description: "Inspect the Squarespace Site Styles settings screen without changing or saving settings. Returns a structured error if the UI does not expose inspectable controls.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("inspect_design_settings", () =>
        design.inspectDesignSettings(website_id),
      ),
  );

  server.registerTool(
    "inspect_site_styles",
    {
      description: "Inspect visible Squarespace Site Styles controls. This does not save design changes.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("inspect_site_styles", () => design.inspectSiteStyles(website_id)),
  );

  server.registerTool(
    "inspect_typography",
    {
      description: "Read computed typography from visible headings and text on the selected rendered page; these are page styles, not a complete site-wide font preset catalog.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_typography", () =>
        design.inspectTypography(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_color_themes",
    {
      description: "Read observed section theme IDs and computed rendered colors for the selected page, not the full site-wide palette editor.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_color_themes", () =>
        design.inspectColorThemes(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_button_styles",
    {
      description: "Read computed styles for visible semantic buttons on the rendered page; styled links and site-wide button presets are not inferred.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_button_styles", () =>
        design.inspectButtonStyles(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_section_settings",
    {
      description: "Inspect rendered section theme, layout, dimensions, and computed colors without opening editing controls.",
      inputSchema: sectionInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id, section_id }) =>
      runTool("inspect_section_settings", () =>
        design.inspectSectionSettings(website_id, page_id, section_id),
      ),
  );

  server.registerTool(
    "list_content_blocks",
    {
      description: "List blocks observed on the selected rendered page, preserving raw Squarespace block types and definition names.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("list_content_blocks", () =>
        design.listContentBlocks(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_content_block",
    {
      description: "Inspect a block's observed ID, raw type, definition name, containing section, and visible text without opening its editor.",
      inputSchema: blockInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id, block_id }) =>
      runTool("inspect_content_block", () =>
        design.inspectContentBlock(website_id, page_id, block_id),
      ),
  );

  server.registerTool(
    "get_block_edit_schema",
    {
      description: "Request the observed edit form schema for a block. Returns an explicit error when Squarespace does not expose a verified editor schema.",
      inputSchema: blockInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id, block_id }) =>
      runTool("get_block_edit_schema", () =>
        design.getBlockEditSchema(website_id, page_id, block_id),
      ),
  );

  server.registerTool(
    "list_available_block_types",
    {
      description: "List block type identifiers observed on the selected rendered page. This is not an exhaustive add-block catalog.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("list_available_block_types", () =>
        design.listAvailableBlockTypes(website_id, page_id),
      ),
  );
}
