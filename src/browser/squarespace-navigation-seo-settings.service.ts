import type { Frame, Page } from "playwright";
import { SquarespaceBrowserError } from "./browser-errors.js";
import type {
  PageNavigationNode,
  PageSeoSettings,
  SquarespacePagesService,
} from "./squarespace-pages.service.js";
import type { SquarespaceBrowserService } from "./squarespace-browser.service.js";

type SettingsBrowser = Pick<
  SquarespaceBrowserService,
  "getWebsite" | "listWebsites" | "openWebsitePages" | "openWebsiteUrl" | "getCurrentPage"
>;
type SettingsPages = Pick<
  SquarespacePagesService,
  | "getNavigationStructure"
  | "getPageDetails"
  | "inspectPageSections"
  | "inspectPageSeoSettings"
  | "listPages"
  | "listNotLinkedPages"
>;

export interface RenderedPageMetadata {
  available: boolean;
  title: string;
  description: string | null;
  canonicalUrl: string | null;
  robots: string | null;
  openGraphTitle: string | null;
  openGraphDescription: string | null;
  openGraphImage: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
  source: "rendered_html";
  unavailableReason: string | null;
}

export interface SquarespaceSettingsInspection {
  getNavigationStructure(websiteId: string): ReturnType<SettingsPages["getNavigationStructure"]>;
  listMainNavigation(websiteId: string): Promise<unknown>;
  listFooterNavigation(websiteId: string): Promise<unknown>;
  listNotLinkedPages(websiteId: string): ReturnType<SettingsPages["listNotLinkedPages"]>;
  inspectNavigationItem(websiteId: string, pageId: string): Promise<unknown>;
  inspectNavigationLinks(websiteId: string, pageId?: string): Promise<unknown>;
  inspectPageSeo(websiteId: string, pageId: string): Promise<unknown>;
  getPageMetaTitle(websiteId: string, pageId: string): Promise<unknown>;
  getPageMetaDescription(websiteId: string, pageId: string): Promise<unknown>;
  inspectPageSlug(websiteId: string, pageId: string): Promise<unknown>;
  inspectSocialSharingSettings(websiteId: string, pageId?: string): Promise<unknown>;
  inspectPageIndexingSettings(websiteId: string, pageId: string): Promise<unknown>;
  inspectWebsiteSettings(websiteId: string): Promise<unknown>;
  inspectDomainSettings(websiteId: string): Promise<unknown>;
  inspectSiteInformation(websiteId: string): Promise<unknown>;
  inspectFavicon(websiteId: string): Promise<unknown>;
  inspectSocialLinks(websiteId: string): Promise<unknown>;
  inspectLanguageSettings(websiteId: string): Promise<unknown>;
  inspectTimezoneSettings(websiteId: string): Promise<unknown>;
}

interface SiteSearchAppearance {
  titleFormat: string | null;
  description: string | null;
  source: "squarespace_website_seo_settings";
  available: boolean;
}

interface PageSeoInspection {
  websiteId: string;
  pageId: string;
  pageName: string;
  sources: {
    pageSettings: PageSeoSettings["source"];
    renderedMetadata: RenderedPageMetadata["source"];
    websiteSearchAppearance: SiteSearchAppearance["source"] | null;
  };
  pageSettings: {
    pageTitle: string;
    slug: string | null;
    isHomepage: boolean;
    seoTitle: string | null;
    seoDescription: string | null;
    seoFieldsAvailable: boolean;
    hiddenFromSearchResults: boolean | null;
  };
  websiteSearchAppearance: SiteSearchAppearance | null;
  renderedMetadata: RenderedPageMetadata;
  socialImage: {
    uploadControlAvailable: boolean;
    visiblePreviewCount: number;
    currentImageDetailsAvailable: false;
  };
  limitations: string[];
}

interface SettingsPageData {
  pathname: string;
  visibleText: string;
  headings: string[];
  fieldValues: Array<{ label: string | null; value: string }>;
  visibleImageCount: number;
}

const WEBSITE_SETTING_CARDS = [
  "Site Availability",
  "Password",
  "Site Languages",
  "Regional Settings",
  "Cookies and Data Privacy",
  "Favicon",
  "Social Links",
  "Social Sharing",
  "Pinterest Save Buttons",
  "Import & Export Content",
  "Blog Preferences",
  "Site Promotion",
  "Crawlers",
  "Ads.txt File",
  "Image Settings",
] as const;

