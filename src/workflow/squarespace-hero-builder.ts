import { z } from "zod";
import {
  ExecutionController,
  type ExecutionControllerOptions,
} from "../execution/execution-controller.js";
import type { ExecutionMetrics } from "../execution/execution-telemetry.js";
import {
  heroElementIds,
  parseHeroSpecification,
  type HeroElementId,
  type HeroSpecification,
} from "./hero-specification.js";

export type HeroOperationStatus =
  | "planned"
  | "executed"
  | "visually_verified"
  | "unsupported"
  | "blocked_duplicate"
  | "failed"
  | "interrupted";

export type HeroStageId =
  | "preflight"
  | "backup"
  | "section"
  | "content"
  | "buttons"
  | "visual"
  | "styling"
  | "layout"
  | "verification"
  | "save";

export interface HeroOperation {
  id: string;
  stage: HeroStageId;
  elementId: HeroElementId | "section";
  description: string;
  status: HeroOperationStatus;
  readiness: "observed_once" | "unsupported";
  evidence: string | null;
  limitation: string | null;
}

export interface HeroStage {
  id: HeroStageId;
  checkpoint: string;
  operations: string[];
  status: "planned" | "blocked" | "unsupported";
}

export interface SquarespaceHeroPlan {
  specification: HeroSpecification;
  deadlineMs: number;
  maxBrowserActions: number;
  stages: HeroStage[];
  operations: HeroOperation[];
  executionMetrics: null;
  boundary: "Agent-controlled shared browser; no MCP browser bridge";
  executionStarted: false;
  saved: false;
  published: false;
}

export interface HeroInspectionEvidence {
  sectionExists: boolean;
  elements: Array<{
    elementId: HeroElementId;
    text: string;
  }>;
  sharedBrowserActionCount?: number;
}

export class SquarespaceHeroExecutionSession {
  private readonly controller: ExecutionController;

