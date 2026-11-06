export const PROVIDER_ERROR_CODES = [
  "authentication_failure",
  "permission_denied",
  "provider_unavailable",
  "rate_limit",
  "conflict",
  "validation_failure",
  "execution_failure",
  "verification_failure",
] as const;

export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number];

const providerErrorBrand: unique symbol = Symbol("provider-error");
const unsupportedErrorBrand: unique symbol = Symbol("unsupported-operation-error");
const operationResultBrand: unique symbol = Symbol("operation-result");

export interface ProviderErrorMetadata {
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

export interface ProviderError {
  readonly [providerErrorBrand]: true;
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly metadata?: ProviderErrorMetadata;
}

export interface UnsupportedOperationError {
  readonly [unsupportedErrorBrand]: true;
  readonly code: "unsupported_operation";
  readonly operation: string;
  readonly message: string;
}

export interface OperationMetadata {
  readonly operationId?: string;
  readonly durationMs?: number;
}

export type OperationResult<T> = (
  | {
      readonly status: "success";
      readonly value: T;
      readonly metadata?: OperationMetadata;
    }
  | {
      readonly status: "unsupported";
      readonly error: UnsupportedOperationError;
    }
  | {
      readonly status: "error";
      readonly error: ProviderError;
    }
) & { readonly [operationResultBrand]: true };

export type SerializedOperationResult<T> =
  | {
      readonly status: "success";
      readonly value: T;
      readonly metadata?: OperationMetadata;
    }
  | {
      readonly status: "unsupported";
      readonly error: {
        readonly code: "unsupported_operation";
        readonly operation: string;
        readonly message: string;
      };
    }
  | {
      readonly status: "error";
      readonly error: {
        readonly code: ProviderErrorCode;
        readonly message: string;
        readonly metadata?: ProviderErrorMetadata;
      };
    };

const publicErrorMessages: Readonly<Record<ProviderErrorCode, string>> = {
  authentication_failure: "The provider could not authenticate this request.",
  permission_denied: "The provider denied permission for this operation.",
  provider_unavailable: "The provider is currently unavailable.",
  rate_limit: "The provider rate limit was reached.",
  conflict: "The provider reported a conflict.",
  validation_failure: "The provider rejected the request as invalid.",
  execution_failure: "The provider could not complete the operation.",
  verification_failure: "The operation could not be verified.",
};

export function operationSuccess<T>(
  value: T,
  metadata?: OperationMetadata,
): OperationResult<T> {
  const safeMetadata = sanitizeOperationMetadata(metadata);
  const result = safeMetadata === undefined
    ? { status: "success" as const, value }
    : { status: "success" as const, value, metadata: safeMetadata };
  return brandOperationResult(result);
}

export function operationError(
  code: ProviderErrorCode,
  _providerMessage: string,
  metadata?: unknown,
): OperationResult<never> {
  const safeCode = isProviderErrorCode(code) ? code : "execution_failure";
  const safeMetadata = sanitizeProviderErrorMetadata(metadata);
  const error = brandProviderError(safeCode, safeMetadata);
  return brandOperationResult({ status: "error", error });
}

export function unsupportedOperation(operation: string): OperationResult<never> {
  const safeOperation = sanitizeOperationId(operation) ?? "unknown_operation";
  const error = Object.defineProperty({
    code: "unsupported_operation" as const,
    operation: safeOperation,
    message: "This operation is not supported by this adapter.",
  }, unsupportedErrorBrand, { value: true });
  return brandOperationResult({
    status: "unsupported",
    error,
  });
}

/**
 * Normalize an untrusted adapter result before logging or transport serialization.
 * TypeScript branding is not a runtime boundary; callers must invoke this explicitly.
 * Successful values are preserved as domain data and are not recursively scrubbed.
 */
export function serializeOperationResult<T>(input: unknown): SerializedOperationResult<T> {
  const result = asPlainRecord(input);
  if (!result) return malformedResult();

  const status = ownValue(result, "status");
  if (status === "success") {
    const value = ownDataProperty(result, "value");
    if (!value.found) return malformedResult();
    const metadata = sanitizeOperationMetadata(ownValue(result, "metadata"));
    return metadata === undefined
      ? { status, value: value.value as T }
      : { status, value: value.value as T, metadata };
  }

  const error = asPlainRecord(ownValue(result, "error"));
  if (!error) return malformedResult();

  if (status === "unsupported") {
    return {
      status,
      error: {
        code: "unsupported_operation",
        operation: sanitizeOperationId(ownValue(error, "operation")) ?? "unknown_operation",
        message: "This operation is not supported by this adapter.",
      },
    };
  }

  if (status === "error") {
    const codeValue = ownValue(error, "code");
    const code = isProviderErrorCode(codeValue) ? codeValue : "execution_failure";
    const metadata = sanitizeProviderErrorMetadata(ownValue(error, "metadata"));
    return metadata === undefined
      ? { status, error: { code, message: publicErrorMessages[code] } }
      : { status, error: { code, message: publicErrorMessages[code], metadata } };
  }

  return malformedResult();
}

function sanitizeProviderErrorMetadata(value: unknown): ProviderErrorMetadata | undefined {
  const record = asPlainRecord(value);
  if (!record) return undefined;

  const safe: { httpStatus?: number; retryAfterMs?: number } = {};
  const httpStatus = ownValue(record, "httpStatus");
  if (typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
    safe.httpStatus = httpStatus;
  }
  const retryAfterMs = ownValue(record, "retryAfterMs");
  if (typeof retryAfterMs === "number" && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) {
    safe.retryAfterMs = retryAfterMs;
  }
  return Object.keys(safe).length === 0 ? undefined : Object.freeze(safe);
}

function sanitizeOperationMetadata(value: unknown): OperationMetadata | undefined {
  const record = asPlainRecord(value);
  if (!record) return undefined;

  const safe: { operationId?: string; durationMs?: number } = {};
  const operationId = sanitizeOperationId(ownValue(record, "operationId"));
  if (operationId !== undefined) safe.operationId = operationId;
  const durationMs = ownValue(record, "durationMs");
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    safe.durationMs = durationMs;
  }
  return Object.keys(safe).length === 0 ? undefined : Object.freeze(safe);
}

function sanitizeOperationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = redactSensitiveText(value);
  return /^[A-Za-z0-9._:-]{1,128}$/.test(safe) ? safe : undefined;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function ownDataProperty(
  record: Record<string, unknown>,
  key: string,
): { readonly found: boolean; readonly value?: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor
      ? { found: true, value: descriptor.value }
      : { found: false };
  } catch {
    return { found: false };
  }
}

function ownValue(record: Record<string, unknown> | undefined, key: string): unknown {
  return record ? ownDataProperty(record, key).value : undefined;
}

function isProviderErrorCode(value: unknown): value is ProviderErrorCode {
  return typeof value === "string" &&
    (PROVIDER_ERROR_CODES as readonly string[]).includes(value);
}

function brandProviderError(
  code: ProviderErrorCode,
  metadata: ProviderErrorMetadata | undefined,
): ProviderError {
  const error = metadata === undefined
    ? { code, message: publicErrorMessages[code] }
    : { code, message: publicErrorMessages[code], metadata };
  return Object.defineProperty(error, providerErrorBrand, { value: true }) as ProviderError;
}

function brandOperationResult<T>(result: object): OperationResult<T> {
  return Object.defineProperty(result, operationResultBrand, { value: true }) as OperationResult<T>;
}

function malformedResult(): SerializedOperationResult<never> {
  return {
    status: "error",
    error: {
      code: "execution_failure",
      message: publicErrorMessages.execution_failure,
    },
  };
}

/** Best-effort for diagnostics only; never treat regex redaction as a complete secret-removal guarantee. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(authorization|proxy-authorization)\s*[:=][^\r\n]*/gi, "$1: [REDACTED]")
    .replace(/\b(cookie|set-cookie)\s*[:=][^\r\n]*/gi, "$1: [REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|(?:auth|access|refresh|session)?[_-]?token|client[_-]?secret|credential|password|passphrase|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2[REDACTED]",
    );
}