const SETTINGS_CATEGORY_NAMES = [
  "Website",
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
] as const;

export class SquarespaceNavigationSeoSettingsService
implements SquarespaceSettingsInspection {
  constructor(
    private readonly browser: SettingsBrowser,
    private readonly pages: SettingsPages,
    private readonly timeoutMs = 15_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer in milliseconds.");
    }
  }

  getNavigationStructure(websiteId: string) {
    return this.pages.getNavigationStructure(websiteId);
  }

  async listMainNavigation(websiteId: string): Promise<unknown> {
    const structure = await this.pages.getNavigationStructure(websiteId);
    const group = structure.groups.find((candidate) => candidate.group === "main_navigation");
    if (!group) {
      throw new SquarespaceBrowserError(
        "NAVIGATION_NOT_AVAILABLE",
        "Squarespace did not expose a Main Navigation group.",
      );
    }
    return { websiteId, group: group.group, label: group.label, pages: group.pages };
  }

  async listFooterNavigation(websiteId: string): Promise<unknown> {
    const structure = await this.pages.getNavigationStructure(websiteId);
    const group = structure.groups.find((candidate) => candidate.group === "footer_navigation");
    if (!group) {
      throw new SquarespaceBrowserError(
        "NAVIGATION_NOT_AVAILABLE",
        "Squarespace did not expose a Footer Navigation group.",
      );
    }
    return { websiteId, group: group.group, label: group.label, pages: group.pages };
  }

  listNotLinkedPages(websiteId: string) {
    return this.pages.listNotLinkedPages(websiteId);
  }

  async inspectNavigationItem(websiteId: string, pageId: string): Promise<unknown> {
    const structure = await this.pages.getNavigationStructure(websiteId);
    for (const group of structure.groups) {
      const found = findNavigationItem(group.pages, pageId);
      if (found) {
        return {
          websiteId,
          source: "squarespace_pages_panel",
          item: found.item,
          order: found.order,
          parentPath: found.parentPath,
        };
      }
    }
    throw new SquarespaceBrowserError(
      "PAGE_NOT_FOUND",
      "The navigation item was not found. Refresh get_navigation_structure and use a returned page ID.",
    );
  }

  async inspectNavigationLinks(
    websiteId: string,
    pageId?: string,
  ): Promise<unknown> {
    const candidates = await this.pages.listPages(websiteId);
    const pageRecord = pageId
      ? candidates.find((candidate) => candidate.id === pageId)
      : candidates.find((candidate) =>
        candidate.type === "page" &&
        candidate.url !== null &&
        new URL(candidate.url).pathname === "/",
      );
    if (!pageRecord) {
      throw new SquarespaceBrowserError(
        pageId ? "PAGE_NOT_FOUND" : "NAVIGATION_NOT_AVAILABLE",
        pageId
          ? "The selected page ID is not in this website's Pages panel."
          : "Squarespace did not expose a homepage URL for rendered navigation inspection.",
      );
    }
    if (pageRecord.type === "folder" || !pageRecord.url) {
      throw new SquarespaceBrowserError(
        "NAVIGATION_NOT_AVAILABLE",
        "Rendered navigation links require a page with a Squarespace URL.",
      );
    }

    const inspection = await this.pages.inspectPageSections(websiteId, pageRecord.id);
    const frame = await this.getRenderedFrame(inspection.url);
    const links = await frame.evaluate<
      Array<{
        index: number;
        area: "footer" | "navigation";
        text: string;
        href: string;
        ariaLabel: string | null;
        visible: boolean;
      }>,
      void
    >(
      `(() => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;
        };
        return Array.from(document.querySelectorAll("nav a[href], footer a[href]"))
          .map((anchor, index) => {
            const url = new URL(anchor.href, window.location.href);
            url.search = "";
            url.hash = "";
            return {
              index,
              area: anchor.closest("footer") ? "footer" : "navigation",
              text: (anchor.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 300),
              href: url.toString(),
              ariaLabel: anchor.getAttribute("aria-label"),
              visible: isVisible(anchor),
            };
          });
      })()`,
      undefined,
    );

    return {
      websiteId,
      pageId: pageRecord.id,
      pageUrl: inspection.url,
      source: "rendered_html_navigation_landmarks",
      links: links.map((link) => ({
        ...link,
        text: redactPrivateText(link.text),
        href: safeSquarespaceOrPublicUrl(link.href),
      })),
      limitation: "Rendered header/footer links do not replace the hierarchical ordering from the Squarespace Pages panel.",
    };
  }

  async inspectPageSeo(
    websiteId: string,
    pageId: string,
  ): Promise<PageSeoInspection> {
    const settings = await this.pages.inspectPageSeoSettings(websiteId, pageId);
    const renderedMetadata = await this.inspectRenderedMetadata(websiteId, pageId);
    const websiteSearchAppearance = settings.isHomepage
      ? await this.readSiteSearchAppearance(websiteId)
      : null;
    return {
      websiteId,
      pageId,
      pageName: settings.pageName,
      sources: {
        pageSettings: settings.source,
        renderedMetadata: renderedMetadata.source,
        websiteSearchAppearance: websiteSearchAppearance?.source ?? null,
      },
      pageSettings: {
        pageTitle: redactPrivateText(settings.pageTitle ?? ""),
        slug: settings.slug,
        isHomepage: settings.isHomepage,
        seoTitle: settings.seoTitle === null ? null : redactPrivateText(settings.seoTitle),
        seoDescription: settings.seoDescription === null
          ? null
          : redactPrivateText(settings.seoDescription),
        seoFieldsAvailable: settings.seoFieldsAvailable,
        hiddenFromSearchResults: settings.hiddenFromSearchResults,
      },
      websiteSearchAppearance,
      renderedMetadata,
      socialImage: {
        uploadControlAvailable: settings.socialImageUploadAvailable,
        visiblePreviewCount: settings.socialImagePreviewCount,
        currentImageDetailsAvailable: false,
      },
      limitations: settings.isHomepage
        ? ["The homepage inherits SEO title and description behavior from website Search Appearance settings."]
        : settings.seoFieldsAvailable
          ? []
          : ["Page-specific SEO controls were not exposed in Squarespace page settings."],
    };
  }

  async getPageMetaTitle(websiteId: string, pageId: string): Promise<unknown> {
    const result = await this.inspectPageSeo(websiteId, pageId);
    return {
      websiteId,
      pageId,
      pageSetting: result.pageSettings.seoTitle,
      websiteTitleFormat: result.websiteSearchAppearance?.titleFormat ?? null,
      renderedTitle: result.renderedMetadata.title,
      sources: {
        pageSetting: result.pageSettings.seoFieldsAvailable
          ? "squarespace_page_settings"
          : null,
        websiteTitleFormat: result.websiteSearchAppearance?.source ?? null,
        renderedTitle: "rendered_html",
      },
    };
  }

  async getPageMetaDescription(websiteId: string, pageId: string): Promise<unknown> {
    const result = await this.inspectPageSeo(websiteId, pageId);
    return {
      websiteId,
      pageId,
      pageSetting: result.pageSettings.seoDescription,
      websiteDescription: result.websiteSearchAppearance?.description ?? null,
      renderedDescription: result.renderedMetadata.description,
      sources: {
        pageSetting: result.pageSettings.seoFieldsAvailable
          ? "squarespace_page_settings"
          : null,
        websiteDescription: result.websiteSearchAppearance?.source ?? null,
        renderedDescription: "rendered_html",
      },
    };
  }

  async inspectPageSlug(websiteId: string, pageId: string): Promise<unknown> {
    const settings = await this.pages.inspectPageSeoSettings(websiteId, pageId);
    const page = await this.pages.getPageDetails(websiteId, pageId);
    return {
      websiteId,
      pageId,
      pageName: settings.pageName,
      slug: settings.slug,
      pageUrl: page.url,
      source: "squarespace_page_settings",
      homepageUsesFixedRootUrl: page.url !== null &&
        new URL(page.url).pathname === "/",
    };
  }

  async inspectSocialSharingSettings(
    websiteId: string,
    pageId?: string,
  ): Promise<unknown> {
    const siteSettings = await this.readSettingsPage(
      websiteId,
      "Social Sharing",
      "/config/settings/website/social-sharing",
    );
    let pageSettings: PageSeoSettings | null = null;
    let renderedMetadata: RenderedPageMetadata | null = null;
    if (pageId) {
      pageSettings = await this.pages.inspectPageSeoSettings(websiteId, pageId);
      renderedMetadata = await this.inspectRenderedMetadata(websiteId, pageId);
    }
    return {
      websiteId,
      source: "squarespace_website_and_page_settings",
      website: {
        imageUploadControlAvailable: siteSettings.visibleText.includes("Add a social logo"),
        visiblePreviewCount: siteSettings.visibleImageCount,
        currentImageDetailsAvailable: false,
      },
      page: pageSettings
        ? {
          pageId,
          imageUploadControlAvailable: pageSettings.socialImageUploadAvailable,
          visiblePreviewCount: pageSettings.socialImagePreviewCount,
          currentImageDetailsAvailable: false,
          renderedMetadata,
        }
        : null,
      limitations: [
        "Squarespace exposed upload controls but did not expose current social image file details in the inspected UI.",
      ],
    };
  }

  async inspectPageIndexingSettings(
    websiteId: string,
    pageId: string,
  ): Promise<unknown> {
    const settings = await this.pages.inspectPageSeoSettings(websiteId, pageId);
    const page = await this.pages.getPageDetails(websiteId, pageId);
    const renderedMetadata = await this.inspectRenderedMetadata(websiteId, pageId);
    return {
      websiteId,
      pageId,
      pageName: settings.pageName,
      hiddenFromSearchResults: settings.hiddenFromSearchResults,
      pageEnabled: page.enabled,
      renderedRobotsMetadata: renderedMetadata.robots,
      source: {
        hiddenFromSearchResults: settings.source,
        pageEnabled: "squarespace_pages_panel",
        renderedRobotsMetadata: renderedMetadata.source,
      },
    };
  }

  async inspectWebsiteSettings(websiteId: string): Promise<unknown> {
    const page = await this.openSettingsRoot(websiteId);
    const categories = await page
      .locator('a[data-test^="menuItem-"]')
      .evaluateAll<Array<{ label: string; href: string }>, void>(
        `(anchors) => anchors.flatMap((anchor) => {
          const label = (anchor.textContent || "").trim();
          const href = anchor.getAttribute("href") || "";
          return href.startsWith("/settings/") && label ? [{ label, href }] : [];
        })`,
        undefined,
      );
    const availableCards: string[] = [];
    for (const title of WEBSITE_SETTING_CARDS) {
      const card = page.getByRole("button", { name: new RegExp(escapeRegExp(title)) });
      if (await card.count() === 1) {
        availableCards.push(title);
      }
    }
    return {
      websiteId,
      pathname: new URL(page.url()).pathname,
      source: "squarespace_settings_ui",
      categories: uniqueByLabel(categories).map((category) => ({
        label: category.label,
        path: new URL(category.href, new URL(this.browser.getWebsite(websiteId).url).origin).pathname,
      })),
      websiteSettings: availableCards,
      limitation: "This lists settings categories exposed by Squarespace; it does not include unrelated account, billing, or owner details.",
    };
  }

  async inspectDomainSettings(websiteId: string): Promise<unknown> {
    const page = await this.openSettingsRoot(websiteId);
    await this.clickObservedCategory(page, "Domains & Email");
    await page.waitForURL(
      (url) => url.pathname.endsWith("/config/settings/domains-email"),
      { timeout: this.timeoutMs },
    );
    const domainsCard = page.getByRole("button", {
      name: /Register and manage domains from Squarespace or other domain sellers/,
    });
    const workspaceCard = page.getByRole("button", {
      name: /Sign up for Google Workspace on a monthly or annual subscription/,
    });
    await domainsCard.waitFor({ state: "visible", timeout: this.timeoutMs });
    const visibleSections = [
      ...((await domainsCard.count()) === 1 ? ["Domains"] : []),
      ...((await workspaceCard.count()) === 1 ? ["Google Workspace"] : []),
    ];
    return {
      websiteId,
      source: "squarespace_domains_email_settings",
      categoryAvailable: true,
      visibleSections,
      domainRecordsAvailable: false,
      unavailableReason: "The observed Domains & Email screen exposed setup/manage cards but no configured domain records or verified domain status.",
    };
  }

  async inspectSiteInformation(websiteId: string): Promise<unknown> {
    const website = this.browser.getWebsite(websiteId);
    return {
      websiteId,
      siteName: redactPrivateText(website.name),
      websiteUrl: safeSquarespaceOrPublicUrl(`${new URL(website.url).origin}/`),
      source: "squarespace_account_website_listing",
      siteInformationSettingsAvailable: false,
      unavailableReason: "No dedicated site-information form was exposed in the inspected Website settings. The site name and URL are read from the authenticated website listing.",
    };
  }

  async inspectFavicon(websiteId: string): Promise<unknown> {
    const data = await this.readSettingsPage(
      websiteId,
      "Favicon",
      "/config/settings/website/favicon",
    );
    return {
      websiteId,
      source: "squarespace_website_favicon_settings",
      uploadControlCount: data.fieldValues.filter((field) => field.label === "file_upload").length,
      visiblePreviewCount: data.visibleImageCount,
      currentFaviconDetailsAvailable: false,
      limitation: "Upload controls were visible, but current favicon file metadata was not exposed.",
    };
  }

  async inspectSocialLinks(websiteId: string): Promise<unknown> {
    const data = await this.readSettingsPage(
      websiteId,
      "Social Links",
      "/config/settings/website/social-links",
    );
    const publicLinks = data.fieldValues
      .filter((field) => field.label === "public_link")
      .map((field) => safeSquarespaceOrPublicUrl(field.value))
      .filter((value): value is string => value !== null);
    return {
      websiteId,
      source: "squarespace_website_social_links_settings",
      links: [...new Set(publicLinks)],
      socialLinkCount: new Set(publicLinks).size,
      emailLinksExcluded: true,
      addLinkControlAvailable: data.fieldValues.some(
        (field) => field.label === "social_link_input",
      ),
    };
  }

  async inspectLanguageSettings(websiteId: string): Promise<unknown> {
    const data = await this.readSettingsPage(
      websiteId,
      "Site Languages",
      "/config/settings/website/language-region/site-languages",
    );
    const languageCombobox = data.fieldValues.find(
      (field) => field.label === "language_combobox",
    );
    return {
      websiteId,
      source: "squarespace_site_language_settings",
      languageRegion: languageCombobox?.value ?? null,
      available: languageCombobox !== undefined,
      unavailableReason: languageCombobox
        ? null
        : "Squarespace displayed the LANGUAGE / REGION label but did not expose a selected language value in the inspected DOM.",
    };
  }

  async inspectTimezoneSettings(websiteId: string): Promise<unknown> {
    const data = await this.readSettingsPage(
      websiteId,
      "Regional Settings",
      "/config/settings/website/language-region/regional-settings",
    );
    const country = data.fieldValues.find((field) => field.label === "Country");
    const timezone = data.fieldValues.find((field) => field.label === "Time Zone");
    const measurementStandard = data.fieldValues.find(
      (field) => field.label === "measurement_standard",
    );
    return {
      websiteId,
      source: "squarespace_regional_settings",
      timezone: timezone?.value.replace(/^Time Zone\s*/, "") ?? null,
      country: country?.value.replace(/^Country\s*/, "") ?? null,
      measurementStandard: measurementStandard?.value ?? null,
      available: country !== undefined || timezone !== undefined,
    };
  }

  private async inspectRenderedMetadata(
    websiteId: string,
    pageId: string,
  ): Promise<RenderedPageMetadata> {
    const pageRecord = await this.pages.getPageDetails(websiteId, pageId);
    if (!pageRecord.url) {
      return unavailableRenderedMetadata(
        "Squarespace did not resolve a URL for this page in the Pages panel.",
      );
    }
    const inspection = await this.pages.inspectPageSections(websiteId, pageId);
    const frame = await this.getRenderedFrame(inspection.url);
    const metadata = await frame.evaluate<
      Omit<RenderedPageMetadata, "available" | "source" | "unavailableReason">,
      void
    >(
      `(() => {
        const meta = (selector) => {
          const element = document.querySelector(selector);
          return element && element.content ? element.content.trim() : null;
        };
        const canonical = document.querySelector('link[rel="canonical"]');
        return {
          title: document.title,
          description: meta('meta[name="description"]'),
          canonicalUrl: canonical ? canonical.href : null,
          robots: meta('meta[name="robots"]'),
          openGraphTitle: meta('meta[property="og:title"]'),
          openGraphDescription: meta('meta[property="og:description"]'),
          openGraphImage: meta('meta[property="og:image"]'),
          twitterTitle: meta('meta[name="twitter:title"]'),
          twitterDescription: meta('meta[name="twitter:description"]'),
          twitterImage: meta('meta[name="twitter:image"]'),
        };
      })()`,
      undefined,
    );
    return {
      ...metadata,
      available: true,
      title: redactPrivateText(metadata.title),
      description: redactNullableText(metadata.description),
      canonicalUrl: metadata.canonicalUrl
        ? safeSquarespaceOrPublicUrl(metadata.canonicalUrl)
        : null,
      robots: redactNullableText(metadata.robots),
      openGraphTitle: redactNullableText(metadata.openGraphTitle),
      openGraphDescription: redactNullableText(metadata.openGraphDescription),
      openGraphImage: metadata.openGraphImage
        ? safeSquarespaceOrPublicUrl(metadata.openGraphImage)
        : null,
      twitterTitle: redactNullableText(metadata.twitterTitle),
      twitterDescription: redactNullableText(metadata.twitterDescription),
      twitterImage: metadata.twitterImage
        ? safeSquarespaceOrPublicUrl(metadata.twitterImage)
        : null,
      source: "rendered_html",
      unavailableReason: null,
    };
  }

  private async readSiteSearchAppearance(
    websiteId: string,
  ): Promise<SiteSearchAppearance> {
    const website = this.browser.getWebsite(websiteId);
    await this.pages.getNavigationStructure(websiteId);
    const homepage = (await this.pages.listPages(websiteId)).find((candidate) =>
      candidate.type === "page" &&
      candidate.url !== null &&
      new URL(candidate.url).pathname === "/",
    );
    if (!homepage) {
      return {
        titleFormat: null,
        description: null,
        source: "squarespace_website_seo_settings",
        available: false,
      };
    }

    const page = await this.browser.getCurrentPage();
    const settingsButton = page.locator(
      `button[aria-label=${JSON.stringify(`Page settings ${homepage.name}`)}]`,
    );
    if (await settingsButton.count() !== 1) {
      throw new SquarespaceBrowserError(
        "SEO_SETTINGS_NOT_AVAILABLE",
        "The homepage's Page Settings control could not be matched unambiguously.",
      );
    }
    await settingsButton.evaluate((element) => (element as HTMLButtonElement).click());
    const dialog = page.locator('[role="dialog"]').last();
    await dialog.waitFor({ state: "visible", timeout: this.timeoutMs });
    try {
      const seoTab = dialog.locator('input[aria-label="SEO"]');
      if (await seoTab.count() !== 1) {
        throw new SquarespaceBrowserError(
          "SEO_SETTINGS_NOT_AVAILABLE",
          "Squarespace did not expose the observed homepage SEO tab.",
        );
      }
      await seoTab.evaluate((element) => (element as HTMLInputElement).click());
      const websiteSeoLink = dialog.locator('a[href="/config/marketing/seo"]');
      if (await websiteSeoLink.count() !== 1) {
        return {
          titleFormat: null,
          description: null,
          source: "squarespace_website_seo_settings",
          available: false,
        };
      }
      await websiteSeoLink.evaluate((element) => (element as HTMLAnchorElement).click());
      await page.locator('input[aria-label="SEO Title Format"]').waitFor({
        state: "visible",
        timeout: this.timeoutMs,
      });
      const titleFormat = await page.locator('input[aria-label="SEO Title Format"]').inputValue();
      const descriptionField = page.locator('textarea[placeholder="Enter a description..."]');
      const description = await descriptionField.count() === 1
        ? await descriptionField.inputValue()
        : null;
      return {
        titleFormat,
        description: redactNullableText(description),
        source: "squarespace_website_seo_settings",
        available: true,
      };
    } finally {
      const close = page.getByRole("button", { name: "Close", exact: true });
      if (await close.count() === 1) {
        await close.click();
      }
    }
  }

  private async openSettingsRoot(websiteId: string): Promise<Page> {
    this.browser.getWebsite(websiteId);
    await this.pages.getNavigationStructure(websiteId);
    const page = await this.browser.getCurrentPage();
    const websiteToggle = page.getByRole("button", { name: "Website", exact: true });
    if (await websiteToggle.count() !== 1) {
      throw new SquarespaceBrowserError(
        "WEBSITE_SETTINGS_NOT_AVAILABLE",
        "Squarespace did not expose the observed Website navigation toggle.",
      );
    }
    await websiteToggle.evaluate((element) => (element as HTMLButtonElement).click());
    const websiteLink = page.locator(
      'a[data-test="menuItem-website"][href="/config/website"]',
    );
    if (await websiteLink.count() !== 1) {
      throw new SquarespaceBrowserError(
        "WEBSITE_SETTINGS_NOT_AVAILABLE",
        "Squarespace did not expose one unambiguous Website settings navigation link.",
      );
    }
    await websiteLink.evaluate((element) => (element as HTMLAnchorElement).click());
    await page.waitForURL(
      (url) => url.origin === new URL(this.browser.getWebsite(websiteId).url).origin &&
        url.pathname.endsWith("/config/website"),
      { timeout: this.timeoutMs },
    );

    const settingsButton = page.locator('button[aria-label="Settings"]');
    if (await settingsButton.count() !== 1) {
      throw new SquarespaceBrowserError(
        "WEBSITE_SETTINGS_NOT_AVAILABLE",
        "Squarespace did not expose one unambiguous Settings control.",
      );
    }
    await settingsButton.evaluate((element) => (element as HTMLButtonElement).click());
    try {
      await page.getByRole("button", { name: /Site Languages/ }).waitFor({
        state: "visible",
        timeout: this.timeoutMs,
      });
    } catch (error) {
      throw new SquarespaceBrowserError(
        "WEBSITE_SETTINGS_NOT_AVAILABLE",
        "The Squarespace Website settings panel did not expose its observed settings cards.",
        { cause: error },
      );
    }
    return page;
  }

  private async readSettingsPage(
    websiteId: string,
    cardTitle: string,
    expectedPath: string,
  ): Promise<SettingsPageData> {
    const page = await this.openSettingsRoot(websiteId);
    const card = page.getByRole("button", {
      name: new RegExp(escapeRegExp(cardTitle)),
    });
    if (await card.count() !== 1) {
      throw new SquarespaceBrowserError(
        "WEBSITE_SETTINGS_NOT_AVAILABLE",
        `Squarespace did not expose one unambiguous ${cardTitle} settings card.`,
      );
    }
    await card.evaluate((element) => (element as HTMLButtonElement).click());
    const website = this.browser.getWebsite(websiteId);
    await page.waitForURL(
      (url) => url.origin === new URL(website.url).origin &&
        url.pathname.endsWith(expectedPath),
      { timeout: this.timeoutMs },
    );
    await page.waitForTimeout(150);
    return page.evaluate<SettingsPageData, void>(String.raw`(() => {
      const controls = Array.from(document.querySelectorAll(
        'input,textarea,select,[role="combobox"],[role="radio"]',
      ));
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const fieldValues = controls.flatMap((element) => {
        if (!isVisible(element)) {
          return [];
        }
        const labels = "labels" in element
          ? Array.from(element.labels ?? []).map((label) => label.innerText.trim())
          : [];
        const role = element.getAttribute("role");
        const type = element.getAttribute("type");
        const value = "value" in element
          ? element.value
          : (element.textContent ?? "").trim();
        if (type === "file") {
          return [{ label: "file_upload", value: "" }];
        }
        if (role === "combobox") {
          const text = (element.textContent ?? "").trim().replace(/\s+/g, " ");
          const label = text.startsWith("Country")
            ? "Country"
            : text.startsWith("Time Zone")
              ? "Time Zone"
              : "language_combobox";
          return [{ label, value: text }];
        }
        if (type === "radio") {
          const label = labels[0] ?? "";
          const checked = element.checked;
          return checked && label
            ? [{ label: "measurement_standard", value: label }]
            : [];
        }
        if (
          element instanceof HTMLInputElement &&
          element.type === "text" &&
          element.getAttribute("aria-label") === "Add a social link or email"
        ) {
          return [{ label: "social_link_input", value: "" }];
        }
        if (element instanceof HTMLAnchorElement) {
          return [];
        }
        return labels.map((label) => ({ label, value }));
      });
      const publicLinks = Array.from(document.querySelectorAll("a[href]"))
        .flatMap((element) => {
          const link = element;
          if (!isVisible(link) || link.href.startsWith("mailto:")) {
            return [];
          }
          const host = new URL(link.href).hostname;
          if (
            host === "squarespace.com" ||
            host.endsWith(".squarespace.com") ||
            host === window.location.hostname
          ) {
            return [];
          }
          return [{ label: "public_link", value: link.href }];
        });
      const textLines = (document.body?.innerText ?? "").split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const publicTextLinks = textLines.flatMap((line) =>
        /^(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(line) &&
          !line.includes("@")
          ? [{ label: "public_link", value: line.startsWith("http") ? line : "https://" + line }]
          : [],
      );
      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .filter(isVisible)
        .map((heading) => (heading.textContent ?? "").trim())
        .filter(Boolean);
      return {
        pathname: window.location.pathname,
        visibleText: document.body?.innerText ?? "",
        headings,
        fieldValues: [...fieldValues, ...publicLinks, ...publicTextLinks],
        visibleImageCount: Array.from(document.querySelectorAll("img")).filter(isVisible).length,
      };
    })()`, undefined);
  }

  private async clickObservedCategory(page: Page, name: string): Promise<void> {
    if (!SETTINGS_CATEGORY_NAMES.includes(name as typeof SETTINGS_CATEGORY_NAMES[number])) {
      throw new SquarespaceBrowserError(
        "WEBSITE_SETTINGS_NOT_AVAILABLE",
        "The requested Squarespace settings category was not verified.",
      );
    }
    const category = page.getByRole("button", { name, exact: true });
    if (await category.count() !== 1) {
      throw new SquarespaceBrowserError(
        "WEBSITE_SETTINGS_NOT_AVAILABLE",
        `Squarespace did not expose one unambiguous ${name} settings category.`,
      );
    }
    await category.evaluate((element) => (element as HTMLInputElement).click());
  }

  private async getRenderedFrame(targetUrl: string): Promise<Frame> {
    const target = new URL(targetUrl);
    const page = await this.browser.getCurrentPage();
    const normalizePath = (path: string) => path === "/" ? path : path.replace(/\/+$/, "");
    const frame = page.frames().find((candidate) => {
      try {
        const frameUrl = new URL(candidate.url());
        return frameUrl.origin === target.origin &&
          normalizePath(frameUrl.pathname) === normalizePath(target.pathname);
      } catch {
        return false;
      }
    });
    if (!frame) {
      throw new SquarespaceBrowserError(
        "SECTIONS_NOT_AVAILABLE",
        "The selected page's rendered Squarespace frame could not be matched.",
      );
    }
    return frame;
  }
}

