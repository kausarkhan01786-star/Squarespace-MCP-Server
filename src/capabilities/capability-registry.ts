import {
  type CapabilityDefinition,
} from "./capability-types.js";
import {
  CMS_IDS,
  type CapabilityOperation,
  type CapabilityOperationBinding,
  type CapabilityStatus,
  type CmsCapabilityBinding,
  type CmsId,
  type OperationEligibility,
  type OperationEligibilityContext,
  type RegisteredCapability,
} from "./capability-types.js";
import { squarespaceCapabilityBindings } from "./providers/squarespace.js";

const capabilityDefinitions: readonly CapabilityDefinition[] = deepFreeze([
  {
    id: "website.pages",
    category: "website_content",
    description: "Manage website page records, page settings, and page lifecycle.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "website.content",
    category: "website_content",
    description: "Manage page content and content blocks.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "editor.sections",
    category: "native_editor",
    description: "Manage native editor sections and their settings.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "design.custom_css",
    category: "design",
    description: "Manage site-level custom CSS.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "developer.code_injection",
    category: "developer",
    description: "Manage code injection in supported site locations.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "developer.custom_html",
    category: "developer",
    description: "Manage custom HTML content.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "developer.custom_javascript",
    category: "developer",
    description: "Manage custom JavaScript content.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "settings.website",
    category: "settings",
    description: "Inspect and manage website-level settings.",
    operations: ["read", "update"],
  },
  {
    id: "settings.domains",
    category: "domains_email",
    description: "Inspect and manage domain and email settings.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "settings.customer_notifications",
    category: "settings",
    description: "Inspect and manage customer notifications.",
    operations: ["read", "update"],
  },
  {
    id: "commerce.management",
    category: "commerce",
    description: "Inspect and manage commerce resources and settings.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "brand.management",
    category: "brand",
    description: "Inspect and manage brand assets and visual identity.",
    operations: ["read", "update"],
  },
  {
    id: "marketing.management",
    category: "marketing",
    description: "Inspect and manage marketing and campaign resources.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "extensions.management",
    category: "extensions",
    description: "Inspect and manage CMS extensions.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "integrations.third_party",
    category: "integrations",
    description: "Inspect and manage third-party integrations.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "account.permissions",
    category: "account",
    description: "Inspect and manage account roles and permissions.",
    operations: ["read", "update"],
  },
  {
    id: "account.billing",
    category: "account",
    description: "Inspect and manage subscriptions, invoices, and billing settings.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "developer.tools",
    category: "developer",
    description: "Inspect and manage developer settings, keys, and webhooks.",
    operations: ["read", "create", "update", "delete"],
  },
  {
    id: "seo.management",
    category: "seo",
    description: "Inspect and manage page and site search-engine settings.",
    operations: ["read", "update"],
  },
  {
    id: "navigation.management",
    category: "navigation",
    description: "Inspect and manage navigation structure and links.",
    operations: ["read", "create", "update", "delete"],
  },
]) satisfies readonly CapabilityDefinition[];

const unknownOperation: CapabilityOperationBinding = Object.freeze({
  status: "UNKNOWN_NEEDS_INVESTIGATION",
  toolNames: Object.freeze([]),
  mechanism: "unknown",
  permissions: Object.freeze([]),
  humanApproval: "unavailable",
  verificationRequirements: Object.freeze([]),
  recoveryStrategy: "none",
  limitations: Object.freeze(["This CMS capability has not been audited."]),
});

function unknownBinding(
  cms: CmsId,
  definition: CapabilityDefinition,
): CmsCapabilityBinding {
  const operations: Partial<Record<CapabilityOperation, CapabilityOperationBinding>> = {};
  for (const operation of definition.operations) {
    operations[operation] = unknownOperation;
  }
  return Object.freeze({
    cms,
    capabilityId: definition.id,
    status: "UNKNOWN_NEEDS_INVESTIGATION",
    operations: Object.freeze(operations),
    evidence: Object.freeze([]),
  });
}

export class CapabilityRegistry {
  private readonly definitions = new Map(
    capabilityDefinitions.map((definition) => [definition.id, definition]),
  );
  private readonly bindings = new Map<string, CmsCapabilityBinding>();

  constructor(bindings: readonly CmsCapabilityBinding[]) {
    for (const binding of bindings) {
      const key = this.key(binding.cms, binding.capabilityId);
      const definition = this.definitions.get(binding.capabilityId);
      if (!definition) {
        throw new TypeError(`Unknown capability definition: ${binding.capabilityId}`);
      }
      if (
        Object.keys(binding.operations).some((operation) =>
          !definition.operations.includes(operation as CapabilityOperation))
      ) {
        throw new TypeError(
          `CMS binding defines an unsupported operation: ${binding.cms}/${binding.capabilityId}`,
        );
      }
      if (this.bindings.has(key)) {
        throw new TypeError(`Duplicate CMS capability binding: ${binding.cms}/${binding.capabilityId}`);
      }
      this.bindings.set(key, deepFreeze(binding));
    }
  }

  getCapabilitiesForCms(cms: CmsId): readonly RegisteredCapability[] {
    return Object.freeze(capabilityDefinitions.map((definition) =>
      this.mergeBinding(cms, definition)));
  }

  getCapability(cms: CmsId, capabilityId: string): RegisteredCapability | undefined {
    const definition = this.definitions.get(capabilityId);
    return definition ? this.mergeBinding(cms, definition) : undefined;
  }

