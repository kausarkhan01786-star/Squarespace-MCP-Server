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
  ["Hidden page", { slug: "hidden-page", enabled: false, navigationTitle: "Hidden page" }],
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
        <button title="Add a new page to the &quot;Main Navigation&quot; group"></button>
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
          <div>
            <button aria-label="Page settings Hidden page"></button>
            <button aria-label="Delete page Hidden page" data-test="delete-item"></button>
          </div>
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
      const deleteButton = target.closest('button[data-test="delete-item"]');
      if (deleteButton) {
        const settingsButton = deleteButton
          .closest('[data-test="pages-panel-item"]')
          .querySelector('button[aria-label^="Page settings "]');
        const settingsLabel = settingsButton.getAttribute('aria-label');
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML =
          '<p>Delete this page?</p>' +
          '<button>Cancel</button><button>Delete</button>';
        dialog.querySelector('button:last-child').addEventListener('click', () => {
          Array.from(document.querySelectorAll('[data-test="pages-panel-item"]'))
            .find(item =>
              item.querySelector('button[aria-label^="Page settings "]')
                ?.getAttribute('aria-label') === settingsLabel
            )
            ?.remove();
          dialog.remove();
        });
        dialog.querySelector('button').addEventListener('click', () => dialog.remove());
        document.body.append(dialog);
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

const movePageHtml = `<!doctype html>
<html><body>
  <div data-test="pages-panel">
    <section>
      <div data-test="pages-panel-group"><h2>Main Navigation</h2></div>
      <div data-test="pages-panel-item">
        <div>
          <div tabindex="0">Existing</div>
          <button aria-label="Page settings Existing"></button>
        </div>
      </div>
      <div data-test="pages-panel-item">
        <div>
          <div tabindex="0">Target Folder</div>
          <button aria-label="Page settings Target Folder"></button>
          <button aria-label="Expand child pages Target Folder" aria-expanded="false"></button>
          <div data-fixture-children hidden></div>
        </div>
      </div>
    </section>
    <section>
      <div data-test="pages-panel-group"><h2>Not Linked</h2></div>
    </section>
  </div>
  <script>
    const records = {
      Existing: { pageTitle: 'Existing', navigationTitle: 'Existing', slug: 'existing' },
      'Target Folder': { pageTitle: 'Target Folder', navigationTitle: 'Target Folder', slug: '' }
    };
    let activeRecord = null;
    let movingRow = null;
    document.addEventListener('pointerdown', event => {
      const target = event.target instanceof Element ? event.target : null;
      movingRow = target?.matches('[tabindex="0"]')
        ? target.closest('[data-test="pages-panel-item"]')
        : null;
    });
    document.addEventListener('pointerup', event => {
      const target = event.target instanceof Element ? event.target : null;
      const destination = target?.closest('section');
      const destinationFolder = target?.closest('[data-test="pages-panel-item"]');
      const folderChildren = destinationFolder?.querySelector('[data-fixture-children]');
      if (movingRow && folderChildren) {
        folderChildren.append(movingRow);
      } else if (movingRow && destination) {
        destination.append(movingRow);
      }
      movingRow = null;
    });
    document.addEventListener('click', event => {
      const target = event.target instanceof Element
        ? event.target.closest('button')
        : null;
      if (!target) return;
      const folderButton = target.closest('button[aria-label^="Expand child pages "], button[aria-label^="Collapse child pages "]');
      if (folderButton) {
        const expanded = folderButton.getAttribute('aria-expanded') === 'true';
        folderButton.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        folderButton.parentElement.querySelector('[data-fixture-children]').hidden = expanded;
        return;
      }
      if (!target.matches('button[aria-label^="Page settings "]')) return;
      const name = target.getAttribute('aria-label').slice('Page settings '.length);
      activeRecord = records[name];
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML =
        '<h1>' + (name === 'Target Folder' ? 'Configure Dropdown' : 'Page Settings') + '</h1>' +
        '<label>Page Title<input aria-label="Page Title" value="' + activeRecord.pageTitle + '"></label>' +
        '<label>Navigation Title<input aria-label="Navigation Title" value="' + activeRecord.navigationTitle + '"></label>' +
        '<label>URL Slug<input aria-label="URL Slug" value="' + activeRecord.slug + '"></label>' +
        '<button data-test="nav-modal-close-button">Close</button>';
      dialog.querySelector('button').addEventListener('click', () => dialog.remove());
      document.body.append(dialog);
    });
  </script>
</body></html>`;

const createPageHtml = (persistTitles: boolean, groupLabel: string) => {
  const addButtonTitle = groupLabel === "Not Linked"
    ? `Add a new page to the "${groupLabel}" navigation group`
    : `Add a new page to the "${groupLabel}" group`;
  return `<!doctype html>
<html><body>
  <div data-test="pages-panel">
    <section>
      <div data-test="pages-panel-group"><h2>${groupLabel}</h2></div>
      <div data-test="pages-panel-item">
        <div><button aria-label="Page settings Existing"></button></div>
      </div>
      <button title="${addButtonTitle.replace(/"/g, "&quot;")}"></button>
    </section>
  </div>
  <script>
    const records = {
      Existing: { pageTitle: 'Existing', navigationTitle: 'Existing', slug: 'existing' }
    };
    const persistTitles = ${persistTitles};
    const groupLabel = ${JSON.stringify(groupLabel)};
    const group = document.querySelector('section');
    let activeRecord = null;
    document.addEventListener('click', event => {
      const target = event.target instanceof Element
        ? event.target.closest('button, a, [role="menuitem"]')
        : null;
      if (!target) return;
      if (target.matches('button[title^="Add a new page to"]')) {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-label', 'Add a Page');
        dialog.setAttribute('data-test', 'catalog-dialog');
        dialog.innerHTML = '<a data-test="add-blank-options-button">Add Blank</a>';
        document.body.append(dialog);
        return;
      }
      if (target.matches('[data-test="add-blank-options-button"]')) {
        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        menu.innerHTML =
          '<div role="menuitem" data-test="blank-page-option">Page</div>' +
          '<div role="menuitem" data-test="blank-blog-option">Blog</div>';
        document.body.append(menu);
        return;
      }
      if (target.matches('[data-test="blank-page-option"], [data-test="blank-blog-option"]')) {
        const name = 'Untitled';
        activeRecord = { pageTitle: name, navigationTitle: name, slug: 'untitled' };
        records[name] = activeRecord;
        const row = document.createElement('div');
        row.setAttribute('data-test', 'pages-panel-item');
        row.innerHTML =
          '<div><button aria-label="Page settings ' + name + '"></button></div>';
        group.insertBefore(row, group.querySelector('button[title^="Add a new page to"]'));
        document.querySelector('[data-test="catalog-dialog"]').remove();
        document.querySelector('[role="menu"]').remove();
        return;
      }
      if (target.matches('button[data-test="duplicate-page"]')) {
        const name = activeRecord.pageTitle + ' (Copy)';
        const copy = {
          pageTitle: name,
          navigationTitle: name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        };
        records[name] = copy;
        const row = document.createElement('div');
        row.setAttribute('data-test', 'pages-panel-item');
        row.innerHTML =
          '<div><button aria-label="Page settings ' + name + '"></button></div>';
        group.insertBefore(row, group.querySelector('button[title^="Add a new page to"]'));
        target.closest('[role="dialog"]').remove();
        return;
      }
      if (target.matches('button[aria-label^="Page settings "]')) {
        const name = target.getAttribute('aria-label').slice('Page settings '.length);
        activeRecord = records[name] || activeRecord;
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML =
          '<h1>Page Settings</h1>' +
          '<label>Page Title<input aria-label="Page Title" value="' + activeRecord.pageTitle + '"></label>' +
          '<label>Navigation Title<input aria-label="Navigation Title" value="' + activeRecord.navigationTitle + '"></label>' +
          '<label>URL Slug<input aria-label="URL Slug" value="' + activeRecord.slug + '"></label>' +
          '<button data-test="duplicate-page">Duplicate Page</button>' +
          '<button data-test="nav-modal-close-button">Close</button>';
        document.body.append(dialog);
        return;
      }
      if (target.matches('button[data-test="nav-modal-close-button"]')) {
        target.closest('[role="dialog"]').remove();
      }
    });
    document.addEventListener('input', event => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !activeRecord) return;
      if (input.getAttribute('aria-label') === 'Page Title') {
        if (persistTitles) {
          delete records[activeRecord.pageTitle];
          activeRecord.pageTitle = input.value;
          activeRecord.slug = input.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          records[activeRecord.pageTitle] = activeRecord;
        }
      } else if (input.getAttribute('aria-label') === 'Navigation Title') {
        if (persistTitles) activeRecord.navigationTitle = input.value;
      } else if (input.getAttribute('aria-label') === 'URL Slug') {
        if (persistTitles) activeRecord.slug = input.value;
      }
      const row = Array.from(document.querySelectorAll('[data-test="pages-panel-item"]'))
        .find(item => item.querySelector('button[aria-label^="Page settings ' + input.defaultValue + '"]'));
      if (row && input.getAttribute('aria-label') === 'Page Title') {
        row.querySelector('button[aria-label^="Page settings "]')
          .setAttribute('aria-label', 'Page settings ' + input.value);
      }
    });
  </script>
</body></html>`;
};

const editorHtml = (confirmSave: boolean, publishDialog = false) => `<!doctype html>
<html><body>
  <main>
    <p id="status">Unsaved changes</p>
    <button id="save">Save</button>
    <button id="publish">Publish</button>
  </main>
  <script>
    const confirmSave = ${JSON.stringify(confirmSave)};
    const publishDialog = ${JSON.stringify(publishDialog)};
    document.getElementById('save').addEventListener('click', () => {
      if (confirmSave) {
        document.getElementById('status').textContent = 'All changes saved';
        document.getElementById('save').remove();
      }
    });
    document.getElementById('publish').addEventListener('click', () => {
      if (publishDialog) {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<p>Publish changes?</p><button>Cancel</button><button>Publish</button>';
        dialog.querySelector('button:last-child').addEventListener('click', () => {
          document.getElementById('status').textContent = 'Site published';
          dialog.remove();
        });
        document.body.append(dialog);
      } else {
        document.getElementById('status').textContent = 'Site published';
      }
    });
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

test("deletes a confirmed non-homepage page and verifies its removal", async () => {
  const { browser, pages } = await createFixture();
  try {
    const records = await pages.listPages(website.id);
    const target = records.find((record) => record.name === "Hidden page");
    const home = records.find((record) => record.name === "Home");
    assert.ok(target);
    assert.ok(home);

    await assert.rejects(() => pages.deletePage(website.id, home.id, "DELETE"), {
      code: "PAGE_DELETE_FAILED",
    });

    const result = await pages.deletePage(website.id, target.id, "DELETE");
    assert.equal(result.success, true);
    assert.equal(result.saved, true);
    assert.equal(result.deletedPageId, target.id);
    assert.match(result.screenshots.before, /^delete-page-before-.*\.png$/);
    assert.match(result.screenshots.after, /^delete-page-after-.*\.png$/);
    assert.equal(
      (await pages.listPages(website.id)).some((record) => record.name === "Hidden page"),
      false,
    );
  } finally {
    await browser.close();
  }
});

test("creates a blank page, verifies saved titles, and captures before/after screenshots", async () => {
  const { browser, page, pages, screenshots } = await createPageFixture();
  try {
    const result = await pages.createPage(
      website.id,
      "A new page",
      "page",
      "main_navigation",
    );

    assert.equal(result.success, true);
    assert.equal(result.saved, true);
    assert.equal(result.pageType, "page");
    assert.equal(result.page.name, "A new page");
    assert.equal(result.page.navigationTitle, "A new page");
    assert.equal(result.page.url, "https://fixture.squarespace.com/a-new-page");
    assert.deepEqual(result.screenshots, {
      before: screenshots[0],
      after: screenshots[1],
    });
    assert.match(result.screenshots.before, /^create-page-before-.*\.png$/);
    assert.match(result.screenshots.after, /^create-page-after-.*\.png$/);
    assert.equal(screenshots.length, 2);
    assert.equal(
      (await page.locator('[data-test="pages-panel-item"]').count()),
      2,
    );
  } finally {
    await browser.close();
  }
});

test("duplicates a page and returns the verified copy", async () => {
  const { browser, pages, screenshots } = await createPageFixture();
  try {
    const initialPages = await pages.listPages(website.id);
    const source = initialPages.find((record) => record.name === "Existing");
    assert.ok(source);

    const result = await pages.duplicatePage(website.id, source.id);
    assert.equal(result.success, true);
    assert.equal(result.saved, true);
    assert.equal(result.sourcePageId, source.id);
    assert.equal(result.page.name, "Existing (Copy)");
    assert.notEqual(result.page.id, source.id);
    assert.equal(screenshots.length, 2);
    assert.match(result.screenshots.before, /^duplicate-page-before-.*\.png$/);
    assert.match(result.screenshots.after, /^duplicate-page-after-.*\.png$/);
  } finally {
    await browser.close();
  }
});

test("moves a page to another navigation group and verifies its location", async () => {
  const { browser, pages, screenshots } = await createMoveFixture();
  try {
    const initialPages = await pages.listPages(website.id);
    const existing = initialPages.find((record) => record.name === "Existing");
    assert.ok(existing);

    const result = await pages.movePage(
      website.id,
      existing.id,
      "not_linked",
    );
    assert.equal(result.success, true);
    assert.equal(result.saved, true);
    assert.equal(result.previousPageId, existing.id);
    assert.equal(result.page.group, "not_linked");
    assert.notEqual(result.page.id, existing.id);
    assert.equal(screenshots.length, 2);
    assert.match(result.screenshots.before, /^move-page-before-.*\.png$/);
    assert.match(result.screenshots.after, /^move-page-after-.*\.png$/);
  } finally {
    await browser.close();
  }
});

test("moves a page into an expanded Squarespace folder", async () => {
  const { browser, pages, screenshots } = await createMoveFixture();
  try {
    const initialPages = await pages.listPages(website.id);
    const existing = initialPages.find((record) => record.name === "Existing");
    const folder = initialPages.find((record) => record.name === "Target Folder");
    assert.ok(existing);
    assert.ok(folder);
    assert.equal(folder.type, "folder");

    const result = await pages.movePage(
      website.id,
      existing.id,
      "main_navigation",
      folder.id,
    );
    assert.equal(result.success, true);
    assert.equal(result.saved, true);
    assert.equal(result.page.group, "main_navigation");
    assert.deepEqual(result.page.parentPath, ["Target Folder"]);
    assert.notEqual(result.page.id, existing.id);
    assert.equal(screenshots.length, 2);
  } finally {
    await browser.close();
  }
});

test("supports the observed blank Blog option", async () => {
  const { browser, pages } = await createPageFixture();
  try {
    const result = await pages.createPage(
      website.id,
      "News",
      "blog",
      "main_navigation",
    );

    assert.equal(result.success, true);
    assert.equal(result.pageType, "blog");
    assert.equal(result.page.name, "News");
    assert.equal(result.page.group, "main_navigation");
  } finally {
    await browser.close();
  }
});

test("selects the observed Not Linked add-page control", async () => {
  const { browser, pages } = await createPageFixture(true, "Not Linked");
  try {
    const result = await pages.createPage(
      website.id,
      "Private page",
      "page",
      "not_linked",
    );
    assert.equal(result.page.group, "not_linked");
  } finally {
    await browser.close();
  }
});

test("does not report success when the requested title does not persist", async () => {
  const { browser, pages, screenshots } = await createPageFixture(false);
  try {
    await assert.rejects(
      () => pages.createPage(website.id, "Unsaved title", "page", "main_navigation"),
      { code: "PAGE_CREATION_FAILED" },
    );
    assert.equal(screenshots.length, 2);
  } finally {
    await browser.close();
  }
});

test("updates a page title and returns the verified page record", async () => {
  const { browser, pages, screenshots } = await createPageFixture();
  try {
    const initialPages = await pages.listPages(website.id);
    const existing = initialPages.find((record) => record.name === "Existing");
    assert.ok(existing);

    const result = await pages.updatePageTitle(website.id, existing.id, "Renamed");
    assert.equal(result.success, true);
    assert.equal(result.saved, true);
    assert.equal(result.previousPageId, existing.id);
    assert.equal(result.page.name, "Renamed");
    assert.equal(result.page.navigationTitle, "Existing");
    assert.notEqual(result.page.id, existing.id);
    assert.equal(screenshots.length, 2);
    assert.match(result.screenshots.before, /^update-page-title-before-.*\.png$/);
    assert.match(result.screenshots.after, /^update-page-title-after-.*\.png$/);
  } finally {
    await browser.close();
  }
});

test("does not report an unsaved page-title update as successful", async () => {
  const { browser, pages, screenshots } = await createPageFixture(false);
  try {
    const initialPages = await pages.listPages(website.id);
    const existing = initialPages.find((record) => record.name === "Existing");
    assert.ok(existing);

    await assert.rejects(
      () => pages.updatePageTitle(website.id, existing.id, "Unsaved"),
      { code: "PAGE_UPDATE_FAILED" },
    );
    assert.equal(screenshots.length, 2);
  } finally {
    await browser.close();
  }
});

test("updates a page URL slug and verifies the resulting internal URL", async () => {
  const { browser, pages, screenshots } = await createPageFixture();
  try {
    const initialPages = await pages.listPages(website.id);
    const existing = initialPages.find((record) => record.name === "Existing");
    assert.ok(existing);

    const result = await pages.updatePageUrl(website.id, existing.id, "New-Location");
    assert.equal(result.success, true);
    assert.equal(result.saved, true);
    assert.equal(result.page.id, existing.id);
    assert.equal(result.page.url, "https://fixture.squarespace.com/new-location");
    assert.equal(screenshots.length, 2);
    assert.match(result.screenshots.before, /^update-page-url-before-.*\.png$/);
    assert.match(result.screenshots.after, /^update-page-url-after-.*\.png$/);
  } finally {
    await browser.close();
  }
});

test("does not report an unsaved page URL update as successful", async () => {
  const { browser, pages, screenshots } = await createPageFixture(false);
  try {
    const initialPages = await pages.listPages(website.id);
    const existing = initialPages.find((record) => record.name === "Existing");
    assert.ok(existing);

    await assert.rejects(
      () => pages.updatePageUrl(website.id, existing.id, "unsaved-location"),
      { code: "PAGE_URL_UPDATE_FAILED" },
    );
    assert.equal(screenshots.length, 2);
  } finally {
    await browser.close();
  }
});

test("rejects changing the Squarespace homepage's fixed URL", async () => {
  const { browser, pages } = await createFixture();
  try {
    const records = await pages.listPages(website.id);
    const home = records.find((record) => record.name === "Home");
    assert.ok(home);
    await assert.rejects(
      () => pages.updatePageUrl(website.id, home.id, "home-path"),
      { code: "PAGE_URL_UPDATE_FAILED" },
    );
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
          <section data-test="page-section" data-section-id="section-1" data-section-theme="light" data-fluid-engine-section>
            <h2>About</h2>
            <div id="block-1" data-block-type="1337" data-definition-name="website.components.html"><p>Visible content</p></div>
          </section>
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
    assert.equal(result.sections[0]?.theme, "light");
    assert.equal(result.sections[0]?.layout, "fluid_engine");
    assert.deepEqual(result.sections[0]?.blocks, [{
      id: "block-1",
      type: "1337",
      definitionName: "website.components.html",
      visibleText: "Visible content",
      textTruncated: false,
    }]);
  } finally {
    await browser.close();
  }
});

test("lists and inspects a single observed section by its returned ID", async () => {
  const { browser, page, pages } = await createFixture();
  try {
    await page.route("https://fixture.squarespace.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body>
          <section data-test="page-section" data-section-id="section-1"><h2>About</h2></section>
          <section data-test="page-section" data-section-id="section-2"><h2>Contact</h2></section>
        </body></html>`,
      });
    });
    const records = await pages.listPages(website.id);
    const servicesPage = records.find((record) => record.name === "Services");
    assert.ok(servicesPage);

    const listed = await pages.listPageSections(website.id, servicesPage.id);
    assert.deepEqual(listed.sections.map((section) => section.id), ["section-1", "section-2"]);
    await page.setContent(pagesPanelHtml);
    const inspected = await pages.inspectSection(
      website.id,
      servicesPage.id,
      " section-2 ",
    );
    assert.equal(inspected.section.id, "section-2");
    assert.deepEqual(inspected.section.headings, ["Contact"]);
    await page.setContent(pagesPanelHtml);
    await assert.rejects(
      () => pages.inspectSection(website.id, servicesPage.id, "missing"),
      { code: "SECTION_NOT_FOUND" },
    );
  } finally {
    await browser.close();
  }
});

