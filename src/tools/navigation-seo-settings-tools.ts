import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import type { SquarespaceSettingsInspection } from "../browser/squarespace-navigation-seo-settings.service.js";
import { SETTINGS_CATEGORY_IDS } from "../browser/squarespace-navigation-seo-settings.service.js";
import {
  outputSchema,
  readOnlyAnnotations,
  runTool as executeTool,
} from "./tool-helpers.js";

const websiteInput = z.object({
  website_id: z.string().trim().min(1).describe("ID returned by list_websites."),
});
const pageInput = websiteInput.extend({
  page_id: z.string().trim().min(1).describe("ID returned by list_pages."),
});
const optionalPageInput = websiteInput.extend({
  page_id: z.string().trim().min(1).optional().describe("Optional page ID returned by list_pages."),
});

export function registerNavigationSeoSettingsTools(
  server: McpServer,
  inspection: SquarespaceSettingsInspection,
  browserOperationLock: BrowserOperationLock,
): void {
  const runTool = (toolName: string, action: () => Promise<unknown>) =>
    executeTool(toolName, action, browserOperationLock);

  server.registerTool(
    "inspect_settings_category",
    {
      description: "Inspect safely readable, visible Squarespace settings values for one category. Sensitive, masked, hidden, and unsupported values are excluded; no settings are changed.",
      inputSchema: websiteInput.extend({
        category_id: z.enum(SETTINGS_CATEGORY_IDS),
      }),
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, category_id }) =>
      runTool("inspect_settings_category", () =>
        inspection.inspectSettingsCategory(website_id, category_id),
      ),
  );

  server.registerTool(
    "list_main_navigation",
    {
      description: "List the hierarchical Main Navigation items and their observed page metadata.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("list_main_navigation", () => inspection.listMainNavigation(website_id)),
  );

  server.registerTool(
    "list_footer_navigation",
    {
      description: "List the hierarchical Footer Navigation items and their observed page metadata.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("list_footer_navigation", () => inspection.listFooterNavigation(website_id)),
  );

  server.registerTool(
    "inspect_navigation_item",
    {
      description: "Inspect one Pages-panel item, including its type, hierarchy, sibling order, URL, and visibility metadata.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_navigation_item", () =>
        inspection.inspectNavigationItem(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_navigation_links",
    {
      description: "Inspect rendered header navigation and footer links for a page. Defaults to the website homepage; Squarespace Pages-panel hierarchy remains the authoritative ordering source.",
      inputSchema: optionalPageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_navigation_links", () =>
        inspection.inspectNavigationLinks(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_page_seo",
    {
      description: "Inspect page SEO settings and rendered HTML metadata, labeling each value by its source. Homepage values may inherit from website Search Appearance.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_page_seo", () => inspection.inspectPageSeo(website_id, page_id)),
  );

  server.registerTool(
    "get_page_meta_title",
    {
      description: "Return the page-specific SEO title, website title format where applicable, and rendered HTML title with source labels.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("get_page_meta_title", () =>
        inspection.getPageMetaTitle(website_id, page_id),
      ),
  );

  server.registerTool(
    "get_page_meta_description",
    {
      description: "Return the page-specific SEO description, website description where applicable, and rendered HTML description with source labels.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("get_page_meta_description", () =>
        inspection.getPageMetaDescription(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_page_slug",
    {
      description: "Read the visible URL Slug field and resolved page URL from Squarespace page settings.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_page_slug", () =>
        inspection.inspectPageSlug(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_social_sharing_settings",
    {
      description: "Inspect observed site-wide and optional page-specific social image settings without reading or changing image uploads.",
      inputSchema: optionalPageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_social_sharing_settings", () =>
        inspection.inspectSocialSharingSettings(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_page_indexing_settings",
    {
      description: "Read the page's Hide from Search Results setting, page enabled status, and rendered robots metadata.",
      inputSchema: pageInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, page_id }) =>
      runTool("inspect_page_indexing_settings", () =>
        inspection.inspectPageIndexingSettings(website_id, page_id),
      ),
  );

  server.registerTool(
    "inspect_website_settings",
    {
      description: "List observed Squarespace Website settings categories and settings cards without opening edit forms.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("inspect_website_settings", () =>
        inspection.inspectWebsiteSettings(website_id),
      ),
  );

  server.registerTool(
    "inspect_domain_settings",
    {
      description: "Inspect the Domains & Email settings overview. Returns an explicit unavailable status when Squarespace does not expose configured domain records.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("inspect_domain_settings", () =>
        inspection.inspectDomainSettings(website_id),
      ),
  );

  server.registerTool(
    "inspect_site_information",
    {
      description: "Read the site name and website URL from the authenticated Squarespace website listing; does not return account-owner information.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("inspect_site_information", () =>
        inspection.inspectSiteInformation(website_id),
      ),
  );

  server.registerTool(
    "inspect_favicon",
    {
      description: "Inspect observed favicon upload controls and visible preview count without accessing account or upload data.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("inspect_favicon", () => inspection.inspectFavicon(website_id)),
  );

  server.registerTool(
    "inspect_social_links",
    {
      description: "Inspect configured public social links and omit email links and private account information.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("inspect_social_links", () => inspection.inspectSocialLinks(website_id)),
  );

  server.registerTool(
    "inspect_language_settings",
    {
      description: "Inspect the visible Site Languages setting and explicitly identify a language value that Squarespace does not expose.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("inspect_language_settings", () =>
        inspection.inspectLanguageSettings(website_id),
      ),
  );

  server.registerTool(
    "inspect_timezone_settings",
    {
      description: "Read the visible country, time zone, and measurement standard from Squarespace Regional Settings.",
      inputSchema: websiteInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id }) =>
      runTool("inspect_timezone_settings", () =>
        inspection.inspectTimezoneSettings(website_id),
      ),
  );
}
