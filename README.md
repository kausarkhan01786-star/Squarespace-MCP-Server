# Squarespace MCP Server

A Node.js and TypeScript Squarespace MCP server with a persistent Playwright
browser service, website/page inspection tools, one guarded Home-page content
mutation, and read-only Squarespace Commerce API inspection tools.

## Requirements

- Node.js 20 or later
- npm
- Chromium installed for Playwright (`npx playwright install chromium`)

## Getting started

```sh
npm install
Copy-Item .env.example .env
npm run build
```

On macOS or Linux, copy the environment template with:

```sh
cp .env.example .env
```

The MCP server uses stdio transport. The browser launches only when a browser
tool is called, not when the MCP process starts.

## VS Code MCP registration

The workspace configuration at `.vscode/mcp.json` starts the compiled server
with `node ${workspaceFolder}/dist/index.js`. Build first with `npm run build`
from the workspace root. The MCP process inherits its environment from VS
Code; this configuration does not include credentials or select a browser
profile. Commerce API calls require `SQUARESPACE_API_KEY` and
`SQUARESPACE_SITE_ID` in the process environment. Browser operations require
their own verified persistent profile and authentication, and are not bridged
to the VS Code shared browser.

## Architecture

```text
src/
  index.ts       Application composition and process entry point
  auth/          Credential and authenticated-session handling
  api/           Reserved for API clients
  browser/       BrowserProvider contract, Playwright provider, and Squarespace UI services
  commerce/      Commerce provider abstraction and Squarespace API adapter
  workflow/      CMS-independent workflow contracts, engine, and Squarespace adapter
  config/        Environment parsing and validated application settings
  tools/         MCP tool definitions and request handling
  utils/         Shared logging, errors, and small utilities
```

The intended request flow is: MCP client → validated tool input → API client
where an official API supports the operation, otherwise an explicit browser
workflow → normalized result or actionable error. Browser operations are
expressed through a CMS-independent `BrowserProvider`; the current
`PlaywrightBrowserProvider` adapts the existing Squarespace Playwright service.
Squarespace-specific selectors remain in the Squarespace browser services, and
Commerce API operations remain in the Commerce provider.

The VS Code shared browser is a separate host integration. The Agent may
operate that authenticated browser directly and pass sanitized evidence to MCP
tools, but this MCP server has no documented API or bridge to invoke those
browser actions. The provider abstraction does not expose Playwright pages or
contexts, cookies, storage state, credentials, or arbitrary page evaluation.
Capabilities that a provider does not implement return an explicit
`unsupported` result; no shared-browser connection is implied.

## Configuration and credentials

Copy `.env.example` to `.env` and set only the values needed for your
installation. The example contains no credentials. Keep `.env` out of version
control, use a secret manager in deployed environments, and never pass
Squarespace passwords or API keys in tool arguments or logs.

Browser authentication is manual; the service never requests or stores
passwords or OTPs. Browser automation should only be used for workflows that
are not available through officially supported APIs and must respect
Squarespace's terms and applicable access controls.

## Browser service

The browser service launches visible Chromium and keeps its login session in a
local persistent profile. The default profile is under the current user's OS
data directory. Optionally set `SQUARESPACE_BROWSER_PROFILE_DIR` in the process
environment to an absolute directory outside the project. The `.env.example` file is a
template; this scaffold does not load `.env` files automatically, so set
environment variables in your shell or hosting environment. Treat the profile
and screenshots as sensitive: they can contain authenticated website data.

Commerce tools use Squarespace's official API, separately from browser
authentication. Configure `SQUARESPACE_API_KEY` and `SQUARESPACE_SITE_ID` in
the MCP server process environment. The API key must have only the read-only
Products, Inventory, Orders, and Discounts permissions needed for the tools
you use. `SQUARESPACE_SITE_ID` is the `siteId` returned by
`GET /1.0/authorization/website` for that key. Each commerce request verifies
that API identity and URL against the selected website from `list_websites`;
the API key is never accepted as a tool argument or written to logs. Tool calls
fail explicitly when credentials, read permissions, or site identity do not
match.

Example usage from TypeScript:

