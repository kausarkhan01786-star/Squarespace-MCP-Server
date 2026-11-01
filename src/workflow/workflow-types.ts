import { z } from "zod";

const textListSchema = z.array(z.string().trim().min(1).max(500)).max(50);

export const clientBriefSchema = z.object({
  businessType: z.string().trim().min(1).max(160),
  websiteGoals: textListSchema.min(1),
  targetAudience: textListSchema.min(1),
  requiredPages: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    purpose: z.string().trim().min(1).max(500),
    sections: z.array(z.object({
      name: z.string().trim().min(1).max(100),
      goal: z.string().trim().min(1).max(500),
    }).strict()).max(30),
    seoRequirements: textListSchema.optional(),
  }).strict()).min(1).max(50),
  requiredFeatures: textListSchema,
  contentRequirements: textListSchema,
  designPreferences: textListSchema,
  assetRequirements: textListSchema,
  responsiveRequirements: textListSchema,
  openQuestions: textListSchema,
}).strict();

export const designSpecificationSchema = z.object({
  source: z.enum(["client_notes", "human_analysis", "external_vision_analysis"]),
  referenceDescription: z.string().trim().max(2_000).optional(),
  visualHierarchy: textListSchema,
  colors: z.array(z.object({
    role: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(80),
    confidence: z.enum(["specified", "estimated", "unknown"]),
  }).strict()).max(30),
  typography: textListSchema,
  spacingAndLayout: textListSchema,
  components: textListSchema,
  imagePlacements: textListSchema,
  responsiveBehavior: textListSchema,
  pixelComparisonVerified: z.literal(false).default(false),
}).strict();

export const analyzeRequirementsInputSchema = z.object({
  brief: clientBriefSchema,
  design_specification: designSpecificationSchema.optional(),
}).strict();

export const workflowActionSchema = z.enum([
  "inspect_pages",
  "inspect_page",
  "inspect_page_sections",
  "inspect_responsive",
  "inspect_page_seo",
  "inspect_design",
  "backup_page",
  "inspect_products",
  "inspect_product",
  "inspect_inventory",
  "inspect_orders",
  "inspect_discounts",
  "add_text_section",
  "create_page",
  "edit_content_block",
  "manage_navigation",
  "set_site_design",
  "configure_custom_code",
  "publish_site",
  "manage_orders",
  "manage_products",
  "manage_inventory",
  "manage_discounts",
]);

export const planWebsiteWorkflowInputSchema = z.object({
  cms: z.string().trim().min(1).max(50),
  website_id: z.string().trim().min(1),
  brief: clientBriefSchema,
  design_specification: designSpecificationSchema.optional(),
  tasks: z.array(z.object({
    action: workflowActionSchema,
    page_id: z.string().trim().min(1).optional(),
    section_id: z.string().trim().min(1).optional(),
    block_id: z.string().trim().min(1).optional(),
    product_id: z.string().trim().min(1).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    text: z.string().min(1).max(500).optional(),
    background_color: z.string().optional(),
    text_color: z.string().optional(),
    confirm_potentially_live_save: z.boolean().optional(),
  }).strict().superRefine((task, context) => {
    const needsPage = new Set<WorkflowAction>([
      "inspect_page",
      "inspect_page_sections",
      "inspect_responsive",
      "inspect_page_seo",
      "inspect_design",
      "backup_page",
      "add_text_section",
    ]);
    if (needsPage.has(task.action) && !task.page_id) {
      context.addIssue({
        code: "custom",
        path: ["page_id"],
        message: `${task.action} requires page_id.`,
      });
    }
    if (task.action === "inspect_product" && !task.product_id) {
      context.addIssue({
        code: "custom",
        path: ["product_id"],
        message: "inspect_product requires product_id.",
      });
    }
    if (task.action === "add_text_section") {
      if (!task.text?.trim()) {
        context.addIssue({
          code: "custom",
          path: ["text"],
          message: "add_text_section requires non-empty text.",
        });
      }
      if (task.background_color !== "#FFFFFF") {
        context.addIssue({
          code: "custom",
          path: ["background_color"],
          message: "The verified add_text_section workflow supports only #FFFFFF.",
        });
      }
      if (task.text_color !== "#000000") {
        context.addIssue({
          code: "custom",
          path: ["text_color"],
          message: "The verified add_text_section workflow supports only #000000.",
        });
      }
      if (task.confirm_potentially_live_save !== true) {
        context.addIssue({
          code: "custom",
          path: ["confirm_potentially_live_save"],
          message: "add_text_section requires explicit confirmation that Squarespace Save may affect the live site.",
        });
      }
    }
  })).min(1).max(100),
}).strict();

export const executeWorkflowInputSchema = z.object({
  workflow_id: z.string().uuid(),
  max_tasks: z.number().int().min(1).max(10).default(1),
  retry_failed_read_only: z.boolean().default(false),
}).strict();

export const approveWorkflowTasksInputSchema = z.object({
  workflow_id: z.string().uuid(),
  plan_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  task_ids: z.array(z.string().uuid()).min(1).max(20),
  confirmed: z.literal(true),
}).strict();

export const workflowIdInputSchema = z.object({
  workflow_id: z.string().uuid(),
}).strict();

export type ClientBrief = z.infer<typeof clientBriefSchema>;
export type DesignSpecification = z.infer<typeof designSpecificationSchema>;
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
export type PlannedTaskInput = z.infer<typeof planWebsiteWorkflowInputSchema>["tasks"][number];

export type WorkflowStage =
  | "requirements"
  | "design_analysis"
  | "planning"
  | "cms_inspection"
  | "construction"
  | "responsive_qa"
  | "seo_qa"
  | "commerce"
  | "publishing";

export type WorkflowTaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "unsupported";

export type WorkflowStatus =
  | "planned"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "partial"
  | "failed";

export interface WorkflowCapability {
  action: WorkflowAction;
  supported: boolean;
  toolName: string | null;
  readOnly: boolean;
  approvalRequired: boolean;
  retrySafe: boolean;
  limitation: string | null;
}

export interface WorkflowAdapter {
  readonly cms: string;
  getCapabilities(): WorkflowCapability[];
  validateTask?(
    action: WorkflowAction,
    websiteId: string,
    args: PlannedTaskInput,
  ): Promise<string | null>;
  verifyWebsite(websiteId: string): Promise<{
    id: string;
    name: string;
    url: string;
  }>;
  execute(
    action: WorkflowAction,
    websiteId: string,
    args: PlannedTaskInput,
  ): Promise<unknown>;
}

export interface WorkflowTask {
  id: string;
  action: WorkflowAction;
  toolName: string | null;
  stage: WorkflowStage;
  pageId: string | null;
  status: WorkflowTaskStatus;
  readOnly: boolean;
  approvalRequired: boolean;
  approved: boolean;
  retrySafe: boolean;
  attempts: number;
  args: PlannedTaskInput;
  result?: unknown;
  error?: string;
}

export interface WebsiteWorkflow {
  id: string;
  cms: string;
  website: { id: string; name: string; url: string };
  brief: ClientBrief;
  designSpecification: DesignSpecification | null;
  tasks: WorkflowTask[];
  fingerprint: string;
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowQaReport {
  workflowId: string;
  status: "not_run" | "passed" | "partial" | "failed";
  checks: Array<{
    check: string;
    status: "passed" | "failed" | "blocked" | "not_verified";
    evidence: string;
  }>;
  limitations: string[];
}
