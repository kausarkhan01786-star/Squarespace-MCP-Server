import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chromium } from "playwright";
import { z } from "zod";
import {
  designMutationGuardSchema,
  verifyDesignMutationGuard,
} from "../browser/design-mutation-guard.js";
import { SquarespaceDesignService } from "../browser/squarespace-design.service.js";
import type { PageSnapshot } from "../backups/page-backup.service.js";
import type { WebsiteSummary } from "../browser/squarespace-browser.service.js";
import { registerDesignTools } from "./design-tools.js";

test("registers ten read-only design tools and returns observed DOM metadata", async () => {
  const website: WebsiteSummary = {
    id: "fixture-site",
    name: "Fixture website",
    url: "https://fixture.squarespace.com/config",
  };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let siteStylesLoading = true;
  await page.route("https://fixture.squarespace.com/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/config/pages") {
      const spinnerMarkup = siteStylesLoading
        ? `<div data-test="loading-spinner" hidden style="width: 12px; height: 12px;"></div>
           <div data-test="loading-spinner" style="width: 12px; height: 12px;"></div>`
        : `<div data-test="loading-spinner" hidden style="width: 12px; height: 12px;"></div>`;
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body>
          <button data-test="frameToolbarSiteStyles" onclick="history.pushState({}, '', '/config/site-styles')">Site Styles</button>
          ${spinnerMarkup}
        </body></html>`,
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><style>
        h1 { font-family: Fixture Serif, serif; font-size: 32px; font-weight: 700; }
        p { line-height: 24px; }
        button { color: rgb(255, 255, 255); background-color: rgb(10, 20, 30); border-radius: 8px; }
      </style></head><body>
        <section data-test="page-section" data-section-id="section-1" data-section-theme="blue" data-fluid-engine-section style="background-color: rgb(1, 2, 3); color: rgb(4, 5, 6); padding: 12px;">
          <h1>Heading</h1>
          <p>Paragraph</p>
          <div id="block-1" data-block-type="1337" data-definition-name="website.components.html"><p>Block text</p></div>
          <button>Call to action</button>
        </section>
      </body></html>`,
    });
  });

  const pages = {
    async inspectPageSections() {
      await page.goto("https://fixture.squarespace.com/home");
      return {
        websiteId: website.id,
        pageId: "page-1",
        url: "https://fixture.squarespace.com/home",
        sections: [{
          id: "section-1",
          theme: "blue",
          layout: "fluid_engine" as const,
          headings: ["Heading"],
          visibleText: "Heading\nParagraph\nBlock text\nCall to action",
          textTruncated: false,
          blocks: [{
            id: "block-1",
            type: "1337",
            definitionName: "website.components.html",
            visibleText: "Block text",
            textTruncated: false,
          }],
          blocksTruncated: false,
        }],
        sectionsTruncated: false,
      };
    },
  };
  const design = new SquarespaceDesignService({
    getWebsite(websiteId) {
      assert.equal(websiteId, website.id);
      return website;
    },
    async openWebsitePages(websiteId) {
      assert.equal(websiteId, website.id);
      await page.goto("https://fixture.squarespace.com/config/pages");
    },
    async getCurrentPage() {
      return page;
    },
  }, pages, 50);
  const server = new McpServer({ name: "design-tools-test", version: "1.0.0" });
  const client = new Client({ name: "design-tools-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerDesignTools(server, design);

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "get_block_edit_schema",
        "inspect_button_styles",
        "inspect_color_themes",
        "inspect_content_block",
        "inspect_design_settings",
        "inspect_section_settings",
        "inspect_site_styles",
        "inspect_typography",
        "list_available_block_types",
        "list_content_blocks",
      ],
    );
    assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));
    for (const name of [
      "add_content_block",
      "add_content_section",
      "duplicate_content_block",
      "duplicate_section",
      "remove_content_block",
      "reorder_content_blocks",
      "update_button_block",
      "update_image_block",
      "update_section_settings",
      "update_text_block",
    ]) {
      assert.equal(listed.tools.some((tool) => tool.name === name), false);
    }
    assert.deepEqual(designMutationGuardSchema.parse({
      website_id: website.id,
      page_id: "page-1",
      pre_change_snapshot_id: "1c69b444-aeff-4a9e-8a8f-b8b2f09b5853",
      confirmed: true,
    }), {
      website_id: website.id,
      page_id: "page-1",
      pre_change_snapshot_id: "1c69b444-aeff-4a9e-8a8f-b8b2f09b5853",
      confirmed: true,
    });
    assert.throws(() => designMutationGuardSchema.parse({
      website_id: website.id,
      page_id: "page-1",
      pre_change_snapshot_id: "1c69b444-aeff-4a9e-8a8f-b8b2f09b5853",
      confirmed: false,
    }));
    const snapshot: PageSnapshot = {
      snapshotId: "1c69b444-aeff-4a9e-8a8f-b8b2f09b5853",
      createdAt: "2026-10-31T16:18:54.124Z",
      website: {
        id: website.id,
        name: website.name,
        url: website.url,
      },
      page: {
        id: "page-1",
        websiteId: website.id,
        name: "Home",
        navigationTitle: "Home",
        type: "page",
        group: "main_navigation",
        groupLabel: "Main Navigation",
        parentId: null,
        parentPath: [],
        url: "https://fixture.squarespace.com/home",
        visibilityStatus: "unknown",
        enabled: null,
      },
      pageUrl: "https://fixture.squarespace.com/home",
      sections: [],
      sectionsTruncated: false,
      screenshots: [],
    };
    const guard = {
      website_id: website.id,
      page_id: "page-1",
      pre_change_snapshot_id: snapshot.snapshotId,
      confirmed: true,
    };
    assert.deepEqual(
      await verifyDesignMutationGuard(guard, async () => snapshot),
      guard,
    );
    await assert.rejects(
      verifyDesignMutationGuard(
        { ...guard, page_id: "another-page" },
        async () => snapshot,
      ),
      { code: "DESIGN_MUTATION_PRECONDITION_FAILED" },
    );

    const blocks = await client.callTool({
      name: "list_content_blocks",
      arguments: { website_id: website.id, page_id: "page-1" },
    });
    assert.equal(blocks.isError, undefined);
    const blockListResult = z.object({
      blocks: z.array(z.object({ type: z.string().nullable() })),
    }).parse(blocks.structuredContent?.result);
    assert.equal(blockListResult.blocks[0]?.type, "1337");

    const block = await client.callTool({
      name: "inspect_content_block",
      arguments: { website_id: website.id, page_id: "page-1", block_id: "block-1" },
    });
    assert.equal(block.isError, undefined);
    const blockResult = z.object({
      block: z.object({ definitionName: z.string().nullable() }),
    }).parse(block.structuredContent?.result);
    assert.equal(blockResult.block.definitionName, "website.components.html");

    const typeCatalog = await client.callTool({
      name: "list_available_block_types",
      arguments: { website_id: website.id, page_id: "page-1" },
    });
    assert.equal(typeCatalog.isError, undefined);
    const typeCatalogResult = z.object({
      complete: z.boolean(),
      types: z.array(z.object({
        type: z.string().nullable(),
        definitionName: z.string().nullable(),
      })),
    }).parse(typeCatalog.structuredContent?.result);
    assert.equal(typeCatalogResult.complete, false);
    assert.deepEqual(typeCatalogResult.types, [{
      type: "1337",
      definitionName: "website.components.html",
    }]);

    const typography = await client.callTool({
      name: "inspect_typography",
      arguments: { website_id: website.id, page_id: "page-1" },
    });
    const typographyResult = z.object({
      source: z.literal("rendered_page_computed_styles"),
      samples: z.array(z.object({
        tag: z.string(),
        fontFamily: z.string(),
      })),
    }).parse(typography.structuredContent?.result);
    assert.ok(typographyResult.samples.some((sample) =>
      sample.tag === "h1" && sample.fontFamily.includes("Fixture Serif")));

    const colors = await client.callTool({
      name: "inspect_color_themes",
      arguments: { website_id: website.id, page_id: "page-1" },
    });
    const colorResult = z.object({
      sections: z.array(z.object({
        theme: z.string().nullable(),
        backgroundColor: z.string(),
      })),
    }).parse(colors.structuredContent?.result);
    assert.equal(colorResult.sections[0]?.theme, "blue");
    assert.equal(colorResult.sections[0]?.backgroundColor, "rgb(1, 2, 3)");

    const buttons = await client.callTool({
      name: "inspect_button_styles",
      arguments: { website_id: website.id, page_id: "page-1" },
    });
    const buttonResult = z.object({
      complete: z.literal(false),
      buttons: z.array(z.object({
        backgroundColor: z.string(),
        borderRadius: z.string(),
      })),
    }).parse(buttons.structuredContent?.result);
    assert.equal(buttonResult.buttons[0]?.backgroundColor, "rgb(10, 20, 30)");
    assert.equal(buttonResult.buttons[0]?.borderRadius, "8px");

    const sectionSettings = await client.callTool({
      name: "inspect_section_settings",
      arguments: {
        website_id: website.id,
        page_id: "page-1",
        section_id: "section-1",
      },
    });
    const sectionResult = z.object({
      section: z.object({
        id: z.string(),
        theme: z.string().nullable(),
        layout: z.enum(["fluid_engine", "unknown"]),
        padding: z.string(),
      }),
    }).parse(sectionSettings.structuredContent?.result);
    assert.equal(sectionResult.section.id, "section-1");
    assert.equal(sectionResult.section.layout, "fluid_engine");
    assert.match(sectionResult.section.padding, /12px/);

    for (const name of ["inspect_design_settings", "inspect_site_styles"]) {
      if (name === "inspect_site_styles") {
        siteStylesLoading = false;
      }
      const result = await client.callTool({
        name,
        arguments: { website_id: website.id },
      });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0]?.text ?? "", /DESIGN_PANEL_NOT_AVAILABLE/);
    }

    const editSchema = await client.callTool({
      name: "get_block_edit_schema",
      arguments: { website_id: website.id, page_id: "page-1", block_id: "block-1" },
    });
    assert.equal(editSchema.isError, true);
    assert.match(editSchema.content[0]?.text ?? "", /BLOCK_EDITOR_NOT_AVAILABLE/);

    const invalidRequest = await client.callTool({
      name: "inspect_section_settings",
      arguments: { website_id: website.id, page_id: "page-1", section_id: " " },
    });
    assert.equal(invalidRequest.isError, true);
  } finally {
    await client.close();
    await server.close();
    await browser.close();
  }
});
