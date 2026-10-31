import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SquarespaceBrowserError } from "./browser-errors.js";

const SQUARESPACE_HOST = "squarespace.com";

export function isAllowedSquarespaceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === SQUARESPACE_HOST ||
        url.hostname.endsWith(`.${SQUARESPACE_HOST}`))
    );
  } catch {
    return false;
  }
}

export function assertAllowedSquarespaceUrl(value: string): URL {
  if (!isAllowedSquarespaceUrl(value)) {
    throw new SquarespaceBrowserError(
      "INVALID_URL",
      "Navigation is limited to HTTPS Squarespace domains.",
    );
  }

  return new URL(value);
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (error) {
    throw new SquarespaceBrowserError(
      "INVALID_URL",
      "Could not safely redact a malformed URL.",
      { cause: error },
    );
  }
}

export function resolveProfileDirectory(
  configuredPath: string | undefined,
  workingDirectory = process.cwd(),
): string {
  const normalizedPath = configuredPath?.trim();
  if (normalizedPath && !isAbsolute(normalizedPath)) {
    throw new SquarespaceBrowserError(
      "PROFILE_DIRECTORY_UNSAFE",
      "The browser profile path must be absolute.",
    );
  }
  const profileDirectory = normalizedPath
    ? resolve(normalizedPath)
    : defaultProfileDirectory();

  const relativePath = relative(resolve(workingDirectory), profileDirectory);
  if (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  ) {
    throw new SquarespaceBrowserError(
      "PROFILE_DIRECTORY_UNSAFE",
      "The browser profile must be outside the project directory to prevent local session data from being committed.",
    );
  }

  return profileDirectory;
}

function defaultProfileDirectory(): string {
  const platformDataDirectory =
    process.env.LOCALAPPDATA ??
    process.env.XDG_DATA_HOME ??
    resolve(homedir(), ".local", "share");
  return resolve(platformDataDirectory, "squarespace-mcp", "chromium-profile");
}
