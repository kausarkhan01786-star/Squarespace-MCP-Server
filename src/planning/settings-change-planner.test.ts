import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CapabilityRegistry,
  capabilityRegistry,
} from "../capabilities/capability-registry.js";
import { squarespaceCapabilityBindings } from "../capabilities/providers/squarespace.js";
import { parseSettingsChangeInstruction } from "./settings-change-parser.js";
import { SettingsChangePlanner } from "./settings-change-planner.js";
import { SquarespaceSettingsPlanningProvider } from "./providers/squarespace-settings-planning-provider.js";
import type { SettingsCategoryInspection } from "../browser/squarespace-navigation-seo-settings.service.js";
import type {
  ParsedSettingsChangeIntent,
  SettingsPlanningField,
  SettingsPlanningProvider,
} from "./settings-change-types.js";

const grantedPermission = "settings.website.write";

function field(
  overrides: Partial<SettingsPlanningField> = {},
): SettingsPlanningField {
  return {
    fieldId: "timezone",
    fieldLabel: "Time Zone",
    currentValue: "America/New_York",
    valueType: "string",
    valueStatus: "AVAILABLE",
    source: "fixture_settings_ui",
    inspectionConfidence: 0.98,
    isSensitive: false,
    limitations: [],
    ...overrides,
  };
}

function provider(
  options: {
    sites?: readonly { id: string; name: string }[];
    fields?: readonly SettingsPlanningField[];
    grantedPermissions?: readonly string[] | null;
    inspectionStatus?:
      | "AVAILABLE"
      | "PARTIALLY_AVAILABLE"
      | "NOT_AVAILABLE"
      | "ACCESS_DENIED"
      | "UNKNOWN"
      | "ERROR";
    capabilityForCategory?: (categoryId: string) => string | undefined;
    inspectKnownField?: SettingsPlanningProvider["inspectKnownField"];
  } = {},
): SettingsPlanningProvider & { inspectionCalls: string[] } {
  const inspectionCalls: string[] = [];
  return {
    cms: "squarespace",
    inspectionCalls,
    async listSites() {
      return options.sites ?? [{ id: "site-1", name: "Fixture site" }];
    },
    async inspectCategory(siteId, categoryId) {
      inspectionCalls.push(`${siteId}:${categoryId}`);
      return {
        status: options.inspectionStatus ?? "PARTIALLY_AVAILABLE",
        fields: options.fields ?? [field()],
        source: "fixture_settings_ui",
        limitations: [],
        errors: [],
      };
    },
    capabilityIdForCategory(categoryId) {
      return options.capabilityForCategory?.(categoryId) ??
        (categoryId === "website" ? "settings.website" : undefined);
    },
    async getGrantedPermissions() {
      return options.grantedPermissions === undefined
        ? [grantedPermission]
        : options.grantedPermissions;
    },
    ...(options.inspectKnownField
      ? { inspectKnownField: options.inspectKnownField }
      : {}),
  };
}

function registryWithTestedWebsiteUpdate(
  options: {
    mechanism?: "browser_ui" | "unknown";
    status?: "IMPLEMENTED_AND_TESTED" | "UNSUPPORTED_OR_RESTRICTED";
    permissions?: readonly string[];
    verification?: readonly string[];
    approval?: "never" | "required" | "policy_based" | "unavailable";
  } = {},
): CapabilityRegistry {
  const website = squarespaceCapabilityBindings.find((binding) =>
    binding.capabilityId === "settings.website");
  assert.ok(website);
  const bindings = squarespaceCapabilityBindings.filter((binding) =>
    binding.capabilityId !== "settings.website");
  return new CapabilityRegistry([
    ...bindings,
    {
      ...website,
      operations: {
        ...website.operations,
        update: {
          status: options.status ?? "IMPLEMENTED_AND_TESTED",
          toolNames: options.mechanism === "unknown"
            ? ["registered-but-unknown"]
            : ["update_website_setting"],
          mechanism: options.mechanism ?? "browser_ui",
          permissions: options.permissions ?? [grantedPermission],
          humanApproval: options.approval ?? "required",
          verificationRequirements: options.verification ?? ["read back exact field value"],
          recoveryStrategy: "snapshot_restore",
          limitations: [],
        },
      },
    },
  ]);
}

function plannerFor(
  settingsProvider: SettingsPlanningProvider,
  registry: CapabilityRegistry = capabilityRegistry,
): SettingsChangePlanner {
  return new SettingsChangePlanner(
    new Map([["squarespace", settingsProvider]]),
    registry,
  );
}

test("parses a supported timezone request without canonicalizing the requested value", () => {
  const intents = parseSettingsChangeInstruction("Change my website timezone to Dhaka.");
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.categoryId, "website");
  assert.equal(intents[0]?.fieldLabel, "Time Zone");
  assert.equal(intents[0]?.fieldId, null);
  assert.equal(intents[0]?.proposedValue, "Dhaka");
  assert.equal(intents[0]?.valueType, "string");
  assert.equal(intents[0]?.operation, "update");
});

