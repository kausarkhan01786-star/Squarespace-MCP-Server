import type {
  ClientBrief,
  DesignSpecification,
  PlannedTaskInput,
  WorkflowCapability,
  WorkflowQaReport,
} from "./workflow-types.js";

export interface RequirementAnalysisProvider {
  analyzeRequirements(input: {
    clientMessage: string;
    knownWebsiteContext?: string;
  }): Promise<ClientBrief>;
}

export interface ScreenshotUnderstandingProvider {
  analyzeScreenshot(input: {
    image: Uint8Array;
    mediaType: string;
    clientContext?: string;
  }): Promise<DesignSpecification>;
}

export interface WebsitePlanningProvider {
  createPlan(input: {
    brief: ClientBrief;
    designSpecification?: DesignSpecification;
    capabilities: WorkflowCapability[];
  }): Promise<PlannedTaskInput[]>;
}

export interface ContentGenerationProvider {
  generateContent(input: {
    brief: ClientBrief;
    pageName: string;
    sectionName: string;
    purpose: string;
  }): Promise<{ text: string }>;
}

export interface TaskSelectionProvider {
  selectTasks(input: {
    proposedTasks: PlannedTaskInput[];
    capabilities: WorkflowCapability[];
    completedTaskIds: string[];
  }): Promise<PlannedTaskInput[]>;
}

export interface QualityAnalysisProvider {
  analyzeQuality(input: {
    report: WorkflowQaReport;
    referenceImage?: Uint8Array;
    renderedScreenshot?: Uint8Array;
  }): Promise<{
    summary: string;
    issues: string[];
    visualComparisonPerformed: boolean;
    confidence: "low" | "medium" | "high";
  }>;
}
