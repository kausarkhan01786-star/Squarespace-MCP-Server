import type {
  CapabilityOperation,
  CapabilityOperationBinding,
  CapabilityStatus,
  CmsCapabilityBinding,
} from "../capability-types.js";

const readPages: CapabilityOperationBinding = {
  status: "IMPLEMENTED_AND_TESTED",
  toolNames: [
    "list_websites",
    "list_pages",
    "get_page_details",
    "get_page_url",
    "get_navigation_structure",
    "list_not_linked_pages",
    "list_page_sections",
    "inspect_section",
    "inspect_page_sections",
    "inspect_mobile_responsive",
  ],
  mechanism: "browser_ui",
  permissions: ["authenticated Squarespace website access"],
  humanApproval: "never",
  verificationRequirements: ["verify selected website and returned page identity"],
  recoveryStrategy: "none",
  limitations: ["Reads depend on observed Squarespace UI controls and selectors."],
};

const unavailable: Record<CapabilityOperation, CapabilityOperationBinding> = {
  read: {
    status: "NOT_IMPLEMENTED",
    toolNames: [],
    mechanism: "unknown",
    permissions: [],
    humanApproval: "unavailable",
    verificationRequirements: [],
    recoveryStrategy: "none",
    limitations: ["No verified MCP operation is registered."],
  },
  create: {
    status: "NOT_IMPLEMENTED",
    toolNames: [],
    mechanism: "unknown",
    permissions: [],
    humanApproval: "unavailable",
    verificationRequirements: [],
    recoveryStrategy: "none",
    limitations: ["No verified MCP operation is registered."],
  },
  update: {
    status: "NOT_IMPLEMENTED",
    toolNames: [],
    mechanism: "unknown",
    permissions: [],
    humanApproval: "unavailable",
    verificationRequirements: [],
    recoveryStrategy: "none",
    limitations: ["No verified MCP operation is registered."],
  },
  delete: {
    status: "NOT_IMPLEMENTED",
    toolNames: [],
    mechanism: "unknown",
    permissions: [],
    humanApproval: "unavailable",
    verificationRequirements: [],
    recoveryStrategy: "none",
    limitations: ["No verified MCP operation is registered."],
  },
};

function operation(
  status: CapabilityStatus,
  toolNames: readonly string[],
  mechanism: CapabilityOperationBinding["mechanism"],
  permissions: readonly string[],
  humanApproval: CapabilityOperationBinding["humanApproval"],
  verificationRequirements: readonly string[],
  recoveryStrategy: CapabilityOperationBinding["recoveryStrategy"],
  limitations: readonly string[] = [],
): CapabilityOperationBinding {
  return {
    status,
    toolNames,
    mechanism,
    permissions,
    humanApproval,
    verificationRequirements,
    recoveryStrategy,
    limitations,
  };
}

function read(
  toolNames: readonly string[],
  mechanism: CapabilityOperationBinding["mechanism"] = "browser_ui",
  permissions: readonly string[] = ["authenticated Squarespace website access"],
  status: CapabilityStatus = "IMPLEMENTED_AND_TESTED",
  limitations: readonly string[] = [],
): CapabilityOperationBinding {
  return operation(
    status,
    toolNames,
    mechanism,
    permissions,
    "never",
    ["verify selected website and inspect returned data"],
    "none",
    limitations,
  );
}

function settingsCategoryRead(): CapabilityOperationBinding {
  return read(
    ["inspect_settings_category"],
    "browser_ui",
    ["authenticated Squarespace website access"],
    "IMPLEMENTED_BUT_UNVERIFIED",
    [
      "The inspector reads only visible, labeled, non-sensitive control values and metadata supported by the current inspector.",
      "Fixture behavior is tested; compatibility with live Squarespace settings UI remains unverified.",
      "Hidden, masked, private, billing-sensitive, and developer-code values are excluded or redacted.",
    ],
  );
}

function mutationNotImplemented(): CapabilityOperationBinding {
  return { ...unavailable.create };
}