```ts
import { SquarespaceBrowserService } from "./browser/index.js";

const browser = new SquarespaceBrowserService();
try {
  await browser.openLoginPage();
  await browser.waitForManualLogin();

  const dashboard = await browser.openAccountDashboard();
  if (!dashboard.loggedIn) {
    throw new Error("Squarespace login is required.");
  }

  const websites = await browser.listWebsites();
  const page = await browser.inspectCurrentPage();
  const screenshotPath = await browser.captureScreenshot();
  console.log({ websites, page, screenshotPath });
} finally {
  await browser.close();
}
```

`switchWebsite(id)` accepts an ID returned by the latest `listWebsites()` call.
`isLoggedIn()` checks the dashboard, and `recoverSession()` reopens the same
profile if Chromium was closed. Manual login may take up to ten minutes; the
browser stays open if that wait times out. `inspectCurrentPage()` redacts URL
query strings and fragments and does not return input values. Screenshots are
saved within the profile's `screenshots` directory.

This service can navigate, inspect pages, switch among listed websites, and
capture screenshots. Screenshots are saved to the local profile's
`screenshots` directory by the browser service.

## Pages and content tools

The server registers these website, page, and content tools:

- `list_websites` — list sites available in the manually authenticated account.
- `list_pages` — return page IDs, names, page/folder types, URLs, navigation
  groups, parent folders, and enabled status; optionally filter by group.
- `get_page_details` — read one page's settings and navigation metadata.
- `get_page_url` — return one page's internal URL.
- `get_navigation_structure` — return nested Main Navigation, Footer
  Navigation, Not Linked, and other groups.
- `list_not_linked_pages` — list pages in the Not Linked group.
- `inspect_page_sections` — inspect visible headings and text in a page's
  rendered sections.
- `list_page_sections` — list observed section IDs, themes, layout markers,
  headings, and block IDs/types for a page.
- `inspect_section` — inspect one section returned by `list_page_sections`.
- `inspect_mobile_responsive` — compare section widths and horizontal overflow
  at the current browser width and a 390x844 viewport, restoring the original
  viewport afterward.
- `create_page_snapshot` — save a local JSON snapshot plus a full-page
  screenshot and individual section screenshots where Squarespace exposes
  them.
- `list_snapshots` — list local snapshots and captured screenshot counts.
- `get_snapshot` — read a validated snapshot by UUID.
- `inspect_design_settings` — open the observed Site Styles screen and report an
  explicit error if it does not expose inspectable controls.
- `inspect_site_styles` — check whether the visible Site Styles controls are
  available; it does not save settings.
- `inspect_typography` — read computed font styles on visible page headings and
  text; this is not a site-wide font preset catalog.
- `inspect_color_themes` — read observed section theme IDs and computed
  rendered colors; this is not the full palette editor.
- `inspect_button_styles` — inspect computed styles on visible semantic
  buttons; it does not infer button presets or styled links.
- `inspect_section_settings` — read a rendered section's theme, layout,
  dimensions, and computed styles.
- `list_content_blocks` and `inspect_content_block` — list rendered block IDs,
  raw block type identifiers, observed definition names, and visible text.
- `get_block_edit_schema` — return an explicit error unless a verified block
  editing form is available.
- `list_available_block_types` — list types seen on the selected page, marked
  incomplete because this is not the add-block catalog.
- `add_text_section` — add a blank section at the bottom of Kausar Mia's Home
  page with one Text block, using the requested text, a pure-white section, and
  pure-black text. It first writes and verifies a fresh local JSON snapshot and
  screenshots, then checks the rendered result after Save.

## Commerce tools (increment 1: read-only)

The commerce provider interface lives separately from browser workflows so
future CMS adapters can report their own capabilities. The first adapter uses
Squarespace's documented HTTPS Commerce APIs and exposes:

- `get_commerce_capabilities` — distinguishes documented API support from
  tools currently implemented by this adapter.
