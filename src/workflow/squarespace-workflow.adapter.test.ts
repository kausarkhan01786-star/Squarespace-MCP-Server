import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowAction } from "./workflow-types.js";
import { SquarespaceWorkflowAdapter } from "./squarespace-workflow.adapter.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";

const website = {
  id: "site-123",
  name: "Example",
  url: "https://example.squarespace.com",
};

function createAdapter(browserProvider = {
  verifyWebsite: async (websiteId: string) => {
    if (websiteId !== website.id) throw new Error("Unlisted website.");
    return { status: "supported" as const, data: website };
  },
}) {
  const calls: Array<{ action: string; args: unknown[] }> = [];
  const services = {
    browserProvider,
    pages: {
      listPages: async (...args: unknown[]) => {
        calls.push({ action: "listPages", args });
        return [];
      },
      getPageDetails: async (...args: unknown[]) => {
        calls.push({ action: "getPageDetails", args });
        return {};
      },
      inspectPageSections: async (...args: unknown[]) => {
        calls.push({ action: "inspectPageSections", args });
        return {};
      },
      inspectMobileResponsive: async (...args: unknown[]) => {
        calls.push({ action: "inspectMobileResponsive", args });
        return { mobile: { horizontalOverflow: false } };
      },
    },
    design: {
      inspectColorThemes: async (...args: unknown[]) => {
        calls.push({ action: "inspectColorThemes", args });
        return {};
      },
    },
    settings: {
      inspectPageSeo: async (...args: unknown[]) => {
        calls.push({ action: "inspectPageSeo", args });
        return {};
      },
    },
    backups: {
      createPageSnapshot: async (...args: unknown[]) => {
        calls.push({ action: "createPageSnapshot", args });
        return {};
      },
    },
    content: {
      verifyHomePageTarget: async (...args: unknown[]) => {
        calls.push({ action: "verifyHomePageTarget", args });
      },
      addTextSection: async (input: unknown) => {
        calls.push({ action: "addTextSection", args: [input] });
        return { verified: true };
      },
    },
    commerce: {
      getCapabilities: () => ({
        provider: "Squarespace Commerce",
        capabilities: [{
          operation: "list_products",
          toolAvailable: false,
        }],
      }),
      listProducts: async (...args: unknown[]) => {
        calls.push({ action: "listProducts", args });
        return { items: [] };
      },
      getProductDetails: async (...args: unknown[]) => {
        calls.push({ action: "getProductDetails", args });
        return {};
      },
      listInventory: async (...args: unknown[]) => {
        calls.push({ action: "listInventory", args });
        return { items: [] };
      },
      listOrders: async (...args: unknown[]) => {
        calls.push({ action: "listOrders", args });
        return { items: [] };
      },
      listDiscounts: async (...args: unknown[]) => {
        calls.push({ action: "listDiscounts", args });
        return { items: [] };
      },
    },
  } as unknown as ConstructorParameters<typeof SquarespaceWorkflowAdapter>[0];
  return {
    adapter: new SquarespaceWorkflowAdapter(services, new BrowserOperationLock()),
    calls,
  };
}

function task(action: WorkflowAction, values: Record<string, unknown> = {}) {
  return { action, ...values } as Parameters<SquarespaceWorkflowAdapter["execute"]>[2];
}

test("declares only verified Squarespace operations and reflects commerce availability", () => {
  const { adapter } = createAdapter();
  const capabilities = new Map(
    adapter.getCapabilities().map((capability) => [capability.action, capability]),
  );
  assert.equal(capabilities.get("inspect_pages")?.toolName, "list_pages");
  assert.equal(capabilities.get("inspect_products")?.supported, false);
  assert.equal(capabilities.get("add_text_section")?.approvalRequired, true);
  assert.equal(capabilities.get("manage_products")?.supported, false);
  assert.equal(capabilities.get("publish_site")?.supported, false);
});

test("dispatches approved add_text_section only through the guarded content service", async () => {
  const { adapter, calls } = createAdapter();
  await adapter.execute("add_text_section", website.id, task("add_text_section", {
    page_id: "home",
    text: "Kausar Mia",
    background_color: "#FFFFFF",
    text_color: "#000000",
    confirm_potentially_live_save: true,
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.action, "addTextSection");
  assert.deepEqual(calls[0]!.args[0], {
    website_id: website.id,
    page_id: "home",
    text: "Kausar Mia",
    background_color: "#FFFFFF",
    text_color: "#000000",
    confirm_potentially_live_save: true,
  });
});

test("validates the supported mutation's exact website and Home target during planning", async () => {
  const { adapter, calls } = createAdapter();
  const limitation = await adapter.validateTask?.(
    "add_text_section",
    website.id,
    task("add_text_section", { page_id: "home" }),
  );
  assert.equal(limitation, null);
  assert.deepEqual(calls, [{
    action: "verifyHomePageTarget",
    args: [website.id, "home"],
  }]);
});

test("refuses unsupported actions and unverified websites without platform fallback", async () => {
  const { adapter } = createAdapter();
  await assert.rejects(adapter.execute("create_page", website.id, task("create_page")));
  await assert.rejects(adapter.verifyWebsite("unknown"));
});

test("fails explicitly when the workflow's browser provider is unavailable", async () => {
  const { adapter } = createAdapter({
    verifyWebsite: async () => ({
      status: "unsupported",
      capability: "verify_website",
      reason: "No browser provider is connected.",
    }),
  });
  await assert.rejects(adapter.verifyWebsite(website.id), {
    code: "BROWSER_CAPABILITY_UNAVAILABLE",
    message: "Cannot verify the selected website: No browser provider is connected.",
  });
});
