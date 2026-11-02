/**
 * Typed errors for the HERE client + tools, and their stable JSON shape.
 *
 * Every error that reaches a tool result is serialised through
 * {@link serializeError} so an agent always receives the same structure:
 *
 * ```json
 * { "ok": false, "error": { "type": "API_ERROR", "message": "...", "status": 401,
 *   "service": "routing", "retryable": false } }
 * ```
 *
 * The HERE API key is never included in an error message (the client redacts it
 * defensively as well).
 */

export type ErrorType = 'CONFIG_ERROR' | 'VALIDATION_ERROR' | 'API_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT_ERROR' | 'INTERNAL_ERROR';

export interface StructuredError {
  type: ErrorType;
  message: string;
  status?: number;
  service?: string;
  /** HERE error code from the response body, e.g. `apiKey invalid`. */
  code?: string;
  retryable?: boolean;
  details?: unknown;
}

export class HereValidationError extends Error {
  readonly type: ErrorType = 'VALIDATION_ERROR';
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = 'HereValidationError';
  }
}

export class HereApiError extends Error {
  readonly type: ErrorType = 'API_ERROR';
  constructor(
    message: string,
    readonly status: number,
    readonly service: string,
    readonly retryable: boolean,
    readonly code?: string,
    readonly details?: unknown,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HereApiError';
  }
}

export class HereNetworkError extends Error {
  readonly type: ErrorType = 'NETWORK_ERROR';
  readonly retryable = true;
  constructor(message: string, readonly service: string, readonly causeMessage?: string) {
    super(message);
    this.name = 'HereNetworkError';
  }
}

export class HereTimeoutError extends Error {
  readonly type: ErrorType = 'TIMEOUT_ERROR';
  readonly retryable = true;
  constructor(message: string, readonly service: string, readonly timeoutMs: number) {
    super(message);
    this.name = 'HereTimeoutError';
  }
}

export class HereInternalError extends Error {
  readonly type: ErrorType = 'INTERNAL_ERROR';
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = 'HereInternalError';
  }
}

export class HereConfigError extends Error {
  readonly type: ErrorType = 'CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'HereConfigError';
  }
}

const REDACTED = '[redacted]';

/**
 * Serialise any thrown value into the stable structured error an agent sees.
 * `apiKey` is optional and is redacted from every string just in case.
 */
export function serializeError(err: unknown, apiKey?: string): StructuredError {
  const redact = (text: string): string =>
    apiKey && apiKey.length > 0 ? text.split(apiKey).join(REDACTED) : text;

  if (err instanceof HereApiError) {
    return {
      type: 'API_ERROR',
      message: redact(err.message),
      status: err.status,
      service: err.service,
      ...(err.code ? { code: redact(err.code) } : {}),
      retryable: err.retryable,
      ...(err.details !== undefined ? { details: redactDeep(err.details, apiKey) } : {}),
    };
  }
  if (err instanceof HereValidationError) {
    return {
      type: 'VALIDATION_ERROR',
      message: redact(err.message),
      ...(err.details !== undefined ? { details: redactDeep(err.details, apiKey) } : {}),
    };
  }
  if (err instanceof HereNetworkError) {
    return {
      type: 'NETWORK_ERROR',
      message: redact(err.message),
      service: err.service,
      retryable: true,
      ...(err.causeMessage ? { code: redact(err.causeMessage) } : {}),
    };
  }
  if (err instanceof HereTimeoutError) {
    return {
      type: 'TIMEOUT_ERROR',
      message: redact(err.message),
      service: err.service,
      retryable: true,
    };
  }
  if (err instanceof HereConfigError) {
    return { type: 'CONFIG_ERROR', message: redact(err.message) };
  }
  if (err instanceof HereInternalError) {
    return {
      type: 'INTERNAL_ERROR',
      message: redact(err.message),
      ...(err.details !== undefined ? { details: redactDeep(err.details, apiKey) } : {}),
    };
  }
  if (err instanceof Error) {
    return { type: 'INTERNAL_ERROR', message: redact(err.message || err.name) };
  }
  return { type: 'INTERNAL_ERROR', message: redact(String(err)) };
}

function redactDeep(value: unknown, apiKey?: string): unknown {
  if (!apiKey || apiKey.length === 0) return value;
  if (typeof value === 'string') return value.split(apiKey).join(REDACTED);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, apiKey));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(item, apiKey);
    }
    return out;
  }
  return value;
}
