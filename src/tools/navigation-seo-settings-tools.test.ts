import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SquarespaceNavigationSeoSettingsService } from "../browser/squarespace-navigation-seo-settings.service.js";
import type {
  PageNavigationNode,
  SquarespacePage,
} from "../browser/squarespace-pages.service.js";
import type { WebsiteSummary } from "../browser/squarespace-browser.service.js";
import type { SquarespaceSettingsInspection } from "../browser/squarespace-navigation-seo-settings.service.js";
import { registerNavigationSeoSettingsTools } from "./navigation-seo-settings-tools.js";

test("registers navigation, SEO, and website settings tools as read-only", async () => {
  const toolNames = [
    "list_main_navigation",
    "list_footer_navigation",
    "inspect_navigation_item",
    "inspect_navigation_links",
    "inspect_page_seo",
    "get_page_meta_title",
    "get_page_meta_description",
    "inspect_page_slug",
    "inspect_social_sharing_settings",
    "inspect_page_indexing_settings",
    "inspect_website_settings",
    "inspect_domain_settings",
    "inspect_site_information",
    "inspect_favicon",
    "inspect_social_links",
    "inspect_language_settings",
    "inspect_timezone_settings",
  ];
  const results = new Map<string, unknown>();
  const inspection: SquarespaceSettingsInspection = {
    async getNavigationStructure(websiteId) {
      return { websiteId, groups: [] };
    },
    async listMainNavigation(websiteId) {
      return { method: "list_main_navigation", websiteId };
    },
    async listFooterNavigation(websiteId) {
      return { method: "list_footer_navigation", websiteId };
    },
    async listNotLinkedPages(websiteId) {
      return [{ id: "page-1", websiteId }];
    },
    async inspectNavigationItem(websiteId, pageId) {
      return { method: "inspect_navigation_item", websiteId, pageId };
    },
    async inspectNavigationLinks(websiteId, pageId) {
      return { method: "inspect_navigation_links", websiteId, pageId };
    },
    async inspectPageSeo(websiteId, pageId) {
      return { method: "inspect_page_seo", websiteId, pageId };
    },
    async getPageMetaTitle(websiteId, pageId) {
      return { method: "get_page_meta_title", websiteId, pageId };
    },
    async getPageMetaDescription(websiteId, pageId) {
      return { method: "get_page_meta_description", websiteId, pageId };
    },
    async inspectPageSlug(websiteId, pageId) {
      return { method: "inspect_page_slug", websiteId, pageId };
    },
    async inspectSocialSharingSettings(websiteId, pageId) {
      return { method: "inspect_social_sharing_settings", websiteId, pageId };
    },
    async inspectPageIndexingSettings(websiteId, pageId) {
      return { method: "inspect_page_indexing_settings", websiteId, pageId };
    },
    async inspectWebsiteSettings(websiteId) {
      return { method: "inspect_website_settings", websiteId };
    },
    async inspectDomainSettings(websiteId) {
      return { method: "inspect_domain_settings", websiteId };
    },
    async inspectSiteInformation(websiteId) {
      return { method: "inspect_site_information", websiteId };
    },
    async inspectFavicon(websiteId) {
      return { method: "inspect_favicon", websiteId };
    },
    async inspectSocialLinks(websiteId) {
      return { method: "inspect_social_links", websiteId };
    },
    async inspectLanguageSettings(websiteId) {
      return { method: "inspect_language_settings", websiteId };
    },
    async inspectTimezoneSettings(websiteId) {
      return { method: "inspect_timezone_settings", websiteId };
    },
  };
  const server = new McpServer({ name: "navigation-settings-test", version: "1.0.0" });
  const client = new Client({ name: "navigation-settings-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerNavigationSeoSettingsTools(server, inspection);

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...toolNames].sort(),
    );
    assert.ok(listed.tools.every((tool) =>
      tool.annotations?.readOnlyHint === true &&
      tool.annotations.destructiveHint === false,
    ));

    for (const name of toolNames) {
      const needsPage = [
        "inspect_navigation_item",
        "inspect_page_seo",
        "get_page_meta_title",
        "get_page_meta_description",
        "inspect_page_slug",
        "inspect_page_indexing_settings",
      ].includes(name);
      const result = await client.callTool({
        name,
        arguments: needsPage
          ? { website_id: "site-1", page_id: "page-1" }
          : { website_id: "site-1" },
      });
      assert.equal(result.isError, undefined, name);
      const value = z.object({ method: z.string() }).parse(
        result.structuredContent?.result,
      );
      assert.equal(value.method, name);
      results.set(name, value);
    }

    const withOptionalPage = await client.callTool({
      name: "inspect_navigation_links",
      arguments: { website_id: "site-1", page_id: "page-1" },
    });
    assert.equal(withOptionalPage.isError, undefined);
    assert.equal(
      z.object({ pageId: z.string() }).parse(
        withOptionalPage.structuredContent?.result,
      ).pageId,
      "page-1",
    );

    const invalid = await client.callTool({
      name: "inspect_page_seo",
      arguments: { website_id: " ", page_id: "page-1" },
    });
    assert.equal(invalid.isError, true);

    for (const mutationName of [
      "create_page",
      "update_page_title",
      "update_page_url",
      "delete_page",
      "publish_page",
      "update_social_links",
      "update_seo_metadata",
    ]) {
      assert.equal(
        listed.tools.some((tool) => tool.name === mutationName),
        false,
        mutationName,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("inspects navigation sibling order and parent hierarchy from the Pages panel tree", async () => {
  const websiteId = "fixture-site";
  const parent: SquarespacePage = {
    id: "folder-1",
    websiteId,
    name: "Projects",
    navigationTitle: "Projects",
    type: "folder",
    group: "main_navigation",
    groupLabel: "Main Navigation",
    parentId: null,
    parentPath: [],
    url: null,
    visibilityStatus: "unknown",
    enabled: null,
  };
  const child: SquarespacePage = {
    id: "page-2",
    websiteId,
    name: "Second",
    navigationTitle: "Second",
    type: "page",
    group: "main_navigation",
    groupLabel: "Main Navigation",
    parentId: parent.id,
    parentPath: [parent.name],
    url: "https://fixture.squarespace.com/second",
    visibilityStatus: "enabled",
    enabled: true,
  };
  const tree: PageNavigationNode = { ...parent, children: [{ ...child, children: [] }] };
  const website: WebsiteSummary = {
    id: websiteId,
    name: "Fixture site",
    url: "https://fixture.squarespace.com/config",
  };
  const service = new SquarespaceNavigationSeoSettingsService(
    {
      getWebsite: () => website,
      async listWebsites() {
        return [website];
      },
      async openWebsitePages() {},
      async openWebsiteUrl() {},
      async getCurrentPage() {
        throw new Error("Navigation tree inspection should not open a browser page.");
      },
    },
    {
      async getNavigationStructure(id) {
        return {
          websiteId: id,
          groups: [
            { group: "main_navigation", label: "Main Navigation", pages: [tree] },
            { group: "footer_navigation", label: "Footer Navigation", pages: [] },
            { group: "not_linked", label: "Not Linked", pages: [] },
            { group: "other", label: "Other", pages: [] },
          ],
        };
      },
      async getPageDetails() {
        return child;
      },
      async inspectPageSections() {
        throw new Error("Rendered inspection is not part of this test.");
      },
      async inspectPageSeoSettings() {
        throw new Error("SEO inspection is not part of this test.");
      },
      async listPages() {
        return [parent, child];
      },
      async listNotLinkedPages() {
        return [];
      },
    },
  );
  assert.deepEqual(await service.inspectNavigationItem(websiteId, child.id), {
    websiteId,
    source: "squarespace_pages_panel",
    item: tree.children[0],
    order: 1,
    parentPath: ["Projects"],
  });
});

test("reads regional settings through the observed Squarespace settings navigation", async () => {
    const websiteId = "settings-fixture-site";
    const website: WebsiteSummary = {
      id: websiteId,
      name: "Settings Fixture",
      url: "https://fixture.squarespace.com/config",
    };
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route("https://fixture.squarespace.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body>
          <button type="button">Website</button>
          <a data-test="menuItem-website" href="/config/website">Website settings</a>
          <button aria-label="Settings" type="button">Settings</button>
          <button type="button">Site Languages</button>
          <button type="button">Regional Settings</button>
          <script>
            document.addEventListener("click", event => {
              const target = event.target;
              if (!(target instanceof Element)) return;
              const link = target.closest('a[data-test="menuItem-website"]');
              if (link) {
                event.preventDefault();
                history.pushState({}, "", link.getAttribute("href"));
              }
              if (target.closest('button')?.textContent?.trim() === "Regional Settings") {
                history.pushState(
                  {},
                  "",
                  "/config/settings/website/language-region/regional-settings",
                );
                document.body.insertAdjacentHTML("beforeend", \`
                  <button role="combobox">Country United States</button>
                  <button role="combobox">Time Zone America/New_York</button>
                  <label>Imperial<input type="radio" checked></label>
                \`);
              }
            });
          </script>
        </body></html>`,
      });
    });

    const service = new SquarespaceNavigationSeoSettingsService(
      {
        getWebsite: (id) => {
          assert.equal(id, websiteId);
          return website;
        },
        async listWebsites() {
          return [website];
        },
        async openWebsitePages(id) {
          assert.equal(id, websiteId);
          await page.goto("https://fixture.squarespace.com/config/pages");
        },
        async openWebsiteUrl() {
          throw new Error("Regional settings inspection should not open a public page.");
        },
        async getCurrentPage() {
          return page;
        },
      },
      {
        async getNavigationStructure(id) {
          await page.goto("https://fixture.squarespace.com/config/pages");
          return { websiteId: id, groups: [] };
        },
        async getPageDetails() {
          throw new Error("Regional settings inspection should not read a page record.");
        },
        async inspectPageSections() {
          throw new Error("Regional settings inspection should not inspect page sections.");
        },
        async inspectPageSeoSettings() {
          throw new Error("Regional settings inspection should not inspect page SEO.");
        },
        async listPages() {
          return [];
        },
        async listNotLinkedPages() {
          return [];
        },
      },
      1_000,
    );

    try {
      const result = await service.inspectTimezoneSettings(websiteId) as {
        timezone: string | null;
        country: string | null;
        measurementStandard: string | null;
        available: boolean;
      };
      assert.deepEqual(result, {
        websiteId,
        source: "squarespace_regional_settings",
        timezone: "America/New_York",
        country: "United States",
        measurementStandard: "Imperial",
        available: true,
      });
    } finally {
      await browser.close();
    }
  });