- `list_products` — `website_id` (required), `cursor` (optional).
- `get_product_details` — `website_id` and `product_id` (required).
- `list_inventory` — `website_id` (required), `cursor` (optional).
- `list_orders` — `website_id` (required), `cursor` (optional). Results retain
  order totals/status, item, and fulfillment summaries, while excluding
  customer names, email, addresses, IDs, custom-form answers, internal notes,
  and tracking numbers/URLs.
- `list_discounts` — `website_id` (required), `offset` (0–1,000,000,
  default 0), and `limit` (1–100, default 50).

All six tools are read-only and use Zod validation. Orders and discounts are
never changed or activated. Commerce API calls do not use or inspect browser
cookies; they require a separate scoped API key.
When the Inventory API returns a bare array without pagination metadata, the
tool reports `hasNextPage: null` rather than claiming the result is complete.

Squarespace documents write APIs for products, inventory, and discounts, but
this increment does not expose them: commerce-specific before/after backups,
idempotency, confirmation, and post-mutation verification are not implemented.
The current capability report distinguishes these documented APIs from
unavailable MCP tools. Category/collection management is not exposed because
the reviewed Commerce API docs do not document a categories/collections
endpoint; product tags are not treated as categories. These are marked
unverified, not asserted to be impossible. Order detail is similarly marked
unverified because a single-order endpoint was not verified. Order mutation
tools are also not exposed in this increment. Inventory is returned as
Squarespace records; out-of-stock classification and inventory-settings
inspection are not yet exposed because the required normalized semantics or
settings workflow have not been verified.

Call `list_websites` first, then pass the returned `website_id` to page tools.
Use page IDs returned from `list_pages` for page and section inspection.
Results are returned as structured JSON. If the persistent browser profile is
not authenticated, the visible browser opens and the account owner must
complete sign-in manually.

The inspection service uses DOM markers observed in the Squarespace interface:
`[data-test="websiteCard"]`, `[data-test="pages-panel"]`,
`[data-test="pages-panel-group"]`, and `[data-test="pages-panel-item"]`.
It reads page title/slug/enabled status through the visible page settings
dialog, closes that dialog without saving, and restores folders that were
initially collapsed. Section inspection uses the observed
`[data-test="page-section"]` marker in the rendered page frame. If Squarespace
changes these markers or the panel does not load, tools return an explicit
error instead of silently returning an incomplete result.

The design/content inspection tools report only visible DOM data and raw
Squarespace block-type identifiers; those identifiers are not treated as
stable semantic block types. On the inspected Kausar Home page, Squarespace
reported raw block type `1337` with observed definition names
`website.components.imageFluid`, `website.components.html`,
`website.components.code`, and `website.components.embed`. The type number is
preserved verbatim and the definition names describe only blocks present on
that page. Mobile inspection resizes the browser viewport temporarily and
does not save or publish content.

The project browser opened the observed Site Styles control and reached
`/config/site-styles`. After the loading indicator cleared, the panel contained
only its heading and no typography, color, button, form, or spacing controls.
The settings tools therefore return an explicit error rather than inventing
site-wide values. Rendered typography, section colors, and semantic button
styles are available separately with their scope clearly marked. The observed
page preview toolbar exposed `Edit` and `Toggle Site Styles editing`. The
`add_text_section` workflow uses the verified **Add a Section** / **Add Blank**,
**Add Block** / **Text**, **Write**, **Edit Section** / **Colors** / **Aa Light
1**, and **Text Color** / **Custom** / **Hex** controls. It is restricted to the
Kausar Mia site and Home page. All other section/block mutations remain
unavailable.

Squarespace Save has not been verified to preserve a draft on a published page.
Consequently, `add_text_section` requests a trusted interactive approval through
MCP form elicitation before waiting for the shared-browser lock. The exact site,
page, text, colors, bottom-section target, Save scope, and no-Publish behavior
are shown in the proposal. `confirm_potentially_live_save` is retained only as a
legacy acknowledgement and is not authorization. If the connected host does
not advertise form elicitation, declines, cancels, or returns an invalid
response, the mutation fails closed. The tool never clicks Publish, and it
refuses to begin if site/page identity or fresh backup verification fails.
Approval permits a potentially live Save; draft-only behavior remains
unverified.

