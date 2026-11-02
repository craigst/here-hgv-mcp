/**
 * Configuration for the HERE HGV MCP server.
 *
 * All configuration is environment driven so the server can run identically
 * under a harness (stdio) or in the gateway / Omb bots (Streamable HTTP).
 * The HERE API key is NEVER written to disk, logged or echoed in errors.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SERVICE_IDS = [
  'geocode',
  'reverseGeocode',
  'discover',
  'browse',
  'autosuggest',
  'routing',
  'matrix',
  'isoline',
  'traffic',
  'waypointSequence',
  'mapImage',
] as const;

export type Service = (typeof SERVICE_IDS)[number];

export const DEFAULT_BASES: Readonly<Record<Service, string>> = {
  geocode: 'https://geocode.search.hereapi.com',
  reverseGeocode: 'https://revgeocode.search.hereapi.com',
  discover: 'https://discover.search.hereapi.com',
  browse: 'https://browse.search.hereapi.com',
  autosuggest: 'https://autosuggest.search.hereapi.com',
  routing: 'https://router.hereapi.com',
  matrix: 'https://matrix.router.hereapi.com',
  isoline: 'https://isoline.router.hereapi.com',
  traffic: 'https://data.traffic.hereapi.com',
  waypointSequence: 'https://wps.hereapi.com',
  mapImage: 'https://image.maps.hereapi.com/mia/v3',
};

const BASE_ENV: Readonly<Record<Service, string>> = {
  geocode: 'HERE_BASE_GEOCODE',
  reverseGeocode: 'HERE_BASE_REVERSE_GEOCODE',
  discover: 'HERE_BASE_DISCOVER',
  browse: 'HERE_BASE_BROWSE',
  autosuggest: 'HERE_BASE_AUTOSUGGEST',
  routing: 'HERE_BASE_ROUTING',
  matrix: 'HERE_BASE_MATRIX',
  isoline: 'HERE_BASE_ISOLINE',
  traffic: 'HERE_BASE_TRAFFIC',
  waypointSequence: 'HERE_BASE_WAYPOINT_SEQUENCE',
  mapImage: 'HERE_BASE_MAP_IMAGE',
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface HereDefaults {
  /** ISO 3166-1 alpha-3 country focus used when a tool does not specify one. */
  country: string;
  /** BCP-47 language used for localised names and instructions. */
  lang: string;
  /** ISO 4217 currency used for toll costs. */
  currency: string;
  /** Unit system sent to HERE (metric by default for the UK). */
  units: 'metric' | 'imperial';
}

export interface Config {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  userAgent: string;
  logLevel: LogLevel;
  bases: Record<Service, string>;
  defaults: HereDefaults;
  /** Present when the server should listen over Streamable HTTP. */
  httpPort?: number;
  httpHost: string;
  /** Stateless HTTP mode: one fresh transport per request, no session ids. */
  statelessHttp: boolean;
  /** Directory static map images may be written to (never outside it). */
  mapOutputDir: string;
}

export class ConfigError extends Error {
  readonly code = 'CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readString(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = readString(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false, 1/0) (got "${raw}")`);
}

function readEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readString(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
  }
  return raw as T;
}

function normaliseBaseUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL (got "${value}")`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${name} must use http or https (got "${value}")`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * Load and validate configuration from the given environment.
 * Throws {@link ConfigError} with an actionable message on bad input.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = readString(env, 'HERE_API_KEY');
  if (!apiKey) {
    throw new ConfigError(
      'HERE_API_KEY is required. Set it in the environment (or in a gitignored .env file) — it is never logged.',
    );
  }

  const bases = { ...DEFAULT_BASES };
  for (const service of SERVICE_IDS) {
    const override = readString(env, BASE_ENV[service]);
    if (override) bases[service] = normaliseBaseUrl(BASE_ENV[service], override);
  }

  const httpPortRaw =
    readString(env, 'HTTP_PORT') ?? readString(env, 'MCP_HTTP_PORT');
  let httpPort: number | undefined;
  if (httpPortRaw !== undefined) {
    const value = Number(httpPortRaw);
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      throw new ConfigError(`HTTP_PORT/MCP_HTTP_PORT must be an integer 0-65535 (got "${httpPortRaw}")`);
    }
    httpPort = value;
  }

  const country = (readString(env, 'HERE_DEFAULT_COUNTRY') ?? 'GBR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(country)) {
    throw new ConfigError('HERE_DEFAULT_COUNTRY must be an ISO 3166-1 alpha-3 code such as GBR');
  }

  const lang = readString(env, 'HERE_DEFAULT_LANG') ?? 'en-GB';
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) {
    throw new ConfigError(`HERE_DEFAULT_LANG must be a BCP-47 language tag such as en-GB (got "${lang}")`);
  }

  const currency = (readString(env, 'HERE_DEFAULT_CURRENCY') ?? 'GBP').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ConfigError('HERE_DEFAULT_CURRENCY must be an ISO 4217 code such as GBP');
  }

  const mapOutputDir =
    readString(env, 'HERE_MAP_OUTPUT_DIR') ?? join(tmpdir(), 'here-hgv-mcp-maps');

  const config: Config = {
    apiKey,
    timeoutMs: readInt(env, 'HERE_TIMEOUT_MS', 20_000, 1_000, 120_000),
    maxRetries: readInt(env, 'HERE_MAX_RETRIES', 2, 0, 5),
    retryBaseMs: readInt(env, 'HERE_RETRY_BASE_MS', 250, 1, 10_000),
    userAgent: readString(env, 'HERE_USER_AGENT') ?? 'here-hgv-mcp/1.0.0',
    logLevel: readEnum(env, 'HERE_LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'] as const, 'warn'),
    bases,
    defaults: {
      country,
      lang,
      currency,
      units: readEnum(env, 'HERE_DEFAULT_UNITS', ['metric', 'imperial'] as const, 'metric'),
    },
    httpHost: readString(env, 'MCP_HTTP_HOST') ?? '0.0.0.0',
    statelessHttp: readBool(env, 'MCP_STATELESS', false),
    mapOutputDir,
    ...(httpPort !== undefined ? { httpPort } : {}),
  };

  return config;
}

/** True when the server was asked to run over Streamable HTTP. */
export function wantsHttp(config: Config): boolean {
  return config.httpPort !== undefined;
}
