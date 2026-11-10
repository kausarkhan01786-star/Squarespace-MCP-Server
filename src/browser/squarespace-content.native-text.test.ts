import assert from "node:assert/strict";
import test from "node:test";
import {
  MutationApprovalError,
  MutationApprovalGuard,
  type MutationAuthorization,
} from "../approval/mutation-approval.js";
import { nativeTextBlockMutationProposal } from "../approval/squarespace-mutation-proposals.js";
import { SquarespaceContentService } from "./squarespace-content.service.js";
import type { WebsiteSummary } from "./squarespace-browser.service.js";
import { SquarespaceBrowserError } from "./browser-errors.js";

const website: WebsiteSummary = {
  id: "fixture-site",
  name: "Fixture",
  url: "https://fixture.squarespace.com",
};

function createService(guard: MutationApprovalGuard, browserCalls: string[]) {
  return new SquarespaceContentService(
    {
      getWebsite: () => { browserCalls.push("getWebsite"); return website; },
      openWebsiteUrl: async () => { browserCalls.push("openWebsiteUrl"); },
      getCurrentPage: async () => { browserCalls.push("getCurrentPage"); throw new Error("No browser interaction expected."); },
    } as never,
    {
      getPageDetails: async () => { browserCalls.push("getPageDetails"); throw new Error("No page read expected."); },
      inspectPageSections: async () => { browserCalls.push("inspectPageSections"); throw new Error("No section read expected."); },
      savePageChanges: async () => { browserCalls.push("savePageChanges"); throw new Error("No save expected."); },
    } as never,
    {} as never,
    guard,
  );
}

async function requestAuthorization(mode: "create" | "edit", sectionId = "section-1", blockId?: string) {
  const guard = new MutationApprovalGuard({ requestApproval: async () => true });
  const authorization = await guard.requestApproval(nativeTextBlockMutationProposal({
    websiteId: website.id,
    pageId: "page-1",
    sectionId,
    ...(blockId ? { blockId } : {}),
    text: "New copy",
    mode,
  }));
  return { guard, authorization };
}

test("native Text Block authorization binds operation, exact section, and text", async () => {
  const create = nativeTextBlockMutationProposal({
    websiteId: website.id,
    pageId: "page-1",
    sectionId: "section-1",
    text: "New copy",
    mode: "create",
  });
  assert.equal(create.action, "content.create_text_block");
  assert.equal(create.targetResource, "page:page-1:section:section-1:new-text-block");
  assert.deepEqual(create.permissionScopes, ["content.block.create", "content.save"]);
  assert.equal(create.payload.sectionId, "section-1");
  assert.equal(create.payload.text, "New copy");
  assert.equal(create.payload.publish, false);

  const edit = nativeTextBlockMutationProposal({
    websiteId: website.id,
    pageId: "page-1",
    sectionId: "section-1",
    blockId: "native-block-1",
    text: "Edited copy",
    mode: "edit",
  });
  assert.equal(edit.action, "content.edit_text_block");
  assert.equal(edit.targetResource, "page:page-1:section:section-1:block:native-block-1");
  assert.equal(edit.payload.blockId, "native-block-1");
  assert.deepEqual(edit.permissionScopes, ["content.block.edit", "content.save"]);
});

test("native Text Block mutation fails before browser access without task authorization", async () => {
  const guard = new MutationApprovalGuard({ requestApproval: async () => true });
  const calls: string[] = [];
  const service = createService(guard, calls);
  await assert.rejects(
    service.mutateNativeTextBlock({
      website_id: website.id,
      page_id: "page-1",
      section_id: "section-1",
      mode: "create",
      text: "New copy",
    }),
    (error: unknown) => error instanceof MutationApprovalError && error.reason === "unavailable",
  );
  assert.deepEqual(calls, []);
});

