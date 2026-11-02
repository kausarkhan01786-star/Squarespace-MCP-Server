import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PageBackupService } from "../backups/page-backup.service.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { SquarespacePagesService } from "../browser/squarespace-pages.service.js";
import {
  outputSchema,
  readOnlyAnnotations,
  runTool,
} from "./tool-helpers.js";

const websiteIdSchema = z.object({
  website_id: z.string().trim().min(1).describe("ID returned by list_websites."),
});
const pageInputSchema = websiteIdSchema.extend({
  page_id: z.string().trim().min(1).describe("ID returned by list_pages."),
});
const sectionInputSchema = pageInputSchema.extend({
  section_id: z.string().trim().min(1).describe("Section ID returned by list_page_sections."),
});
const snapshotInputSchema = pageInputSchema;
const snapshotIdSchema = z.object({
  snapshot_id: z.string().uuid().describe("Snapshot UUID returned by create_page_snapshot or list_snapshots."),
});
const listPagesSchema = websiteIdSchema.extend({
  group: z.enum(["main_navigation", "footer_navigation", "not_linked", "other"]).optional(),
});
export function registerPagesTools(
  server: McpServer,
  pages: SquarespacePagesService,
  backups: PageBackupService,
  browserOperationLock: BrowserOperationLock,
): void {
  const runBrowserTool = (toolName: string, action: () => Promise<unknown>) =>
    runTool(toolName, action, browserOperationLock);

  server.registerTool(
    "list_websites",
    {
      description: "List Squarespace websites available in the manually authenticated browser session.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runBrowserTool("list_websites", () => pages.listWebsites()),
  );

  server.registerTool(
    "create_page_snapshot",
    {
      description: "Save a local JSON snapshot of the inspected page and capture a full-page screenshot plus individual section screenshots where available. Does not modify or publish the Squarespace website.",
      inputSchema: snapshotInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runBrowserTool(
        "create_page_snapshot",
        () => backups.createPageSnapshot(website_id, page_id),
      ),
  );

  server.registerTool(
    "list_snapshots",
    {
      description: "List locally saved page snapshots and their captured screenshot counts.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runTool("list_snapshots", () => backups.listSnapshots()),
  );

  server.registerTool(
    "get_snapshot",
    {
      description: "Read a validated local page snapshot by UUID.",
      inputSchema: snapshotIdSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ snapshot_id }) =>
      runTool("get_snapshot", () => backups.getSnapshot(snapshot_id)),
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
      runBrowserTool(
        "list_pages",
        () => pages.listPages(website_id, group),
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
      runBrowserTool(
        "get_page_details",
        () => pages.getPageDetails(website_id, page_id),
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
      runBrowserTool("get_page_url", () => pages.getPageUrl(website_id, page_id)),
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
      runBrowserTool(
        "get_navigation_structure",
        () => pages.getNavigationStructure(website_id),
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
      runBrowserTool(
        "list_not_linked_pages",
        () => pages.listNotLinkedPages(website_id),
      ),
  );

  server.registerTool(
    "list_page_sections",
    {
      description: "List visible section IDs, themes, layouts, headings, and observed block identifiers for one page.",
      inputSchema: pageInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runBrowserTool(
        "list_page_sections",
        () => pages.listPageSections(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_section",
    {
      description: "Inspect one visible Squarespace section and its observed blocks without editing or publishing it.",
      inputSchema: sectionInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id, section_id }) =>
      runBrowserTool(
        "inspect_section",
        () => pages.inspectSection(website_id, page_id, section_id),
      ),
  );

  server.registerTool(
    "inspect_mobile_responsive",
    {
      description: "Compare rendered section widths and horizontal overflow at the current desktop size and a 390x844 mobile viewport.",
      inputSchema: pageInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runBrowserTool(
        "inspect_mobile_responsive",
        () => pages.inspectMobileResponsive(website_id, page_id),
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
      runBrowserTool(
        "inspect_page_sections",
        () => pages.inspectPageSections(website_id, page_id),
      ),
  );
}