test("asks for clarification when a target setting is not evidenced", () => {
  const intents = parseSettingsChangeInstruction("Enable the announcement bar.");
  assert.equal(intents[0]?.categoryId, null);
  assert.equal(intents[0]?.fieldLabel, "announcement bar");
  assert.equal(intents[0]?.status, "NEEDS_CLARIFICATION");
  assert.equal(intents[0]?.proposedValue, true);

  const ambiguous = parseSettingsChangeInstruction("Make it better.");
  assert.equal(ambiguous[0]?.status, "NEEDS_CLARIFICATION");
  assert.equal(ambiguous[0]?.proposedValue, null);
});

test("parses multiple independent intents without guessing unknown categories", () => {
  const intents = parseSettingsChangeInstruction(
    "Change my website timezone to Dhaka and enable announcement bar.",
  );
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.categoryId, "website");
  assert.equal(intents[1]?.categoryId, null);
  assert.equal(intents[1]?.status, "NEEDS_CLARIFICATION");
});

test("plans an evidence-backed request and leaves it blocked by real Squarespace write status", async () => {
  const settingsProvider = provider();
  const planner = plannerFor(settingsProvider);
  const plan = await planner.analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  const change = plan.changes[0]!;

  assert.equal(plan.originalInstruction, "Change my website timezone to Dhaka.");
  assert.equal(plan.cmsProvider, "squarespace");
  assert.equal(plan.siteId, "site-1");
  assert.equal(plan.status, "BLOCKED");
  assert.equal(change.categoryId, "website");
  assert.equal(change.fieldId, "timezone");
  assert.equal(change.currentValue, "America/New_York");
  assert.equal(change.proposedValue, "Dhaka");
  assert.deepEqual(change.comparison, {
    fieldLabel: "Time Zone",
    currentValue: "America/New_York",
    proposedValue: "Dhaka",
    changeRequired: true,
    status: "COMPARABLE",
  });
  assert.equal(change.capabilityStatus, "PARTIALLY_IMPLEMENTED");
  assert.equal(change.capabilityCheck.operationStatus, "NOT_IMPLEMENTED");
  assert.equal(change.capabilityCheck.eligibleForExecution, false);
  assert.equal(plan.executionEnabled, false);
  assert.ok(settingsProvider.inspectionCalls.includes("site-1:website"));
  assert.equal(planner.getSettingsChangePlan(plan.planId), plan);
});

test("Squarespace planner adapter reuses the existing read-only timezone inspector", async () => {
  let categoryReads = 0;
  let timezoneReads = 0;
  const inspection: SettingsCategoryInspection = {
    cms: "squarespace",
    categoryId: "website",
    status: "PARTIALLY_AVAILABLE",
    fields: [],
    availableValues: [],
    restrictedFieldCount: 0,
    unsupportedFieldCount: 0,
    source: "squarespace_settings_ui",
    mechanism: "browser_ui",
    inspectionMethod: "visible_dom_controls_and_existing_inspectors",
    inspectedAt: "2026-01-01T00:00:00.000Z",
    limitations: [],
    unsupportedFields: [],
    errors: [],
  };
  const settingsProvider = new SquarespaceSettingsPlanningProvider(
    {
      async listWebsites() {
        return [{
          id: "site-1",
          name: "Fixture site",
          url: "https://fixture.squarespace.com/config",
        }];
      },
    },
    {
      async inspectSettingsCategory() {
        categoryReads += 1;
        return inspection;
      },
      async inspectTimezoneSettings() {
        timezoneReads += 1;
        return {
          websiteId: "site-1",
          source: "squarespace_regional_settings",
          timezone: "America/New_York",
          available: true,
        };
      },
    },
  );
  const plan = await plannerFor(settingsProvider).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal(categoryReads, 1);
  assert.equal(timezoneReads, 1);
  assert.equal(plan.currentSettingsEvidence[0]?.fieldId, "timezone");
  assert.equal(plan.currentSettingsEvidence[0]?.currentValue, "America/New_York");
  assert.equal(
    plan.currentSettingsEvidence[0]?.source,
    "squarespace_regional_settings",
  );
});

test("allows a fully evidenced change to become ready for approval, never execution", async () => {
  const planner = plannerFor(
    provider(),
    registryWithTestedWebsiteUpdate(),
  );
  const plan = await planner.analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });

  assert.equal(plan.status, "READY_FOR_APPROVAL");
  assert.equal(plan.changes[0]?.status, "READY_FOR_APPROVAL");
  assert.equal(plan.changes[0]?.approvalRequired, true);
  assert.equal(plan.changes[0]?.capabilityCheck.permissionStatus, "KNOWN");
  assert.equal(plan.changes[0]?.capabilityCheck.eligibleForExecution, false);
  assert.equal(plan.executionEnabled, false);
});

