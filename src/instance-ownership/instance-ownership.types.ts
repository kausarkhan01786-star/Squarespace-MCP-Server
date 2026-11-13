export type InstanceOwnershipErrorCode =
  | "INSTANCE_ALREADY_RUNNING"
  | "INSTANCE_OWNERSHIP_ACQUISITION_FAILED"
  | "INVALID_OWNERSHIP_IDENTITY"
  | "PLATFORM_NOT_SUPPORTED"
  | "ARCHITECTURE_NOT_SUPPORTED"
  | "NATIVE_ADDON_NOT_BUILT"
  | "OWNERSHIP_ALREADY_ACQUIRED"
  | "OWNERSHIP_RELEASE_FAILED"
  | "SECURITY_DESCRIPTOR_FAILED";

export class InstanceOwnershipError extends Error {
  constructor(
    public readonly code: InstanceOwnershipErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InstanceOwnershipError";
  }
}

export interface InstanceOwnershipLease {
  readonly identity: string;
  readonly pipeName: string;
  isOwned(): boolean;
  release(): Promise<boolean>;
}

export interface InstanceOwnershipProvider {
  acquire(identity?: string): Promise<InstanceOwnershipLease>;
}

export const VALID_IDENTITY_REGEX = /^[a-zA-Z0-9_\-]{1,64}$/;

export function sanitizeIdentity(identity?: string): string {
  const target = identity?.trim() || "default";
  if (!VALID_IDENTITY_REGEX.test(target)) {
    throw new InstanceOwnershipError(
      "INVALID_OWNERSHIP_IDENTITY",
      "Ownership identity must be 1 to 64 alphanumeric characters, underscores, or hyphens.",
    );
  }
  return target;
}
