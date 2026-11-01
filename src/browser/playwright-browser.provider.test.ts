import assert from "node:assert/strict";
import test from "node:test";
import { SquarespaceBrowserError } from "./browser-errors.js";
import { UnsupportedBrowserProvider } from "./playwright-browser.provider.js";
import { PlaywrightBrowserProvider } from "./playwright-browser.provider.js";

const website = {
  id: "site-1",
  name: "Example",
  url: "https://example.squarespace.com",
};

function createProvider() {
  const calls: string[] = [];
  const browser = {
    getWebsite: (websiteId: string) => {
      if (websiteId !== website.id) throw new SquarespaceBrowserError("WEBSITE_NOT_FOUND", "Missing.");
      return website;
    },
    inspectCurrentPage: async () => ({
      title: "Example page",
      url: "https://example.squarespace.com/home",
      visibleText: "not returned",
      visibleTextTruncated: false,
      buttons: [{ text: "Send", ariaLabel: "Send", disabled: false }],
      links: [{ text: "Contact", url: "https://example.squarespace.com/contact" }],
      inputs: [{
        type: "email",
        name: "email",
        placeholder: "person@example.com",
        ariaLabel: null,
        disabled: false,
        required: true,
      }],
    }),
    captureScreenshot: async (fileName?: string) => {
      calls.push(`screenshot:${fileName ?? ""}`);
      return "C:\\private\\profile\\screenshots\\page.png";
    },
    openWebsiteUrl: async (_websiteId: string, destination: string) => {
      calls.push(`navigate:${destination}`);
    },
  };
  const pages = {
    inspectPageSections: async () => ({
      websiteId: website.id,
      pageId: "home",
      url: "https://example.squarespace.com/home",
      sections: [{
        id: "section-1",
        theme: "light",
        layout: "fluid_engine" as const,
        headings: ["Welcome"],
        visibleText: "Hello",
        textTruncated: false,
        blocksTruncated: false,
        blocks: [{
          id: "block-1",
          type: "text",
          visibleText: "Hello",
          textTruncated: false,
        }],
      }],
      sectionsTruncated: false,
    }),
  };
  return {
    provider: new PlaywrightBrowserProvider(
      browser as unknown as ConstructorParameters<typeof PlaywrightBrowserProvider>[0],
      pages as unknown as ConstructorParameters<typeof PlaywrightBrowserProvider>[1],
      () => new Date("2025-01-02T03:04:05.000Z"),
    ),
    calls,
  };
}

test("Playwright provider exposes typed supported capabilities without browser objects", async () => {
  const { provider } = createProvider();
  assert.ok(provider.getCapabilities().every((capability) => capability.supported));
  assert.deepEqual(await provider.verifyWebsite(website.id), {
    status: "supported",
    data: { ...website, url: `${website.url}/` },
  });

  const inspection = await provider.inspectCurrentPage(website.id);
  assert.equal(inspection.status, "supported");
  if (inspection.status === "supported") {
    assert.equal("visibleText" in inspection.data, false);
    assert.equal(inspection.data.inputs[0]?.placeholder, "[redacted email]");
  }
});

test("screenshots return sanitized evidence rather than local profile paths", async () => {
  const { provider } = createProvider();
  assert.deepEqual(await provider.captureScreenshot(website.id), {
    status: "supported",
    data: {
      fileName: "page.png",
      capturedAt: "2025-01-02T03:04:05.000Z",
      fullPage: true,
    },
  });
});

test("navigation remains restricted to the verified website origin", async () => {
  const { provider, calls } = createProvider();
  const result = await provider.navigateWithinWebsite(
    website.id,
    "https://example.squarespace.com/contact",
  );
  assert.equal(result.status, "supported");
  assert.deepEqual(calls, ["navigate:https://example.squarespace.com/contact"]);
  await assert.rejects(
    provider.navigateWithinWebsite(website.id, "https://other.squarespace.com/"),
    { code: "INVALID_URL" },
  );
  assert.equal(calls.length, 1);
});

test("sections and blocks are returned as provider-neutral sanitized summaries", async () => {
  const { provider } = createProvider();
  const sections = await provider.inspectSections(website.id, "home");
  const blocks = await provider.inspectBlocks(website.id, "home");
  assert.equal(sections.status, "supported");
  if (sections.status === "supported") {
    assert.deepEqual(sections.data[0], {
      sectionId: "section-1",
      theme: "light",
      headings: ["Welcome"],
      visibleText: "Hello",
      textTruncated: false,
      blocksTruncated: false,
    });
  }
  assert.equal(blocks.status, "supported");
  if (blocks.status === "supported") {
    assert.deepEqual(blocks.data[0], {
      sectionId: "section-1",
      blockId: "block-1",
      type: "text",
      visibleText: "Hello",
      textTruncated: false,
    });
  }
});

test("unsupported providers report limitations explicitly", async () => {
  const provider = new UnsupportedBrowserProvider("Shared browser bridge is not available.");
  assert.ok(provider.getCapabilities().every((capability) => !capability.supported));
  assert.deepEqual(await provider.inspectCurrentPage("site-1"), {
    status: "unsupported",
    capability: "inspect_current_page",
    reason: "Shared browser bridge is not available.",
  });
});