Mutation approvals are server-issued, immutable, proposal-bound, single-use,
and expire after two minutes. They remain internal to the server and cannot be
supplied by tool callers. Save and Publish are separate permission scopes and
cannot be granted by the same proposal. Directly callable page mutation
services are guarded too; currently unsupported mutation paths have no
registered approval proposal and therefore remain blocked.

### VS Code host elicitation diagnostic

The temporary `human-approval-diagnostic` stdio server is isolated from the
Squarespace server and registers only `test_human_approval_prompt`. It does not
construct a CMS provider, access the browser, or issue mutation approvals.
Build with `npm run build`, then start or restart the **human-approval-diagnostic**
server from VS Code's MCP server controls. Invoke `test_human_approval_prompt`
from Chat. VS Code should show the exact harmless message and an **Accept /
Decline** choice. The tool reports the host's response (`accept`, `decline`, or
`cancel`); unsupported capability, timeout, or transport failure is reported
without authorization. Remove the diagnostic server entry from `.vscode/mcp.json`
and its dedicated source/test files after host verification is complete.

Backups are stored under the project-local `backups/` directory, which is
git-ignored:

```text
backups/
  snapshots/<snapshot-uuid>.json
  screenshots/<snapshot-uuid>-page.png
  screenshots/<snapshot-uuid>-section-<index>-<section-id>.png
```

Call `create_page_snapshot` with `website_id` and `page_id` to inspect the page
and save its JSON plus screenshots:

```json
{
  "website_id": "ID returned by list_websites",
  "page_id": "ID returned by list_pages"
}
```

The tool returns the generated `snapshotId` and screenshot paths. Use
`list_snapshots` to find local backups and `get_snapshot` with a returned
`snapshot_id` to retrieve one. The JSON includes snapshot ID/time,
credential-free website and page URLs, page metadata, section IDs, visible
headings/text, observed layout/theme values, block IDs/types/text, and
screenshot metadata associating every image with the snapshot, website, page,
and (for section images) section ID. A section image is explicitly marked
`unavailable` if Squarespace will not expose that section for capture. Images
are PNGs captured from the public page frame, not the authenticated dashboard.

The snapshot writer removes URL query strings/fragments and redacts bearer/JWT
strings, credential-like values, email addresses, and phone numbers from saved
text. Screenshots mask any section whose inspected text requires redaction.
Other text or content embedded in images cannot be reliably classified;
review local backups before sharing them. Backups are inspection records and
screenshots, not a restorable Squarespace export. UUID filenames and exclusive
file creation prevent accidental overwrite. `list_snapshots` returns local
metadata; `get_snapshot` validates and returns a saved JSON snapshot.

Block-specific editing beyond the single `add_text_section` workflow, other
section mutations, Custom CSS, Custom Code, and header/footer customization
are not available as MCP tools. Page create/update/move/delete and explicit
publish operations are also intentionally not registered. The guarded
`add_text_section` tool is the only registered operation that can save website
content.

Page types are reported conservatively as `folder` or `page`, based on the
observed folder controls. A page's enabled/disabled status is `unknown` when
Squarespace does not expose an Enable Page checkbox for that item. Navigation
group and enabled status are separate properties: a Not Linked page can still
be enabled.

Opening and closing page settings and temporarily expanding folders are used
only to inspect existing page data; original collapsed folder states are
restored afterward.

## Navigation, SEO, and website settings

The navigation/SEO/settings tools are read-only and use the persistent
authenticated browser profile:

- `list_main_navigation`, `list_footer_navigation`, and
  `list_not_linked_pages` return the observed Pages-panel groups.
- `inspect_navigation_item` reports the page/folder record, parent hierarchy,
  and sibling order.
- `inspect_navigation_links` reads rendered `nav` and `footer` links from the
  selected page (or the homepage when `page_id` is omitted). The Pages-panel
  tree remains the source of hierarchy and configured ordering.
- `inspect_page_seo`, `get_page_meta_title`, and
  `get_page_meta_description` distinguish page SEO form values, website Search
  Appearance values, and metadata read from rendered HTML.
