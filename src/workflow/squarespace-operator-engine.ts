import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ExecutionController,
  ExecutionStoppedError,
  type ExecutionControllerOptions,
} from "../execution/execution-controller.js";
import type { ExecutionMetrics } from "../execution/execution-telemetry.js";
import {
  validateResponsiveLayouts,
  type LayoutRect,
  type LayoutSurface,
} from "./layout-validation.js";
import {
  parseHeroSpecification,
  type HeroElementId,
  type HeroSpecification,
} from "./hero-specification.js";

export type SquarespaceHeroBlockPlan =
  | {
      id: HeroElementId;
      sectionId: string;
      type: "Text";
      content: string;
    }
  | {
      id: HeroElementId;
      sectionId: string;
      type: "Button";
      content: string;
      destination?: string;
      variant: "primary" | "secondary";
    }
  | {
      id: HeroElementId;
      sectionId: string;
      type: "Image";
      content: string;
      assetId: string;
    };

export interface SquarespaceHeroOperatorPlan {
  version: 1;
  fingerprint: string;
  sectionId: string;
  maxBrowserActions: number;
  estimatedBrowserActions: number;
  specification: HeroSpecification;
  blocks: SquarespaceHeroBlockPlan[];
}

export interface MeasuredSectionLayout {
  section: LayoutRect;
  elements: Array<{ id: HeroElementId; rect: LayoutRect }>;
}

export interface SquarespaceOperatorDriver {
  /** Each method represents one browser action and is scoped to the supplied section ID. */
  verifyTargetSection(sectionId: string): Promise<{ sectionId: string; empty: boolean }>;
  insertTextBlock(sectionId: string, elementId: HeroElementId): Promise<{ blockId: string }>;
  setTextBlockContent(sectionId: string, blockId: string, content: string): Promise<void>;
  insertButtonBlock(sectionId: string, elementId: HeroElementId): Promise<{ blockId: string }>;
  configureButtonBlock(
    sectionId: string,
    blockId: string,
    button: { label: string; destination?: string; variant: "primary" | "secondary" },
  ): Promise<void>;
  insertImageBlock(sectionId: string, elementId: HeroElementId): Promise<{ blockId: string }>;
  selectImageAsset(sectionId: string, blockId: string, assetId: string): Promise<void>;
  applySectionStyle(sectionId: string, specification: HeroSpecification["styling"]): Promise<void>;
  placeResponsiveBlocks(
    sectionId: string,
    placements: Array<{
      id: HeroElementId;
      blockId: string;
      desktop: LayoutRect;
      mobile: LayoutRect;
    }>,
  ): Promise<void>;
  inspectResponsiveLayout(
    sectionId: string,
    blockIds: HeroElementId[],
  ): Promise<Record<LayoutSurface, MeasuredSectionLayout>>;
}

export interface OperatorActionTiming {
  ordinal: number;
  action: string;
  sectionId: string;
  durationMs: number;
}

export interface SquarespaceOperatorReport {
  version: 1;
  planFingerprint: string;
  sectionId: string;
  status:
    | "succeeded"
    | "collision_detected"
    | "failed"
    | "interrupted"
    | "action_budget_exceeded"
    | "timed_out"
    | "browser_operation_timed_out"
    | "api_request_timed_out"
    | "cancelled";
  failureCode: string | null;
  createdBlocks: Array<{ id: HeroElementId; type: SquarespaceHeroBlockPlan["type"]; blockId: string }>;
  actions: OperatorActionTiming[];
  collisionCheckCount: 0 | 1;
  layoutErrors: string[];
  executionMetrics: ExecutionMetrics;
  saved: false;
  published: false;
}