test("authorization for one section or block cannot be reused for another target", async () => {
  const { guard, authorization }: { guard: MutationApprovalGuard; authorization: MutationAuthorization } =
    await requestAuthorization("edit", "section-1", "native-block-1");
  const calls: string[] = [];
  const service = createService(guard, calls);
  await assert.rejects(
    service.mutateNativeTextBlock({
      website_id: website.id,
      page_id: "page-1",
      section_id: "section-2",
      block_id: "native-block-1",
      mode: "edit",
      text: "New copy",
    }, undefined, authorization),
    { reason: "scope_mismatch" },
  );
  assert.deepEqual(calls, []);
});

interface MockOptions {
  mode?: "create" | "edit";
  addCount?: number;
  writeCount?: number;
  pageMismatch?: boolean;
  wrongSection?: boolean;
  wrongType?: boolean;
  saveResult?: { saved: boolean; published: boolean; action: "saved" | "published" | "already_saved" };
  saveError?: Error;
  verificationMismatch?: boolean;
  failFill?: boolean;
  baselineDrift?: boolean;
  unrelatedDriftBeforeSave?: boolean;
  failAfterInsertion?: boolean;
  expectedPageUrl?: string;
  currentPageUrl?: string;
}

function createOrchestrationFixture(options: MockOptions = {}) {
  const mode = options.mode ?? "create";
  const expectedPageUrl = options.expectedPageUrl ?? "https://fixture.squarespace.com/target";
  const expectedPage = new URL(expectedPageUrl);
  const expectedEditorUrl = `${expectedPage.origin}${expectedPage.pathname}`;
  const state = { inserted: false, editorOpen: false, text: "Old copy", fills: 0, addClicks: 0, writeClicks: 0, saveCalls: 0, inspectCalls: 0, openedUrl: "" };
  const original = mode === "edit"
    ? [{ id: "block-1", type: "text", definitionName: "Text", visibleText: "Old copy", textTruncated: false }]
    : [{ id: "block-existing", type: "image", definitionName: "Image", visibleText: "", textTruncated: false }];
  const blockNodes = () => {
    const current = original.map((record) => ({
      ...record,
      id: record.id,
      type: record.type,
      definitionName: record.definitionName,
      visibleText: record.id === "block-1" ? state.text
        : options.baselineDrift && state.editorOpen ? "Unexpected external change"
          : options.unrelatedDriftBeforeSave && state.editorOpen && state.fills ? "Changed during edit"
            : record.visibleText,
      textTruncated: false,
    }));
    if (state.inserted) current.push({
      id: "observed-new-id", type: options.wrongType ? "image" : "text", definitionName: options.wrongType ? "Image" : "Text",
      visibleText: state.text, textTruncated: false,
    });
    return current;
  };
  const elementFor = (record: ReturnType<typeof blockNodes>[number]) => ({
    getAttribute: (name: string) => name === "id" ? record.id : name === "data-block-type" ? record.type : name === "data-definition-name" ? record.definitionName : null,
    innerText: record.visibleText,
  });
  const one = { count: async () => 1, isVisible: async () => true, isEnabled: async () => true, isDisabled: async () => false, click: async () => {} };
  let frame: any;
  let page: any;
  const locator = (kind: string, count = 1): any => ({
    count: async () => kind === "selector" ? (state.inserted ? 0 : 1) : kind === "blocks" ? blockNodes().length : count,
    isVisible: async () => true,
    isEnabled: async () => true,
    isDisabled: async () => false,
    waitFor: async () => {},
    nth: () => locator(kind, count),
    hover: async () => {},
    click: async () => {
      if (kind === "add") state.addClicks++;
      if (kind === "text-option") state.inserted = true;
      if (kind === "write") state.writeClicks++;
      if (kind === "text-option" && options.failAfterInsertion) throw new Error("editor disconnected after insertion");
    },
    fill: async (text: string) => {
      state.fills++;
      if (options.failFill) throw new Error("fill timeout");
      state.text = text;
    },
    evaluate: async (fn: (element: any) => unknown) => fn({
      getAttribute: (name: string) => name === "data-block-type" ? (options.wrongType ? "image" : "text") : name === "data-definition-name" ? (options.wrongType ? "Image" : "Text") : null,
      innerText: state.text,
      value: state.text,
    }),
    evaluateAll: async (fn: (elements: any[]) => unknown) => fn(
      kind === "blocks" ? blockNodes().map(elementFor)
        : kind === "page-sections" ? [{
            getAttribute: (name: string) => name === "data-section-id" ? "section-1" : null,
            querySelectorAll: () => blockNodes().map(elementFor),
          }]
          : [],
    ),
    locator: (selector: string) => {
      if (selector === '[data-block-type]') return locator("blocks", blockNodes().length);
      if (selector.includes('contenteditable') || selector.includes('role="textbox"') || selector.includes("textarea")) return locator("editable");
      if (selector.includes("Add Block")) return locator("add", options.addCount ?? 1);
      if (selector.includes("data-section-id")) return locator("section", options.wrongSection ? 0 : 1);
      if (selector.includes("id=") && selector.includes("data-block-type")) return locator("block");
      return locator("other", 0);
    },
    getByRole: (role: string, args: { name: string }) => {
      if (role === "button" && args.name === "Write") return locator("write", options.writeCount ?? 1);
      if (role === "button" && args.name === "Text") return locator("text-option");
      if (role === "region" && args.name === "Block Selector") return locator("selector", state.inserted ? 0 : 1);
      return locator("other");
    },
  });
  const section = locator("section");
  frame = { url: () => options.pageMismatch ? "https://fixture.squarespace.com/other" : expectedEditorUrl, locator: (selector: string) => selector === '[data-test="page-section"]' ? locator("page-sections") : section.locator(selector) };
  page = {
    url: () => options.currentPageUrl ?? expectedEditorUrl,
    frames: () => [frame],
    locator: (selector: string) => selector.includes("sqs-site-frame") ? locator("none", 0) : locator(selector.includes("Add Block") ? "add" : "other", selector.includes("Add Block") ? options.addCount ?? 1 : 1),
    getByRole: (role: string, args: { name: string }) => {
      if (args.name === "Edit") return { ...one, click: async () => { state.editorOpen = true; } };
      if (args.name === "Save" || args.name === "Exit") return one;
      if (role === "region" && args.name === "Block Selector") return locator("selector", state.inserted ? 0 : 1);
      return locator("other");
    },
    getByText: () => ({ waitFor: async () => { throw new Error("not shown"); } }),
  };
  const pageDetails = {
    id: "page-1", websiteId: website.id, name: "Target", navigationTitle: "Target", type: "page" as const,
    group: "main_navigation" as const, groupLabel: "Main Navigation", parentId: null, parentPath: [],
    url: expectedPageUrl, visibilityStatus: "enabled" as const, enabled: true,
    identity: { kind: "native" as const, native_id: "page-1", synthetic_id: null, title: "Target", slug: "target", is_homepage: false },
  };
  const guard = new MutationApprovalGuard({ requestApproval: async () => true });
  const fixtureInput = {
    website_id: website.id, page_id: "page-1", section_id: "section-1",
    ...(mode === "edit" ? { block_id: "block-1" } : {}), mode, text: "New copy",
  };
  const proposal = nativeTextBlockMutationProposal({
    websiteId: website.id, pageId: "page-1", sectionId: "section-1",
    ...(mode === "edit" ? { blockId: "block-1" } : {}), text: "New copy", mode,
  });
  const pages = {
    getPageDetails: async () => pageDetails,
    inspectPageSections: async () => {
      state.inspectCalls++;
      const records = blockNodes();
      return {
        websiteId: website.id,
        pageId: options.pageMismatch ? "wrong-page" : "page-1",
        url: expectedPageUrl,
        sectionsTruncated: false,
        sections: [{ id: options.wrongSection ? "wrong-section" : "section-1", theme: null, layout: "unknown" as const,
          headings: [], visibleText: records.map((record) => record.visibleText).join(" "), textTruncated: false,
          blocks: options.verificationMismatch ? [] : records, blocksTruncated: false }],
      };
    },
    savePageChanges: async () => {
      state.saveCalls++;
      if (options.saveError) throw options.saveError;
      return options.saveResult ?? { saved: true, published: false, action: "saved" as const };
    },
  };
  const service = new SquarespaceContentService({
    getWebsite: () => website,
    openWebsiteUrl: async (_id: string, url: string) => { state.openedUrl = url; },
    getCurrentPage: async () => page,
  } as never, pages as never, {} as never, guard, 50);
  return { state, service, guard, proposal, fixtureInput, pageDetails };
}

