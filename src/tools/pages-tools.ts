import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import { SquarespacePagesService } from "../browser/squarespace-pages.service.js";

const outputSchema = z.object({ result: z.unknown() });
const websiteIdSchema = z.object({
  website_id: z.string().trim().min(1).describe("ID returned by list_websites."),
});
const pageInputSchema = websiteIdSchema.extend({
  page_id: z.string().trim().min(1).describe("ID returned by list_pages."),
});
const listPagesSchema = websiteIdSchema.extend({
  group: z.enum(["main_navigation", "footer_navigation", "not_linked", "other"]).optional(),
});
const createPageSchema = websiteIdSchema.extend({
  title: z.string().trim().min(1).max(100).describe("Title for the new page."),
  page_type: z.enum(["page", "blog"]).describe("Blank Squarespace page type to create."),
  navigation_group: z
    .enum(["main_navigation", "not_linked", "footer_navigation"])
    .describe("Navigation group where the page should be created."),
});
const updatePageTitleSchema = pageInputSchema.extend({
  title: z.string().trim().min(1).max(100).describe("New page title."),
});
const updatePageUrlSchema = pageInputSchema.extend({
  url_slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/)
    .describe("New single-segment URL slug; do not include a domain or path separators."),
});
const movePageSchema = pageInputSchema.extend({
  destination_group: z
    .enum(["main_navigation", "footer_navigation", "not_linked"])
    .describe("Navigation group where the page should be moved."),
  destination_folder_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional folder ID in the destination group."),
});
const deletePageSchema = pageInputSchema.extend({
  confirmation: z
    .literal("DELETE")
    .describe("Explicit confirmation required before deleting a page."),
});
const savePageChangesSchema = websiteIdSchema.extend({
  publish: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to publish the saved changes to the live site."),
  confirmation: z
    .literal("PUBLISH")
    .optional()
    .describe("Required when publish is true."),
}).superRefine((value, context) => {
  if (value.publish && value.confirmation !== "PUBLISH") {
    context.addIssue({
      code: "custom",
      path: ["confirmation"],
      message: "Publishing changes requires confirmation: PUBLISH.",
    });
  }
});
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const pageCreationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const pageDuplicationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const pageMoveAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const pageUpdateAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const pageDeleteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const pageSaveAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerPagesTools(
  server: McpServer,
  pages: SquarespacePagesService,
): void {
  server.registerTool(
    "list_websites",
    {
      description: "List Squarespace websites available in the manually authenticated browser session.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runTool("list_websites", () => pages.listWebsites()),
  );

  server.registerTool(
    "create_page",
    {
      description: "Create a blank Squarespace Page or Blog in a selected navigation group. Does not invoke a publish action.",
      inputSchema: createPageSchema,
      outputSchema,
      annotations: pageCreationAnnotations,
    },
    async ({ website_id, title, page_type, navigation_group }) =>
      runTool("create_page", () =>
        pages.createPage(website_id, title, page_type, navigation_group),
      ),
  );

  server.registerTool(
    "duplicate_page",
    {
      description: "Duplicate a Squarespace page using its visible Page Settings control and verify the copy appears.",
      inputSchema: pageInputSchema,
      outputSchema,
      annotations: pageDuplicationAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("duplicate_page", () =>
        pages.duplicatePage(website_id, page_id),
      ),
  );

  server.registerTool(
    "move_page",
    {
      description: "Move a Squarespace page to a navigation group or folder using the visible Pages-panel drag-and-drop controls.",
      inputSchema: movePageSchema,
      outputSchema,
      annotations: pageMoveAnnotations,
    },
    async ({ website_id, page_id, destination_group, destination_folder_id }) =>
      runTool("move_page", () =>
        pages.movePage(
          website_id,
          page_id,
          destination_group,
          destination_folder_id,
        ),
      ),
  );

  server.registerTool(
    "delete_page",
    {
      description: "Delete a non-homepage Squarespace page after explicit DELETE confirmation, then verify it was removed.",
      inputSchema: deletePageSchema,
      outputSchema,
      annotations: pageDeleteAnnotations,
    },
    async ({ website_id, page_id, confirmation }) =>
      runTool("delete_page", () =>
        pages.deletePage(website_id, page_id, confirmation),
      ),
  );

  server.registerTool(
    "save_page_changes",
    {
      description: "Save the currently open Squarespace editor changes, or publish them after explicit PUBLISH confirmation, then verify visible Squarespace confirmation.",
      inputSchema: savePageChangesSchema,
      outputSchema,
      annotations: pageSaveAnnotations,
    },
    async ({ website_id, publish, confirmation }) =>
      runTool("save_page_changes", () =>
        pages.savePageChanges(website_id, publish, confirmation),
      ),
  );

  server.registerTool(
    "update_page_title",
    {
      description: "Update and verify a Squarespace page title without changing its navigation title or invoking publish.",
      inputSchema: updatePageTitleSchema,
      outputSchema,
      annotations: pageUpdateAnnotations,
    },
    async ({ website_id, page_id, title }) =>
      runTool("update_page_title", () =>
        pages.updatePageTitle(website_id, page_id, title),
      ),
  );

  server.registerTool(
    "update_page_url",
    {
      description: "Update and verify a page's URL Slug. The Squarespace homepage's fixed root URL cannot be changed.",
      inputSchema: updatePageUrlSchema,
      outputSchema,
      annotations: pageUpdateAnnotations,
    },
    async ({ website_id, page_id, url_slug }) =>
      runTool("update_page_url", () =>
        pages.updatePageUrl(website_id, page_id, url_slug),
      ),
  );

  server.registerTool(
    "list_pages",
    {
      description: "Read page names, URLs, types, navigation groups, nesting, and enabled status for a Squarespace website.",
      inputSchema: listPagesSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, group }) =>
      runTool("list_pages", () =>
        pages.listPages(website_id, group),
      ),
  );

  server.registerTool(
    "get_page_details",
    {
      description: "Read the visible settings and navigation details for one Squarespace page.",
      inputSchema: pageInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("get_page_details", () =>
        pages.getPageDetails(website_id, page_id),
      ),
  );

  server.registerTool(
    "get_page_url",
    {
      description: "Return the internal Squarespace URL slug resolved for one page.",
      inputSchema: pageInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("get_page_url", () => pages.getPageUrl(website_id, page_id)),
  );

  server.registerTool(
    "get_navigation_structure",
    {
      description: "Return Main Navigation, Footer Navigation, and Not Linked pages as a nested tree.",
      inputSchema: websiteIdSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("get_navigation_structure", () =>
        pages.getNavigationStructure(website_id),
      ),
  );

  server.registerTool(
    "list_not_linked_pages",
    {
      description: "List pages in Squarespace's Not Linked group, including nested pages.",
      inputSchema: websiteIdSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("list_not_linked_pages", () =>
        pages.listNotLinkedPages(website_id),
      ),
  );

  server.registerTool(
    "inspect_page_sections",
    {
      description: "Inspect visible content sections on one Squarespace page without editing or publishing it.",
      inputSchema: pageInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_page_sections", () =>
        pages.inspectPageSections(website_id, page_id),
      ),
  );
}

async function runTool(
  toolName: string,
  action: () => Promise<unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: { result: unknown };
  isError?: boolean;
}> {
  try {
    const result = await action();
    return {
      content: [{ type: "text", text: JSON.stringify({ result }) }],
      structuredContent: { result },
    };
  } catch (error) {
    const detail = error instanceof SquarespaceBrowserError
      ? { code: error.code, message: error.message }
      : {
          code: "UNEXPECTED_ERROR",
          message: error instanceof Error ? error.message : "The tool failed for an unknown reason.",
        };
    console.error(`[${toolName}] ${detail.code}: ${detail.message}`);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: detail }) }],
    };
  }
}