export interface SquarespaceOperatorOptions {
  timeoutMs?: number;
  maxBrowserActions?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export const squarespaceHeroOperatorPlanInputSchema = z.object({
  specification: z.unknown(),
  section_id: z.string().trim().min(1),
  max_browser_actions: z.number().int().min(1).max(39).default(39),
}).strict();

const HERO_BLOCK_ORDER: HeroElementId[] = [
  "eyebrow",
  "heading",
  "description",
  "primary_button",
  "secondary_button",
  "visual",
];

export function createSquarespaceHeroOperatorPlan(rawInput: unknown): SquarespaceHeroOperatorPlan {
  const input = squarespaceHeroOperatorPlanInputSchema.parse(rawInput);
  const sectionId = input.section_id;
  const maxBrowserActions = input.max_browser_actions;
  const specification = parseHeroSpecification(input.specification);
  if (specification.content.visual.kind !== "image") {
    throw new Error("The native operator currently supports Image visuals only.");
  }

  const blocks: SquarespaceHeroBlockPlan[] = HERO_BLOCK_ORDER.map((id) => {
    switch (id) {
      case "eyebrow":
        return { id, sectionId, type: "Text", content: specification.content.eyebrow };
      case "heading":
        return { id, sectionId, type: "Text", content: specification.content.heading };
      case "description":
        return { id, sectionId, type: "Text", content: specification.content.description };
      case "primary_button":
      case "secondary_button": {
        const button = specification.content.buttons[id === "primary_button" ? 0 : 1];
        return {
          id,
          sectionId,
          type: "Button",
          content: button.label,
          ...(button.destination ? { destination: button.destination } : {}),
          variant: button.variant,
        };
      }
      case "visual":
        return {
          id,
          sectionId,
          type: "Image",
          content: specification.content.visual.description,
          assetId: specification.content.visual.assetId!,
        };
    }
  });
  const planWithoutFingerprint = {
    version: 1 as const,
    sectionId,
    maxBrowserActions,
    estimatedBrowserActions: blocks.length * 2 + 4,
    specification,
    blocks,
  };
  return {
    ...planWithoutFingerprint,
    fingerprint: createHash("sha256")
      .update(canonicalJson(planWithoutFingerprint))
      .digest("hex"),
  };
}

export async function executeSquarespaceHeroPlan(
  plan: SquarespaceHeroOperatorPlan,
  driver: SquarespaceOperatorDriver,
  options: SquarespaceOperatorOptions = {},
): Promise<SquarespaceOperatorReport> {
  assertPlanSectionBindings(plan);
  const controllerOptions: ExecutionControllerOptions = {
    timeoutMs: options.timeoutMs ?? 180_000,
    maxBrowserActions: options.maxBrowserActions ?? plan.maxBrowserActions,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  if (controllerOptions.maxBrowserActions > 39) {
    throw new RangeError("The operator action budget cannot exceed 39 browser actions.");
  }
  const controller = new ExecutionController(controllerOptions);
  const now = options.now ?? (() => performance.now());
  const actions: OperatorActionTiming[] = [];
  const createdBlocks: SquarespaceOperatorReport["createdBlocks"] = [];
  let collisionCheckCount: 0 | 1 = 0;
  let layoutErrors: string[] = [];
  let hasLayoutCollisions = false;
  let status: SquarespaceOperatorReport["status"] = "succeeded";
  let failureCode: string | null = null;
  let ordinal = 0;

  const action = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    controller.beforeBrowserAction();
    const startedAt = now();
    ordinal += 1;
    try {
      return await run();
    } finally {
      actions.push({
        ordinal,
        action: name,
        sectionId: plan.sectionId,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
      });
    }
  };

  const stage = async <T>(
    stageId: "website_verification" | "block_creation" | "style_application" | "result_verification",
    run: () => Promise<T>,
  ): Promise<T> => {
    controller.startStage(stageId);
    try {
      return await run();
    } finally {
      controller.endStage(stageId);
    }
  };

  try {
    const target = await stage("website_verification", () =>
      action("verify_target_section", () => driver.verifyTargetSection(plan.sectionId)));
    if (target.sectionId !== plan.sectionId || !target.empty) {
      throw new OperatorExecutionError("target_section_mismatch");
    }

    await stage("block_creation", async () => {
      for (const block of plan.blocks) {
        const result = await action(`insert_${block.type.toLowerCase()}_block:${block.id}`, () => {
          switch (block.type) {
            case "Text":
              return driver.insertTextBlock(plan.sectionId, block.id);
            case "Button":
              return driver.insertButtonBlock(plan.sectionId, block.id);
            case "Image":
              return driver.insertImageBlock(plan.sectionId, block.id);
          }
        });
        if (!result.blockId.trim()) throw new OperatorExecutionError("empty_native_block_id");
        createdBlocks.push({ id: block.id, type: block.type, blockId: result.blockId });
        if (block.type === "Text") {
          await action(`set_text_content:${block.id}`, () =>
            driver.setTextBlockContent(plan.sectionId, result.blockId, block.content));
        } else if (block.type === "Button") {
          await action(`configure_button:${block.id}`, () =>
            driver.configureButtonBlock(plan.sectionId, result.blockId, {
              label: block.content,
              ...(block.destination ? { destination: block.destination } : {}),
              variant: block.variant,
            }));
        } else {
          await action(`select_image_asset:${block.id}`, () =>
            driver.selectImageAsset(plan.sectionId, result.blockId, block.assetId));
        }
      }
    });

    await stage("style_application", () =>
      action("apply_section_style", () =>
        driver.applySectionStyle(plan.sectionId, plan.specification.styling)));
    const placements = plan.blocks.map((block) => ({
      id: block.id,
      blockId: createdBlocks.find((created) => created.id === block.id)!.blockId,
      desktop: plan.specification.layout.desktop.positions[block.id],
      mobile: plan.specification.layout.mobile.positions[block.id],
    }));
    await action("place_responsive_blocks", () =>
      driver.placeResponsiveBlocks(plan.sectionId, placements));

    await stage("result_verification", async () => {
      const measured = await action("inspect_placed_layout_once", () =>
        driver.inspectResponsiveLayout(plan.sectionId, HERO_BLOCK_ORDER));
      collisionCheckCount = 1;
      const results = validateResponsiveLayouts(
        (["desktop", "mobile"] as const).map((surface) => ({
          surface,
          section: measured[surface].section,
          elements: measured[surface].elements.map(({ id, rect }) => ({ id, rect })),
        })),
      );
      for (const surface of ["desktop", "mobile"] as const) {
        const observedIds = new Set(measured[surface].elements.map(({ id }) => id));
        for (const id of HERO_BLOCK_ORDER) {
          if (!observedIds.has(id)) layoutErrors.push(`${id} is missing from ${surface} layout inspection.`);
        }
      }
      layoutErrors = [
        ...layoutErrors,
        ...results.flatMap((result) => result.errors),
      ];
      hasLayoutCollisions = layoutErrors.length > 0;
    });
    if (hasLayoutCollisions) status = "collision_detected";
  } catch (error) {
    if (error instanceof ExecutionStoppedError) {
      status = error.reason === "browser_operation_timeout"
        ? "browser_operation_timed_out"
        : error.reason === "api_request_timeout"
          ? "api_request_timed_out"
          : error.reason;
      failureCode = error.reason;
    } else if (error instanceof OperatorExecutionError) {
      status = "failed";
      failureCode = error.code;
    } else {
      status = "failed";
      failureCode = "operator_action_failed";
    }
  }

  const executionMetrics = controller.finish(
    status === "succeeded" || status === "collision_detected"
      ? "succeeded"
      : status === "cancelled" ||
          status === "timed_out" ||
          status === "browser_operation_timed_out" ||
          status === "api_request_timed_out"
        ? status
        : status === "failed"
          ? "failed"
          : "interrupted",
  );
  return {
    version: 1,
    planFingerprint: plan.fingerprint,
    sectionId: plan.sectionId,
    status,
    failureCode,
    createdBlocks,
    actions,
    collisionCheckCount,
    layoutErrors,
    executionMetrics,
    saved: false,
    published: false,
  };
}

function assertPlanSectionBindings(plan: SquarespaceHeroOperatorPlan): void {
  const { fingerprint, ...fingerprintedPlan } = plan;
  if (
    !Number.isSafeInteger(plan.maxBrowserActions) ||
    plan.maxBrowserActions < 1 ||
    plan.maxBrowserActions > 39 ||
    fingerprint !== createHash("sha256").update(canonicalJson(fingerprintedPlan)).digest("hex")
  ) {
    throw new Error("The operator plan is invalid or has changed since planning.");
  }
  if (!plan.sectionId || plan.blocks.some((block) => block.sectionId !== plan.sectionId)) {
    throw new Error("Every planned native block must be bound to the exact target section ID.");
  }
  if (plan.blocks.length !== HERO_BLOCK_ORDER.length ||
    plan.blocks.some((block, index) => block.id !== HERO_BLOCK_ORDER[index])) {
    throw new Error("The operator plan must contain the complete native Hero block sequence.");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

class OperatorExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