async function runAuthorizedFixture(fixture: ReturnType<typeof createOrchestrationFixture>) {
  const authorization = await fixture.guard.requestApproval(fixture.proposal);
  return fixture.service.mutateNativeTextBlock(fixture.fixtureInput, undefined, authorization);
}

test("native Text Block create executes once, checks Save, and reaches fresh verification", async () => {
  const fixture = createOrchestrationFixture();
  const result = await runAuthorizedFixture(fixture);
  assert.equal(result.blockId, "observed-new-id");
  assert.equal(result.verified, true);
  assert.equal(fixture.state.addClicks, 1);
  assert.equal(fixture.state.writeClicks, 1);
  assert.equal(fixture.state.fills, 1);
  assert.equal(fixture.state.saveCalls, 1);
  assert.equal(fixture.state.inspectCalls, 2);
  assert.equal(fixture.state.openedUrl, "https://fixture.squarespace.com/target");
});

test("native Text Block edit executes once against its exact block", async () => {
  const fixture = createOrchestrationFixture({ mode: "edit" });
  const result = await runAuthorizedFixture(fixture);
  assert.equal(result.blockId, "block-1");
  assert.equal(fixture.state.addClicks, 0);
  assert.equal(fixture.state.fills, 1);
  assert.equal(fixture.state.saveCalls, 1);
});

