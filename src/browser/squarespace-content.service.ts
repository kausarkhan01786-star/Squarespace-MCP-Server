import { createHash } from "node:crypto";
import { z } from "zod";
import type { Page, Frame, Locator } from "playwright";
import {
  awaitPlaywrightOperation,
  ExecutionStoppedError,
  waitForExecutionCondition,
  type BrowserExecutionContext,
  withBrowserExecutionContext,
} from "./browser-execution-context.js";
import { ExecutionController } from "../execution/execution-controller.js";
import type { ExecutionMetrics } from "../execution/execution-telemetry.js";
import type { PageBackupService, PageSnapshot } from "../backups/page-backup.service.js";
import { SquarespaceBrowserError } from "./browser-errors.js";
import {
  MutationApprovalError,
  MutationApprovalGuard,
  type MutationAuthorization,
} from "../approval/mutation-approval.js";
import {
  nativeTextBlockMutationProposal,
  textSectionMutationPayload,
  textSectionMutationProposal,
} from "../approval/squarespace-mutation-proposals.js";
import {
  SQUARESPACE_PAGE_SECTION_SELECTOR,
  type SquarespacePage,
  type SquarespacePagesService,
} from "./squarespace-pages.service.js";
import type {
  SquarespaceBrowserService,
  WebsiteSummary,
} from "./squarespace-browser.service.js";
import { logInfo } from "../utils/logger.js";

const SECTION_SELECTOR = SQUARESPACE_PAGE_SECTION_SELECTOR;
const BLOCK_SELECTOR = "[data-block-type]";
const SITE_FRAME_SELECTOR = 'iframe#sqs-site-frame[data-testid="sqs-site-frame"], iframe#sqs-site-frame';
const SAVE_CONTROL_SELECTORS = [
  '[data-test="frameToolbarSave"]',
  'button:has-text("Save")',
];
const EXIT_CONTROL_SELECTORS = [
  '[data-test="frameToolbarCancel"]',
  'button:has-text("Exit")',
];
const ADD_SECTION_CONTROL_SELECTORS = [
  '[data-test="section-add-button"]',
  'button:has-text("Add Section")',
];
const ADD_BLOCK_CONTROL_SELECTORS = [
  'button:has-text("Add Block")',
  '[aria-label="Add Block"]',
];
const SECTION_SETTINGS_CONTROL_SELECTORS = [
  '[data-test="toolbar-button-settings"]',
  'button[aria-label="Open Section Settings"]',
];

export const addTextSectionInputSchema = z.object({
  website_id: z.string().trim().min(1).describe("ID returned by list_websites for the authenticated Squarespace account."),
  page_id: z.string().trim().min(1).describe("ID returned by list_pages for the selected website."),
  text: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
  background_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
  text_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"),
  confirm_potentially_live_save: z.boolean().default(false).describe(
    "Legacy acknowledgement only. A trusted interactive approval is still required; this value does not authorize a mutation.",
  ),
});

export type AddTextSectionInput = z.infer<typeof addTextSectionInputSchema>;

const nativeTextBlockInputSchema = z.object({
  website_id: z.string().trim().min(1),
  page_id: z.string().trim().min(1),
  section_id: z.string().trim().min(1),
  block_id: z.string().trim().min(1).optional(),
  mode: z.enum(["create", "edit"]),
  text: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
}).strict().superRefine((input, context) => {
  if (input.mode === "edit" && !input.block_id) {
    context.addIssue({ code: "custom", path: ["block_id"], message: "Editing requires the exact existing block ID." });
  }
  if (input.mode === "create" && input.block_id) {
    context.addIssue({ code: "custom", path: ["block_id"], message: "Creating a block cannot accept a caller-supplied block ID." });
  }
});

export type NativeTextBlockInput = z.infer<typeof nativeTextBlockInputSchema>;

export interface NativeTextBlockResult {
  websiteId: string;
  pageId: string;
  sectionId: string;
  blockId: string;
  mode: "create" | "edit";
  text: string;
  saved: true;
  published: false;
  verified: true;
  saveAction: "saved" | "already_saved";
}

type ContentBrowser = Pick<
  SquarespaceBrowserService,
  "getWebsite" | "openWebsiteUrl" | "getCurrentPage"
>;
type ContentPages = Pick<
  SquarespacePagesService,
  "getPageDetails" | "inspectPageSections" | "savePageChanges"
>;
type ContentBackups = Pick<
  PageBackupService,
  "createPageSnapshot" | "verifyFreshSnapshot"
>;

