import assert from "node:assert/strict";
import test from "node:test";
import {
  CapabilityRegistry,
  capabilityRegistry,
  getCapabilitiesForCms,
  getCapability,
  getOperationStatus,
  getOperationUnavailableReason,
  isOperationEligible,
  listUnsupportedAndUnknown,
} from "./capability-registry.js";
import { CMS_IDS } from "./capability-types.js";
import { squarespaceCapabilityBindings } from "./providers/squarespace.js";

test("registry recognizes every supported CMS identifier and returns the universal catalog", () => {
  assert.deepEqual(CMS_IDS, ["squarespace", "wordpress", "wix"]);
  for (const cms of CMS_IDS) {
    assert.equal(getCapabilitiesForCms(cms).length, 20);
  }
});

test("looks up a Squarespace capability and preserves evidence separately from status", () => {
  const capability = getCapability("squarespace", "website.pages");
  assert.equal(capability?.status, "PARTIALLY_IMPLEMENTED");
  assert.equal(capability?.operations.read?.status, "IMPLEMENTED_AND_TESTED");
  assert.ok(capability?.evidence.some((item) => item.kind === "test"));
  assert.equal(getCapability("squarespace", "not.a.capability"), undefined);
});

test("returns operation-specific status without promoting method-only mutations", () => {
  assert.equal(
    getOperationStatus("squarespace", "website.pages", "read"),
    "IMPLEMENTED_AND_TESTED",
  );
  assert.equal(
    getOperationStatus("squarespace", "website.pages", "create"),
    "NOT_IMPLEMENTED",
  );
  assert.equal(
    getOperationStatus("squarespace", "website.content", "create"),
    "IMPLEMENTED_BUT_UNVERIFIED",
  );
});

test("unknown capability and undefined operation fail with clear unavailable reasons", () => {
  assert.equal(getOperationStatus("squarespace", "missing.capability", "read"), undefined);
  assert.match(
    getOperationUnavailableReason("squarespace", "missing.capability", "read") ?? "",
    /Unknown capability/,
  );
  assert.match(
    getOperationUnavailableReason("squarespace", "settings.website", "delete") ?? "",
    /not defined/,
  );
});

test("unimplemented, unverified, and unknown operations are never executable", () => {
  for (const [capabilityId, operation] of [
    ["website.pages", "create"],
    ["website.content", "create"],
    ["design.custom_css", "update"],
    ["account.billing", "read"],
  ] as const) {
    assert.equal(
      isOperationEligible("squarespace", capabilityId, operation).eligible,
      false,
    );
  }
  assert.equal(isOperationEligible("wordpress", "website.pages", "read").eligible, false);
  assert.equal(isOperationEligible("wix", "website.pages", "read").eligible, false);
});

test("WordPress and Wix remain unknown until their capabilities are audited", () => {
  for (const cms of ["wordpress", "wix"] as const) {
    for (const capability of getCapabilitiesForCms(cms)) {
      assert.equal(capability.status, "UNKNOWN_NEEDS_INVESTIGATION");
      for (const operation of Object.values(capability.operations)) {
        assert.equal(operation?.status, "UNKNOWN_NEEDS_INVESTIGATION");
        assert.deepEqual(operation?.toolNames, []);
      }
    }
    assert.equal(listUnsupportedAndUnknown(cms).length, 20);
  }
});

test("unsupported capabilities are listed and cannot be executed", () => {
  const designBinding = squarespaceCapabilityBindings.find(
    (binding) => binding.capabilityId === "design.custom_css",
  );
  assert.ok(designBinding);
  const registry = new CapabilityRegistry([
    ...squarespaceCapabilityBindings.filter(
      (binding) => binding.capabilityId !== "design.custom_css",
    ),
    {
      ...designBinding,
      status: "UNSUPPORTED_OR_RESTRICTED",
      operations: {
        ...designBinding.operations,
        update: {
          ...designBinding.operations.update!,
          status: "UNSUPPORTED_OR_RESTRICTED",
        },
      },
    },
  ]);
  assert.equal(
    registry.isOperationEligible("squarespace", "design.custom_css", "update").eligible,
    false,
  );
  assert.ok(
    registry.listUnsupportedAndUnknown("squarespace")
      .some((capability) => capability.id === "design.custom_css"),
  );
});

