import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { SquarespaceBrowserError } from "./browser-errors.js";
import {
  SETTINGS_CATEGORY_IDS,
  SquarespaceNavigationSeoSettingsService,
} from "./squarespace-navigation-seo-settings.service.js";
import type { WebsiteSummary } from "./squarespace-browser.service.js";

const websiteId = "settings-fixture-site";
const website: WebsiteSummary = {
  id: websiteId,
  name: "Settings Fixture",
  url: "https://fixture.squarespace.com/config",
};

interface FixtureOptions {
  missingCategory?: string;
  accessDeniedCategory?: string;
  transitionDomains?: boolean;
  browserError?: boolean;
  detailedControls?: boolean;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
  browser: Browser;
  page: Page;
  service: SquarespaceNavigationSeoSettingsService;
}> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const categories = [
    "Domains & Email",
    "Customer Notifications",
    "Selling",
    "Brand",
    "Marketing",
    "Extensions",
    "Third Party Tools",
    "Permissions & Ownership",
    "Billing",
    "Developer Tools",
  ].filter((label) => label !== options.missingCategory);
  const categoryButtons = categories
    .map((label) => `<button type="button">${label}</button>`)
    .join("\n");
  const detailedControls = options.detailedControls
    ? `
      <label>Text setting<input aria-label="Text setting" value="Visible fixture value"></label>
      <label>Numeric setting<input type="number" aria-label="Numeric setting" value="42"></label>
      <label>Selection<select aria-label="Selection"><option>First</option><option selected>Second</option></select></label>
      <label>Boolean preference<input type="checkbox" aria-label="Boolean preference" checked></label>
      <label>Enabled<input type="radio" name="radio-setting" aria-label="Enabled" checked></label>
      <label>Disabled<input type="radio" name="radio-setting" aria-label="Disabled"></label>
      <label>Empty setting<input aria-label="Empty setting" value=""></label>
      <label>Masked setting<input type="password" aria-label="Masked setting" value="fixture-only-mask"></label>
      <label>API key<input aria-label="API key" value="fixture-only-sensitive-marker"></label>
      <label>Contact email<input type="email" aria-label="Contact email" value="fixture@example.invalid"></label>
      <label>Contact name<input aria-label="Contact name" value="Fixture Person"></label>
      <label>Masked text<input aria-label="Masked text" value="********"></label>
      <label>Public link<input type="url" aria-label="Public link" value="https://example.invalid/about"></label>
      <label>Secret URL<input type="url" aria-label="Secret URL" value="https://example.invalid/path?token=fixture-only-url-marker"></label>
      <label>Hidden setting<input type="hidden" aria-label="Hidden setting" value="fixture-only-hidden-marker"></label>
      <label>Upload<input type="file" aria-label="Upload"></label>
      <label>Custom code<textarea aria-label="Custom code">fixture-only-code-marker</textarea></label>
      <button role="combobox" aria-label="Unexposed choice">Choose a value</button>
      <label>Feature switch<input role="switch" aria-label="Feature switch" type="checkbox" aria-checked="false"></label>
    `
    : "";

  await page.route("https://fixture.squarespace.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <button type="button">Website</button>
        <a data-test="menuItem-website" href="/config/website">Website settings</a>
        <a data-test="menuItem-site-languages" href="/settings/website/site-languages">Site Languages</a>
        <button aria-label="Settings" type="button">Settings</button>
        <button type="button">Site Languages</button>
        ${categoryButtons}
        <script>
          document.documentElement.dataset.mutationCount = "0";
          document.addEventListener("click", event => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const link = target.closest('a[data-test="menuItem-website"]');
            if (link) {
              event.preventDefault();
              history.pushState({}, "", link.getAttribute("href"));
              return;
            }
            const button = target.closest("button");
            const label = button?.textContent?.trim();
            if (label === "Save" || label === "Publish") {
              const count = Number(document.documentElement.dataset.mutationCount || "0");
              document.documentElement.dataset.mutationCount = String(count + 1);
            }
            if (label === "Domains & Email" && ${options.transitionDomains !== false}) {
              history.pushState({}, "", "/config/settings/domains-email");
              document.body.insertAdjacentHTML("beforeend", \`
                <button>Register and manage domains from Squarespace or other domain sellers</button>
                <button>Sign up for Google Workspace on a monthly or annual subscription</button>
              \`);
            }
            if (label && !["Website", "Settings", "Site Languages"].includes(label)) {
              ${options.accessDeniedCategory
                ? `if (label === ${JSON.stringify(options.accessDeniedCategory)}) {
                    document.body.insertAdjacentHTML("beforeend", "<h2>" + label + "</h2><p>Access denied</p>");
                    return;
                  }`
                : ""}
              document.body.insertAdjacentHTML("beforeend", \`
                <h2>\${label}</h2>
                <label>Observed \${label} option<input aria-label="Observed \${label} option"></label>
                  ${detailedControls}
                  <button>Save</button>
                  <button>Publish</button>
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
      async openWebsitePages() {
        await page.goto(`${website.url}/pages`);
      },
      async openWebsiteUrl() {
        throw new Error("Settings inspection must not navigate to a public page.");
      },
      async getCurrentPage() {
        return page;
      },
    },
    {
      async getNavigationStructure(id) {
        assert.equal(id, websiteId);
        if (options.browserError) {
          throw new SquarespaceBrowserError(
            "WEBSITE_SETTINGS_NOT_AVAILABLE",
            "Fixture settings navigation failed.",
          );
        }
        await page.goto(`${website.url}/pages`);
        return { websiteId: id, groups: [] };
      },
      async getPageDetails() {
        throw new Error("Settings inspection must not inspect page details.");
      },
      async inspectPageSections() {
        throw new Error("Settings inspection must not inspect page content.");
      },
      async inspectPageSeoSettings() {
        throw new Error("Settings inspection must not inspect page SEO.");
      },
      async listPages() {
        return [];
      },
      async listNotLinkedPages() {
        return [];
      },
    },
    250,
  );
  return { browser, page, service };
}

test("inspects all settings category IDs through read-only UI fixtures", async () => {
  const fixture = await createFixture();
  try {
    for (const categoryId of SETTINGS_CATEGORY_IDS) {
      const result = await fixture.service.inspectSettingsCategory(websiteId, categoryId);
      assert.equal(result.cms, "squarespace", categoryId);
      assert.equal(result.categoryId, categoryId);
      assert.equal(result.source, "squarespace_settings_ui");
      assert.equal(result.mechanism, "browser_ui");
      assert.ok(Number.isFinite(Date.parse(result.inspectedAt)), categoryId);
      assert.ok(Array.isArray(result.limitations), categoryId);
      assert.ok(Array.isArray(result.unsupportedFields), categoryId);
      assert.ok(Array.isArray(result.fields), categoryId);
      assert.ok(Array.isArray(result.availableValues), categoryId);
      assert.equal(typeof result.restrictedFieldCount, "number", categoryId);
      assert.equal(typeof result.unsupportedFieldCount, "number", categoryId);
      assert.ok(Array.isArray(result.errors), categoryId);
      if (categoryId === "website" || categoryId === "domains_email") {
        assert.equal(result.status, "PARTIALLY_AVAILABLE", categoryId);
        assert.ok(result.availableValues.length > 0, categoryId);
      } else {
        assert.equal(result.status, "PARTIALLY_AVAILABLE", categoryId);
        assert.equal(result.fields[0]?.value, null);
        assert.equal(
          result.fields[0]?.valueStatus,
          categoryId === "billing" ||
            categoryId === "customer_notifications" ||
            categoryId === "permissions_ownership"
            ? "REDACTED"
            : "EMPTY",
          categoryId,
        );
      }
    }
    assert.equal(
      await fixture.page.locator("html").getAttribute("data-mutation-count"),
      "0",
    );
  } finally {
    await fixture.browser.close();
  }
});

test("reports missing categories and access denial without inventing settings", async () => {
  const missing = await createFixture({ missingCategory: "Billing" });
  try {
    const result = await missing.service.inspectSettingsCategory(websiteId, "billing");
    assert.equal(result.status, "UNKNOWN");
    assert.deepEqual(result.fields, []);
    assert.ok(result.unsupportedFields.includes("Billing settings values and controls"));
  } finally {
    await missing.browser.close();
  }

  const denied = await createFixture({ accessDeniedCategory: "Billing" });
  try {
    const result = await denied.service.inspectSettingsCategory(websiteId, "billing");
    assert.equal(result.status, "ACCESS_DENIED");
    assert.equal(result.fields[0]?.valueStatus, "ACCESS_DENIED");
    assert.ok(result.unsupportedFields.includes("Billing settings"));
  } finally {
    await denied.browser.close();
  }
});

test("reports browser navigation timeouts without returning a successful inspection", async () => {
  const fixture = await createFixture({ transitionDomains: false });
  try {
    const result = await fixture.service.inspectSettingsCategory(websiteId, "domains_email");
    assert.equal(result.status, "ERROR");
    assert.deepEqual(result.errors, [{ code: "BROWSER_TIMEOUT" }]);
  } finally {
    await fixture.browser.close();
  }
});

test("reports settings browser errors without exposing exception messages", async () => {
  const fixture = await createFixture({ browserError: true });
  try {
    const result = await fixture.service.inspectSettingsCategory(websiteId, "billing");
    assert.equal(result.status, "ERROR");
    assert.deepEqual(result.errors, [{ code: "WEBSITE_SETTINGS_NOT_AVAILABLE" }]);
    assert.doesNotMatch(JSON.stringify(result), /Fixture settings navigation failed/);
  } finally {
    await fixture.browser.close();
  }
});

test("extracts visible values and states while excluding masked, sensitive, and hidden values", async () => {
  const fixture = await createFixture({ detailedControls: true });
  try {
    const result = await fixture.service.inspectSettingsCategory(
      websiteId,
      "customer_notifications",
    );
    const field = (label: string) => result.fields.find((item) => item.label === label);

    assert.equal(field("Text setting")?.value, "Visible fixture value");
    assert.equal(field("Text setting")?.valueType, "string");
    assert.equal(field("Numeric setting")?.value, 42);
    assert.equal(field("Numeric setting")?.valueType, "number");
    assert.equal(field("Selection")?.value, "Second");
    assert.equal(field("Boolean preference")?.value, true);
    assert.equal(field("Enabled")?.value, true);
    assert.equal(field("Disabled")?.value, false);
    assert.equal(field("Empty setting")?.valueStatus, "EMPTY");
    assert.equal(field("Empty setting")?.value, null);
    assert.equal(field("Masked setting")?.valueStatus, "MASKED");
    assert.equal(field("Masked setting")?.value, null);
    const maskedText = field("Masked text")?.value;
    assert.equal(
      field("Masked text")?.valueStatus,
      "MASKED",
      typeof maskedText === "string"
        ? Array.from(maskedText).map((character) => character.codePointAt(0))
          .join(",")
        : String(maskedText),
    );
    assert.equal(field("Masked text")?.value, null);
    assert.equal(field("API key")?.valueStatus, "REDACTED");
    assert.equal(field("API key")?.value, null);
    assert.equal(field("Contact email")?.valueStatus, "REDACTED");
    assert.equal(field("Contact email")?.value, null);
    assert.equal(field("Contact name")?.valueStatus, "REDACTED");
    assert.equal(field("Contact name")?.value, null);
    assert.equal(field("Upload")?.valueStatus, "UNSUPPORTED");
    assert.equal(field("Feature switch")?.value, false);
    assert.equal(field("Public link")?.value, "https://example.invalid/about");
    assert.equal(field("Public link")?.valueType, "url");
    assert.equal(field("Secret URL")?.valueStatus, "REDACTED");
    assert.equal(field("Secret URL")?.value, null);
    assert.equal(field("Unexposed choice")?.valueStatus, "UNKNOWN");
    assert.equal(field("Unexposed choice")?.value, null);
    assert.equal(field("Hidden setting"), undefined);
    assert.equal(
      result.fields.some((item) =>
        JSON.stringify(item).includes("fixture-only-sensitive-marker") ||
        JSON.stringify(item).includes("fixture-only-hidden-marker") ||
        JSON.stringify(item).includes("fixture-only-url-marker") ||
        JSON.stringify(item).includes("fixture-only-code-marker") ||
        JSON.stringify(item).includes("fixture@example.invalid") ||
        JSON.stringify(item).includes("Fixture Person")),
      false,
    );
    assert.equal(result.restrictedFieldCount, 7);
    assert.ok(result.unsupportedFieldCount >= 1);
    assert.equal(
      await fixture.page.locator("html").getAttribute("data-mutation-count"),
      "0",
    );
  } finally {
    await fixture.browser.close();
  }
});

test("does not interpret a prompt or label as an unexposed setting value", async () => {
  const fixture = await createFixture({ detailedControls: true });
  try {
    const result = await fixture.service.inspectSettingsCategory(websiteId, "marketing");
    const choice = result.fields.find((item) => item.fieldId && item.label === "Unexposed choice");
    assert.equal(choice?.valueStatus, "UNKNOWN");
    assert.equal(choice?.value, null);
    assert.equal(choice?.confidence, 0);
  } finally {
    await fixture.browser.close();
  }
});

test("excludes developer code fields and restricts billing fields by default", async () => {
  const developerFixture = await createFixture({ detailedControls: true });
  try {
    const result = await developerFixture.service.inspectSettingsCategory(
      websiteId,
      "developer_tools",
    );
    assert.equal(
      result.fields.find((field) => field.label === "Custom code")?.valueStatus,
      "UNSUPPORTED",
    );
    assert.equal(result.fields.find((field) => field.label === "Custom code")?.value, null);
    assert.ok(result.unsupportedFields.includes("Hidden or non-rendered controls"));
  } finally {
    await developerFixture.browser.close();
  }

  const billingFixture = await createFixture({ detailedControls: true });
  try {
    const result = await billingFixture.service.inspectSettingsCategory(websiteId, "billing");
    assert.equal(result.fields.find((field) => field.label === "Text setting")?.valueStatus, "REDACTED");
    assert.equal(result.fields.find((field) => field.label === "Text setting")?.value, null);
    assert.equal(result.fields.find((field) => field.label === "Selection")?.valueStatus, "REDACTED");
  } finally {
    await billingFixture.browser.close();
  }
});