export class SquarespaceContentService {
  constructor(
    private readonly browser: ContentBrowser,
    private readonly pages: ContentPages,
    private readonly backups: ContentBackups,
    private readonly approval: MutationApprovalGuard,
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer in milliseconds.");
    }
  }

  async verifyHomePageTarget(websiteId: string, pageId: string): Promise<void> {
    const website = this.browser.getWebsite(websiteId);
    this.assertConfirmedWebsite(website);
    const homePage = await this.pages.getPageDetails(websiteId, pageId);
    this.assertHomePage(homePage, website, pageId);
  }

  async requestTextSectionApproval(rawInput: unknown): Promise<MutationAuthorization> {
    const input = addTextSectionInputSchema.parse(rawInput);
    const website = this.browser.getWebsite(input.website_id);
    this.assertConfirmedWebsite(website);
    return this.approval.requestApproval(
      textSectionMutationProposal({
        websiteId: input.website_id,
        pageId: input.page_id,
        text: input.text,
      }),
    );
  }

  revokeTextSectionApproval(authorization: MutationAuthorization): void {
    this.approval.revoke(authorization.receipt);
  }

  async addTextSection(
    rawInput: unknown,
    execution?: BrowserExecutionContext,
    authorization?: MutationAuthorization,
  ): Promise<{
    websiteId: string;
    pageId: string;
    text: string;
    backgroundColor: string;
    textColor: string;
    backupSnapshotId: string;
    screenshots: { before: string; after: string };
    saved: true;
    explicitPublishClicked: false;
    verified: true;
    executionMetrics?: ExecutionMetrics;
  }> {
    if (!authorization && !this.approval.hasActiveAuthorization()) {
      throw new MutationApprovalError(
        "unavailable",
        "A valid task-scoped or operation-scoped authorization is required before changing Squarespace content.",
      );
    }
    const ownedController = execution
      ? undefined
      : new ExecutionController({ timeoutMs: 180_000, maxBrowserActions: 100 });
    const context = execution ?? ownedController!;
    try {
      const execute = () => withBrowserExecutionContext(
        context,
        () => this.runAddTextSection(rawInput, context),
      );
      const result = this.approval.hasActiveAuthorization()
        ? await execute()
        : authorization
          ? await this.approval.runAuthorized(authorization.proposal, authorization.receipt, execute)
          : await execute();
      if (!ownedController) return result;
      const executionMetrics = ownedController.finish("succeeded");
      logInfo("content_execution_metrics", executionMetrics);
      return { ...result, executionMetrics };
    } catch (error) {
      const stopped = error instanceof ExecutionStoppedError &&
          context.mutationOutcomeUncertain &&
          !error.mutationOutcomeUncertain
        ? new ExecutionStoppedError(error.reason, true)
        : error;
      if (ownedController) {
        const status = stopped instanceof ExecutionStoppedError
          ? stopped.reason === "cancelled"
            ? "cancelled"
            : stopped.reason === "timed_out"
              ? "timed_out"
              : stopped.reason === "browser_operation_timeout"
                ? "browser_operation_timed_out"
                : stopped.reason === "api_request_timeout"
                  ? "api_request_timed_out"
              : "interrupted"
          : "failed";
        logInfo("content_execution_metrics", ownedController.finish(status));
      }
      throw stopped;
    } finally {
      this.approval.revoke(
        authorization?.proposal.action === "workflow.execute" ? undefined : authorization?.receipt,
      );
    }
  }

  async mutateNativeTextBlock(
    rawInput: unknown,
    execution?: BrowserExecutionContext,
    authorization?: MutationAuthorization,
  ): Promise<NativeTextBlockResult> {
    if (!authorization && !this.approval.hasActiveAuthorization()) {
      throw new MutationApprovalError("unavailable", "A task-scoped authorization is required for native Text Block changes.");
    }
    const input = nativeTextBlockInputSchema.parse(rawInput);
    const proposal = nativeTextBlockMutationProposal({
      websiteId: input.website_id,
      pageId: input.page_id,
      sectionId: input.section_id,
      ...(input.block_id ? { blockId: input.block_id } : {}),
      text: input.text,
      mode: input.mode,
    });
    const operationScope = input.mode === "create" ? "content.block.create" : "content.block.edit";
    const authorizationExpectation = {
      provider: proposal.provider,
      websiteId: input.website_id,
      pageId: input.page_id,
      action: proposal.action,
      targetResource: proposal.targetResource,
      payload: proposal.payload,
    };
    const context: BrowserExecutionContext = execution ?? new ExecutionController({ timeoutMs: 180_000, maxBrowserActions: 100 });
    const ownedController = execution ? undefined : context as ExecutionController;
    let activeEditorFrame: Frame | undefined;
    let activeBlockId = input.block_id ?? "";
    try {
      const run = (): Promise<NativeTextBlockResult> => withBrowserExecutionContext(context, async (): Promise<NativeTextBlockResult> => {
      this.approval.assertAuthorized({ scope: operationScope, ...authorizationExpectation });
      this.approval.assertAuthorized({ scope: "content.save", ...authorizationExpectation });
      const initial = await this.pages.inspectPageSections(input.website_id, input.page_id);
      const targetSections = initial.sections.filter((section) => section.id === input.section_id);
      if (initial.sectionsTruncated || targetSections.length !== 1 || initial.sections.some((section) =>
        section.blocksTruncated || section.textTruncated || section.blocks.some((block) => block.textTruncated))) {
        throw new SquarespaceBrowserError(
          targetSections.length > 1 ? "SECTION_NOT_FOUND" : "WORKFLOW_BASELINE_UNAVAILABLE",
          "The selected section is missing, ambiguous, or truncated; no editor changes were made.",
        );
      }
      const website = this.browser.getWebsite(input.website_id);
      this.assertConfirmedWebsite(website);
      const pageRecord = await this.pages.getPageDetails(input.website_id, input.page_id);
      const targetUrl = this.assertHomePage(pageRecord, website, input.page_id);
      const workflowBaseline = (authorization as MutationAuthorization & {
        baselineFingerprints?: Readonly<Record<string, string>>;
      } | undefined)?.baselineFingerprints?.[`page:${input.page_id}:section:${input.section_id}`];
      if (workflowBaseline) {
        const actualBaseline = createHash("sha256").update(JSON.stringify({
          websiteId: input.website_id,
          pageId: input.page_id,
          url: initial.url,
          sections: initial.sections,
        })).digest("hex");
        if (workflowBaseline !== actualBaseline) {
          throw new SquarespaceBrowserError(
            "WORKFLOW_PLAN_MISMATCH",
            "The page changed after task authorization; replan against the current content before editing.",
          );
        }
      }
      const originalSection = targetSections[0]!;
      const originalSections = initial.sections.map((section) => ({
        ...section,
        headings: [...section.headings],
        blocks: section.blocks.map((block) => ({ ...block })),
      }));
      const originalBlocks = originalSection.blocks.map((block) => ({ ...block }));
      if (originalSection.blocks.some((block) => !block.id)) {
        throw new SquarespaceBrowserError(
          "WORKFLOW_BASELINE_UNAVAILABLE",
          "The section contains a block without a stable ID; safe preservation and duplicate detection are unavailable.",
        );
      }
      const existingBlock = input.mode === "edit"
        ? originalBlocks.find((block) => block.id === input.block_id)
        : undefined;
      if (input.mode === "edit" && !existingBlock) {
        throw new SquarespaceBrowserError("CONTENT_BLOCK_NOT_FOUND", "The requested block is not in the selected section.");
      }
      if (existingBlock && !isNativeTextBlock(existingBlock.type, existingBlock.definitionName)) {
        throw new SquarespaceBrowserError("BLOCK_EDITOR_NOT_AVAILABLE", "The selected block is not identified as a native Text Block.");
      }

      context.startStage("editor_setup");
      // Start from the exact, previously resolved page URL so the editor cannot
      // inherit a page selection left behind by an earlier browser operation.
      const editorUrl = targetUrl;
      context.checkpoint();
      context.beforeBrowserAction();
      await this.browser.openWebsiteUrl(input.website_id, editorUrl, context);
      const page = await this.browser.getCurrentPage();
      await this.assertPageUrl(page, editorUrl);
      await this.clickOne(page.getByRole("button", { name: "Edit", exact: true }), "Edit", context);
      await this.waitForEditor(page, context);
      const frame = await this.findTargetPageFrame(page, targetUrl);
      activeEditorFrame = frame;
      const section = frame.locator(`[data-section-id=${cssAttributeValue(input.section_id)}]`);
      if (await this.inspectCount(section, context) !== 1) {
        throw new SquarespaceBrowserError("SECTION_NOT_FOUND", "The editor does not expose exactly one selected section ID.");
      }
      const initialEditorBlocks = await readEditorBlockIds(section);
      const expectedIds = originalBlocks.map((block) => block.id!).sort();
      if (initialEditorBlocks.slice().sort().join("\u0000") !== expectedIds.join("\u0000")) {
        throw new SquarespaceBrowserError(
          "WORKFLOW_BASELINE_UNAVAILABLE",
          `The editor section differs from the inspected page baseline (expected ${expectedIds.length} identified blocks, observed ${initialEditorBlocks.length}).`,
        );
      }
      const editorBaseline = await readEditorBlockSnapshots(section);
      assertEditorBaseline(editorBaseline, originalBlocks, "The selected editor section differs from the approved content baseline.");
      context.endStage("editor_setup");

      let blockId = input.block_id ?? "";
      let block: Locator;
      if (input.mode === "create") {
        context.startStage("block_creation");
        await section.hover();
        const addBlock = await this.resolveVisibleEnabledControl(section, ADD_BLOCK_CONTROL_SELECTORS, "Add Block", context);
        await this.clickOne(addBlock, "Add Block", context);
        const selector = page.getByRole("region", { name: "Block Selector", exact: true });
        await this.waitForLocator(selector, { state: "visible", timeout: this.timeoutMs }, context);
        const textOption = selector.getByRole("button", { name: "Text", exact: true });
        context.beforeBrowserAction();
        context.markMutationStarted();
        await this.clickOne(textOption, "Text block", context);
        await this.waitForLocator(selector, { state: "hidden", timeout: this.timeoutMs }, context);
        await this.waitForCount(section.locator(BLOCK_SELECTOR), initialEditorBlocks.length + 1, context);
        const afterInsertIds = await readEditorBlockIds(section);
        const inserted = afterInsertIds.filter((id) => !initialEditorBlocks.includes(id));
        if (inserted.length !== 1 || !inserted[0]) {
          throw new SquarespaceBrowserError("CONTENT_BLOCK_AMBIGUOUS", "Squarespace did not expose exactly one new native block ID after insertion.");
        }
        blockId = inserted[0];
        activeBlockId = blockId;
        block = section.locator(`[id=${cssAttributeValue(blockId)}][data-block-type]`);
        if (await this.inspectCount(block, context) !== 1 ||
          !await block.evaluate((element) => {
            const name = `${element.getAttribute("data-block-type") ?? ""} ${element.getAttribute("data-definition-name") ?? ""}`;
            return /(?:^|[.\s_-])text(?:$|[.\s_-])/i.test(name);
          })) {
          throw new SquarespaceBrowserError("BLOCK_EDITOR_NOT_AVAILABLE", "The inserted block is not verifiable as a native Text Block.");
        }
        context.endStage("block_creation");
      } else {
        block = section.locator(`[id=${cssAttributeValue(blockId)}][data-block-type]`);
        if (await this.inspectCount(block, context) !== 1 ||
          !await block.evaluate((element) => isTextDefinition(
            element.getAttribute("data-block-type"),
            element.getAttribute("data-definition-name"),
          ))) {
          throw new SquarespaceBrowserError("CONTENT_BLOCK_AMBIGUOUS", "The selected Text Block ID is not unique in the editor section.");
        }
      }

      context.startStage("text_entry");
      await this.clickOne(block, "Text block", context);
      await this.clickOne(block.getByRole("button", { name: "Write", exact: true }), "Write", context);
      const editableCandidates = block.locator('[contenteditable="true"], [role="textbox"], textarea');
      if (await this.inspectCount(editableCandidates, context) !== 1) {
        throw new SquarespaceBrowserError("BLOCK_EDITOR_NOT_AVAILABLE", "The Text Block editor did not expose exactly one editable text control.");
      }
      const editable = editableCandidates;
      await this.waitForLocator(editable, { state: "visible", timeout: this.timeoutMs }, context);
      context.beforeBrowserAction();
      context.markMutationStarted();
      const fillOperation = editable.fill(input.text, {
        timeout: Math.max(1, Math.min(this.timeoutMs, context.remainingMs)),
      });
      try {
        await awaitPlaywrightOperation(fillOperation, context);
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          context.checkpoint();
          throw new ExecutionStoppedError("browser_operation_timeout", true);
        }
        throw error;
      }
      const enteredText = await editable.evaluate((element) =>
        "value" in element ? String((element as HTMLInputElement).value) : (element as HTMLElement).innerText.trim());
      if (enteredText !== input.text) {
        throw new SquarespaceBrowserError("TEXT_SECTION_VERIFICATION_FAILED", "The editor did not retain the exact requested text.");
      }
      context.endStage("text_entry");

      const beforeSaveEditorState = await readEditorBlockSnapshots(section);
      assertEditorMutationMatches(beforeSaveEditorState, editorBaseline, blockId, input.text, input.mode);
      const beforeSavePageState = await readEditorPageSections(frame);
      assertEditorPageMutationMatches(beforeSavePageState, originalSections, input.section_id, blockId, input.text, input.mode);

      context.startStage("save");
      const save = await this.pages.savePageChanges(input.website_id, false, undefined, context, {
        pageId: input.page_id,
        action: proposal.action,
        targetResource: proposal.targetResource,
        payload: proposal.payload,
      });
      if (save.published || save.action === "published" || !save.saved) {
        throw new SquarespaceBrowserError("PAGE_SAVE_FAILED", "Squarespace did not confirm a draft Save without publishing.");
      }
      context.endStage("save");

      context.startStage("result_verification");
      const final = await this.pages.inspectPageSections(input.website_id, input.page_id);
      const finalSections = final.sections.filter((candidate) => candidate.id === input.section_id);
      const finalSection = finalSections[0];
      const finalBlocks = finalSection?.blocks.filter((candidate) => candidate.id === blockId) ?? [];
      if (final.websiteId !== input.website_id || final.pageId !== input.page_id || final.url !== initial.url ||
        final.sectionsTruncated || final.sections.length !== originalSections.length ||
        final.sections.some((section, index) => section.id !== originalSections[index]?.id) ||
        finalSections.length !== 1 || finalBlocks.length !== 1 ||
        finalBlocks[0]!.visibleText.trim() !== input.text || finalBlocks[0]!.textTruncated ||
        !isNativeTextBlock(finalBlocks[0]!.type, finalBlocks[0]!.definitionName)) {
        throw new SquarespaceBrowserError("TEXT_SECTION_VERIFICATION_FAILED", "Fresh page inspection did not confirm the saved Text Block and exact content.");
      }
      for (const beforeSection of originalSections) {
        const afterSection = final.sections.find((candidate) => candidate.id === beforeSection.id);
        if (!afterSection) {
          throw new SquarespaceBrowserError("TEXT_SECTION_VERIFICATION_FAILED", "Save changed or removed an unrelated page section.");
        }
        if (beforeSection.id !== input.section_id && JSON.stringify(afterSection) !== JSON.stringify(beforeSection)) {
          throw new SquarespaceBrowserError("TEXT_SECTION_VERIFICATION_FAILED", "Save changed unrelated page content.");
        }
      }
      if (input.mode === "edit") {
        const unchanged = originalBlocks.filter((candidate) => candidate.id !== blockId);
        if (finalSection!.blocks.length !== originalBlocks.length ||
          finalSection!.blocks.map((block) => block.id).join("\u0000") !== originalBlocks.map((block) => block.id).join("\u0000") ||
          unchanged.some((before) => {
          const after = finalSection!.blocks.find((candidate) => candidate.id === before.id);
          return !after || after.type !== before.type || after.definitionName !== before.definitionName || after.visibleText !== before.visibleText;
        })) {
          throw new SquarespaceBrowserError("TEXT_SECTION_VERIFICATION_FAILED", "Editing the Text Block changed unrelated section content.");
        }
      } else {
        const newBlockIds = finalSection!.blocks.map((candidate) => candidate.id).filter(Boolean);
        if (finalSection!.blocks.length !== originalBlocks.length + 1 ||
          originalBlocks.some((before) => !newBlockIds.includes(before.id)) ||
          finalSection!.blocks.filter((candidate) => candidate.id !== blockId).map((candidate) => candidate.id).join("\u0000") !==
            originalBlocks.map((candidate) => candidate.id).join("\u0000")) {
          throw new SquarespaceBrowserError("TEXT_SECTION_VERIFICATION_FAILED", "Creating the Text Block changed unrelated section content.");
        }
      }
      context.endStage("result_verification");
      context.markMutationVerified();
      const result = {
        websiteId: input.website_id,
        pageId: input.page_id,
        sectionId: input.section_id,
        blockId,
        mode: input.mode,
        text: input.text,
        saved: true as const,
        published: false as const,
        verified: true as const,
        saveAction: save.action as "saved" | "already_saved",
      };
      ownedController?.finish("succeeded");
      return result;
      });
      return await (authorization && !this.approval.hasActiveAuthorization()
        ? this.approval.runAuthorized(authorization.proposal, authorization.receipt, run)
        : run());
    } catch (error) {
      if (ownedController) ownedController.finish(error instanceof ExecutionStoppedError ? "interrupted" : "failed");
      if (context.mutationOutcomeUncertain && !(error instanceof ExecutionStoppedError && error.mutationOutcomeUncertain)) {
        let observedEditorTarget = "editor state could not be re-inspected";
        if (activeEditorFrame) {
          try {
            const sections = await readEditorPageSections(activeEditorFrame);
            const section = sections.find((candidate) => candidate.id === input.section_id);
            const target = section?.blocks.filter((candidate) => candidate.id === activeBlockId) ?? [];
            observedEditorTarget = target.length === 1
              ? `editor re-inspection observed target ${target[0]!.id} with text length ${target[0]!.text.length}`
              : "editor re-inspection could not uniquely identify the target block";
          } catch {
            // Keep the operation uncertain if browser/editor inspection is unavailable.
          }
        }
        throw new SquarespaceBrowserError(
          "OUTCOME_UNCERTAIN",
          `The Text Block operation may have partially changed the editor or CMS. Its outcome is uncertain; ${observedEditorTarget}. Do not retry until the page and editor state are reviewed.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (ownedController) {
        this.approval.revoke(
          authorization?.proposal.action === "workflow.execute" ? undefined : authorization?.receipt,
        );
      }
    }
  }

  private async runAddTextSection(
    rawInput: unknown,
    execution: BrowserExecutionContext,
  ): Promise<{
    websiteId: string;
    pageId: string;
    text: string;
    backgroundColor: string;
    textColor: string;
    backupSnapshotId: string;
    screenshots: { before: string; after: string };
    saved: true;
    explicitPublishClicked: false;
    verified: true;
  }> {
    const input = addTextSectionInputSchema.parse(rawInput);
    const proposalInput = textSectionMutationProposal({
      websiteId: input.website_id,
      pageId: input.page_id,
      text: input.text,
      backgroundColor: input.background_color,
      textColor: input.text_color,
    });
    this.approval.assertAuthorized({
      scope: "content.section.create",
      provider: proposalInput.provider,
      websiteId: input.website_id,
      pageId: input.page_id,
      action: proposalInput.action,
      targetResource: proposalInput.targetResource,
      payload: textSectionMutationPayload(input.text, input.background_color, input.text_color),
    });
    const website = this.browser.getWebsite(input.website_id);
    this.assertConfirmedWebsite(website);
    execution?.startStage("website_verification");
    execution?.recordDomInspection();
    const homePage = await this.pages.getPageDetails(input.website_id, input.page_id);
    const homeUrl = this.assertHomePage(homePage, website, input.page_id);
    execution?.endStage("website_verification");

    const backupStartedAt = new Date();
    execution?.startStage("backup");
    const createdBackup = await this.backups.createPageSnapshot(
      input.website_id,
      input.page_id,
    );
    const backup = await this.backups.verifyFreshSnapshot(
      createdBackup.snapshotId,
      input.website_id,
      input.page_id,
      backupStartedAt,
    );
    this.assertSnapshotMatchesHome(backup, website, homePage, homeUrl);
    execution?.recordScreenshot(
      backup.screenshots.filter((screenshot) => screenshot.status === "captured").length,
    );
    execution?.endStage("backup");

    const editorUrl = new URL("/config/website", website.url).toString();
    execution?.startStage("editor_setup");
    execution?.checkpoint();
    execution?.beforeBrowserAction();
    await this.browser.openWebsiteUrl(input.website_id, editorUrl, execution);
    const page = await this.browser.getCurrentPage();
    await this.assertPageUrl(page, editorUrl);
    execution?.recordDomInspection();
    await this.assertPublishedHomePreview(page);
    await this.clickOne(
      page.getByRole("button", { name: "Edit", exact: true }),
      "Edit",
      execution,
    );
    await this.waitForEditor(page, execution);
    execution?.endStage("editor_setup");

    execution?.startStage("section_creation");
    execution?.recordDomInspection();
    const frame = await this.findHomeFrame(page, homeUrl);
    const sectionsBefore = frame.locator(SECTION_SELECTOR);
    const initialSectionCount = await this.inspectCount(sectionsBefore, execution);
    execution?.recordDomInspection();
    const observedSectionIds = await sectionsBefore.evaluateAll((sections) =>
      sections.map((section) => section.getAttribute("data-section-id")),
    );
    const backupSectionIds = backup.sections.map((section) => section.id);
    const observedStartsAt = backupSectionIds.length - observedSectionIds.length;
    const observedMatchesFullBackup =
      observedSectionIds.length === backupSectionIds.length &&
      observedSectionIds.every((sectionId, index) => sectionId === backupSectionIds[index]);
    const observedMatchesBackupSuffix =
      observedSectionIds.length > 0 &&
      observedStartsAt >= 0 &&
      observedSectionIds.every((sectionId, index) =>
        sectionId !== null && sectionId === backupSectionIds[observedStartsAt + index]);
    if (
      backupSectionIds.some((sectionId) => sectionId === null) ||
      (!observedMatchesFullBackup && !observedMatchesBackupSuffix)
    ) {
      throw this.editorError(
        "The rendered Home sections do not match the fresh backup; no page content was changed.",
      );
    }
    execution?.beforeBrowserAction();
    await frame.locator("body").press("End");
    execution?.recordDomInspection();
    const addSectionButton = await this.resolveVisibleEnabledControl(
      page,
      ADD_SECTION_CONTROL_SELECTORS,
      "Add Section",
      execution,
    );
    await this.clickOne(addSectionButton, "Add Section", execution);
    const sectionDialog = page.getByRole("dialog", { name: "Add a Section", exact: true });
    await this.waitForLocator(sectionDialog, { state: "visible", timeout: this.timeoutMs }, execution);
    const addBlank = sectionDialog.getByText("Add Blank", { exact: true });
    await this.clickOne(addBlank, "Add Blank", execution);
    await this.waitForLocator(sectionDialog, { state: "hidden", timeout: this.timeoutMs }, execution);
    await this.waitForCount(frame.locator(SECTION_SELECTOR), initialSectionCount + 1, execution);
    const newSection = frame.locator(SECTION_SELECTOR).last();
    const newSectionTextCells = newSection.getByRole("gridcell", {
      name: "Text",
      exact: true,
    });
    if ((await this.inspectCount(newSectionTextCells, execution)) !== 0) {
      throw this.editorError("The new blank section was not empty before adding its Text block.");
    }
    execution?.beforeBrowserAction();
    await newSection.hover();
    const addBlockButton = await this.resolveVisibleEnabledControl(
      page,
      ADD_BLOCK_CONTROL_SELECTORS,
      "Add Block",
      execution,
    );
    await this.clickOne(addBlockButton, "Add Block", execution);
    const blockSelector = page.getByRole("region", { name: "Block Selector", exact: true });
    await this.waitForLocator(blockSelector, { state: "visible", timeout: this.timeoutMs }, execution);
    await this.clickOne(
      blockSelector.getByRole("button", { name: "Text", exact: true }),
      "Text block",
      execution,
    );
    await this.waitForLocator(blockSelector, { state: "hidden", timeout: this.timeoutMs }, execution);
    await this.waitForCount(newSectionTextCells, 1, execution);
    const newTextCell = newSectionTextCells.last();
    execution?.beforeBrowserAction();
    await newTextCell.click();
    await this.clickOne(page.getByRole("button", { name: "Write", exact: true }), "Write", execution);
    const editableText = newTextCell.getByRole("textbox");
    await this.waitForLocator(editableText, { state: "visible", timeout: this.timeoutMs }, execution);
    execution?.beforeBrowserAction();
    await editableText.fill(input.text);
    execution?.beforeBrowserAction();
    await editableText.press("Control+A");
    execution?.endStage("section_creation");

    execution?.startStage("block_creation");
    await this.applyBlackTextColor(page, execution);
    execution?.endStage("block_creation");

    execution?.startStage("style_application");
    execution?.beforeBrowserAction();
    await newSection.hover();
    await this.openSectionSettings(page, execution);
    await this.selectWhiteSectionTheme(page, execution);
    await this.assertSectionColors(newSection, input.text, execution);
    execution?.endStage("style_application");

    execution?.startStage("save");
    execution?.checkpoint();
    this.approval.assertAuthorized({
      scope: "content.save",
      provider: proposalInput.provider,
      websiteId: input.website_id,
      pageId: input.page_id,
      action: proposalInput.action,
      targetResource: proposalInput.targetResource,
      payload: textSectionMutationPayload(input.text),
    });
    const saveResult = await this.pages.savePageChanges(
      input.website_id,
      false,
      undefined,
      execution,
      {
        pageId: input.page_id,
        action: proposalInput.action,
        targetResource: proposalInput.targetResource,
        payload: textSectionMutationPayload(input.text),
      },
    );
    execution?.checkpoint();
    execution?.endStage("save");
    if (saveResult.published) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_VERIFICATION_FAILED",
        "Squarespace reported that the operation published changes; no further editor actions were taken.",
      );
    }
    execution?.startStage("result_verification");
    execution?.recordDomInspection();
    const after = await this.pages.inspectPageSections(input.website_id, input.page_id);
    const lastSection = after.sections.at(-1);
    if (
      after.url !== homeUrl ||
      after.sections.length !== backup.sections.length + 1 ||
      !lastSection?.visibleText.includes(input.text) ||
      !lastSection.blocks.some((block) => block.visibleText.trim() === input.text)
    ) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_VERIFICATION_FAILED",
        "Squarespace did not expose the saved text block in the new bottom Home section.",
      );
    }
    const renderedPage = await this.browser.getCurrentPage();
    const renderedFrame = await this.findHomeFrame(renderedPage, homeUrl);
    await this.assertSectionColors(
      renderedFrame.locator(SECTION_SELECTOR).last(),
      input.text,
      execution,
    );
    execution?.endStage("result_verification");
    execution?.markMutationVerified();

    return {
      websiteId: input.website_id,
      pageId: input.page_id,
      text: input.text,
      backgroundColor: input.background_color,
      textColor: input.text_color,
      backupSnapshotId: backup.snapshotId,
      screenshots: saveResult.screenshots,
      saved: true,
      explicitPublishClicked: false,
      verified: true,
    };
  }

  private assertConfirmedWebsite(website: WebsiteSummary): void {
    let url: URL;
    try { url = new URL(website.url); } catch {
      throw new SquarespaceBrowserError("TEXT_SECTION_TARGET_MISMATCH", "Target website URL is invalid.");
    }
    if (url.protocol !== "https:") {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_TARGET_MISMATCH",
        "Target website must be a verified HTTPS site from the authenticated Squarespace account.",
      );
    }
  }

  assertHomePage(
    page: SquarespacePage,
    website: WebsiteSummary,
    expectedPageId: string,
  ): string {
    if (
      page.id !== expectedPageId ||
      page.type !== "page" ||
      !page.url
    ) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_TARGET_MISMATCH",
        "The selected page ID is not a page on the selected website.",
      );
    }
    const target = new URL(page.url);
    const origin = new URL(website.url).origin;
    if (
      target.origin !== origin ||
      page.websiteId !== website.id
    ) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_TARGET_MISMATCH",
        "The selected page URL does not belong to the selected website.",
      );
    }
    target.search = "";
    target.hash = "";
    return target.toString();
  }

  private assertSnapshotMatchesHome(
    snapshot: PageSnapshot,
    website: WebsiteSummary,
    homePage: SquarespacePage,
    homeUrl: string,
  ): void {
    if (
      new URL(snapshot.website.url).origin !== new URL(website.url).origin ||
      snapshot.page.id !== homePage.id ||
      snapshot.page.websiteId !== website.id ||
      snapshot.page.websiteId !== website.id ||
      snapshot.pageUrl !== homeUrl ||
      !snapshot.screenshots.some((screenshot) =>
        screenshot.kind === "full_page" && screenshot.status === "captured")
    ) {
      throw new SquarespaceBrowserError(
        "SNAPSHOT_VERIFICATION_FAILED",
        "The verified backup does not match the selected website and page.",
      );
    }
  }

  private async findTargetPageFrame(page: Page, targetUrl: string): Promise<Frame> {
    const target = new URL(targetUrl);
    const matchesTarget = (candidate: Frame): boolean => {
      try {
        const actual = new URL(candidate.url());
        return actual.origin === target.origin && normalizePath(actual.pathname) === normalizePath(target.pathname);
      } catch {
        return false;
      }
    };
    const siteFrame = page.locator(SITE_FRAME_SELECTOR);
    const siteFrameCount = await this.inspectCount(siteFrame);
    if (siteFrameCount > 1) {
      throw new SquarespaceBrowserError("TEXT_SECTION_TARGET_MISMATCH", "Multiple site editor frames are present; page identity is ambiguous.");
    }
    if (siteFrameCount === 1) {
      const element = await siteFrame.elementHandle();
      const frame = element ? await element.contentFrame() : null;
      if (frame && matchesTarget(frame) && await frame.locator(SECTION_SELECTOR).count() > 0) return frame;
    }
    const matchingFrames = page.frames().filter(matchesTarget);
    if (matchingFrames.length !== 1 || await matchingFrames[0]!.locator(SECTION_SELECTOR).count() === 0) {
      throw new SquarespaceBrowserError("SECTIONS_NOT_AVAILABLE", "The editor did not expose the exact inspected page URL.");
    }
    return matchingFrames[0]!;
  }

  private async assertPageUrl(page: Page, expectedUrl: string): Promise<void> {
    const actual = new URL(page.url());
    const expected = new URL(expectedUrl);
    if (actual.origin !== expected.origin || normalizePath(actual.pathname) !== normalizePath(expected.pathname)) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_TARGET_MISMATCH",
        "The current browser page is not on the confirmed Squarespace website.",
      );
    }
  }

  private async assertPublishedHomePreview(page: Page): Promise<void> {
    try {
      const publishedPreview = page.getByText(/Page\s*.?\s*Published/i).first();
      await publishedPreview.waitFor({ state: "visible", timeout: Math.min(3000, this.timeoutMs) });
    } catch {
      // Editor preview may not have the published banner or is already in edit view
    }
  }

  private async waitForEditor(
    page: Page,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    await this.resolveVisibleEnabledControl(page, SAVE_CONTROL_SELECTORS, "Save", execution);
    await this.resolveVisibleEnabledControl(page, EXIT_CONTROL_SELECTORS, "Exit", execution);
    execution?.recordDomInspection();
    await this.assertPublishedHomePreview(page);
  }

  private async findHomeFrame(page: Page, homeUrl: string): Promise<Frame> {
    const target = new URL(homeUrl);
    const siteFrameElement = page.locator(SITE_FRAME_SELECTOR).first();
    if ((await this.inspectCount(siteFrameElement)) > 0) {
      const siteFrame = await siteFrameElement.elementHandle();
      const contentFrame = siteFrame ? await siteFrame.contentFrame() : null;
      if (contentFrame) {
        const frameUrl = new URL(contentFrame.url());
        if (frameUrl.origin === target.origin) {
          const sectionCount = await contentFrame.locator(SECTION_SELECTOR).count();
          if (sectionCount > 0) {
            return contentFrame;
          }
        }
      }
    }

    const frame = page.frames().find((candidate) => {
      try {
        const url = new URL(candidate.url());
        return url.origin === target.origin;
      } catch {
        return false;
      }
    });
    if (!frame || (await frame.locator(SECTION_SELECTOR).count()) === 0) {
      throw this.editorError("The page editor frame could not be verified.");
    }
    return frame;
  }

  private async resolveVisibleEnabledControl(
    scope: Page | Locator,
    selectors: string[],
    controlName: string,
    execution?: BrowserExecutionContext,
  ): Promise<Locator> {
    const control = scope.locator(selectors.map((selector) => `${selector}:visible`).join(","));
    const count = await this.inspectCount(control, execution);
    if (count !== 1 || !(await control.isEnabled())) {
      throw this.editorError(`The selected editor scope did not expose exactly one enabled ${controlName} control (found ${count}).`);
    }
    return control;
  }

  private async applyBlackTextColor(
    page: Page,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    await this.clickOne(
      page.getByRole("button", { name: "Text Color", exact: true }),
      "Text Color",
      execution,
    );
    await this.clickOne(
      page.getByRole("tab", { name: "Custom", exact: true }),
      "Custom color",
      execution,
    );
    const hex = page.getByRole("spinbutton", { name: "Hex", exact: true });
    if ((await this.inspectCount(hex, execution)) !== 1) {
      throw this.editorError("The Text Color picker did not expose one Hex field.");
    }
    execution?.beforeBrowserAction();
    await hex.fill("#000000");
    execution?.beforeBrowserAction();
    await hex.press("Enter");
    execution?.beforeBrowserAction();
    await page.keyboard.press("Escape");
  }

  private async openSectionSettings(
    page: Page,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    const settings = await this.resolveVisibleEnabledControl(
      page,
      SECTION_SETTINGS_CONTROL_SELECTORS,
      "Open Section Settings",
      execution,
    );
    await this.clickOne(settings, "Open Section Settings", execution);
    await this.waitForLocator(
      page.getByRole("dialog", { name: "Section editor form", exact: true }),
      { state: "visible", timeout: this.timeoutMs },
      execution,
    );
  }

  private async selectWhiteSectionTheme(
    page: Page,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    await this.clickOne(
      page.getByRole("tab", { name: "Colors", exact: true }),
      "Section Colors",
      execution,
    );
    await this.clickOne(
      page.getByRole("button", { name: "Aa Light 1", exact: true }),
      "Aa Light 1",
      execution,
    );
    execution?.beforeBrowserAction();
    await page.keyboard.press("Escape");
    await this.waitForLocator(
      page.getByRole("dialog", { name: "Section editor form", exact: true }),
      { state: "hidden", timeout: this.timeoutMs },
      execution,
    );
  }

  private async assertSectionColors(
    section: Locator,
    text: string,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    execution?.recordDomInspection();
    const result = await section.evaluate((element, args) => {
      const block = Array.from(element.querySelectorAll<HTMLElement>(args.blockSelector))
        .find((candidate) => (candidate.innerText || "").includes(args.expectedText));
      const textElement = block?.querySelector<HTMLElement>("p,h1,h2,h3,h4,h5,h6,span");
      return {
        background: getComputedStyle(element).backgroundColor,
        text: textElement ? getComputedStyle(textElement).color : null,
        blockText: (block?.innerText || "").trim(),
      };
    }, { blockSelector: BLOCK_SELECTOR, expectedText: text });
    if (!result.blockText && !result.blockText.includes(text)) {
      throw new SquarespaceBrowserError(
        "TEXT_SECTION_VERIFICATION_FAILED",
        "The section does not contain the expected text block.",
      );
    }
  }

  private async waitForCount(
    locator: Locator,
    expectedCount: number,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    try {
      if (expectedCount > 0) {
        await this.waitForLocator(
          locator.nth(expectedCount - 1),
          { state: "attached", timeout: this.timeoutMs },
          execution,
        );
      }
      const observedCount = await this.inspectCount(locator, execution);
      if (observedCount !== expectedCount) {
        throw this.editorError(`Squarespace exposed ${observedCount} sections or Text blocks; expected ${expectedCount}.`);
      }
    } catch (error) {
      if (error instanceof ExecutionStoppedError) throw error;
      if (error instanceof SquarespaceBrowserError) throw error;
      throw this.editorError("Squarespace did not create the expected section or Text block.");
    }
  }

  private async clickOne(
    locator: Locator,
    label: string,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    execution?.recordDomInspection();
    execution?.checkpoint();
    if ((await locator.count()) !== 1 || !(await locator.isVisible()) || !(await locator.isEnabled())) {
      throw this.editorError(`Squarespace did not expose one visible, enabled ${label} control.`);
    }
    execution?.beforeBrowserAction();
    const click = locator.click({
      timeout: Math.max(
        1,
        Math.min(this.timeoutMs, execution?.remainingMs ?? this.timeoutMs),
      ),
    });
    if (execution) {
      try {
        await awaitPlaywrightOperation(click, execution);
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          execution.checkpoint();
          throw new ExecutionStoppedError("browser_operation_timeout");
        }
        throw error;
      }
    } else {
      await click;
    }
  }

  private async inspectCount(locator: Locator, execution?: BrowserExecutionContext): Promise<number> {
    execution?.recordDomInspection();
    return locator.count();
  }

  private async waitForLocator(
    locator: Locator,
    options: { state: "attached" | "detached" | "visible" | "hidden"; timeout: number },
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      execution?.checkpoint();
      if (!execution) {
        await locator.waitFor(options);
        return;
      }
      await waitForExecutionCondition(
        async () => {
          if (options.state === "visible") return locator.isVisible();
          const count = await locator.count();
          return options.state === "hidden" || options.state === "detached"
            ? count === 0
            : count > 0;
        },
        Boolean,
        execution,
        options.timeout,
      );
    } finally {
      execution?.recordExplicitWait(Date.now() - startedAt);
    }
  }

  private editorError(message: string): SquarespaceBrowserError {
    return new SquarespaceBrowserError("TEXT_SECTION_EDITOR_UNAVAILABLE", message);
  }
}

function cssAttributeValue(value: string): string {
  return JSON.stringify(value);
}

function normalizePath(path: string): string {
  return path === "/" ? "/" : `/${path.replace(/^\/+|\/+$/g, "")}`;
}

async function readEditorBlockIds(section: Locator): Promise<string[]> {
  const ids = await section.locator(BLOCK_SELECTOR).evaluateAll((blocks) =>
    blocks.map((block) => block.getAttribute("id")),
  );
  if (ids.some((id) => !id)) {
    throw new SquarespaceBrowserError(
      "WORKFLOW_BASELINE_UNAVAILABLE",
      "The rendered section contains a block without a stable native ID.",
    );
  }
  return ids as string[];
}

interface EditorBlockSnapshot {
  id: string;
  type: string | null;
  definitionName: string | null;
  text: string;
}

async function readEditorBlockSnapshots(section: Locator): Promise<EditorBlockSnapshot[]> {
  const blocks = await section.locator(BLOCK_SELECTOR).evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute("id") ?? "",
      type: element.getAttribute("data-block-type"),
      definitionName: element.getAttribute("data-definition-name"),
      text: (element as HTMLElement).innerText.trim(),
    })),
  );
  if (blocks.some((block) => !block.id) || new Set(blocks.map((block) => block.id)).size !== blocks.length) {
    throw new SquarespaceBrowserError(
      "WORKFLOW_BASELINE_UNAVAILABLE",
      "The editor section contains missing or duplicate block IDs; safe baseline validation is unavailable.",
    );
  }
  return blocks;
}

async function readEditorPageSections(frame: Frame): Promise<Array<{ id: string; blocks: EditorBlockSnapshot[] }>> {
  const sections = await frame.locator(SECTION_SELECTOR).evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute("data-section-id") ?? "",
      blocks: Array.from(element.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).map((block) => ({
        id: block.getAttribute("id") ?? "",
        type: block.getAttribute("data-block-type"),
        definitionName: block.getAttribute("data-definition-name"),
        text: block.innerText.trim(),
      })),
    })),
  );
  if (sections.some((section) => !section.id || section.blocks.some((block) => !block.id)) ||
    new Set(sections.map((section) => section.id)).size !== sections.length) {
    throw new SquarespaceBrowserError("WORKFLOW_BASELINE_UNAVAILABLE", "The editor page no longer exposes stable section and block identifiers.");
  }
  return sections;
}

function assertEditorPageMutationMatches(
  actual: Array<{ id: string; blocks: EditorBlockSnapshot[] }>,
  baseline: Array<{ id: string | null; blocks: Array<{ id: string | null; type: string | null; definitionName?: string | null; visibleText: string }> }>,
  targetSectionId: string,
  targetBlockId: string,
  expectedText: string,
  mode: "create" | "edit",
): void {
  if (actual.length !== baseline.length || baseline.some((section) => {
    if (!section.id) return true;
    const current = actual.find((candidate) => candidate.id === section.id);
    if (!current) return true;
    const targetSection = section.id === targetSectionId;
    const originalBlocks = section.blocks;
    if (!targetSection) {
      return current.blocks.length !== originalBlocks.length || originalBlocks.some((before) => {
        const after = current.blocks.find((block) => block.id === before.id);
        return !after || after.type !== before.type || after.definitionName !== (before.definitionName ?? null) ||
          after.text !== before.visibleText.trim();
      });
    }
    const target = current.blocks.filter((block) => block.id === targetBlockId);
    if (target.length !== 1 || !isNativeTextBlock(target[0]!.type, target[0]!.definitionName) || target[0]!.text !== expectedText) return true;
    const unchanged = originalBlocks.filter((block) => mode === "create" || block.id !== targetBlockId);
    return current.blocks.length !== unchanged.length + 1 || unchanged.some((before) => {
      const after = current.blocks.find((block) => block.id === before.id);
      return !after || after.type !== before.type || after.definitionName !== (before.definitionName ?? null) ||
        after.text !== before.visibleText.trim();
    });
  })) {
    throw new SquarespaceBrowserError("WORKFLOW_PLAN_MISMATCH", "Page content changed after authorization; no Save was attempted.");
  }
}

function assertEditorBaseline(
  actual: EditorBlockSnapshot[],
  expected: Array<{ id?: string | null; type: string | null; definitionName?: string | null; visibleText: string }>,
  message: string,
): void {
  if (actual.length !== expected.length || expected.some((before) => {
    const current = actual.find((block) => block.id === before.id);
    return !current || current.type !== before.type ||
      current.definitionName !== (before.definitionName ?? null) || current.text !== before.visibleText.trim();
  })) {
    throw new SquarespaceBrowserError("WORKFLOW_PLAN_MISMATCH", message);
  }
}

function assertEditorMutationMatches(
  actual: EditorBlockSnapshot[],
  baseline: EditorBlockSnapshot[],
  targetBlockId: string,
  expectedText: string,
  mode: "create" | "edit",
): void {
  const target = actual.filter((block) => block.id === targetBlockId);
  if (target.length !== 1 || !isNativeTextBlock(target[0]!.type, target[0]!.definitionName) || target[0]!.text !== expectedText) {
    throw new SquarespaceBrowserError("WORKFLOW_PLAN_MISMATCH", "The intended native Text Block changed before Save.");
  }
  const expectedUnchanged = baseline.filter((block) => mode === "create" || block.id !== targetBlockId);
  if (actual.length !== expectedUnchanged.length + 1 || expectedUnchanged.some((before) => {
    const after = actual.find((block) => block.id === before.id);
    return !after || after.type !== before.type || after.definitionName !== before.definitionName || after.text !== before.text;
  })) {
    throw new SquarespaceBrowserError("WORKFLOW_PLAN_MISMATCH", "Unrelated section content changed before Save; the operation was stopped.");
  }
}

function isNativeTextBlock(type: string | null, definitionName: string | null | undefined): boolean {
  return isTextDefinition(type, definitionName);
}

function isTextDefinition(type: string | null, definitionName: string | null | undefined): boolean {
  return /(?:^|[.\s_-])text(?:$|[.\s_-])/i.test(`${type ?? ""} ${definitionName ?? ""}`);
}
