export type ExecutionStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export type ExecutionStage =
  | "website_verification"
  | "backup"
  | "editor_setup"
  | "section_creation"
  | "block_creation"
  | "style_application"
  | "save"
  | "result_verification"
  | "workflow_task";

export interface ExecutionMetrics {
  totalDurationMs: number;
  browserActionCount: number;
  domInspectionCount: number;
  screenshotCount: number;
  explicitWaitDurationMs: number;
  retryCount: number;
  stageDurationsMs: Partial<Record<ExecutionStage, number>>;
  status: ExecutionStatus;
}

export class ExecutionTelemetry {
  private readonly startedAt: number;
  private readonly stageStartedAt = new Map<ExecutionStage, number>();
  private readonly metrics: ExecutionMetrics = {
    totalDurationMs: 0,
    browserActionCount: 0,
    domInspectionCount: 0,
    screenshotCount: 0,
    explicitWaitDurationMs: 0,
    retryCount: 0,
    stageDurationsMs: {},
    status: "running",
  };

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  startStage(stage: ExecutionStage): void {
    if (!this.stageStartedAt.has(stage)) {
      this.stageStartedAt.set(stage, this.now());
    }
  }

  endStage(stage: ExecutionStage): void {
    const startedAt = this.stageStartedAt.get(stage);
    if (startedAt === undefined) return;
    this.metrics.stageDurationsMs[stage] =
      (this.metrics.stageDurationsMs[stage] ?? 0) + Math.max(0, this.now() - startedAt);
    this.stageStartedAt.delete(stage);
  }

  recordBrowserAction(): void {
    this.metrics.browserActionCount += 1;
  }

  recordDomInspection(): void {
    this.metrics.domInspectionCount += 1;
  }

  recordScreenshot(count = 1): void {
    this.metrics.screenshotCount += Math.max(0, Math.floor(count));
  }

  recordExplicitWait(durationMs: number): void {
    this.metrics.explicitWaitDurationMs += Math.max(0, durationMs);
  }

  recordRetry(): void {
    this.metrics.retryCount += 1;
  }

  finish(status: ExecutionStatus): ExecutionMetrics {
    this.metrics.status = status;
    this.metrics.totalDurationMs = Math.max(0, this.now() - this.startedAt);
    for (const stage of this.stageStartedAt.keys()) this.endStage(stage);
    return this.snapshot();
  }

  snapshot(): ExecutionMetrics {
    return {
      ...this.metrics,
      stageDurationsMs: { ...this.metrics.stageDurationsMs },
    };
  }
}

export interface ExecutionReporter {
  recordBrowserAction(): void;
  recordDomInspection(): void;
  recordScreenshot(count?: number): void;
  recordExplicitWait(durationMs: number): void;
  startStage(stage: ExecutionStage): void;
  endStage(stage: ExecutionStage): void;
}
