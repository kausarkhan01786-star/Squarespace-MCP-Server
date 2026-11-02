import type { Frame, Page } from "playwright";
import {
  ExecutionStoppedError,
  waitForExecutionDelay,
  waitForLocatorState,
  waitForPageUrl,
} from "./browser-execution-context.js";
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
  inspectSettingsCategory(
    websiteId: string,
    categoryId: SettingsCategoryId,
  ): Promise<SettingsCategoryInspection>;
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
  hasSocialLogoControl: boolean;
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

export const SETTINGS_CATEGORY_IDS = [
  "website",
  "domains_email",
  "customer_notifications",
  "selling",
  "brand",
  "marketing",
  "extensions",
  "third_party_tools",
  "permissions_ownership",
  "billing",
  "developer_tools",
] as const;

export type SettingsCategoryId = typeof SETTINGS_CATEGORY_IDS[number];
export type SettingsInspectionStatus =
  | "AVAILABLE"
  | "PARTIALLY_AVAILABLE"
  | "NOT_AVAILABLE"
  | "ACCESS_DENIED"
  | "UNKNOWN"
  | "ERROR";

export type SettingsFieldValue = string | number | boolean | string[] | null;
export type SettingsFieldValueType =
  | "string"
  | "number"
  | "boolean"
  | "url"
  | "string_list"
  | "unknown";
export type SettingsFieldValueStatus =
  | "AVAILABLE"
  | "EMPTY"
  | "MASKED"
  | "REDACTED"
  | "ACCESS_DENIED"
  | "UNSUPPORTED"
  | "UNKNOWN"
  | "ERROR";

export interface SettingsFieldInspection {
  fieldId: string;
  label: string;
  value: SettingsFieldValue;
  valueType: SettingsFieldValueType;
  valueStatus: SettingsFieldValueStatus;
  source: string;
  inspectionMethod: string;
  confidence: number;
  limitations: string[];
  isSensitive: boolean;
}

export interface SettingsInspectionError {
  code: string;
}

interface VisibleSettingsInspection {
  fields: SettingsFieldInspection[];
  headings: string[];
  unsupportedLabels: string[];
  accessDenied: boolean;
}