- `inspect_page_slug` and `inspect_page_indexing_settings` read the visible
  page slug and Hide Page from Search Results controls.
- `inspect_social_sharing_settings` checks the visible site/page upload controls
  and, when `page_id` is supplied, rendered social metadata.
- `inspect_website_settings`, `inspect_domain_settings`,
  `inspect_site_information`, `inspect_favicon`, `inspect_social_links`,
  `inspect_language_settings`, and `inspect_timezone_settings` inspect only
  the corresponding visible Squarespace settings UI or the website listing.

On the inspected Kausar site, the page SEO panel exposed optional SEO title and
description fields plus the Hide Page from Search Results checkbox for a
non-homepage page. The homepage panel directs to the website Search Appearance
screen instead; its title format and site description are read there.
Rendered `<title>`, description, canonical, robots, Open Graph, and Twitter
metadata are returned separately and are not represented as saved settings.

The Website settings screen exposed language/region, regional/timezone,
favicon, social links, and social sharing controls. The inspected Regional
Settings exposed country and timezone values. Site Languages showed its
setting label but no selected language value in the DOM. Favicon and social
sharing screens exposed upload controls but not current image file details.
Social-link inspection omits `mailto:` links and email addresses. The Domains
& Email screen exposed setup/manage cards but no configured domain records;
`inspect_domain_settings` marks those records unavailable. Site information is
limited to the name and URL returned by the authenticated website listing and
does not include owner, billing, or account-profile data.

Reading settings opens the relevant existing panel and closes it without
saving. These tools do not change navigation, page SEO, domains, language,
timezone, favicon, social links, or any other live Squarespace content.

## AI CMS developer workflow (Step 9)

The workflow tools provide structured coordination for an AI agent hosted by
the MCP client. The server validates briefs/design specifications, verifies a
selected website against the active authenticated Squarespace website listing,
plans tasks against explicit adapter capabilities, and executes only registered
operations. It does not contain an LLM, accept or analyze image files, or
silently select a different site/CMS. The host AI must supply the structured
interpretation; the server does not claim that it independently understood a
free-form brief or screenshot.

Registered workflow tools:

- `analyze_client_requirements` — requires `brief` with `businessType`,
  `websiteGoals`, `targetAudience`, `requiredPages` (each with `name`,
  `purpose`, and `sections`), `requiredFeatures`, `contentRequirements`,
  `designPreferences`, `assetRequirements`, `responsiveRequirements`, and
  `openQuestions`. Optional `design_specification` includes a source, visual
  hierarchy, colors/confidence, typography, spacing/layout, components,
  image placements, and responsive behavior. Pixel comparison is always
  reported unverified.
- `plan_website_workflow` — requires `cms` (`squarespace`), `website_id`
  returned by `list_websites`, the structured `brief`, optional
  `design_specification`, and ordered `tasks`. Each task has an `action` and
  only the identifiers/options relevant to existing tools, such as `page_id`,
  `product_id`, `cursor`, `offset`, or `limit`. Page-targeted tasks require
  `page_id`. Unsupported actions are represented in the plan rather than
  called.
- `approve_workflow_tasks` — requires `workflow_id`, the exact returned
  `plan_fingerprint`, selected `task_ids`, and the legacy `confirmed: true`
  acknowledgement. It separately requests trusted interactive approval for
  every selected mutation. A boolean supplied by an unattended model is never
  proof of human consent; hosts without MCP form elicitation fail closed.
- `execute_website_workflow` — requires a workflow ID; `max_tasks` is 1–10
  (default 1), `timeout_ms` is 1,000–600,000 (default 180,000), and
  `max_browser_actions` is 1–500 (default 100). Tasks execute in plan order,
  one at a time. Results and status include sanitized duration, instrumented
  browser actions, DOM inspections, screenshots, explicit waits, retries,
  per-stage durations, and execution status. Timeout and cancellation are
  cooperative at safe checkpoints; an in-progress mutation is marked
  interrupted and must be inspected before any later attempt.
- `cancel_website_workflow` — requests cooperative cancellation by workflow ID.
  It does not roll back an in-progress mutation or imply that it did not take
  effect.