test("reports no change when the verified current value already matches", async () => {
  const settingsProvider = provider({
    fields: [field({ currentValue: "Dhaka" })],
  });
  const plan = await plannerFor(
    settingsProvider,
    registryWithTestedWebsiteUpdate(),
  ).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  const change = plan.changes[0]!;
  assert.equal(plan.status, "NO_CHANGE_REQUIRED");
  assert.equal(change.status, "NO_CHANGE_REQUIRED");
  assert.equal(change.comparison.changeRequired, false);
  assert.deepEqual(change.blockedReasons, []);
});

test("does not compare unknown, masked, redacted, or inaccessible current values", async () => {
  for (const valueStatus of ["UNKNOWN", "MASKED", "REDACTED", "ACCESS_DENIED"] as const) {
    const currentField = field({
      currentValue: "must-not-escape",
      valueStatus,
      isSensitive: valueStatus === "MASKED" || valueStatus === "REDACTED",
      inspectionConfidence: 0,
    });
    const plan = await plannerFor(provider({ fields: [currentField] }))
      .analyzeSettingsChangeRequest({
        instruction: "Change my website timezone to Dhaka.",
        cmsProvider: "squarespace",
        siteId: "site-1",
      });
    const change = plan.changes[0]!;
    assert.equal(change.currentValue, null, valueStatus);
    assert.equal(change.comparison.changeRequired, null, valueStatus);
    assert.equal(change.comparison.status, "UNAVAILABLE", valueStatus);
    assert.doesNotMatch(JSON.stringify(plan), /must-not-escape/, valueStatus);
  }
});

test("blocks invalid value types without coercion", async () => {
  const settingsProvider = provider({
    fields: [field({ valueType: "string", currentValue: "America/New_York" })],
  });
  const plan = await plannerFor(settingsProvider).previewSettingsChanges({
    originalInstruction: "Set Time Zone to true.",
    cmsProvider: "squarespace",
    siteId: "site-1",
    changes: [{
      categoryId: "website",
      fieldLabel: "Time Zone",
      proposedValue: true,
      valueType: "boolean",
    }],
  });
  assert.equal(plan.changes[0]?.status, "BLOCKED");
  assert.equal(plan.changes[0]?.comparison.status, "UNAVAILABLE");
  assert.equal(plan.changes[0]?.proposedValue, true);
});

test("does not infer a site when multiple sites are available", async () => {
  const settingsProvider = provider({
    sites: [
      { id: "site-1", name: "One" },
      { id: "site-2", name: "Two" },
    ],
  });
  const plan = await plannerFor(settingsProvider).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
  });
  assert.equal(plan.status, "NEEDS_CLARIFICATION");
  assert.equal(plan.siteId, null);
  assert.match(plan.clarificationQuestions.join(" "), /Multiple sites/);
  assert.deepEqual(settingsProvider.inspectionCalls, []);
});

test("resolves a missing site ID only when exactly one connected site exists", async () => {
  const settingsProvider = provider();
  const plan = await plannerFor(settingsProvider).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
  });
  assert.equal(plan.siteId, "site-1");
  assert.equal(settingsProvider.inspectionCalls.length, 1);
});

test("keeps WordPress and Wix unknown when no provider implementation exists", async () => {
  for (const cmsProvider of ["wordpress", "wix"] as const) {
    const plan = await plannerFor(provider()).analyzeSettingsChangeRequest({
      instruction: "Change my website timezone to Dhaka.",
      cmsProvider,
      siteId: "site-1",
    });
    assert.equal(plan.cmsProvider, cmsProvider);
    assert.equal(plan.changes[0]?.status, "NEEDS_INVESTIGATION");
    assert.equal(plan.changes[0]?.capabilityStatus, "UNKNOWN_NEEDS_INVESTIGATION");
    assert.equal(plan.changes[0]?.capabilityCheck.eligibleForExecution, false);
  }
});

test("keeps unknown capabilities in investigation state", async () => {
  const settingsProvider = provider({
    capabilityForCategory: () => "settings.not_audited",
  });
  const plan = await plannerFor(settingsProvider).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal(plan.changes[0]?.status, "NEEDS_INVESTIGATION");
  assert.equal(plan.changes[0]?.capabilityStatus, "UNKNOWN_NEEDS_INVESTIGATION");
});

test("reports missing required permissions and blocks readiness", async () => {
  const settingsProvider = provider({ grantedPermissions: [] });
  const plan = await plannerFor(
    settingsProvider,
    registryWithTestedWebsiteUpdate(),
  ).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal(plan.changes[0]?.status, "BLOCKED");
  assert.equal(plan.changes[0]?.capabilityCheck.permissionStatus, "MISSING");
  assert.deepEqual(plan.changes[0]?.capabilityCheck.missingPermissions, [grantedPermission]);
});