test("Squarespace aggregate statuses match the Phase 1 audit", () => {
  const expected: Record<string, string> = {
    "website.pages": "PARTIALLY_IMPLEMENTED",
    "website.content": "PARTIALLY_IMPLEMENTED",
    "editor.sections": "PARTIALLY_IMPLEMENTED",
    "design.custom_css": "NOT_IMPLEMENTED",
    "developer.code_injection": "NOT_IMPLEMENTED",
    "developer.custom_html": "NOT_IMPLEMENTED",
    "developer.custom_javascript": "NOT_IMPLEMENTED",
    "settings.website": "PARTIALLY_IMPLEMENTED",
    "settings.domains": "PARTIALLY_IMPLEMENTED",
    "settings.customer_notifications": "NOT_IMPLEMENTED",
    "commerce.management": "PARTIALLY_IMPLEMENTED",
    "brand.management": "PARTIALLY_IMPLEMENTED",
    "marketing.management": "PARTIALLY_IMPLEMENTED",
    "extensions.management": "NOT_IMPLEMENTED",
    "integrations.third_party": "NOT_IMPLEMENTED",
    "account.permissions": "NOT_IMPLEMENTED",
    "account.billing": "NOT_IMPLEMENTED",
    "developer.tools": "NOT_IMPLEMENTED",
    "seo.management": "PARTIALLY_IMPLEMENTED",
    "navigation.management": "PARTIALLY_IMPLEMENTED",
  };
  for (const [capabilityId, status] of Object.entries(expected)) {
    assert.equal(getCapability("squarespace", capabilityId)?.status, status, capabilityId);
  }
});

test("eligibility requires verified implementation, permissions, approval, and verification", () => {
  const contentBinding = squarespaceCapabilityBindings.find(
    (binding) => binding.capabilityId === "website.content",
  );
  assert.ok(contentBinding);
  const testedCreate = {
    ...contentBinding.operations.create!,
    status: "IMPLEMENTED_AND_TESTED" as const,
  };
  const registry = new CapabilityRegistry([
    ...squarespaceCapabilityBindings.filter(
      (binding) => binding.capabilityId !== "website.content",
    ),
    {
      ...contentBinding,
      operations: { ...contentBinding.operations, create: testedCreate },
    },
  ]);
  const permissionContext = {
    grantedPermissions: ["content.section.create", "content.save"],
  };
  const verifiedContext = {
    ...permissionContext,
    humanApprovalGranted: true,
    verificationCompleted: true,
  };

  assert.match(
    registry.getOperationUnavailableReason(
      "squarespace",
      "website.content",
      "create",
      { ...permissionContext, verificationCompleted: true },
    ) ?? "",
    /Explicit human approval is required/,
  );
  assert.match(
    registry.getOperationUnavailableReason(
      "squarespace",
      "website.content",
      "create",
      { ...permissionContext, humanApprovalGranted: true },
    ) ?? "",
    /verification has not been completed/,
  );
  assert.match(
    registry.getOperationUnavailableReason(
      "squarespace",
      "website.content",
      "create",
      { humanApprovalGranted: true, verificationCompleted: true },
    ) ?? "",
    /Missing required permission/,
  );
  assert.equal(
    registry.isOperationEligible(
      "squarespace",
      "website.content",
      "create",
      verifiedContext,
    ).eligible,
    true,
  );

  const readContext = {
    grantedPermissions: ["authenticated Squarespace website access"],
    verificationCompleted: true,
  };
  assert.equal(
    registry.isOperationEligible("squarespace", "website.pages", "read", readContext).eligible,
    true,
  );
});