- Previously completed tasks are not repeated. Retry is opt-in and limited to
  failed tasks declared both read-only and retry-safe; interrupted mutations
  are never automatically replayed.
- `get_workflow_status` and `get_workflow_qa_report` — inspect task execution
  and evidence-based QA status.
- `list_workflow_adapters` — report available CMS adapters and each operation's
  supported status/limitations.
- `plan_squarespace_hero` — validate Hero content, styling, ordered element
  positions, and return a staged **plan only**; it does not inspect/control the
  Agent's browser or mutate, save, or publish a page.
- `plan_squarespace_hero_operator` — requires the structured specification and
  a specific `section_id`; returns a deterministic, fingerprinted native
  Text/Button/Image block plan with a configurable action budget capped at 39.

The operator engine executes its immutable plan in one pass: every driver
method receives the same section ID, blocks are added through type-specific
methods (never a generic Add Block method), responsive positions are applied
as one batch, and measured desktop/mobile bounds are collision-checked once
after placement. The current six-block plan estimates 16 browser actions. It
records each browser-action duration and returns an
ordered report with counts, status, collision findings, and explicit
`saved: false` / `published: false` fields. It does not retry failed actions
or attempt to save or publish.

The engine is an orchestration contract, not an authenticated shared-browser
adapter. The VS Code Agent's browser tools can inspect and run Playwright
against the shared page, but they do not expose an injectable `Page` or an
execution API to this MCP process. No execution tool or Squarespace editor
driver is registered; implementing one from the separate MCP browser session
would assume shared authentication and is intentionally not done. The supplied
section ID must identify an existing empty section; section creation is
deliberately outside this block executor. Planning alone makes no website
changes.

The Hero specification separates content, styling, and desktop/mobile layout.
The Agent remains the only controller of the VS Code shared browser. MCP does
not expose an undocumented bridge or assume that its persistent Playwright
session is authenticated as the Agent. A Hero execution session can collect
stage timings, action counts when the Agent runtime exposes them, cancellation,
and sanitized evidence references. Operations move from planned to executed
and then visually verified only when the Agent reports the corresponding
evidence. Duplicate content in the inspected target section blocks creation.

The existing staged Hero planner and `add_text_section` tool remain separate
from this operator contract. Previously observed editor controls are not
treated as proof that a reusable shared-browser adapter exists. A native
operator plan is not evidence that the site was edited; live execution,
section creation, and Save/Publish remain unavailable through this MCP server.

The Squarespace adapter currently executes only verified operations:

| Workflow action | Registered tool | Support |
| --- | --- | --- |
| `inspect_pages` | `list_pages` | Read-only |
| `inspect_page` | `get_page_details` | Read-only |
| `inspect_page_sections` | `inspect_page_sections` | Read-only |
| `inspect_responsive` | `inspect_mobile_responsive` | Read-only |
| `inspect_page_seo` | `inspect_page_seo` | Read-only |
| `inspect_design` | `inspect_color_themes` | Read-only rendered section colors |
| `backup_page` | `create_page_snapshot` | Local snapshot/screenshots |
| `inspect_products` | `list_products` | Read-only; requires configured Commerce API |
| `inspect_product` | `get_product_details` | Read-only; requires configured Commerce API |
| `inspect_inventory` | `list_inventory` | Read-only; requires configured Commerce API |
| `inspect_orders` | `list_orders` | Read-only; customer-sensitive fields omitted |
| `inspect_discounts` | `list_discounts` | Read-only; requires configured Commerce API |
| `add_text_section` | `add_text_section` | Guarded, narrowly scoped mutation |

`add_text_section` accepts `page_id`, `text`, `background_color: "#FFFFFF"`,
and `text_color: "#000000"`. Its workflow task must be approved through trusted
interactive elicitation using the workflow ID and exact plan fingerprint;
planning first checks that the target is the confirmed Kausar Mia website and
its Home page. `confirm_potentially_live_save` is a legacy acknowledgement,
not an authorization token. Approval explicitly permits the existing
potentially-live Save because draft-only Save behavior has not been confirmed.
The content tool still creates and verifies a fresh snapshot/screenshots,
checks site and Home-page identity, verifies the result, and never clicks
Publish. Other page creation/editing, arbitrary block or design changes,
navigation changes, custom code, commerce writes, order
changes, discounts, and publishing are unsupported and are not executed.