test("inspects mobile overflow at a narrow viewport and restores the original viewport", async () => {
  const { browser, page, pages } = await createFixture();
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.route("https://fixture.squarespace.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
          <section data-test="page-section" data-section-id="section-wide">
            <div style="width: 500px">Wide content</div>
          </section>
        </body></html>`,
      });
    });
    const records = await pages.listPages(website.id);
    const servicesPage = records.find((record) => record.name === "Services");
    assert.ok(servicesPage);

    const result = await pages.inspectMobileResponsive(website.id, servicesPage.id);
    assert.deepEqual(result.mobileViewport, { width: 390, height: 844 });
    assert.equal(result.desktop.viewportWidth, 1280);
    assert.equal(result.mobile.viewportWidth, 390);
    assert.equal(result.mobile.sections[0]?.id, "section-wide");
    assert.equal(result.mobile.sections[0]?.horizontalOverflow, true);
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 });
  } finally {
    await browser.close();
  }
});

test("saves current editor changes and verifies Squarespace confirmation", async () => {
  const { browser, pages, screenshots } = await createEditorFixture(true);
  try {
    const result = await pages.savePageChanges(website.id);
    assert.equal(result.success, true);
    assert.equal(result.saved, true);
    assert.equal(result.published, false);
    assert.equal(result.action, "saved");
    assert.equal(screenshots.length, 2);
    assert.match(result.screenshots.before, /^save-page-changes-before-.*\.png$/);
    assert.match(result.screenshots.after, /^save-page-changes-after-.*\.png$/);
    assert.match(result.inspection.after.visibleText, /All changes saved/);
  } finally {
    await browser.close();
  }
});

test("publishes only with explicit confirmation and verifies Squarespace confirmation", async () => {
  const { browser, pages, screenshots } = await createEditorFixture(true, true);
  try {
    await assert.rejects(
      () => pages.savePageChanges(website.id, true),
      { code: "CONFIRMATION_REQUIRED" },
    );

    const result = await pages.savePageChanges(website.id, true, "PUBLISH");
    assert.equal(result.success, true);
    assert.equal(result.saved, true);
    assert.equal(result.published, true);
    assert.equal(result.action, "published");
    assert.equal(screenshots.length, 2);
    assert.match(result.inspection.after.visibleText, /Site published/);
  } finally {
    await browser.close();
  }
});

test("does not report editor save success without Squarespace confirmation", async () => {
  const { browser, pages, screenshots } = await createEditorFixture(false);
  try {
    await assert.rejects(
      () => pages.savePageChanges(website.id),
      { code: "PAGE_SAVE_FAILED" },
    );
    assert.equal(screenshots.length, 2);
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
  let initialized = false;
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
      if (!initialized) {
        await page.setContent(pagesPanelHtml);
        initialized = true;
      }
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
    async captureScreenshot(fileName) {
      return fileName ?? "fixture-screenshot.png";
    },
  });
  return { browser, page, pages };
}

async function createPageFixture(
  persistTitles = true,
  groupLabel = "Main Navigation",
): Promise<{
  browser: Browser;
  page: Page;
  pages: SquarespacePagesService;
  screenshots: string[];
}> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const screenshots: string[] = [];
  let initialized = false;
  const pages = new SquarespacePagesService(
    {
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
        if (!initialized) {
          await page.setContent(createPageHtml(persistTitles, groupLabel));
          initialized = true;
        }
      },
      async openWebsiteUrl(websiteId: string) {
        if (websiteId !== website.id) {
          throw new Error("Unknown fixture website.");
        }
      },
      async getCurrentPage() {
        return page;
      },
      async captureScreenshot(fileName?: string) {
        screenshots.push(fileName ?? "unnamed.png");
        return fileName ?? "unnamed.png";
      },
    },
    2_000,
  );
  return { browser, page, pages, screenshots };
}

async function createMoveFixture(): Promise<{
  browser: Browser;
  pages: SquarespacePagesService;
  screenshots: string[];
}> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const screenshots: string[] = [];
  let initialized = false;
  const pages = new SquarespacePagesService(
    {
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
        if (!initialized) {
          await page.setContent(movePageHtml);
          initialized = true;
        }
      },
      async openWebsiteUrl() {},
      async getCurrentPage() {
        return page;
      },
      async captureScreenshot(fileName?: string) {
        screenshots.push(fileName ?? "unnamed.png");
        return fileName ?? "unnamed.png";
      },
    },
    2_000,
  );
  return { browser, pages, screenshots };
}

async function createEditorFixture(
  confirmSave: boolean,
  publishDialog = false,
): Promise<{
  browser: Browser;
  pages: SquarespacePagesService;
  screenshots: string[];
}> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(editorHtml(confirmSave, publishDialog));
  const screenshots: string[] = [];
  const pages = new SquarespacePagesService(
    {
      async listWebsites() {
        return [website];
      },
      getWebsite(websiteId: string) {
        if (websiteId !== website.id) {
          throw new Error("Unknown fixture website.");
        }
        return website;
      },
      async openWebsitePages() {
        throw new Error("Editor save should not navigate away from the current editor.");
      },
      async openWebsiteUrl() {
        throw new Error("Editor save should not navigate away from the current editor.");
      },
      async getCurrentPage() {
        return page;
      },
      async captureScreenshot(fileName?: string) {
        screenshots.push(fileName ?? "unnamed.png");
        return fileName ?? "unnamed.png";
      },
    },
    2_000,
  );
  return { browser, pages, screenshots };
}