export interface SettingsCategoryInspection {
  cms: "squarespace";
  categoryId: SettingsCategoryId;
  status: SettingsInspectionStatus;
  fields: SettingsFieldInspection[];
  availableValues: SettingsFieldInspection[];
  restrictedFieldCount: number;
  unsupportedFieldCount: number;
  source: "squarespace_settings_ui";
  mechanism: "browser_ui";
  inspectionMethod: "visible_dom_controls_and_existing_inspectors";
  inspectedAt: string;
  limitations: string[];
  unsupportedFields: string[];
  errors: SettingsInspectionError[];
}

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
        imageUploadControlAvailable: siteSettings.hasSocialLogoControl,
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
    const categories = await page.evaluate<Array<{ label: string; href: string }>>(
      String.raw`(() => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const anchors = Array.from(document.querySelectorAll('a[data-test^="menuItem-"]'));
      return anchors.filter(isVisible).flatMap((anchor) => {
          const label = (anchor.textContent || "").trim();
          const href = anchor.getAttribute("href") || "";
          return href.startsWith("/settings/") && label ? [{ label, href }] : [];
        });
      })()`,
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

  async inspectSettingsCategory(
    websiteId: string,
    categoryId: SettingsCategoryId,
  ): Promise<SettingsCategoryInspection> {
    const inspectedAt = new Date().toISOString();
    const label = settingsCategoryLabel(categoryId);
    const makeResult = (
      fields: SettingsFieldInspection[],
      options: {
        status?: SettingsInspectionStatus;
        limitations?: string[];
        unsupportedFields?: string[];
        errors?: SettingsInspectionError[];
      } = {},
    ): SettingsCategoryInspection => {
      const availableValues = fields.filter((field) =>
        field.valueStatus === "AVAILABLE");
      const unsupportedFields = options.unsupportedFields ?? [];
      const status = options.status ?? (
        fields.length === 0
          ? "UNKNOWN"
        : fields.every((field) =>
            field.valueStatus === "AVAILABLE" || field.valueStatus === "EMPTY") &&
            unsupportedFields.length === 0
          ? "AVAILABLE"
            : "PARTIALLY_AVAILABLE"
      );
      return {
        cms: "squarespace",
        categoryId,
        status,
        fields,
        availableValues,
        restrictedFieldCount: fields.filter((field) =>
          field.valueStatus === "MASKED" ||
          field.valueStatus === "REDACTED" ||
          field.valueStatus === "ACCESS_DENIED").length,
        unsupportedFieldCount: new Set([
          ...fields
            .filter((field) => field.valueStatus === "UNSUPPORTED")
            .map((field) => field.label),
          ...unsupportedFields,
        ]).size,
        source: "squarespace_settings_ui",
        mechanism: "browser_ui",
        inspectionMethod: "visible_dom_controls_and_existing_inspectors",
        inspectedAt,
        limitations: options.limitations ?? [],
        unsupportedFields,
        errors: options.errors ?? [],
      };
    };

    try {
      if (categoryId === "website") {
        const settings = await this.inspectWebsiteSettings(websiteId) as {
          categories: Array<{ label: string; path: string }>;
          websiteSettings: string[];
        };
        const website = this.browser.getWebsite(websiteId);
        const page = await this.browser.getCurrentPage();
        const inspected = await this.readVisibleSettingsFields(page, categoryId);
        if (inspected.accessDenied) {
          return makeResult([settingsAccessDeniedField("Website")], {
            status: "ACCESS_DENIED",
            limitations: ["Squarespace reported that access to Website settings is denied."],
            unsupportedFields: ["Website settings"],
          });
        }
        const fields = [
          settingsListField("settings_categories", "Available settings categories",
            settings.categories.map((category) => category.label)),
          settingsListField("website_settings_cards", "Visible Website settings cards",
            settings.websiteSettings),
          settingsValueField(
            "site_name",
            "Public site name",
            redactPrivateText(website.name),
            "string",
            "squarespace_account_website_listing",
            "authenticated_website_listing",
          ),
          settingsValueField(
            "website_url",
            "Public website URL",
            safeSquarespaceOrPublicUrl(`${new URL(website.url).origin}/`),
            "url",
            "squarespace_account_website_listing",
            "authenticated_website_listing",
          ),
          ...inspected.fields,
        ];
        return makeResult(fields, {
          limitations: [
            "Website category cards and public site metadata are observable, but this overview does not inspect every linked Website settings screen.",
            "Only visible, labeled controls on the current settings screen are read.",
          ],
          unsupportedFields: [
            "Values on Website sub-settings screens not opened by existing inspectors",
            "Hidden or non-rendered controls",
          ],
        });
      }

      if (categoryId === "domains_email") {
        const settings = await this.inspectDomainSettings(websiteId) as {
          visibleSections: string[];
          domainRecordsAvailable: boolean;
        };
        const page = await this.browser.getCurrentPage();
        const inspected = await this.readVisibleSettingsFields(page, categoryId);
        if (inspected.accessDenied) {
          return makeResult([settingsAccessDeniedField("Domains & Email")], {
            status: "ACCESS_DENIED",
            limitations: ["Squarespace reported that access to Domains & Email settings is denied."],
            unsupportedFields: ["Domains & Email settings"],
          });
        }
        const unsupportedFields = settings.domainRecordsAvailable
          ? []
          : [
            "Configured domain records",
            "Verified domain status",
            "Email configuration details",
          ];
        return makeResult([
          settingsListField(
            "visible_sections",
            "Visible Domains & Email sections",
            settings.visibleSections,
          ),
          ...inspected.fields,
        ], {
          limitations: [
            "The observed screen exposes setup cards, not configured domain records or verified domain status.",
            "Only visible, labeled controls on the current settings screen are read.",
          ],
          unsupportedFields,
        });
      }

      const page = await this.openSettingsRoot(websiteId);
      const category = page.getByRole("button", { name: label, exact: true });
      const categoryCount = await category.count();
      if (categoryCount === 0) {
        return makeResult([], {
          status: "UNKNOWN",
          limitations: [`The ${label} category was not exposed in the observed settings UI.`],
          unsupportedFields: [`${label} settings values and controls`],
        });
      }
      if (categoryCount !== 1) {
        throw new SquarespaceBrowserError(
          "WEBSITE_SETTINGS_NOT_AVAILABLE",
          `Squarespace exposed an ambiguous ${label} settings category.`,
        );
      }

      await this.clickObservedCategory(page, label);
      await waitForExecutionDelay(150);
      const inspected = await this.readVisibleSettingsFields(page, categoryId);
      if (inspected.accessDenied) {
        return makeResult([settingsAccessDeniedField(label)], {
          status: "ACCESS_DENIED",
          limitations: [`Squarespace reported that access to ${label} settings is denied.`],
          unsupportedFields: [`${label} settings`],
        });
      }

      return makeResult(inspected.fields, {
        limitations: [
          "Only visible, labeled controls and their exposed values are inspected.",
          "Hidden controls, inaccessible fields, and settings outside the current category screen are not inspected.",
          ...(inspected.headings.length === 0
            ? ["No visible category heading was exposed."]
            : []),
        ],
        unsupportedFields: [
          ...inspected.unsupportedLabels,
          "Hidden or non-rendered controls",
          "Settings not exposed by the current account",
        ],
      });
    } catch (error) {
      let code = "INSPECTION_FAILED";
      if (error instanceof SquarespaceBrowserError) {
        code = error.code;
      } else if (error instanceof ExecutionStoppedError) {
        code = error.reason.toUpperCase();
      } else if (error instanceof Error && error.name === "TimeoutError") {
        code = "BROWSER_TIMEOUT";
      } else if (error instanceof TypeError) {
        code = "INSPECTION_TYPE_ERROR";
      } else if (error instanceof ReferenceError) {
        code = "INSPECTION_REFERENCE_ERROR";
      } else if (error instanceof SyntaxError) {
        code = "INSPECTION_SYNTAX_ERROR";
      }
      return makeResult([], {
        status: "ERROR",
        limitations: ["Inspection stopped before reliable settings values could be returned."],
        unsupportedFields: [`${label} values not inspected`],
        errors: [{ code }],
      });
    }
  }

  private async readVisibleSettingsFields(
    page: Page,
    categoryId: SettingsCategoryId,
  ): Promise<VisibleSettingsInspection> {
    return page.evaluate<VisibleSettingsInspection, void>(
      String.raw`((category) => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const accessDenied =
          /access denied|permission denied|not authorized|you do not have permission/i
            .test(document.body?.innerText ?? "");
        if (accessDenied) {
          return { fields: [], headings: [], unsupportedLabels: [], accessDenied: true };
        }

        const privateLabel =
          /password|passcode|secret|token|api[\s_-]*key|access[\s_-]*key|credential|cookie|private[\s_-]*key|e-?mail|phone|mobile|postal address|billing address|first name|last name|full name|contact|recipient|\bname\b|birth|personal|customer|user|member|owner|account holder|card|cvv|security code|bank|routing/i;
        const billingSafeLabel =
          /\bplan\b|\bsubscription (?:type|plan|tier)\b|\b(?:billing|subscription) (?:frequency|interval)\b|\bcurrency\b/i;
        const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4"))
          .filter(isVisible)
          .map((element) => (element.textContent ?? "").trim())
          .filter(Boolean);
        const fields = [];
        const unsupportedLabels = [];
        const controls = Array.from(document.querySelectorAll(
          "input,textarea,select,[role='combobox'],[role='switch'],[role='radio']",
        ));

        const labelFor = (element) => {
          const nativeLabels = "labels" in element
            ? Array.from(element.labels ?? [])
              .filter(isVisible)
              .map((item) => item.innerText.trim())
            : [];
          const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id))
            .filter((item) => item !== null && isVisible(item))
            .map((item) => item.innerText.trim());
          return element.getAttribute("aria-label")?.trim() ??
            nativeLabels.find(Boolean) ??
            labelledBy.find(Boolean) ??
            element.closest("label")?.textContent?.trim() ??
            element.getAttribute("name")?.trim() ??
            "";
        };
        const addField = (
          label,
          value,
          valueType,
          valueStatus,
          inspectionMethod,
          isSensitive,
          limitations = [],
        ) => {
          const fieldId = "setting_" + (fields.length + 1);
          fields.push({
            fieldId,
            label,
            value,
            valueType,
            valueStatus,
            source: "squarespace_settings_ui",
            inspectionMethod,
            confidence: valueStatus === "AVAILABLE" || valueStatus === "EMPTY"
              ? 0.95
              : valueStatus === "UNKNOWN"
                ? 0
                : 1,
            limitations,
            isSensitive,
          });
        };

        for (const element of controls) {
          if (!isVisible(element)) continue;
          const input = element instanceof HTMLInputElement ? element : null;
          const type = input?.type.toLowerCase() ?? "";
          if (type === "hidden") continue;
          if (["button", "submit", "reset", "image"].includes(type)) continue;

          const label = labelFor(element);
          const role = element.getAttribute("role");
          const safePublicName = /\b(?:site|website) name\b/i.test(label);
          const sensitive = (
            privateLabel.test(label + " " + (input?.name ?? "")) &&
            !(safePublicName && !privateLabel.test(input?.name ?? ""))
          ) ||
            (category === "billing" && !billingSafeLabel.test(label));
          if (!label) {
            unsupportedLabels.push("Unlabeled visible control");
            continue;
          }
          if (type === "password") {
            addField(
              label,
              null,
              "unknown",
              "MASKED",
              "password_control_presence",
              true,
              ["Password values are never read."],
            );
            continue;
          }
          if (sensitive || type === "email" || type === "tel") {
            addField(
              label,
              null,
              "unknown",
              "REDACTED",
              "sensitive_field_classification",
              true,
              ["Sensitive values are not read or returned."],
            );
            continue;
          }
          if (
            element instanceof HTMLTextAreaElement ||
            (category === "developer_tools" && /code|script|javascript|html|injection/i.test(label))
          ) {
            addField(
              label,
              null,
              "unknown",
              "UNSUPPORTED",
              "long_form_or_code_field_exclusion",
              false,
              ["Long-form text and code or injection contents are not inspected."],
            );
            unsupportedLabels.push(label);
            continue;
          }
          if (type === "file") {
            addField(
              label,
              null,
              "unknown",
              "UNSUPPORTED",
              "file_control_exclusion",
              false,
              ["File contents and local file paths are not inspected."],
            );
            unsupportedLabels.push(label);
            continue;
          }
          if (input?.type === "checkbox" || role === "switch") {
            const checked = input
              ? input.checked
              : element.getAttribute("aria-checked") === "true";
            addField(
              label,
              checked,
              "boolean",
              "AVAILABLE",
              "visible_toggle_checked_state",
              false,
            );
            continue;
          }
          if (input?.type === "radio" || role === "radio") {
            const checked = input
              ? input.checked
              : element.getAttribute("aria-checked") === "true";
            addField(
              label,
              checked,
              "boolean",
              "AVAILABLE",
              "visible_radio_checked_state",
              false,
            );
            continue;
          }
          if (element instanceof HTMLSelectElement) {
            const selected = Array.from(element.selectedOptions)
              .map((option) => option.label.trim())
              .filter(Boolean);
            const value = element.multiple
              ? selected
              : selected[0] ?? null;
            addField(
              label,
              value,
              element.multiple ? "string_list" : "string",
              selected.length === 0 ? "EMPTY" : "AVAILABLE",
              "visible_selected_native_option",
              false,
            );
            continue;
          }
          if (role === "combobox") {
            const exposedValue = element.getAttribute("aria-valuetext")?.trim() ||
              element.getAttribute("aria-valuenow")?.trim() ||
              Array.from(element.querySelectorAll("[role='option'][aria-selected='true']"))
                .filter(isVisible)
                .map((option) => option.textContent?.trim() ?? "")
                .find(Boolean) ||
              null;
            addField(
              label,
              exposedValue,
              "string",
              exposedValue === null ? "UNKNOWN" : "AVAILABLE",
              "visible_accessible_combobox_value",
              false,
              exposedValue === null
                ? ["No selected option value was exposed through the visible accessible control."]
                : [],
            );
            continue;
          }

          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            if (!["text", "search", "url", "number", "date", "datetime-local", "time"]
              .includes(type || "text") && !(element instanceof HTMLTextAreaElement)) {
              addField(
                label,
                null,
                "unknown",
                "UNSUPPORTED",
                "unsupported_control_type",
                false,
                ["This visible control type is not read by the settings inspector."],
              );
              unsupportedLabels.push(label);
              continue;
            }
            const rawValue = element.value.trim();
            if (rawValue && /^[\u2022\u25cf\u00b7\u00d7*]+$/.test(rawValue)) {
              addField(
                label,
                null,
                "unknown",
                "MASKED",
                "visible_masked_value",
                true,
                ["Masked values are never returned."],
              );
              continue;
            }
            let value = rawValue || null;
            let valueStatus = value === null
              ? "EMPTY"
              : "AVAILABLE";
            let valueType =
              type === "url" ? "url" : type === "number" ? "number" : "string";
            if (type === "url" && rawValue) {
              try {
                const url = new URL(rawValue);
                if (
                  !["http:", "https:"].includes(url.protocol) ||
                  url.username ||
                  url.password ||
                  url.search ||
                  url.hash
                ) {
                  addField(
                    label,
                    null,
                    "url",
                    "REDACTED",
                    "unsafe_url_exclusion",
                    true,
                    ["URLs containing credentials, query parameters, or fragments are not returned."],
                  );
                  continue;
                }
                value = url.toString();
              } catch {
                value = null;
                valueStatus = "UNKNOWN";
              }
            } else if (type === "number" && rawValue) {
              const numberValue = Number(rawValue);
              value = Number.isFinite(numberValue) ? numberValue : null;
              if (value === null) valueStatus = "UNKNOWN";
            }
            addField(
              label,
              value,
              valueType,
              valueStatus,
              element instanceof HTMLTextAreaElement
                ? "visible_textarea_value"
                : type === "url"
                  ? "visible_public_url_value"
                  : type === "number"
                    ? "visible_number_input_value"
                    : "visible_text_input_value",
              false,
            );
            continue;
          }

          unsupportedLabels.push(label);
          addField(
            label,
            null,
            "unknown",
            "UNSUPPORTED",
            "unsupported_visible_control",
            false,
            ["The visible control does not expose a supported value representation."],
          );
        }

        return { fields, headings, unsupportedLabels, accessDenied: false };
      })(${JSON.stringify(categoryId)})`,
      undefined,
    );
  }

  async inspectDomainSettings(websiteId: string): Promise<unknown> {
    const page = await this.openSettingsRoot(websiteId);
    await this.clickObservedCategory(page, "Domains & Email");
    await waitForPageUrl(
      page,
      (url) => url.pathname.endsWith("/config/settings/domains-email"),
      this.timeoutMs,
    );
    const domainsCard = page.getByRole("button", {
      name: /Register and manage domains from Squarespace or other domain sellers/,
    });
    const workspaceCard = page.getByRole("button", {
      name: /Sign up for Google Workspace on a monthly or annual subscription/,
    });
    await waitForLocatorState(domainsCard, "visible", this.timeoutMs);
    const visibleSections = [
      ...((await domainsCard.count()) === 1 && await domainsCard.isVisible()
        ? ["Domains"]
        : []),
      ...((await workspaceCard.count()) === 1 && await workspaceCard.isVisible()
        ? ["Google Workspace"]
        : []),
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
    await waitForLocatorState(dialog, "visible", this.timeoutMs);
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
      await waitForLocatorState(
        page.locator('input[aria-label="SEO Title Format"]'),
        "visible",
        this.timeoutMs,
      );
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
    await waitForPageUrl(
      page,
      (url) => url.origin === new URL(this.browser.getWebsite(websiteId).url).origin &&
        url.pathname.endsWith("/config/website"),
      this.timeoutMs,
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
      await waitForLocatorState(
        page.getByRole("button", { name: /Site Languages/ }),
        "visible",
        this.timeoutMs,
      );
    } catch (error) {
      if (error instanceof ExecutionStoppedError) throw error;
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
    await waitForPageUrl(
      page,
      (url) => url.origin === new URL(website.url).origin &&
        url.pathname.endsWith(expectedPath),
      this.timeoutMs,
    );
    await waitForExecutionDelay(150);
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
      const safeVisibleUrl = (value) => {
        try {
          const url = new URL(value);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          ) {
            return null;
          }
          return url.toString();
        } catch {
          return null;
        }
      };
      const fieldValues = controls.flatMap((element) => {
        if (!isVisible(element)) {
          return [];
        }
        const input = element instanceof HTMLInputElement ? element : null;
        const type = input?.type.toLowerCase() ?? "";
        if (type === "hidden") {
          return [];
        }
        const labels = "labels" in element
          ? Array.from(element.labels ?? [])
            .filter(isVisible)
            .map((label) => label.innerText.trim())
          : [];
        const role = element.getAttribute("role");
        const accessibleLabel = element.getAttribute("aria-label")?.trim() ??
          labels.find(Boolean) ??
          input?.name ??
          "";
        if (
          input?.type === "text" &&
          input.getAttribute("aria-label") === "Add a social link or email"
        ) {
          return [{ label: "social_link_input", value: "" }];
        }
        const isPrivate = /password|passcode|secret|token|api[\s_-]*key|access[\s_-]*key|credential|cookie|private[\s_-]*key|e-?mail|phone|mobile|postal address|billing address|first name|last name|full name|contact|recipient|\bname\b|birth|personal|customer|user|member|owner|account holder|card|cvv|security code|bank|routing/i
          .test(accessibleLabel + " " + (input?.name ?? "")) ||
          ["password", "email", "tel"].includes(type);
        if (isPrivate) {
          return [];
        }
        if (element instanceof HTMLTextAreaElement) {
          return [];
        }
        if (type === "file") {
          return [{ label: "file_upload", value: "" }];
        }
        if (role === "combobox") {
          const text = (element.textContent ?? "").trim().replace(/\s+/g, " ");
          const label = accessibleLabel.startsWith("Country") || text.startsWith("Country")
            ? "Country"
            : accessibleLabel.startsWith("Time Zone") || text.startsWith("Time Zone")
              ? "Time Zone"
              : accessibleLabel.startsWith("Language") || text.startsWith("Language")
                ? "language_combobox"
                : null;
          if (!label) {
            return [];
          }
          const value = element.getAttribute("aria-valuetext")?.trim() ??
            (label === "Country"
              ? text.replace(/^Country\s*/i, "")
              : label === "Time Zone"
                ? text.replace(/^Time Zone\s*/i, "")
                : text);
          return [{ label, value }];
        }
        if (type === "radio") {
          const label = labels[0] ?? "";
          const checked = input?.checked ?? false;
          return checked && label
            ? [{ label: "measurement_standard", value: label }]
            : [];
        }
        if (type === "password") {
          return [];
        }
        let value = element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement
          ? element.value
          : element instanceof HTMLSelectElement
            ? Array.from(element.selectedOptions).map((option) => option.label).join(", ")
            : "";
        if (
          type === "url" ||
          /^https?:\/\//i.test(value) ||
          /^www\./i.test(value)
        ) {
          const safeUrl = safeVisibleUrl(value.startsWith("www.")
            ? "https://" + value
            : value);
          if (!safeUrl) {
            return [];
          }
          value = safeUrl;
        }
        if (/^[\u2022\u25cf\u00b7\u00d7*]+$/.test(value)) {
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
          const safeUrl = safeVisibleUrl(link.href);
          return safeUrl ? [{ label: "public_link", value: safeUrl }] : [];
        });
      const textLines = (document.body?.innerText ?? "").split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const publicTextLinks = textLines.flatMap((line) => {
        if (
          !/^(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(line) ||
          line.includes("@")
        ) {
          return [];
        }
        const safeUrl = safeVisibleUrl(/^https?:\/\//i.test(line)
          ? line
          : "https://" + line);
        return safeUrl ? [{ label: "public_link", value: safeUrl }] : [];
      });
      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .filter(isVisible)
        .map((heading) => (heading.textContent ?? "").trim())
        .filter(Boolean);
      const hasSocialLogoControl = Array.from(document.querySelectorAll("button,[role='button']"))
        .filter(isVisible)
        .some((element) => (element.textContent ?? "").includes("Add a social logo"));
      return {
        pathname: window.location.pathname,
        hasSocialLogoControl,
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

function settingsCategoryLabel(categoryId: SettingsCategoryId): string {
  switch (categoryId) {
    case "website":
      return "Website";
    case "domains_email":
      return "Domains & Email";
    case "customer_notifications":
      return "Customer Notifications";
    case "selling":
      return "Selling";
    case "brand":
      return "Brand";
    case "marketing":
      return "Marketing";
    case "extensions":
      return "Extensions";
    case "third_party_tools":
      return "Third Party Tools";
    case "permissions_ownership":
      return "Permissions & Ownership";
    case "billing":
      return "Billing";
    case "developer_tools":
      return "Developer Tools";
  }
}

function settingsListField(
  fieldId: string,
  label: string,
  value: string[],
): SettingsFieldInspection {
  return {
    fieldId,
    label,
    value,
    valueType: "string_list",
    valueStatus: value.length === 0 ? "EMPTY" : "AVAILABLE",
    source: "squarespace_settings_ui",
    inspectionMethod: "existing_read_only_settings_inspector",
    confidence: 1,
    limitations: [],
    isSensitive: false,
  };
}

function settingsAccessDeniedField(label: string): SettingsFieldInspection {
  return {
    fieldId: "category_access",
    label: `${label} settings access`,
    value: null,
    valueType: "unknown",
    valueStatus: "ACCESS_DENIED",
    source: "squarespace_settings_ui",
    inspectionMethod: "visible_access_denial_message",
    confidence: 1,
    limitations: ["The category could not be inspected with the current access."],
    isSensitive: false,
  };
}

function settingsValueField(
  fieldId: string,
  label: string,
  value: string | null,
  valueType: "string" | "url",
  source: string,
  inspectionMethod: string,
): SettingsFieldInspection {
  return {
    fieldId,
    label,
    value,
    valueType,
    valueStatus: value === null ? "UNKNOWN" : "AVAILABLE",
    source,
    inspectionMethod,
    confidence: value === null ? 0 : 1,
    limitations: value === null ? ["No safe value was exposed by the existing inspector."] : [],
    isSensitive: false,
  };
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
