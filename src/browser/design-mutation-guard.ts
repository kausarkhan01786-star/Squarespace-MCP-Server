import { z } from "zod";
import { SquarespaceBrowserError } from "./browser-errors.js";
import type { PageSnapshot } from "../backups/page-backup.service.js";

export const designMutationGuardSchema = z.object({
  website_id: z.string().trim().min(1),
  page_id: z.string().trim().min(1),
  pre_change_snapshot_id: z.string().uuid(),
  confirmed: z.literal(true),
});

export type DesignMutationGuard = z.infer<typeof designMutationGuardSchema>;

export async function verifyDesignMutationGuard(
  input: unknown,
  getSnapshot: (snapshotId: string) => Promise<PageSnapshot>,
): Promise<DesignMutationGuard> {
  const guard = designMutationGuardSchema.parse(input);
  const snapshot = await getSnapshot(guard.pre_change_snapshot_id);
  if (
    snapshot.website.id !== guard.website_id ||
    snapshot.page.id !== guard.page_id
  ) {
    throw new SquarespaceBrowserError(
      "DESIGN_MUTATION_PRECONDITION_FAILED",
      "The required pre-change snapshot does not match the selected website and page.",
    );
  }
  return guard;
}
