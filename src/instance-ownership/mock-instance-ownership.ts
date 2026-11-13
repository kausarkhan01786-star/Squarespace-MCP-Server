import {
  InstanceOwnershipError,
  sanitizeIdentity,
  type InstanceOwnershipLease,
  type InstanceOwnershipProvider,
} from "./instance-ownership.types.js";

export class MockInstanceOwnershipProvider implements InstanceOwnershipProvider {
  private static readonly globalActiveIdentities = new Set<string>();

  public acquisitionCount = 0;
  public releaseCount = 0;
  public forceFailAcquisition = false;
  public forceFailRelease = false;

  static resetGlobalState(): void {
    MockInstanceOwnershipProvider.globalActiveIdentities.clear();
  }

  async acquire(identity?: string): Promise<InstanceOwnershipLease> {
    const cleanIdentity = sanitizeIdentity(identity);
    this.acquisitionCount++;

    if (this.forceFailAcquisition) {
      throw new InstanceOwnershipError(
        "INSTANCE_OWNERSHIP_ACQUISITION_FAILED",
        `Simulated acquisition failure for identity: ${cleanIdentity}`,
      );
    }

    if (MockInstanceOwnershipProvider.globalActiveIdentities.has(cleanIdentity)) {
      throw new InstanceOwnershipError(
        "INSTANCE_ALREADY_RUNNING",
        `Another service instance is already running with ownership identity: ${cleanIdentity}`,
      );
    }

    MockInstanceOwnershipProvider.globalActiveIdentities.add(cleanIdentity);

    let released = false;
    const provider = this;

    return {
      identity: cleanIdentity,
      pipeName: `\\\\.\\pipe\\squarespace-mcp-owner-${cleanIdentity}`,
      isOwned(): boolean {
        return !released && MockInstanceOwnershipProvider.globalActiveIdentities.has(cleanIdentity);
      },
      async release(): Promise<boolean> {
        provider.releaseCount++;
        if (released) {
          return false;
        }
        if (provider.forceFailRelease) {
          throw new InstanceOwnershipError(
            "OWNERSHIP_RELEASE_FAILED",
            `Simulated release failure for identity: ${cleanIdentity}`,
          );
        }
        released = true;
        MockInstanceOwnershipProvider.globalActiveIdentities.delete(cleanIdentity);
        return true;
      },
    };
  }
}