test("current page URL matching accepts only a trailing-slash difference for the same page", async (t) => {
  for (const [expectedPageUrl, currentPageUrl] of [
    ["https://fixture.squarespace.com/projects", "https://fixture.squarespace.com/projects/"],
    ["https://fixture.squarespace.com/projects/", "https://fixture.squarespace.com/projects"],
  ]) {
    await t.test(`${new URL(expectedPageUrl).pathname} matches ${new URL(currentPageUrl).pathname}`, async () => {
      const fixture = createOrchestrationFixture({ expectedPageUrl, currentPageUrl });
      const result = await runAuthorizedFixture(fixture);
      assert.equal(result.verified, true);
      const expectedPage = new URL(expectedPageUrl);
      assert.equal(fixture.state.openedUrl, `${expectedPage.origin}${expectedPage.pathname}`);
    });
  }
});

test("current page URL matching ignores query strings but keeps the path identity", async () => {
  const fixture = createOrchestrationFixture({
    expectedPageUrl: "https://fixture.squarespace.com/projects?source=panel",
    currentPageUrl: "https://fixture.squarespace.com/projects/?mode=edit",
  });
  const result = await runAuthorizedFixture(fixture);
  assert.equal(result.verified, true);
  assert.equal(fixture.state.openedUrl, "https://fixture.squarespace.com/projects");
});

test("current page URL matching rejects another path, another origin, and homepage/non-homepage mismatches", async (t) => {
  for (const [expectedPageUrl, currentPageUrl] of [
    ["https://fixture.squarespace.com/projects", "https://fixture.squarespace.com/other"],
    ["https://fixture.squarespace.com/projects", "https://other.squarespace.com/projects"],
    ["https://fixture.squarespace.com/projects", "https://fixture.squarespace.com/"],
    ["https://fixture.squarespace.com/", "https://fixture.squarespace.com/projects"],
  ]) {
    await t.test(`${expectedPageUrl} does not match ${currentPageUrl}`, async () => {
      const fixture = createOrchestrationFixture({ expectedPageUrl, currentPageUrl });
      await assert.rejects(runAuthorizedFixture(fixture), { code: "TEXT_SECTION_TARGET_MISMATCH" });
      assert.equal(fixture.state.addClicks, 0);
      assert.equal(fixture.state.fills, 0);
      assert.equal(fixture.state.saveCalls, 0);
    });
  }
});