function entry(
  capabilityId: string,
  status: CapabilityStatus,
  operations: Partial<Record<CapabilityOperation, CapabilityOperationBinding>>,
  evidence: CmsCapabilityBinding["evidence"],
): CmsCapabilityBinding {
  return { cms: "squarespace", capabilityId, status, operations, evidence };
}

const auditEvidence: CmsCapabilityBinding["evidence"] = [
  {
    kind: "audit",
    source: "repository capability audit",
    note: "Read-only source and test inspection; no live Squarespace session was accessed.",
  },
];

export const squarespaceCapabilityBindings: readonly CmsCapabilityBinding[] = [
  entry("website.pages", "PARTIALLY_IMPLEMENTED", {
    read: readPages,
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, [
    ...auditEvidence,
    { kind: "implementation", source: "src/tools/pages-tools.ts", note: "Registers page and section inspection tools." },
    { kind: "test", source: "src/browser/squarespace-pages.service.test.ts", note: "Exercises page service behavior with fixtures." },
  ]),
  entry("website.content", "PARTIALLY_IMPLEMENTED", {
    read: read(
      ["inspect_page_sections", "list_content_blocks", "inspect_content_block"],
      "browser_ui",
      ["authenticated Squarespace website access"],
      "IMPLEMENTED_AND_TESTED",
      ["Rendered text and block identifiers are partial views of stored content."],
    ),
    create: operation(
      "IMPLEMENTED_BUT_UNVERIFIED",
      ["add_text_section"],
      "browser_ui",
      ["content.section.create", "content.save"],
      "required",
      ["fresh page snapshot before Save", "verify resulting section and text after Save"],
      "manual_recovery",
      ["Only a fixed Home-page section/block shape is supported; Save may affect the live site."],
    ),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, [
    ...auditEvidence,
    { kind: "implementation", source: "src/browser/squarespace-content.service.ts", note: "Contains the narrowly scoped, approval-guarded text-section workflow." },
    { kind: "test", source: "src/tools/content-tools.test.ts", note: "Tests approval and tool behavior with mocks." },
  ]),
  entry("editor.sections", "PARTIALLY_IMPLEMENTED", {
    read: read(
      ["list_page_sections", "inspect_section", "inspect_section_settings"],
      "browser_ui",
    ),
    create: operation(
      "IMPLEMENTED_BUT_UNVERIFIED",
      ["add_text_section"],
      "browser_ui",
      ["content.section.create", "content.save"],
      "required",
      ["fresh page snapshot before Save", "verify resulting section after Save"],
      "manual_recovery",
      ["Only the fixed text-section workflow is available; general section editing is not."],
    ),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("design.custom_css", "NOT_IMPLEMENTED", {
    read: mutationNotImplemented(),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("developer.code_injection", "NOT_IMPLEMENTED", {
    read: mutationNotImplemented(),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("developer.custom_html", "NOT_IMPLEMENTED", {
    read: mutationNotImplemented(),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("developer.custom_javascript", "NOT_IMPLEMENTED", {
    read: mutationNotImplemented(),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("settings.website", "PARTIALLY_IMPLEMENTED", {
    read: read(
      [
        "inspect_settings_category",
        "inspect_website_settings",
        "inspect_site_information",
        "inspect_language_settings",
        "inspect_timezone_settings",
        "inspect_favicon",
        "inspect_social_links",
        "inspect_social_sharing_settings",
      ],
      "browser_ui",
      ["authenticated Squarespace website access"],
      "IMPLEMENTED_BUT_UNVERIFIED",
      ["Some values and uploaded asset details are not exposed by the observed UI."],
    ),
    update: mutationNotImplemented(),
  }, [
    ...auditEvidence,
    {
      kind: "test",
      source: "src/browser/squarespace-settings-inspection.test.ts",
      note: "Exercises settings category summaries using isolated UI fixtures.",
    },
  ]),
  entry("settings.domains", "PARTIALLY_IMPLEMENTED", {
    read: read(
      ["inspect_settings_category", "inspect_domain_settings"],
      "browser_ui",
      ["authenticated Squarespace website access"],
      "IMPLEMENTED_BUT_UNVERIFIED",
      ["Inspects the Domains & Email overview, not configured domain records."],
    ),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, [
    ...auditEvidence,
    {
      kind: "test",
      source: "src/browser/squarespace-settings-inspection.test.ts",
      note: "Exercises the Domains & Email overview using an isolated UI fixture.",
    },
  ]),
  entry("settings.customer_notifications", "PARTIALLY_IMPLEMENTED", {
    read: settingsCategoryRead(),
    update: mutationNotImplemented(),
  }, auditEvidence),
  entry("commerce.management", "PARTIALLY_IMPLEMENTED", {
    read: read(
      [
        "inspect_settings_category",
        "get_commerce_capabilities",
        "list_products",
        "get_product_details",
        "list_inventory",
        "list_orders",
        "list_discounts",
      ],
      "official_api",
      ["Squarespace Commerce Products read", "Inventory read", "Orders read", "Discounts read"],
      "IMPLEMENTED_AND_TESTED",
      ["Writes and some API semantics remain unavailable or unverified."],
    ),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, [
    ...auditEvidence,
    { kind: "implementation", source: "src/commerce/squarespace-commerce.provider.ts", note: "Commerce provider issues read-only API requests and reports write availability separately." },
    { kind: "test", source: "src/commerce/squarespace-commerce.provider.test.ts", note: "Tests provider parsing and requests with mocked fetch." },
  ]),
  entry("brand.management", "PARTIALLY_IMPLEMENTED", {
    read: read(
      [
        "inspect_settings_category",
        "inspect_typography",
        "inspect_color_themes",
        "inspect_button_styles",
        "inspect_favicon",
        "inspect_social_links",
        "inspect_social_sharing_settings",
      ],
      "browser_ui",
      ["authenticated Squarespace website access"],
      "IMPLEMENTED_BUT_UNVERIFIED",
      ["Rendered styles and visible controls are not a complete brand settings catalog."],
    ),
    update: mutationNotImplemented(),
  }, auditEvidence),
  entry("marketing.management", "PARTIALLY_IMPLEMENTED", {
    read: read(
      [
        "inspect_settings_category",
        "inspect_page_seo",
        "get_page_meta_title",
        "get_page_meta_description",
        "inspect_page_indexing_settings",
        "inspect_social_sharing_settings",
        "list_discounts",
      ],
      "hybrid",
      ["authenticated Squarespace website access", "Squarespace Commerce Discounts read"],
      "IMPLEMENTED_BUT_UNVERIFIED",
      ["Only selected SEO, sharing, and discount inspection is covered."],
    ),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("extensions.management", "PARTIALLY_IMPLEMENTED", {
    read: settingsCategoryRead(),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("integrations.third_party", "PARTIALLY_IMPLEMENTED", {
    read: settingsCategoryRead(),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("account.permissions", "PARTIALLY_IMPLEMENTED", {
    read: settingsCategoryRead(),
    update: mutationNotImplemented(),
  }, auditEvidence),
  entry("account.billing", "PARTIALLY_IMPLEMENTED", {
    read: settingsCategoryRead(),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("developer.tools", "PARTIALLY_IMPLEMENTED", {
    read: settingsCategoryRead(),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
  entry("seo.management", "PARTIALLY_IMPLEMENTED", {
    read: read(
      [
        "inspect_settings_category",
        "inspect_page_seo",
        "get_page_meta_title",
        "get_page_meta_description",
        "inspect_page_slug",
        "inspect_page_indexing_settings",
      ],
      "browser_ui",
    ),
    update: mutationNotImplemented(),
  }, auditEvidence),
  entry("navigation.management", "PARTIALLY_IMPLEMENTED", {
    read: read(
      [
        "inspect_settings_category",
        "get_navigation_structure",
        "list_main_navigation",
        "list_footer_navigation",
        "list_not_linked_pages",
        "inspect_navigation_item",
        "inspect_navigation_links",
      ],
      "browser_ui",
    ),
    create: mutationNotImplemented(),
    update: mutationNotImplemented(),
    delete: mutationNotImplemented(),
  }, auditEvidence),
];
