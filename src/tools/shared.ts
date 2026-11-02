/**
 * Shared plumbing for all tools: result envelopes, place resolution, the HGV
 * truck profile, avoid-option builders and input validation helpers.
 */
import { z } from 'zod';
import type { HereClient } from '../client.js';
import type { Config } from '../config.js';
import { HereValidationError, serializeError } from '../errors.js';
import { formatLatLng, parseLatLng, type LatLng } from '../util/geo.js';
import {
  metresToCentimetres,
  toCommaList,
  type QueryValue,
} from '../util/params.js';

export interface ToolContext {
  client: HereClient;
  config: Config;
}

export interface ToolTextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Standard success envelope: JSON first (stable, machine readable), then an
 * optional compact human summary as a second text block.
 */
export function jsonResult(payload: Record<string, unknown>, humanSummary?: string): ToolResult {
  const body = { ok: true as const, ...payload };
  const content: ToolTextContent[] = [
    { type: 'text', text: JSON.stringify(body, null, 2) },
  ];
  if (humanSummary && humanSummary.trim().length > 0) {
    content.push({ type: 'text', text: humanSummary.trim() });
  }
  return { content };
}

/** Standard failure envelope — always a structured, non-throwing result. */
export function errorResult(error: unknown, context: ToolContext): ToolResult {
  const structured = serializeError(error, context.config.apiKey);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, error: structured }, null, 2),
      },
    ],
    isError: true,
  };
}

/** Run a tool body, converting any thrown error into a structured tool error. */
export async function runTool(
  context: ToolContext,
  work: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await work();
  } catch (error) {
    return errorResult(error, context);
  }
}

/* ------------------------------------------------------------------ */
/* Place resolution (coordinates or address)                          */
/* ------------------------------------------------------------------ */

export interface ResolvedPlace {
  input: string;
  point: LatLng;
  /** Human label: the address title when geocoded, else the input coordinates. */
  label: string;
  /** True when the input was free text and had to be geocoded first. */
  geocoded: boolean;
  countryCode?: string;
}

interface GeocodeItemShape {
  title?: string;
  resultType?: string;
  position?: { lat?: number; lng?: number };
  access?: { lat?: number; lng?: number }[];
  address?: { label?: string; countryCode?: string };
}

/**
 * Accept either a `"lat,lng"` pair or free-text address and return a point.
 * Free text is geocoded through HERE using the configured country focus.
 */
export async function resolvePlace(
  context: ToolContext,
  input: string,
  options: { country?: string; lang?: string } = {},
): Promise<ResolvedPlace> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new HereValidationError('A location string is required (either "lat,lng" or an address)');
  }
  const direct = parseLatLng(trimmed);
  if (direct) {
    return {
      input: trimmed,
      point: direct,
      label: formatLatLng(direct),
      geocoded: false,
    };
  }

  const country = options.country ?? context.config.defaults.country;
  const lang = options.lang ?? context.config.defaults.lang;
  const response = await context.client.requestJson<{ items?: GeocodeItemShape[] }>(
    'geocode',
    '/v1/geocode',
    {
      query: {
        q: trimmed,
        in: country ? `countryCode:${country}` : undefined,
        limit: 1,
        lang,
      },
    },
  );
  const item = response.data.items?.[0];
  const position = item?.position;
  const point =
    position && Number.isFinite(position.lat) && Number.isFinite(position.lng)
      ? { lat: position.lat as number, lng: position.lng as number }
      : undefined;
  if (!point) {
    throw new HereValidationError(
      `Could not resolve "${trimmed}" to a location. Supply coordinates as "lat,lng" or a more specific address.`,
      { input: trimmed, country },
    );
  }
  const label = item?.title ?? item?.address?.label ?? trimmed;
  return {
    input: trimmed,
    point,
    label,
    geocoded: true,
    ...(item?.address?.countryCode ? { countryCode: item.address.countryCode } : {}),
  };
}

