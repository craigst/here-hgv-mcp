/**
 * Query-string construction for HERE APIs.
 *
 * HERE's v7/v8 APIs use three parameter styles that all need to survive the
 * trip through a URL:
 *   - flat params           `limit=5`
 *   - comma lists           `types=address,street`, `lang=en-GB`
 *   - "deep object" params  `truck[height]=420`, `range[type]=time`
 *
 * Repetition is intentionally NOT used: HERE expects comma separated lists.
 * Undefined/null values are dropped so optional tool params behave naturally.
 */

export type QueryScalar = string | number | boolean;

export type QueryObject = { readonly [key: string]: QueryValue };

export type QueryValue =
  | QueryScalar
  | readonly QueryScalar[]
  | QueryObject
  | null
  | undefined;

function scalarToString(value: QueryScalar): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot serialise non-finite number "${value}" as a query parameter`);
    }
    return String(value);
  }
  return value;
}

function appendValue(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    if (value.length === 0) return;
    params.set(key, value.map((item) => scalarToString(item)).join(','));
    return;
  }

  if (typeof value === 'object') {
    for (const [subKey, subValue] of Object.entries(value)) {
      appendValue(params, `${key}[${subKey}]`, subValue as QueryValue);
    }
    return;
  }

  params.set(key, scalarToString(value));
}

/**
 * Build a URLSearchParams from a plain object, applying HERE's conventions.
 * If `apiKey` is supplied it is appended last as `apiKey=...`.
 */
export function buildSearchParams(
  query: Record<string, QueryValue>,
  apiKey?: string,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    appendValue(params, key, value);
  }
  if (apiKey) params.set('apiKey', apiKey);
  return params;
}

/** Join a list of primitives into HERE's comma separated form. */
export function toCommaList(
  values: readonly (string | number)[] | undefined,
): string | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((value) => String(value)).join(',');
}

/** Convert decimal metres to the integer centimetres HERE expects for vehicles. */
export function metresToCentimetres(metres: number): number {
  return Math.round(metres * 100);
}

/** Convert kilograms to the integer kilograms HERE expects (identity for clarity). */
export function kilograms(kg: number): number {
  return Math.round(kg);
}