  constructor(
    readonly plan: SquarespaceHeroPlan,
    options: Omit<ExecutionControllerOptions, "timeoutMs" | "maxBrowserActions"> & {
      timeoutMs?: number;
      maxBrowserActions?: number;
    } = {},
  ) {
    this.controller = new ExecutionController({
      timeoutMs: options.timeoutMs ?? plan.deadlineMs,
      maxBrowserActions: options.maxBrowserActions ?? plan.maxBrowserActions,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  checkpoint(): void {
    this.controller.checkpoint();
  }

  beforeSharedBrowserAction(): void {
    this.controller.beforeBrowserAction();
  }

  recordDomInspection(): void {
    this.controller.recordDomInspection();
  }

  recordScreenshot(): void {
    this.controller.recordScreenshot();
  }

  recordExplicitWait(durationMs: number): void {
    this.controller.recordExplicitWait(durationMs);
  }

  startStage(stage: "preflight" | "backup" | HeroStageId): void {
    this.controller.startStage(stage === "preflight" ? "website_verification" : stageToTelemetryStage(stage));
  }

  endStage(stage: "preflight" | "backup" | HeroStageId): void {
    this.controller.endStage(stage === "preflight" ? "website_verification" : stageToTelemetryStage(stage));
  }

  recordOperation(
    operationId: string,
    result: {
      executed?: boolean;
      visuallyVerified?: boolean;
      interrupted?: boolean;
      evidence?: string;
    },
  ): void {
    recordHeroOperation(this.plan, operationId, result);
  }

  preventDuplicates(evidence: HeroInspectionEvidence): HeroElementId[] {
    const duplicates = inspectHeroDuplicates(this.plan.specification, evidence);
    recordHeroDuplicates(this.plan, duplicates);
    return duplicates;
  }

  finish(status: ExecutionMetrics["status"]): ExecutionMetrics {
    return this.controller.finish(status);
  }
}

export const heroPlanningInputSchema = z.object({
  specification: z.unknown(),
  deadline_ms: z.number().int().min(1_000).max(600_000).default(180_000),
  max_browser_actions: z.number().int().min(1).max(500).default(100),
}).strict();

const OBSERVED_ONCE_CAPABILITIES = new Set([
  "add_blank_section",
  "add_text_block",
  "enter_text",
  "add_button_block",
]);

const UNVERIFIED_CAPABILITY_REASONS: Record<string, string> = {
  position_element: "Reliable per-element positioning has not been verified; the earlier two-button attempt overlapped.",
  add_visual: "Image/decorative visual creation has not been verified in the target editor.",
  set_style: "Arbitrary color, typography, and spacing mapping from the specification has not been verified.",
  responsive_layout: "Reliable mobile-specific layout controls have not been verified.",
  save_draft: "Draft-only Save behavior is unverified; saving could affect the live site.",
  screenshot_verify: "Shared-browser screenshots and execution telemetry are supplied by the Agent environment, not this MCP process.",
};

export function planSquarespaceHero(input: unknown): SquarespaceHeroPlan {
  const parsed = heroPlanningInputSchema.parse(input);
  const specification = parseHeroSpecification(parsed.specification);
  const operations = createHeroOperations(specification);
  const stages: HeroStage[] = [
    {
      id: "preflight",
      checkpoint: "Confirm the current tab/site and inspect the target Home page for duplicates before any write.",
      operations: ["inspect_target", "detect_duplicates"],
      status: "planned",
    },
    {
      id: "backup",
      checkpoint: "Create and verify a fresh page snapshot before the first editor mutation.",
      operations: ["create_backup"],
      status: "planned",
    },
    {
      id: "section",
      checkpoint: "Use the observed Add Section → Add Blank editor flow; verify exactly one new section.",
      operations: ["create_section"],
      status: "planned",
    },
    {
      id: "content",
      checkpoint: "Add and inspect eyebrow, heading, and description separately; stop if any duplicate is detected.",
      operations: ["add_eyebrow", "add_heading", "add_description"],
      status: "planned",
    },
    {
      id: "buttons",
      checkpoint: "Add primary then secondary buttons; inspect each element before continuing.",
      operations: ["add_primary_button", "add_secondary_button"],
      status: "planned",
    },
    {
      id: "visual",
      checkpoint: "Add supporting visual only after a real editor control is confirmed.",
      operations: ["add_visual"],
      status: "unsupported",
    },
    {
      id: "styling",
      checkpoint: "Apply only a confirmed theme/style mapping; do not infer color or spacing controls.",
      operations: ["apply_styling"],
      status: "unsupported",
    },
    {
      id: "layout",
      checkpoint: "Measure all element boxes on desktop and mobile, then reject overlap/out-of-bounds layouts.",
      operations: ["position_elements", "verify_desktop_layout", "verify_mobile_layout"],
      status: "blocked",
    },
    {
      id: "verification",
      checkpoint: "Verify expected text/elements and obtain targeted visual evidence from the shared browser.",
      operations: ["verify_elements", "capture_targeted_evidence"],
      status: "blocked",
    },
    {
      id: "save",
      checkpoint: "Require separate user authorization after confirming whether Save can affect the live site; never publish.",
      operations: ["save_without_publish"],
      status: "blocked",
    },
  ];

  for (const stage of stages) {
    if (operations.some((operation) =>
      operation.stage === stage.id && operation.readiness === "unsupported")) {
      stage.status = "unsupported";
    }
  }

  return {
    specification,
    deadlineMs: parsed.deadline_ms,
    maxBrowserActions: parsed.max_browser_actions,
    stages,
    operations,
    executionMetrics: null,
    boundary: "Agent-controlled shared browser; no MCP browser bridge",
    executionStarted: false,
    saved: false,
    published: false,
  };
}

export function inspectHeroDuplicates(
  specification: HeroSpecification,
  evidence: HeroInspectionEvidence,
): HeroElementId[] {
  if (!evidence.sectionExists) return [];
  const expected = expectedElementTexts(specification);
  const found = new Set<HeroElementId>();
  for (const element of evidence.elements) {
    const expectedText = expected[element.elementId];
    if (expectedText && normalizeText(expectedText) === normalizeText(element.text)) {
      found.add(element.elementId);
    }
  }
  return heroElementIds.filter((id) => found.has(id));
}

export function recordHeroOperation(
  plan: SquarespaceHeroPlan,
  operationId: string,
  result: {
    executed?: boolean;
    visuallyVerified?: boolean;
    interrupted?: boolean;
    evidence?: string;
  },
): SquarespaceHeroPlan {
  const operation = plan.operations.find((candidate) => candidate.id === operationId);
  if (operation?.readiness === "unsupported") {
    throw new Error("Unsupported Hero operations cannot be marked executed.");
  }
  if (!operation || operation.status !== "planned") {
    throw new Error("Only a planned Hero operation can be recorded.");
  }
  if (result.visuallyVerified && !result.executed) {
    throw new Error("A Hero operation must be executed before visual verification.");
  }
  if (result.visuallyVerified && !result.evidence?.trim()) {
    throw new Error("Visual verification requires a sanitized evidence reference.");
  }
  if (
    result.visuallyVerified &&
    !/^[A-Za-z0-9._:-]{1,160}$/.test(result.evidence!.trim())
  ) {
    throw new Error("Visual evidence must be a sanitized, non-path reference.");
  }
  operation.status = result.interrupted
    ? "interrupted"
    : result.visuallyVerified
      ? "visually_verified"
      : result.executed
        ? "executed"
        : "planned";
  operation.evidence = result.visuallyVerified ? result.evidence!.trim() : null;
  return plan;
}

export function recordHeroDuplicates(
  plan: SquarespaceHeroPlan,
  duplicates: HeroElementId[],
): SquarespaceHeroPlan {
  for (const elementId of duplicates) {
    for (const operation of plan.operations.filter((entry) => entry.elementId === elementId)) {
      if (operation.status === "planned") {
        operation.status = "blocked_duplicate";
        operation.limitation = "Matching content already exists in the inspected target section; do not create a duplicate.";
      }
    }
  }
  return plan;
}

function createHeroOperations(spec: HeroSpecification): HeroOperation[] {
  const observed = (
    id: string,
    stage: HeroStageId,
    elementId: HeroElementId | "section",
    description: string,
    capability: string,
  ): HeroOperation => ({
    id,
    stage,
    elementId,
    description,
    status: OBSERVED_ONCE_CAPABILITIES.has(capability) ? "planned" : "unsupported",
    readiness: OBSERVED_ONCE_CAPABILITIES.has(capability) ? "observed_once" : "unsupported",
    evidence: null,
    limitation: OBSERVED_ONCE_CAPABILITIES.has(capability)
      ? "Control was observed in a prior editor session; repeatability and layout safety still require controlled live testing."
      : UNVERIFIED_CAPABILITY_REASONS[capability] ?? "No verified Squarespace editor operation is registered.",
  });
  return [
    observed("create_section", "section", "section", "Add one blank section at the Home page bottom.", "add_blank_section"),
    observed("add_eyebrow", "content", "eyebrow", `Add eyebrow text: ${spec.content.eyebrow}`, "add_text_block"),
    observed("add_heading", "content", "heading", `Add heading text: ${spec.content.heading}`, "add_text_block"),
    observed("add_description", "content", "description", `Add description text: ${spec.content.description}`, "add_text_block"),
    observed("add_primary_button", "buttons", "primary_button", `Add primary button: ${spec.content.buttons[0].label}`, "add_button_block"),
    observed("add_secondary_button", "buttons", "secondary_button", `Add secondary button: ${spec.content.buttons[1].label}`, "add_button_block"),
    observed("add_visual", "visual", "visual", `Add ${spec.content.visual.kind} visual: ${spec.content.visual.description}`, "add_visual"),
    observed("apply_styling", "styling", "section", "Apply specified background, typography, alignment, and spacing.", "set_style"),
    observed("position_elements", "layout", "section", "Position all elements using specified desktop and mobile rectangles.", "position_element"),
    observed("verify_desktop_layout", "verification", "section", "Verify desktop bounding boxes and reject overlap/out-of-bounds.", "responsive_layout"),
    observed("verify_mobile_layout", "verification", "section", "Verify mobile bounding boxes and reject overlap/out-of-bounds.", "responsive_layout"),
    observed("save_without_publish", "save", "section", "Save changes without publishing, only after separate authorization.", "save_draft"),
  ];
}

function expectedElementTexts(spec: HeroSpecification): Record<HeroElementId, string> {
  return {
    eyebrow: spec.content.eyebrow,
    heading: spec.content.heading,
    description: spec.content.description,
    primary_button: spec.content.buttons[0].label,
    secondary_button: spec.content.buttons[1].label,
    visual: spec.content.visual.description,
  };
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function stageToTelemetryStage(stage: HeroStageId) {
  switch (stage) {
    case "preflight":
      return "website_verification" as const;
    case "backup":
      return "backup" as const;
    case "section":
      return "section_creation" as const;
    case "content":
      return "block_creation" as const;
    case "buttons":
      return "block_creation" as const;
    case "visual":
      return "block_creation" as const;
    case "styling":
      return "style_application" as const;
    case "layout":
    case "verification":
      return "result_verification" as const;
    case "save":
      return "save" as const;
  }
}