/** Resolve several places in order (used by matrix and multi-stop tools). */
export async function resolvePlaces(
  context: ToolContext,
  inputs: string[],
  options: { country?: string; lang?: string; max?: number } = {},
): Promise<ResolvedPlace[]> {
  const max = options.max ?? 25;
  if (inputs.length > max) {
    throw new HereValidationError(`At most ${max} locations can be resolved in one call (got ${inputs.length})`);
  }
  return Promise.all(inputs.map((input) => resolvePlace(context, input, options)));
}

/* ------------------------------------------------------------------ */
/* Truck / HGV profile                                                */
/* ------------------------------------------------------------------ */

/**
 * Hazardous-goods classes accepted by HERE Routing v8
 * `vehicle[shippedHazardousGoods]` (verified live).
 */
export const HAZARDOUS_GOODS = [
  'explosive',
  'gas',
  'flammable',
  'liquid',
  'harmful',
  'toxic',
  'combustible',
  'organic',
  'poison',
  'radioactive',
  'corrosive',
  'poisonous',
  'dangerous',
  'other',
  'none',
] as const;

/**
 * ADR cargo tunnel restriction categories. `A` means "no restriction" and is
 * accepted by HERE; B–E progressively restrict which tunnels may be used.
 */
export const TUNNEL_CATEGORIES = ['A', 'B', 'C', 'D', 'E'] as const;

/** HERE Routing v8 `vehicle[category]` values. */
export const TRUCK_CATEGORIES = ['undefined', 'lightTruck'] as const;

/** HERE Routing v8 avoid features, plus v7-era aliases agents commonly use. */
export const AVOID_FEATURES = [
  'seasonalClosure',
  'tollRoad',
  'tollroad',
  'controlledAccessHighway',
  'motorway',
  'ferry',
  'carShuttleTrain',
  'tunnel',
  'dirtRoad',
  'difficultTurns',
  'uTurns',
] as const;

export const EMISSION_TYPES = [
  'euro0',
  'euro1',
  'euro2',
  'euro3',
  'euro4',
  'euro5',
  'euro6',
  'none',
] as const;

const metres = (min: number, max: number, description: string) =>
  z.number().min(min).max(max).describe(description);

/**
 * The HGV profile (HERE Routing v8 `vehicle[...]`). Dimensions are METRES and
 * weights KILOGRAMS (ergonomic for humans/agents); they are converted to
 * HERE's centimetres internally.
 *
 * NOTE: HERE v8 has no `vehicle[emissionType]` and no `vehicle[limitedWeight]`;
 * neither is advertised here. Emission class is a toll attribute and is passed
 * as `tolls[emissionType]` by the route/tolls tools.
 */
export const truckProfileSchema = z
  .object({
    heightM: metres(0.5, 5.0, 'Overall vehicle height in metres (e.g. 4.2 for a 4.2 m trailer). Sent as vehicle[height] in centimetres.').optional(),
    widthM: metres(0.5, 5.0, 'Overall vehicle width in metres (e.g. 2.55). Sent as vehicle[width] in centimetres.').optional(),
    lengthM: metres(1, 30, 'Overall vehicle length in metres including trailers (e.g. 16.5). Sent as vehicle[length] in centimetres.').optional(),
    grossWeightKg: z.number().min(0).max(80_000).describe('Gross vehicle weight in kilograms including load and trailers (e.g. 44000 for 44 t).').optional(),
    weightPerAxleKg: z.number().min(0).max(30_000).describe('Heaviest weight on any single axle, in kilograms.').optional(),
    axleCount: z.number().int().min(2).max(99).describe('Total number of axles on vehicle + trailers (HERE minimum is 2).').optional(),
    trailerCount: z.number().int().min(0).max(9).describe('Number of trailers attached (0 for a rigid lorry).').optional(),
    trailerAxleCount: z.number().int().min(1).max(99).describe('Number of axles across the trailers (only meaningful with trailers).').optional(),
    shippedHazardousGoods: z
      .array(z.enum(HAZARDOUS_GOODS))
      .max(15)
      .describe('ADR hazardous goods carried. Any entry makes the router apply hazmat tunnel/road restrictions. Empty/omitted = none.')
      .optional(),
    tunnelCategory: z
      .enum(TUNNEL_CATEGORIES)
      .describe('ADR cargo tunnel restriction category (A=unrestricted, B/C/D/E increasingly restrictive). The route uses only tunnels of a less restrictive category.')
      .optional(),
    category: z
      .enum(TRUCK_CATEGORIES)
      .describe('HERE vehicle category: "undefined" (normal HGV routing) or "lightTruck".')
      .optional(),
    licensePlate: z
      .string()
      .min(2)
      .max(16)
      .describe('Optional plate (HERE uses the last characters for environmental-zone restrictions).')
      .optional(),
  })
  .describe('HGV profile. Only used when transportMode is "truck".');