function findNavigationItem(
  nodes: PageNavigationNode[],
  pageId: string,
  parentPath: string[] = [],
): { item: PageNavigationNode; order: number; parentPath: string[] } | null {
  for (const [index, node] of nodes.entries()) {
    if (node.id === pageId) {
      return {
        item: node,
        order: index + 1,
        parentPath,
      };
    }
    const child = findNavigationItem(node.children, pageId, [...parentPath, node.name]);
    if (child) {
      return child;
    }
  }
  return null;
}

function uniqueByLabel<T extends { label: string }>(items: T[]): T[] {
  const found = new Set<string>();
  return items.filter((item) => {
    if (found.has(item.label)) {
      return false;
    }
    found.add(item.label);
    return true;
  });
}

function redactPrivateText(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\b(?:password|token|secret|cookie)\s*[:=]\s*\S+/gi, "[redacted]");
}

function redactNullableText(value: string | null): string | null {
  return value === null ? null : redactPrivateText(value);
}

function unavailableRenderedMetadata(reason: string): RenderedPageMetadata {
  return {
    available: false,
    title: "",
    description: null,
    canonicalUrl: null,
    robots: null,
    openGraphTitle: null,
    openGraphDescription: null,
    openGraphImage: null,
    twitterTitle: null,
    twitterDescription: null,
    twitterImage: null,
    source: "rendered_html",
    unavailableReason: reason,
  };
}

function safeSquarespaceOrPublicUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return redactPrivateText(url.toString());
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
