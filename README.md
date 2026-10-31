# Squarespace MCP Server

A Node.js and TypeScript Squarespace MCP server with a persistent Playwright
browser service and read-only website/page inspection tools. Official API
integrations and content-changing tools are not included in this phase.

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

## Architecture

```text
src/
  index.ts       Application composition and process entry point
  auth/          Credential and authenticated-session handling
  api/           Clients for officially supported Squarespace APIs
  browser/       Persistent Playwright session and read-only page inspection
  config/        Environment parsing and validated application settings
  tools/         MCP inspection tool definitions and request handling
  utils/         Shared logging, errors, and small utilities
```

The intended request flow is: MCP client → validated tool input → API client
where an official API supports the operation, otherwise an explicit browser
workflow → normalized result or actionable error. Keeping these integrations
separate makes API coverage and browser-dependent behavior clear and testable.

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
capture screenshots; it does not edit or publish website content.

## Pages inspection tools

The MCP server registers these read-only tools:

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

Call `list_websites` first, then pass the returned `website_id` to page tools.
Use page IDs returned from `list_pages` for `get_page_details`,
`get_page_url`, and `inspect_page_sections`. Results are returned as
structured JSON. If the persistent browser profile is not authenticated, the
visible browser opens and the account owner must complete sign-in manually.

The pages service uses DOM markers observed in the Squarespace interface:
`[data-test="websiteCard"]`, `[data-test="pages-panel"]`,
`[data-test="pages-panel-group"]`, and `[data-test="pages-panel-item"]`.
It reads page title/slug/enabled status through the visible page settings
dialog, closes that dialog without saving, and restores folders that were
initially collapsed. Section inspection uses the observed
`[data-test="page-section"]` marker in the rendered page frame. If Squarespace
changes these markers or the panel does not load, tools return an explicit
error instead of silently returning an incomplete result.

Page types are reported conservatively as `folder` or `page`, based on the
observed folder controls. A page's enabled/disabled status is `unknown` when
Squarespace does not expose an Enable Page checkbox for that item. Navigation
group and enabled status are separate properties: a Not Linked page can still
be enabled.

All tools are marked read-only and do not create, edit, delete, save, or
publish website content. Opening and closing page settings and temporarily
expanding folders are used only to inspect existing page data; original
collapsed folder states are restored afterward.

## Development

- `npm run dev` — watch and run the TypeScript entry point
- `npm run build` — compile to `dist/`
- `npm run typecheck` — run TypeScript without emitting files
- `npm test` — run browser, Pages inspection, and MCP tool tests
- `npm start` — run the compiled entry point

Strict TypeScript checks are enabled in `tsconfig.json`. No Squarespace API
calls are made by these inspection tools.