  hasExplicitBinding(cms: CmsId, capabilityId: string): boolean {
    return this.bindings.has(this.key(cms, capabilityId));
  }

  isOperationDefined(
    capabilityId: string,
    operation: CapabilityOperation,
  ): boolean {
    return this.definitions.get(capabilityId)?.operations.includes(operation) ?? false;
  }

  getOperationStatus(
    cms: CmsId,
    capabilityId: string,
    operation: CapabilityOperation,
  ): CapabilityStatus | undefined {
    return this.getCapability(cms, capabilityId)?.operations[operation]?.status;
  }

  isOperationEligible(
    cms: CmsId,
    capabilityId: string,
    operation: CapabilityOperation,
    context: OperationEligibilityContext = {},
  ): OperationEligibility {
    const capability = this.getCapability(cms, capabilityId);
    if (!capability) {
      return unavailable(`Unknown capability "${capabilityId}" for CMS "${cms}".`);
    }
    if (!capability.operations[operation]) {
      return unavailable(`Operation "${operation}" is not defined for capability "${capabilityId}".`);
    }
    const binding = capability.operations[operation]!;
    if (binding.status !== "IMPLEMENTED_AND_TESTED") {
      return unavailable(
        `Operation status is ${binding.status}; only IMPLEMENTED_AND_TESTED operations are executable.`,
      );
    }
    if (binding.toolNames.length === 0) {
      return unavailable("No executable tool is registered for this operation.");
    }
    if (binding.mechanism === "unknown") {
      return unavailable("The execution mechanism has not been verified.");
    }
    if (binding.humanApproval === "unavailable") {
      return unavailable("The required human approval mechanism is unavailable.");
    }
    if (
      binding.humanApproval === "required" &&
      context.humanApprovalGranted !== true
    ) {
      return unavailable("Explicit human approval is required before execution.");
    }
    if (
      binding.humanApproval === "policy_based" &&
      context.policyAuthorized !== true
    ) {
      return unavailable("A matching authorization policy is required before execution.");
    }
    const grantedPermissions = new Set(context.grantedPermissions ?? []);
    const missingPermissions = binding.permissions.filter(
      (permission) => !grantedPermissions.has(permission),
    );
    if (missingPermissions.length > 0) {
      return unavailable(`Missing required permission(s): ${missingPermissions.join(", ")}.`);
    }
    if (binding.verificationRequirements.length === 0) {
      return unavailable("No verification requirements are defined for this operation.");
    }
    if (context.verificationCompleted !== true) {
      return unavailable("Required pre-execution verification has not been completed.");
    }
    return { eligible: true, reason: null };
  }

  getOperationUnavailableReason(
    cms: CmsId,
    capabilityId: string,
    operation: CapabilityOperation,
    context: OperationEligibilityContext = {},
  ): string | null {
    return this.isOperationEligible(cms, capabilityId, operation, context).reason;
  }

  listUnsupportedAndUnknown(cms: CmsId): readonly RegisteredCapability[] {
    return Object.freeze(this.getCapabilitiesForCms(cms).filter((capability) =>
      capability.status === "UNSUPPORTED_OR_RESTRICTED" ||
      capability.status === "UNKNOWN_NEEDS_INVESTIGATION" ||
      Object.values(capability.operations).some((operation) =>
        operation?.status === "UNSUPPORTED_OR_RESTRICTED" ||
        operation?.status === "UNKNOWN_NEEDS_INVESTIGATION")));
  }

  private mergeBinding(
    cms: CmsId,
    definition: CapabilityDefinition,
  ): RegisteredCapability {
    const binding = this.bindings.get(this.key(cms, definition.id)) ??
      unknownBinding(cms, definition);
    return Object.freeze({
      cms,
      id: definition.id,
      category: definition.category,
      description: definition.description,
      status: binding.status,
      operations: binding.operations,
      evidence: binding.evidence,
    });
  }

  private key(cms: CmsId, capabilityId: string): string {
    return `${cms}:${capabilityId}`;
  }
}

function unavailable(reason: string): OperationEligibility {
  return { eligible: false, reason };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const allUnknownBindings: CmsCapabilityBinding[] = CMS_IDS
  .filter((cms) => cms !== "squarespace")
  .flatMap((cms) => capabilityDefinitions.map((definition) =>
    unknownBinding(cms, definition)));

export const capabilityRegistry = new CapabilityRegistry([
  ...squarespaceCapabilityBindings,
  ...allUnknownBindings,
]);

export const getCapabilitiesForCms = (cms: CmsId) =>
  capabilityRegistry.getCapabilitiesForCms(cms);

export const getCapability = (cms: CmsId, capabilityId: string) =>
  capabilityRegistry.getCapability(cms, capabilityId);

export const getOperationStatus = (
  cms: CmsId,
  capabilityId: string,
  operation: CapabilityOperation,
) => capabilityRegistry.getOperationStatus(cms, capabilityId, operation);

export const isOperationEligible = (
  cms: CmsId,
  capabilityId: string,
  operation: CapabilityOperation,
  context?: OperationEligibilityContext,
) => capabilityRegistry.isOperationEligible(cms, capabilityId, operation, context);

export const getOperationUnavailableReason = (
  cms: CmsId,
  capabilityId: string,
  operation: CapabilityOperation,
  context?: OperationEligibilityContext,
) => capabilityRegistry.getOperationUnavailableReason(cms, capabilityId, operation, context);

export const listUnsupportedAndUnknown = (cms: CmsId) =>
  capabilityRegistry.listUnsupportedAndUnknown(cms);
