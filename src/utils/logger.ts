const SAFE_FIELDS = new Set([
  "action",
  "authenticated",
  "browserActionCount",
  "code",
  "dashboardEvidenceVisible",
  "dashboardMarkerPresent",
  "domInspectionCount",
  "explicitWaitDurationMs",
  "loginFormVisible",
  "operation",
  "pageCount",
  "resultCount",
  "retryCount",
  "screenshotCount",
  "stageDurationsMs",
  "status",
  "toolName",
  "totalDurationMs",
  "websiteCardCount",
]);

const SAFE_ERROR_NAMES = new Set([
  "AggregateError",
  "Error",
  "ExecutionStoppedError",
  "RangeError",
  "SquarespaceBrowserError",
  "TypeError",
]);

export function logInfo(event: string, fields: object = {}): void {
  writeDiagnostic("info", event, fields);
}

export function logError(
  event: string,
  error?: unknown,
  fields: object = {},
): void {
  let errorDetails: { name: string; code?: string } | undefined;
  if (error !== undefined) {
    const code = getErrorCode(error);
    errorDetails = {
      name: error instanceof Error && SAFE_ERROR_NAMES.has(error.name)
        ? error.name
        : "UnknownError",
      ...(code === undefined ? {} : { code }),
    };
  }
  writeDiagnostic("error", event, fields, errorDetails);
}

function writeDiagnostic(
  level: "info" | "error",
  event: string,
  fields: object,
  error?: { name: string; code?: string },
): void {
  const record = {
    level,
    event: /^[a-z0-9_.-]{1,80}$/i.test(event) ? event : "application_diagnostic",
    ...filterFields(fields),
    ...(error ? { error } : {}),
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function filterFields(fields: object): Record<string, unknown> {
  const safeFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key)) continue;
    if (key === "stageDurationsMs") {
      safeFields[key] = sanitizeStageDurations(value);
    } else if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      safeFields[key] = value;
    } else if (
      typeof value === "string" &&
      value.length <= 80 &&
      /^[a-z0-9_.-]+$/i.test(value) &&
      (key !== "code" || /^[A-Z0-9_]+$/.test(value))
    ) {
      safeFields[key] = value;
    }
  }
  return safeFields;
}

function sanitizeStageDurations(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([stage, duration]) =>
        /^[a-z0-9_]{1,80}$/i.test(stage) &&
        typeof duration === "number" &&
        Number.isFinite(duration),
    ),
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)
    ? code
    : undefined;
}
