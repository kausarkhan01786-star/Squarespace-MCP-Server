export type BatchOperation =
  | { kind: "create_section"; sectionId: string; placement: "bottom" }
  | { kind: "add_text"; sectionId: string; elementId: string; text: string; role: "eyebrow" | "heading" | "description" }
  | { kind: "add_button"; sectionId: string; elementId: string; label: string; destination?: string; variant: "primary" | "secondary" }
  | { kind: "add_image"; sectionId: string; elementId: string; assetId: string }
  | { kind: "set_section_style"; sectionId: string; backgroundColor: string; textColor: string }
  | { kind: "set_layout"; sectionId: string; surface: "desktop" | "mobile"; layout: string };

export type BatchOperationStatus =
  | "planned"
  | "supported"
  | "unsupported"
  | "executed"
  | "verified"
  | "failed";

export interface BatchOperationEntry {
  id: string;
  operation: BatchOperation;
  status: BatchOperationStatus;
  limitation: string | null;
}

export interface BatchOperationPlan {
  plannedOperations: BatchOperationEntry[];
  supportedOperations: BatchOperationEntry[];
  executedOperations: BatchOperationEntry[];
  verifiedOperations: BatchOperationEntry[];
  unsupportedOperations: BatchOperationEntry[];
  failedOperations: BatchOperationEntry[];
}

export function planBatchOperations(
  operations: Array<{ id: string; operation: BatchOperation; capability: string }>,
  supportedCapabilities: ReadonlySet<string>,
): BatchOperationPlan {
  const plannedOperations = operations.map(({ id, operation, capability }) => ({
    id,
    operation,
    status: supportedCapabilities.has(capability) ? "supported" as const : "unsupported" as const,
    limitation: supportedCapabilities.has(capability)
      ? null
      : `No verified adapter capability is registered for "${capability}".`,
  }));
  return {
    plannedOperations,
    supportedOperations: plannedOperations.filter((entry) => entry.status === "supported"),
    executedOperations: [],
    verifiedOperations: [],
    unsupportedOperations: plannedOperations.filter((entry) => entry.status === "unsupported"),
    failedOperations: [],
  };
}

export function recordBatchExecution(
  plan: BatchOperationPlan,
  operationId: string,
  succeeded: boolean,
): BatchOperationPlan {
  const operation = plan.plannedOperations.find((entry) => entry.id === operationId);
  if (!operation || operation.status !== "supported") {
    throw new Error("Only a supported planned operation can be executed.");
  }
  operation.status = succeeded ? "executed" : "failed";
  plan.supportedOperations = plan.supportedOperations.filter((entry) => entry.id !== operationId);
  if (succeeded) {
    plan.executedOperations.push(operation);
  } else {
    plan.failedOperations.push(operation);
  }
  return plan;
}

export function recordBatchVerification(
  plan: BatchOperationPlan,
  operationId: string,
  verified: boolean,
): BatchOperationPlan {
  const operation = plan.executedOperations.find((entry) => entry.id === operationId);
  if (!operation) throw new Error("Only an executed operation can be verified.");
  if (!verified) {
    operation.status = "failed";
    plan.executedOperations = plan.executedOperations.filter((entry) => entry.id !== operationId);
    plan.failedOperations.push(operation);
    return plan;
  }
  operation.status = "verified";
  plan.executedOperations = plan.executedOperations.filter((entry) => entry.id !== operationId);
  plan.verifiedOperations.push(operation);
  return plan;
}
