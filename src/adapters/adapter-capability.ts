import { z } from "zod";
import { CMS_IDS, CAPABILITY_OPERATIONS } from "../capabilities/capability-types.js";

const permissionRequirementSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("required"),
    permissions: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  z.object({ kind: z.literal("permissionless") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);

export const capabilityEvidenceSourceTypes = [
  "live_provider_test",
  "synthetic_test",
  "official_documentation",
] as const;
export type CapabilityEvidenceSourceType = typeof capabilityEvidenceSourceTypes[number];

export const capabilityEvidenceClaims = [
  "independently_tested",
  "synthetic_only",
  "documented_capability",
] as const;
export type CapabilityEvidenceClaim = typeof capabilityEvidenceClaims[number];

export interface CapabilityVerificationEvidence {
  readonly evidenceId: string;
  readonly sourceType: CapabilityEvidenceSourceType;
  readonly claim: CapabilityEvidenceClaim;
  readonly cms: typeof CMS_IDS[number];
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly operationId: typeof CAPABILITY_OPERATIONS[number];
  readonly contractVersion: string;
  readonly reference: string;
  readonly publisherAuthority: string;
  readonly scope: "adapter_operation" | "provider_site";
  readonly siteIdentityHash: string | null;
  readonly retrievedAt: string;
  readonly reviewedAt: string | null;
  readonly reviewerAuthority: string | null;
  readonly reviewStatus: "approved" | "pending" | "rejected";
  readonly validity: "active" | "expired" | "revoked" | "superseded" | "conflicted";
  readonly validUntil: string | null;
  readonly limitations: readonly string[];
}

const capabilityVerificationEvidenceSchema = z.object({
  evidenceId: z.string().trim().min(1),
  sourceType: z.enum(capabilityEvidenceSourceTypes),
  claim: z.enum(capabilityEvidenceClaims),
  cms: z.enum(CMS_IDS),
  adapterId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  capabilityId: z.string().trim().min(1),
  operationId: z.enum(CAPABILITY_OPERATIONS),
  contractVersion: z.string().trim().min(1),
  reference: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password &&
        !url.search && !url.hash;
    } catch {
      return false;
    }
  }),
  publisherAuthority: z.string().trim().min(1),
  scope: z.enum(["adapter_operation", "provider_site"]),
  siteIdentityHash: z.string().regex(/^[a-f0-9]{64}$/i).nullable(),
  retrievedAt: z.string().datetime({ offset: true }),
  reviewedAt: z.string().datetime({ offset: true }).nullable(),
  reviewerAuthority: z.string().trim().min(1).nullable(),
  reviewStatus: z.enum(["approved", "pending", "rejected"]),
  validity: z.enum(["active", "expired", "revoked", "superseded", "conflicted"]),
  validUntil: z.string().datetime({ offset: true }).nullable(),
  limitations: z.array(z.string()),
}).strict();

export const adapterCapabilityDescriptorSchema = z.object({
  capabilityId: z.string().trim().min(1),
  operationId: z.enum(CAPABILITY_OPERATIONS),
  support: z.enum(["supported", "unsupported", "not_verified"]),
  access: z.enum(["none", "read_only", "write", "read_write"]),
  executionMechanism: z.enum([
    "none",
    "official_api",
    "browser_automation",
    "hybrid",
    "custom_code",
    "manual",
    "unknown",
  ]),
  verification: z.enum([
    "independently_verified",
    "synthetic_only",
    "not_verified",
  ]),
  approvalRequirement: z.enum(["none", "required", "policy_based"]),
  permissionRequirement: permissionRequirementSchema,
  evidence: z.array(capabilityVerificationEvidenceSchema),
}).strict();

export type AdapterCapabilityDescriptor = z.infer<
  typeof adapterCapabilityDescriptorSchema
>;

export const adapterCapabilityDescriptorsSchema = z.array(
  adapterCapabilityDescriptorSchema,
);

export const adapterCapabilityDeclarationSchema = z.object({
  cms: z.enum(CMS_IDS),
  adapterId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  contractVersion: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  descriptors: adapterCapabilityDescriptorsSchema,
}).strict();

export type AdapterCapabilityDeclaration = z.infer<
  typeof adapterCapabilityDeclarationSchema
>;

export const adapterCapabilityDeclarationSetSchema = z.array(
  adapterCapabilityDeclarationSchema,
).max(256);

export type AdapterCapabilityDeclarationSet = z.infer<
  typeof adapterCapabilityDeclarationSetSchema
>;