test("missing and multiple Add Block controls fail closed before insertion", async (t) => {
  for (const count of [0, 2]) {
    await t.test(`matching count ${count}`, async () => {
      const fixture = createOrchestrationFixture({ addCount: count });
      await assert.rejects(runAuthorizedFixture(fixture), SquarespaceBrowserError);
      assert.equal(fixture.state.addClicks, 0);
      assert.equal(fixture.state.saveCalls, 0);
    });
  }
});

test("missing and multiple Write controls fail closed", async (t) => {
  for (const count of [0, 2]) {
    await t.test(`matching count ${count}`, async () => {
      const fixture = createOrchestrationFixture({ writeCount: count });
      await assert.rejects(runAuthorizedFixture(fixture), SquarespaceBrowserError);
      assert.equal(fixture.state.fills, 0);
      assert.equal(fixture.state.saveCalls, 0);
    });
  }
});

test("wrong page, section, block type, and baseline/verification drift are rejected", async (t) => {
  for (const options of [{ pageMismatch: true }, { wrongSection: true }, { wrongType: true }, { baselineDrift: true }, { verificationMismatch: true }]) {
    await t.test(JSON.stringify(options), async () => {
      const fixture = createOrchestrationFixture(options);
      await assert.rejects(runAuthorizedFixture(fixture), (error: unknown) => error instanceof SquarespaceBrowserError || error instanceof MutationApprovalError);
      if ("baselineDrift" in options) {
        assert.equal(fixture.state.addClicks, 0);
        assert.equal(fixture.state.fills, 0);
      }
    });
  }
});

test("pre-Save unrelated content drift is rejected", async () => {
  const fixture = createOrchestrationFixture({ unrelatedDriftBeforeSave: true });
  await assert.rejects(runAuthorizedFixture(fixture), { code: "OUTCOME_UNCERTAIN" });
  assert.equal(fixture.state.saveCalls, 0);
  assert.equal(fixture.state.addClicks, 1);
});

test("Save rejection and timeout after partial mutation never report success or retry", async (t) => {
  for (const options of [
    { saveResult: { saved: false, published: false, action: "already_saved" as const } },
    { saveError: new Error("save timeout") },
    { failFill: true },
    { failAfterInsertion: true },
  ]) {
    await t.test(Object.keys(options)[0]!, async () => {
      const fixture = createOrchestrationFixture(options);
      let failure: unknown;
      await assert.rejects(runAuthorizedFixture(fixture), (error: unknown) => { failure = error; return true; });
      assert.equal(fixture.state.addClicks, 1);
      assert.equal(fixture.state.fills, "failAfterInsertion" in options ? 0 : 1);
      assert.equal(fixture.state.saveCalls, "saveResult" in options || "saveError" in options ? 1 : 0);
      assert.equal((failure as SquarespaceBrowserError).code, "OUTCOME_UNCERTAIN");
    });
  }
});

test("mismatched task authorization is rejected before browser interaction", async () => {
  const fixture = createOrchestrationFixture({ mode: "edit" });
  const wrongProposal = nativeTextBlockMutationProposal({
    websiteId: website.id, pageId: "page-1", sectionId: "another-section", blockId: "block-1", text: "New copy", mode: "edit",
  });
  const authorization = await fixture.guard.requestApproval(wrongProposal);
  await assert.rejects(fixture.service.mutateNativeTextBlock(fixture.fixtureInput, undefined, authorization), MutationApprovalError);
  assert.equal(fixture.state.inspectCalls, 0);
});

test("expired authorization is rejected before browser access", async () => {
  const fixture = createOrchestrationFixture();
  const authorization = await fixture.guard.requestApproval(fixture.proposal);
  fixture.guard.revoke(authorization.receipt);
  await assert.rejects(
    fixture.service.mutateNativeTextBlock(fixture.fixtureInput, undefined, authorization),
    MutationApprovalError,
  );
  assert.equal(fixture.state.inspectCalls, 0);
});