export type TruckProfile = z.infer<typeof truckProfileSchema>;

export interface TruckParamsResult {
  params: Record<string, QueryValue>;
  /** Plain-English notes for the agent about mappings/ignored fields. */
  notices: string[];
}

/**
 * Map the ergonomic profile onto HERE Routing v8 `vehicle[...]` parameters.
 * (HERE v8 accepts `vehicle[...]`; `truck[...]` is the deprecated spelling.)
 */
export function buildRoutingTruckParams(
  profile: TruckProfile | undefined,
  transportMode: string,
): TruckParamsResult {
  const params: Record<string, QueryValue> = {};
  const notices: string[] = [];
  if (!profile) return { params, notices };

  if (transportMode !== 'truck') {
    notices.push(
      `HGV profile ignored because transportMode="${transportMode}". Use transportMode="truck" for HGV restrictions.`,
    );
    return { params, notices };
  }

  const set = (name: string, value: number | string | string[] | undefined): void => {
    if (value === undefined) return;
    params[`vehicle[${name}]`] = value;
  };

  if (profile.heightM !== undefined) set('height', metresToCentimetres(profile.heightM));
  if (profile.widthM !== undefined) set('width', metresToCentimetres(profile.widthM));
  if (profile.lengthM !== undefined) set('length', metresToCentimetres(profile.lengthM));
  if (profile.grossWeightKg !== undefined) set('grossWeight', Math.round(profile.grossWeightKg));
  if (profile.weightPerAxleKg !== undefined) set('weightPerAxle', Math.round(profile.weightPerAxleKg));
  if (profile.axleCount !== undefined) set('axleCount', profile.axleCount);
  if (profile.trailerCount !== undefined) set('trailerCount', profile.trailerCount);
  if (profile.trailerAxleCount !== undefined) set('trailerAxleCount', profile.trailerAxleCount);
  if (profile.shippedHazardousGoods && profile.shippedHazardousGoods.length > 0) {
    const goods = profile.shippedHazardousGoods.filter((item) => item !== 'none');
    if (goods.length > 0) {
      set('shippedHazardousGoods', toCommaList(goods));
    } else {
      notices.push('shippedHazardousGoods contained only "none"; no hazmat restriction sent.');
    }
  }
  if (profile.tunnelCategory !== undefined) set('tunnelCategory', profile.tunnelCategory);
  if (profile.category !== undefined) set('category', profile.category);
  if (profile.licensePlate !== undefined) set('licensePlate', profile.licensePlate);

  return { params, notices };
}

/* ------------------------------------------------------------------ */
/* Avoid options                                                      */
/* ------------------------------------------------------------------ */

