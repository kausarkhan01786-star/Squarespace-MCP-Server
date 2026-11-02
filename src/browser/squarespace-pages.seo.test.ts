import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { SquarespacePagesService } from "./squarespace-pages.service.js";
import { MutationApprovalGuard } from "../approval/mutation-approval.js";
import type { WebsiteSummary } from "./squarespace-browser.service.js";

test("reads observed page SEO, indexing, slug, and social-image controls without saving", async () => {
  const website: WebsiteSummary = {
    id: "seo-fixture-site",
    name: "SEO Fixture",
    url: "https://fixture.squarespace.com/config",
  };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route("https://fixture.squarespace.com/config/pages", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <div data-test="pages-panel">
          <section>
            <div data-test="pages-panel-group"><h2>Main Navigation</h2></div>
            <div data-test="pages-panel-item">
              <button aria-label="Page settings About"></button>
            </div>
          </section>
        </div>
        <script>
          document.addEventListener('click', event => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const pageSettings = target.closest('button[aria-label^="Page settings "]');
            if (!pageSettings) return;
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.innerHTML =
              '<h1>Page Settings</h1>' +
              '<label>PAGE TITLE<input aria-label="Page Title" value="About"></label>' +
              '<label>NAVIGATION TITLE<input aria-label="Navigation Title" value="About"></label>' +
              '<label>URL SLUG<input aria-label="URL Slug" value="about"></label>' +
              '<input type="button" aria-label="SEO">' +
              '<input type="button" aria-label="Social Image">' +
              '<button aria-label="Close">Close</button>' +
              '<div data-panel></div>';
            const panel = dialog.querySelector('[data-panel]');
            dialog.querySelector('[aria-label="SEO"]').addEventListener('click', () => {
              panel.innerHTML =
                '<textarea aria-label="SEO Title (Optional)">About page title</textarea>' +
                '<textarea aria-label="SEO Description (Optional)">About page description</textarea>' +
                '<input type="checkbox" aria-label="Hide Page from Search Results">';
            });
            dialog.querySelector('[aria-label="Social Image"]').addEventListener('click', () => {
              panel.innerHTML = '<input type="file"><img alt="Social preview" src="/social.png">';
            });
            dialog.querySelector('[aria-label="Close"]').addEventListener('click', () => dialog.remove());
            document.body.append(dialog);
          });
        </script>
      </body></html>`,
    });
  });

  const pages = new SquarespacePagesService({
    async listWebsites() {
      return [website];
    },
    getWebsite(websiteId) {
      assert.equal(websiteId, website.id);
      return website;
    },
    async openWebsitePages(websiteId) {
      assert.equal(websiteId, website.id);
      await page.goto("https://fixture.squarespace.com/config/pages");
    },
    async openWebsiteUrl() {
      throw new Error("This read-only settings test should not navigate to a page.");
    },
    async getCurrentPage() {
      return page;
    },
    async captureScreenshot() {
      throw new Error("This read-only settings test should not capture screenshots.");
    },
  }, new MutationApprovalGuard({ requestApproval: async () => true }), 1000);

  try {
    const [about] = await pages.listPages(website.id);
    assert.ok(about);
    const result = await pages.inspectPageSeoSettings(website.id, about.id);
    assert.deepEqual(result, {
      websiteId: website.id,
      pageId: about.id,
      pageName: "About",
      pageTitle: "About",
      slug: "about",
      isHomepage: false,
      seoTitle: "About page title",
      seoDescription: "About page description",
      seoFieldsAvailable: true,
      hiddenFromSearchResults: false,
      socialImageUploadAvailable: true,
      socialImagePreviewCount: 0,
      source: "squarespace_page_settings",
    });
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.locator("input[aria-label='Hide Page from Search Results']").count(), 0);
  } finally {
    await browser.close();
  }
});