test("requires a compatible approval policy and verification requirements", async () => {
  for (const options of [
    { approval: "unavailable" as const },
    { approval: "never" as const },
    { verification: [] },
  ]) {
    const plan = await plannerFor(
      provider(),
      registryWithTestedWebsiteUpdate(options),
    ).analyzeSettingsChangeRequest({
      instruction: "Change my website timezone to Dhaka.",
      cmsProvider: "squarespace",
      siteId: "site-1",
    });
    assert.equal(plan.changes[0]?.status, "BLOCKED");
    assert.equal(plan.changes[0]?.capabilityCheck.eligibleForExecution, false);
    if ("verification" in options) {
      assert.ok(plan.changes[0]?.blockedReasons.some((reason) =>
        /verification requirements/i.test(reason)));
    } else {
      assert.ok(plan.changes[0]?.blockedReasons.some((reason) =>
        /approval policy|human approval/i.test(reason)));
    }
  }
});

test("does not use a targeted inspector to bypass category access denial", async () => {
  let targetedReads = 0;
  const settingsProvider = provider({
    inspectionStatus: "ACCESS_DENIED",
    inspectKnownField: async () => {
      targetedReads += 1;
      return field();
    },
  });
  const plan = await plannerFor(settingsProvider).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal(targetedReads, 0);
  assert.equal(plan.changes[0]?.status, "BLOCKED");
  assert.equal(plan.changes[0]?.evidence.currentValueStatus, "ACCESS_DENIED");
  assert.equal(plan.changes[0]?.currentValue, null);
});

test("blocks a registered operation with an unknown execution mechanism", async () => {
  const plan = await plannerFor(
    provider(),
    registryWithTestedWebsiteUpdate({ mechanism: "unknown" }),
  ).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal(plan.changes[0]?.status, "BLOCKED");
  assert.ok(plan.changes[0]?.blockedReasons.some((reason) =>
    /execution mechanism/i.test(reason)));
});

test("never treats an explicitly unsupported update operation as executable", async () => {
  const plan = await plannerFor(
    provider(),
    registryWithTestedWebsiteUpdate({ status: "UNSUPPORTED_OR_RESTRICTED" }),
  ).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal(plan.changes[0]?.status, "UNSUPPORTED");
  assert.equal(plan.changes[0]?.capabilityCheck.eligibleForExecution, false);
});

test("classifies website-wide, commerce, and sensitive changes conservatively", async () => {
  const high = await plannerFor(provider()).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal(high.changes[0]?.riskLevel, "HIGH");

  const sensitiveProvider = provider({
    fields: [field({
      fieldId: "api-key",
      fieldLabel: "API key",
      currentValue: null,
      valueStatus: "REDACTED",
      isSensitive: true,
      inspectionConfidence: 1,
    })],
    capabilityForCategory: () => "developer.tools",
  });
  const sensitiveIntent: ParsedSettingsChangeIntent = {
    categoryId: "website",
    fieldId: null,
    fieldLabel: "API key",
    proposedValue: "new-value",
    valueType: "string",
    operation: "update",
    confidence: 1,
    status: "RESOLVED",
    warnings: [],
  };
  const sensitivePlan = await plannerFor(sensitiveProvider).previewSettingsChanges({
    originalInstruction: "Change API key.",
    cmsProvider: "squarespace",
    siteId: "site-1",
    changes: [{
      categoryId: sensitiveIntent.categoryId!,
      fieldLabel: sensitiveIntent.fieldLabel,
      proposedValue: sensitiveIntent.proposedValue,
      valueType: sensitiveIntent.valueType,
    }],
  });
  assert.equal(sensitivePlan.changes[0]?.riskLevel, "CRITICAL");
  assert.equal(sensitivePlan.changes[0]?.status, "BLOCKED");
  assert.equal(sensitivePlan.changes[0]?.currentValue, null);
});

test("returns partial plans when one request includes an unresolved setting", async () => {
  const plan = await plannerFor(provider()).analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka and enable announcement bar.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal(plan.status, "PARTIAL");
  assert.equal(plan.changes.length, 2);
  assert.equal(plan.changes[0]?.status, "BLOCKED");
  assert.equal(plan.changes[1]?.status, "NEEDS_INVESTIGATION");
  assert.equal(plan.changes[1]?.currentValue, null);
});

test("planner has no mutation dependency and only invokes read-only provider methods", async () => {
  const settingsProvider = provider();
  const planner = plannerFor(settingsProvider);
  await planner.analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal("execute" in planner, false);
  assert.equal("mutationHandler" in planner, false);
  assert.equal(settingsProvider.inspectionCalls.length, 1);
});