export const avoidOptionsSchema = z
  .object({
    features: z
      .array(z.enum(AVOID_FEATURES))
      .max(9)
      .describe('Road features to avoid, e.g. ["tollRoad","ferry"]. v7 aliases "tollroad" and "motorway" are mapped to tollRoad / controlledAccessHighway.')
      .optional(),
    areas: z
      .array(z.string().min(1))
      .max(20)
      .describe('Areas to avoid: "bbox:west,south,east,north" or "polygon:lat,lng;lat,lng;..." entries (max 20).')
      .optional(),
    countries: z
      .array(z.string().regex(/^[A-Za-z]{3}$/))
      .max(20)
      .describe('ISO 3166-1 alpha-3 country codes to exclude entirely, e.g. ["IRL"].')
      .optional(),
    tollTransponders: z
      .array(z.string().min(1))
      .max(5)
      .describe('Toll transponder systems the vehicle has (HERE currently supports ["all"]).')
      .optional(),
    truckRoadTypes: z
      .array(z.string().min(1))
      .max(20)
      .describe('HERE truck road type identifiers to avoid, e.g. ["BK1","BK2"].')
      .optional(),
  })
  .describe('Road/area avoidance options.');

export type AvoidOptions = z.infer<typeof avoidOptionsSchema>;

export interface AvoidParamsResult {
  params: Record<string, QueryValue>;
  notices: string[];
}

const FEATURE_ALIASES: Record<string, string> = {
  tollroad: 'tollRoad',
  motorway: 'controlledAccessHighway',
};

export function buildAvoidParams(
  avoid: AvoidOptions | undefined,
  options: { matrixStyle?: boolean } = {},
): AvoidParamsResult {
  const params: Record<string, QueryValue> = {};
  const notices: string[] = [];
  if (!avoid) return { params, notices };

  if (avoid.features && avoid.features.length > 0) {
    const mapped = avoid.features.map((feature) => FEATURE_ALIASES[feature] ?? feature);
    const deduped = [...new Set(mapped)];
    for (const feature of avoid.features) {
      const target = FEATURE_ALIASES[feature];
      if (target) notices.push(`avoid feature "${feature}" mapped to HERE v8 "${target}".`);
    }
    params['avoid[features]'] = toCommaList(deduped);
  }
  if (avoid.areas && avoid.areas.length > 0) {
    params['avoid[areas]'] = avoid.areas.join('|');
  }
  if (avoid.countries && avoid.countries.length > 0) {
    params['exclude[countries]'] = toCommaList(
      avoid.countries.map((code) => code.toUpperCase()),
    );
  }
  if (avoid.tollTransponders && avoid.tollTransponders.length > 0) {
    params['avoid[tollTransponders]'] = toCommaList(avoid.tollTransponders);
  }
  if (avoid.truckRoadTypes && avoid.truckRoadTypes.length > 0) {
    params['avoid[truckRoadTypes]'] = toCommaList(avoid.truckRoadTypes);
  }

  // The matrix API takes arrays, not the query-string flavour, but reuses the
  // same object shape. Returning query-style keys keeps a single builder.
  void options.matrixStyle;
  return { params, notices };
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                 */
/* ------------------------------------------------------------------ */

const RFC3339_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate an RFC 3339 timestamp. HERE v8 requires an explicit UTC offset
 * (`Z` or `+hh:mm`); a bare local time is rejected with an actionable message.
 */
export function validateDateTime(value: string, field: string, allowNow = false): string {
  const trimmed = value.trim();
  if (allowNow && trimmed.toLowerCase() === 'now') return trimmed;
  if (!RFC3339_WITH_OFFSET.test(trimmed)) {
    throw new HereValidationError(
      `${field} must be an RFC 3339 timestamp with an explicit UTC offset, e.g. "2026-11-03T08:30:00+00:00" or "2026-11-03T08:30:00Z" (got "${value}").`,
    );
  }
  return trimmed;
}

/** Exactly one of departureTime / arrivalTime may be supplied. */
export function assertNotBoth(
  departureTime: string | undefined,
  arrivalTime: string | undefined,
): void {
  if (departureTime && arrivalTime) {
    throw new HereValidationError('Supply either departureTime or arrivalTime, not both.');
  }
}

/** Round a coordinate list to a predictable precision for labels. */
export function labelFor(point: LatLng): string {
  return formatLatLng(point);
}
