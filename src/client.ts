/**
 * The single HERE HTTP client.
 *
 * Responsibilities:
 *   - one place that knows HERE's base URLs and injects `apiKey`
 *   - a hard per-request timeout (default 20 s)
 *   - bounded retries with exponential backoff + jitter on 429/5xx and
 *     network failures, honouring `Retry-After`
 *   - typed errors ({@link HereApiError} etc.) with a stable JSON shape
 *   - the API key is never logged: URLs are redacted before they reach a log
 *     line or an error message
 */
import type { Config, Service } from './config.js';
import {
  HereApiError,
  HereNetworkError,
  HereTimeoutError,
  HereValidationError,
} from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { buildSearchParams, type QueryValue } from './util/params.js';

export interface HereRequestInit {
  method?: 'GET' | 'POST';
  query?: Record<string, QueryValue>;
  /**
   * Parameters that HERE expects REPEATED (`via=…&via=…`), not comma-joined.
   * Only a handful of HERE params use form/explode=true; `via` is the main one.
   */
  repeatQuery?: Record<string, readonly string[]>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /**
   * Fetch redirect policy. The matrix status endpoint answers 303 with a
   * Location header, which we must inspect ourselves so the apiKey survives.
   */
  redirect?: 'follow' | 'manual' | 'error';
  /** Non-2xx statuses to treat as a successful response (body still parsed). */
  acceptStatus?: number[];
}

export interface HereResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  durationMs: number;
  /** Sanitised request URL (apiKey redacted) — safe to log or return. */
  url: string;
}

export interface HereBinaryResponse {
  buffer: Buffer;
  status: number;
  headers: Headers;
  contentType?: string;
  durationMs: number;
  url: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDACTED = 'REDACTED';

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class HereClient {
  readonly config: Config;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(
    config: Config,
    options: { fetchImpl?: typeof fetch; logger?: Logger } = {},
  ) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = options.logger ?? createLogger(config.logLevel).child('here');
  }

  /** Number of retries actually available for a request. */
  private retriesFor(init: HereRequestInit): number {
    return init.retries ?? this.config.maxRetries;
  }

  /**
   * Build the absolute request URL for a service + path.
   *
   * `path` may be an absolute URL: HERE's matrix API returns `statusUrl` /
   * `resultUrl` on a different host (and redirects the result to S3), and
   * those URLs carry their own authorisation — the apiKey is not appended.
   *
   * When `includeApiKey` is false the URL is still fully formed but carries no
   * credential — used for returnable map-image URLs and error messages.
   */
  buildUrl(
    service: Service,
    path: string,
    query: Record<string, QueryValue> = {},
    options: { includeApiKey?: boolean; repeatQuery?: Record<string, readonly string[]> } = {},
  ): URL {
    const absolute = /^https?:\/\//i.test(path);
    let url: URL;
    if (absolute) {
      url = new URL(path);
    } else {
      const base = this.config.bases[service];
      if (!base) throw new HereValidationError(`Unknown HERE service "${service}"`);
      const suffix = path.startsWith('/') ? path : `/${path}`;
      url = new URL(`${base}${suffix}`);
    }
    // Absolute URLs returned by HERE (matrix statusUrl/resultUrl) live on
    // *.hereapi.com and still need the apiKey — but an S3 presigned redirect
    // must NOT be altered, so only hereapi.com hosts get the key.
    const isHereHost = /(^|\.)hereapi\.com$/i.test(url.hostname);
    const withKey =
      options.includeApiKey !== false &&
      (absolute ? isHereHost && !url.searchParams.has('apiKey') : true);
    const params = buildSearchParams(query, withKey ? this.config.apiKey : undefined);
    for (const [key, value] of params.entries()) url.searchParams.append(key, value);
    for (const [key, values] of Object.entries(options.repeatQuery ?? {})) {
      for (const value of values) url.searchParams.append(key, value);
    }
    return url;
  }

  /** Replace the apiKey value (and any bare occurrence of it) with REDACTED. */
  redact(text: string): string {
    let output = text.split(this.config.apiKey).join(REDACTED);
    try {
      const url = new URL(output);
      if (url.searchParams.has('apiKey')) {
        url.searchParams.set('apiKey', REDACTED);
        output = url.toString();
      }
    } catch {
      // not a URL — leave the string replacement as-is
    }
    return output;
  }

