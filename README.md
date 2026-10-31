# Squarespace MCP Server

A Node.js and TypeScript foundation for an MCP-compatible Squarespace website
management agent. It currently provides a reusable, read-only Playwright
browser service; MCP tools and Squarespace API integrations will be added
incrementally.

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

The MCP server entry point and tool registrations are not implemented yet, so
the `start` command does not start an MCP server.

## Architecture

```text
src/
  index.ts       Application composition and process entry point
  auth/          Credential and authenticated-session handling
  api/           Clients for officially supported Squarespace APIs
  browser/       Persistent Playwright session and read-only browser services
  config/        Environment parsing and validated application settings
  tools/         MCP tool definitions and request handling
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

## Development

- `npm run dev` — watch and run the TypeScript entry point
- `npm run build` — compile to `dist/`
- `npm run typecheck` — run TypeScript without emitting files
- `npm test` — run browser URL and profile-path security tests
- `npm start` — run the compiled entry point

Strict TypeScript checks are enabled in `tsconfig.json`. This initial phase
intentionally does not implement MCP tools or connect to Squarespace APIs.
