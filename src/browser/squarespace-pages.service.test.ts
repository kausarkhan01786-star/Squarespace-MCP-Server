import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  SquarespacePagesService,
} from "./squarespace-pages.service.js";
import type { WebsiteSummary } from "./squarespace-browser.service.js";

const website: WebsiteSummary = {
  id: "fixture-site",
  name: "Fixture Website",
  url: "https://fixture.squarespace.com/config",
};

const pageRecords = new Map([
  ["Home", { slug: "", enabled: true, navigationTitle: "Home" }],
  ["Work", { slug: "work", enabled: null, navigationTitle: "Work" }],
  ["Services", { slug: "services", enabled: false, navigationTitle: "Services" }],
  ["Footer page", { slug: "footer-page", enabled: true, navigationTitle: "Footer" }],
  ["Hidden page", { slug: "hidden-page", enabled: false, navigationTitle: "Hidden" }],
]);

const pagesPanelHtml = `<!doctype html>
<html><body>
  <div data-test="pages-panel">
    <div>
      <section>
        <div data-test="pages-panel-group"><h2>Main Navigation</h2></div>
        <div data-test="pages-panel-item">
          <div>
            <button aria-label="Home Page settings Home"></button>
            <button aria-label="Page settings Home"></button>
          </div>
        </div>
        <div data-test="pages-panel-item">
          <div>
            <button aria-label="Page settings Work"></button>
            <button aria-label="Expand child pages Work" aria-expanded="false"></button>
            <div data-fixture-children hidden>
              <div data-test="pages-panel-item">
                <div>
                  <button aria-label="Page settings Services"></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section>
        <div data-test="pages-panel-group"><h2>Footer Navigation</h2></div>
        <div data-test="pages-panel-item">
          <div><button aria-label="Page settings Footer page"></button></div>
        </div>
      </section>
      <section>
        <div data-test="pages-panel-group"><h2>Not Linked</h2></div>
        <div data-test="pages-panel-item">
          <div><button aria-label="Page settings Hidden page"></button></div>
        </div>
      </section>
    </div>
  </div>
  <script>
    document.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const folderButton = target.closest('button[aria-label^="Expand child pages "], button[aria-label^="Collapse child pages "]');
      if (folderButton) {
        const expanded = folderButton.getAttribute('aria-expanded') === 'true';
        folderButton.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        folderButton.parentElement.querySelector('[data-fixture-children]').hidden = expanded;
        return;
      }
      const settingsButton = target.closest('button[aria-label^="Page settings "]');
      if (!settingsButton) return;
      const name = settingsButton.getAttribute('aria-label').slice('Page settings '.length);
      const record = ${JSON.stringify(Object.fromEntries(pageRecords))}[name];
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML =
        '<h1>' + (name === 'Work' ? 'Configure Dropdown' : 'Page Settings') + '</h1>' +
        '<label>Page Title<input aria-label="Page Title" value="' + name + '"></label>' +
        '<label>Navigation Title<input aria-label="Navigation Title" value="' + record.navigationTitle + '"></label>' +
        '<label>URL Slug<input aria-label="URL Slug" value="' + record.slug + '"></label>' +
        (record.enabled === null ? '' :
          '<label>Enable Page<input type="checkbox" aria-label="Enable Page" ' +
          (record.enabled ? 'checked' : '') + '></label>') +
        '<button aria-label="Close">Close</button>';
      dialog.querySelector('button').addEventListener('click', () => dialog.remove());
      document.body.append(dialog);
    }, 2_000);
  </script>
</body></html>`;

test("reads and categorizes nested page records without leaving folder UI expanded", async () => {
  const { browser, page, pages } = await createFixture();
  try {
    const records = await pages.listPages(website.id);
    assert.equal(records.length, 5);
    assert.equal(records.find((record) => record.name === "Home")?.url, "https://fixture.squarespace.com/");
    assert.equal(records.find((record) => record.name === "Services")?.visibilityStatus, "disabled");
    assert.equal(records.find((record) => record.name === "Footer page")?.group, "footer_navigation");
    assert.equal(records.find((record) => record.name === "Hidden page")?.group, "not_linked");
    assert.equal(records.find((record) => record.name === "Work")?.type, "folder");
    assert.equal(
      records.find((record) => record.name === "Services")?.parentId,
      records.find((record) => record.name === "Work")?.id,
    );
    assert.equal(
      await page.locator('button[aria-label="Expand child pages Work"]').getAttribute("aria-expanded"),
      "false",
    );

    const tree = await pages.getNavigationStructure(website.id);
    const mainGroup = tree.groups.find((group) => group.group === "main_navigation");
    assert.equal(mainGroup?.pages[1]?.children[0]?.name, "Services");

    const notLinked = await pages.listNotLinkedPages(website.id);
    assert.deepEqual(notLinked.map((record) => record.name), ["Hidden page"]);
    assert.equal(notLinked[0]?.visibilityStatus, "disabled");

    const home = records.find((record) => record.name === "Home");
    assert.ok(home);
    assert.deepEqual(await pages.getPageUrl(website.id, home.id), {
      websiteId: website.id,
      pageId: home.id,
      url: "https://fixture.squarespace.com/",
    });
    await assert.rejects(() => pages.getPageDetails(website.id, "missing"), {
      code: "PAGE_NOT_FOUND",
    });
  } finally {
    await browser.close();
  }
});

test("inspects Squarespace section records using the observed data-test selector", async () => {
  const { browser, page, pages } = await createFixture();
  try {
    await page.route("https://fixture.squarespace.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body>
          <section data-test="page-section" data-section-id="section-1"><h2>About</h2><p>Visible content</p></section>
        </body></html>`,
      });
    });
    const records = await pages.listPages(website.id);
    const servicesPage = records.find((record) => record.name === "Services");
    assert.ok(servicesPage);
    const result = await pages.inspectPageSections(website.id, servicesPage.id);
    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0]?.id, "section-1");
    assert.deepEqual(result.sections[0]?.headings, ["About"]);
  } finally {
    await browser.close();
  }
});

async function createFixture(): Promise<{
  browser: Browser;
  page: Page;
  pages: SquarespacePagesService;
}> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(pagesPanelHtml);
  const pages = new SquarespacePagesService({
    async listWebsites() {
      return [website];
    },
    getWebsite(websiteId: string) {
      if (websiteId !== website.id) {
        throw new Error("Unknown fixture website.");
      }
      return website;
    },
    async openWebsitePages(websiteId: string) {
      if (websiteId !== website.id) {
        throw new Error("Unknown fixture website.");
      }
      await page.setContent(pagesPanelHtml);
    },
    async openWebsiteUrl(websiteId: string, url: string) {
      if (websiteId !== website.id) {
        throw new Error("Unknown fixture website.");
      }
      await page.goto(url);
    },
    async getCurrentPage() {
      return page;
    },
  });
  return { browser, page, pages };
}