The CMS-neutral batch-operation contract can represent section, text, button,
image, style, and layout operations while keeping planned, supported, executed,
verified, unsupported, and failed operations distinct. It is a planning/result
model only; it does not make Squarespace expose those actions. The reusable
layout validator checks supplied desktop/mobile element rectangles for overlap
and section-boundary violations, but no current Squarespace builder supplies
those measurements or executes a multi-element Hero batch. Do not treat a
batch as successful until each supported operation is executed and its result
is independently verified.

Each workflow execution carries one abort signal, an absolute deadline, and its
workflow/task IDs. The deadline aborts automatically. Cancellation removes a
queued browser-lock waiter; active browser work keeps the shared lock until its
Playwright operation settles, and Chromium navigation is stopped with
`Page.stopLoading` without closing the shared page or context. Selector waits
in workflow browser services poll in short cancellable intervals. Commerce
fetches receive the signal and distinguish request timeouts from workflow
deadlines. Playwright does not provide an abort signal for screenshot capture;
those operations can only report cancellation after the screenshot settles or
times out. Cancellation during a save reports that the CMS state is uncertain
and requires verification. Interrupted mutations are never replayed
automatically. Execution metrics distinguish user cancellation, workflow
deadlines, browser-operation timeouts, and API-request timeouts. Telemetry
contains only counts, durations, stage names, task IDs/actions, and status—never
page text, credentials, cookies, or browser storage.

Workflow plans and results are held in memory and disappear when the MCP server
restarts. The service does not persist client briefs. QA reports distinguish
completed tool execution from measured results; mobile overflow is only
reported when the responsive inspector returned it, and screenshot/reference
comparison, general link checks, pixel-level matching, and publication status
remain unverified. Only the Squarespace adapter is real; Shopify, WordPress,
Wix, Webflow, and HubSpot adapters are not advertised or registered.

### Provider and CMS extension contracts

`src/workflow/ai-provider-ports.ts` defines provider-neutral TypeScript
interfaces for requirement analysis, screenshot understanding, website
planning, content generation, task selection, and quality analysis. These are
integration ports only: there is no AI client, model credential, image upload
path, or fabricated implementation in this server. The MCP client/agent may
implement them and must label model-generated or estimated values as such.

Every future CMS adapter must implement `WorkflowAdapter`, validate an exact
site identity, list explicit per-action capabilities, reject unsupported
actions, and use CMS-specific verified tools for execution. Platform-specific
site IDs, authentication, backup/restore semantics, and approval requirements
must remain inside each adapter. No fallback to another CMS or website is
permitted. Integration status:

| CMS | Adapter status | Contract entry point |
| --- | --- | --- |
| Squarespace | Implemented for the actions listed above | `WorkflowAdapter` and `SquarespaceWorkflowAdapter` |
| WordPress | Not implemented | Build a WordPress-specific adapter only after REST API/authentication, backup, and verification behavior are validated |
| Shopify | Not implemented | Build a Shopify Admin API adapter with scoped access, shop identity validation, and mutation-specific confirmation |
| Wix | Not implemented | Build a Wix-specific adapter after supported API and site identity behavior are verified |
| Webflow | Not implemented | Build a Webflow-specific adapter after API scopes, site identity, and publishing/draft semantics are verified |
| HubSpot | Not implemented | Build a HubSpot CMS adapter after account identity, content APIs, and publication safeguards are verified |

The read-only capability metadata in `src/capabilities/` separates universal
capability definitions from CMS-specific operation bindings. It records
per-operation implementation status, tools, execution mechanism, permissions,
approval, verification, recovery, limitations, and separate evidence. Only
`IMPLEMENTED_AND_TESTED` operations with their required permissions, approval,
and completed verification can be reported eligible; the registry itself never
executes CMS actions. Squarespace entries reflect the repository audit, while
WordPress and Wix remain `UNKNOWN_NEEDS_INVESTIGATION`.

