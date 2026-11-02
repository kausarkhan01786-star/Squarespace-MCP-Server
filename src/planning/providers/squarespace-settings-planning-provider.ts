import type { SquarespaceNavigationSeoSettingsService } from "../../browser/squarespace-navigation-seo-settings.service.js";
import { SETTINGS_CATEGORY_IDS } from "../../browser/squarespace-navigation-seo-settings.service.js";
import type { SquarespaceBrowserService } from "../../browser/squarespace-browser.service.js";
import type {
  PlannedValue,
  SettingsPlanningField,
  SettingsPlanningInspection,
  SettingsPlanningProvider,
} from "../settings-change-types.js";

type SettingsInspectionService = Pick<
  SquarespaceNavigationSeoSettingsService,
  "inspectSettingsCategory" | "inspectTimezoneSettings"
>;
type SiteInventory = Pick<SquarespaceBrowserService, "listWebsites">;

const CATEGORY_CAPABILITIES: Readonly<Record<string, string>> = {
  website: "settings.website",
  domains_email: "settings.domains",
  customer_notifications: "settings.customer_notifications",
  selling: "commerce.management",
  brand: "brand.management",
  marketing: "marketing.management",
  extensions: "extensions.management",
  third_party_tools: "integrations.third_party",
  permissions_ownership: "account.permissions",
  billing: "account.billing",
  developer_tools: "developer.tools",
};

export class SquarespaceSettingsPlanningProvider implements SettingsPlanningProvider {
  readonly cms = "squarespace" as const;

  constructor(
    private readonly sites: SiteInventory,
    private readonly settings: SettingsInspectionService,
  ) {}

  async listSites() {
    return (await this.sites.listWebsites()).map((site) => ({
      id: site.id,
      name: site.name,
    }));
  }

  async inspectCategory(
    siteId: string,
    categoryId: string,
  ): Promise<SettingsPlanningInspection> {
    const category = SETTINGS_CATEGORY_IDS.find((candidate) =>
      candidate === categoryId);
    if (!category) {
      return {
        status: "UNKNOWN",
        fields: [],
        source: "squarespace_settings_ui",
        limitations: ["The requested category is not defined by the Squarespace provider."],
        errors: [],
      };
    }
    const result = await this.settings.inspectSettingsCategory(siteId, category);
    return {
      status: result.status,
      fields: result.fields.map((field) => ({
        fieldId: field.fieldId,
        fieldLabel: field.label,
        currentValue: toPlannedValue(field.value),
        valueType: field.valueType,
        valueStatus: field.valueStatus,
        source: field.source,
        inspectionConfidence: field.confidence,
        isSensitive: field.isSensitive,
        limitations: field.limitations,
      })),
      source: result.source,
      limitations: result.limitations,
      errors: result.errors.map((error) => error.code),
    };
  }

  capabilityIdForCategory(categoryId: string): string | undefined {
    return CATEGORY_CAPABILITIES[categoryId];
  }

  async inspectKnownField(
    siteId: string,
    categoryId: string,
    fieldLabel: string,
  ): Promise<SettingsPlanningField | null> {
    if (
      categoryId !== "website" ||
      !/^(?:time\s*zone|timezone)$/i.test(fieldLabel.trim())
    ) {
      return null;
    }

    const result: unknown = await this.settings.inspectTimezoneSettings(siteId);
    if (!isRecord(result) || !("timezone" in result)) return null;
    const value = typeof result.timezone === "string" ? result.timezone : null;
    const available = result.available === true && value !== null;
    return {
      fieldId: "timezone",
      fieldLabel: "Time Zone",
      currentValue: value,
      valueType: "string",
      valueStatus: available ? "AVAILABLE" : "UNKNOWN",
      source: typeof result.source === "string"
        ? result.source
        : "squarespace_site_timezone_settings",
      inspectionConfidence: available ? 0.95 : 0,
      isSensitive: false,
      limitations: available
        ? []
        : ["The existing timezone inspector did not expose a selected timezone value."],
    };
  }
}

function toPlannedValue(value: unknown): PlannedValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toPlannedValue);
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, item]) =>
      [key, toPlannedValue(item)] as const);
    return Object.fromEntries(entries);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