  /**
   * Perform a JSON request against a HERE service, retrying transient failures.
   */
  async requestJson<T>(
    service: Service,
    path: string,
    init: HereRequestInit = {},
  ): Promise<HereResponse<T>> {
    const response = await this.execute(service, path, init);
    const text = response.body.toString('utf8');
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new HereApiError(
        `HERE ${service} returned a non-JSON response (HTTP ${response.status})`,
        response.status,
        service,
        false,
        'invalidJson',
        { bodyPreview: text.slice(0, 300) },
      );
    }
    return {
      data: parsed as T,
      status: response.status,
      headers: response.headers,
      durationMs: response.durationMs,
      url: response.url,
    };
  }

  /**
   * Perform a request whose response is binary (static map images).
   */
  async requestBuffer(
    service: Service,
    path: string,
    init: HereRequestInit = {},
  ): Promise<HereBinaryResponse> {
    const response = await this.execute(service, path, init);
    return {
      buffer: response.body,
      status: response.status,
      headers: response.headers,
      ...(response.contentType ? { contentType: response.contentType } : {}),
      durationMs: response.durationMs,
      url: response.url,
    };
  }

  private async execute(
    service: Service,
    path: string,
    init: HereRequestInit,
  ): Promise<{
    body: Buffer;
    status: number;
    headers: Headers;
    durationMs: number;
    url: string;
    contentType?: string;
  }> {
    const method = init.method ?? 'GET';
    const url = this.buildUrl(service, path, init.query ?? {}, {
      ...(init.repeatQuery ? { repeatQuery: init.repeatQuery } : {}),
    });
    const safeUrl = this.redact(url.toString());
    const maxRetries = this.retriesFor(init);
    const timeoutMs = init.timeoutMs ?? this.config.timeoutMs;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        const baseDelay = Math.min(8_000, this.config.retryBaseMs * 2 ** (attempt - 1));
        const jitter = Math.floor(Math.random() * 100);
        let delay = baseDelay + jitter;
        if (lastError instanceof HereApiError && lastError.retryAfterMs !== undefined) {
          delay = Math.max(delay, Math.min(30_000, lastError.retryAfterMs));
        }
        this.logger.debug('retrying HERE request', {
          service,
          attempt,
          delayMs: delay,
          status: lastError instanceof HereApiError ? lastError.status : undefined,
        });
        await sleep(delay);
      }

      const started = Date.now();
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      this.logger.debug('HERE request', { service, method, url: safeUrl, attempt });

      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          signal: controller.signal,
          redirect: init.redirect ?? 'follow',
          headers: {
            accept: 'application/json',
            // The matrix result endpoint requires gzip and may 303-redirect to
            // object storage; Node's fetch follows redirects and decompresses.
            'accept-encoding': 'gzip, deflate',
            'user-agent': this.config.userAgent,
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(init.headers ?? {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        if (timedOut) {
          lastError = new HereTimeoutError(
            `HERE ${service} request timed out after ${timeoutMs} ms`,
            service,
            timeoutMs,
          );
        } else {
          const cause = error instanceof Error ? error.message : String(error);
          lastError = new HereNetworkError(
            `Could not reach HERE ${service} (${cause})`,
            service,
            cause,
          );
        }
        if (attempt >= maxRetries) break;
        continue;
      }

      let body: Buffer;
      try {
        body = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        clearTimeout(timer);
        const cause = error instanceof Error ? error.message : String(error);
        lastError = new HereNetworkError(
          `Failed reading HERE ${service} response (${cause})`,
          service,
          cause,
        );
        if (attempt >= maxRetries) break;
        continue;
      }
      clearTimeout(timer);
      const durationMs = Date.now() - started;

      if (response.ok || (init.acceptStatus?.includes(response.status) ?? false)) {
        const contentType = response.headers.get('content-type') ?? undefined;
        return {
          body,
          status: response.status,
          headers: response.headers,
          durationMs,
          url: safeUrl,
          ...(contentType ? { contentType } : {}),
        };
      }

      const errorBody = this.parseErrorBody(body);
      const status = response.status;
      const retryable = isRetryableStatus(status);
      const retryAfterMs = parseRetryAfter(response.headers);
      const message =
        errorBody.message ??
        `HERE ${service} API returned HTTP ${status} ${response.statusText}`.trim();

      lastError = new HereApiError(
        this.redact(message),
        status,
        service,
        retryable,
        errorBody.code,
        {
          ...(errorBody.details !== undefined ? { response: errorBody.details } : {}),
          requestUrl: safeUrl,
        },
        retryAfterMs,
      );

      if (!retryable || attempt >= maxRetries) break;
    }

    if (lastError instanceof HereApiError) throw lastError;
    if (lastError instanceof HereTimeoutError) throw lastError;
    if (lastError instanceof HereNetworkError) throw lastError;
    throw new HereApiError(
      `HERE ${service} request failed`,
      0,
      service,
      false,
      'unknown',
    );
  }

  private parseErrorBody(body: Buffer): {
    message?: string;
    code?: string;
    details?: unknown;
  } {
    const text = body.toString('utf8').trim();
    if (text.length === 0) return {};
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const message =
        (typeof parsed.error_description === 'string' && parsed.error_description) ||
        (typeof parsed.message === 'string' && parsed.message) ||
        (typeof parsed.title === 'string' && parsed.title) ||
        (typeof parsed.error === 'string' && parsed.error) ||
        undefined;
      const code =
        (typeof parsed.error === 'string' && parsed.error) ||
        (typeof parsed.code === 'string' && parsed.code) ||
        undefined;
      return {
        ...(message ? { message } : {}),
        ...(code ? { code } : {}),
        details: this.redactJson(parsed),
      };
    } catch {
      return { message: this.redact(text.slice(0, 300)) };
    }
  }

  private redactJson(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.redactJson(item));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key.toLowerCase() === 'apikey') {
          out[key] = REDACTED;
        } else {
          out[key] = this.redactJson(item);
        }
      }
      return out;
    }
    return value;
  }
}