### Persistence, recovery, and security audit status

No persistent workflow store is enabled. A safe next design is a
`WorkflowRepository` interface backed by local SQLite with migrations and
transactional writes for workflow plans, task state transitions, and approval
records. The schema should separate workflow metadata, ordered task input,
approval fingerprints/actors/timestamps, and sanitized execution events.
Task inputs and results may contain client content, so retention must be
bounded and configurable; omit screenshots and customer data by default.
Persist no API keys, cookies, or browser profiles. Store the database outside
the repository with restrictive OS permissions and use OS-backed encryption
for sensitive fields where required. On restart, mark tasks left `running` as
`interrupted`/`outcome_unknown`; never retry a mutation automatically. Require
fresh site verification and re-approval before recovery can resume a mutation.
This persistence design is not implemented yet.

Security boundaries include HTTPS Squarespace-domain checks, per-call
website-list validation, API site ID/URL matching, Zod tool schemas, explicit
workflow approvals, and backups for the current text-section mutation. Page
snapshots are sanitized inspection records, not restorable CMS exports; they
have no cryptographic integrity signature. Browser operations share one
persistent browser page. A shared FIFO operation lock serializes registered
browser-dependent MCP tools and workflow browser actions, with a 30-second
acquisition timeout. Nested service calls reuse the current lock scope;
Commerce API-only operations and local snapshot reads remain outside the
browser lock.

MCP tests use the SDK's in-memory client/server transport and mocked adapters;
browser tests use fixture DOMs, and commerce tests mock `fetch`. They do not
authenticate to or mutate a live Squarespace site. During the Step 10 audit,
the shared browser showed the Kausar Mia Pages settings route, but its captured
console history included network-disconnected and rendering errors. Therefore
the browser's present authentication/connectivity and current UI workflow
controls were not considered verified by that inspection.

The current checkout had a modified `.env.example` with nonempty
`SQUARESPACE_API_KEY` and `SQUARESPACE_SITE_ID` assignments. Their values were
not displayed or changed in this audit because the file was already user
modified. Replace them with explicit safe placeholders before committing or
sharing the file. `.env` is ignored and was not present; its contents were not
read.

### Verified capability prioritization

| Candidate | Current status | Next safe work |
| --- | --- | --- |
| Create page | An internal Pages service has mock-tested page creation, saved-title verification, and before/after screenshots; no MCP tool is registered | Verify present UI and add fresh snapshot, explicit approval, failure recovery, and MCP communication tests before exposing it |
| Add blank section / text block | Only the narrowly scoped `add_text_section` flow is registered | Keep other variants unsupported until UI selectors, backup, save semantics, and post-save content verification are validated |
| Add images or buttons | No verified add/edit tools | Inspect UI and upload/link semantics first; then add isolated guarded tools |
| Edit existing content | Existing block inspection does not expose a verified general edit schema | Do not infer schemas from rendered block types |
| Change section background / typography | Rendered color inspection exists; general design-setting controls are not verified | Verify controls and style semantics before a mutation API |
| Navigation management | Read-only hierarchy and links are available | Verify supported mutation workflow, rollback, and confirmation behavior |
| SEO metadata | Read-only settings and rendered metadata inspection are available | Verify an update workflow, snapshot coverage, and rendered post-save results |
| Responsive QA | Desktop/mobile measurements exist; no tablet screenshot or AI vision analysis | Add tablet and multi-viewport screenshot evidence; keep model analysis a separate optional provider |

No live website mutation or Commerce API request was performed for this audit.

## Development

- `npm run dev` — watch and run the TypeScript entry point
- `npm run build` — compile to `dist/`
- `npm run typecheck` — run TypeScript without emitting files
- `npm test` — run browser, CMS, workflow, and MCP tool tests
- `npm start` — run the compiled entry point

Strict TypeScript checks are enabled in `tsconfig.json`. The page/design tools use the visible Squarespace interface. The commerce tools
use the official APIs documented at
[Squarespace Commerce APIs](https://developers.squarespace.com/commerce-apis/overview)
and do not make live changes.
