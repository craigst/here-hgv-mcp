/**
 * Response shaping.
 *
 * HERE responses are rich but verbose: raw payloads can run to hundreds of
 * kilobytes and use deeply nested structures. Every tool returns a stable,
 * agent-friendly projection instead:
 *   - distances in metres AND a human `distanceText` where useful
 *   - durations in seconds AND `durationText`
 *   - polylines opt-in, never by default
 *   - unknown/absent fields simply omitted rather than `null`
 *
 * The input types are intentionally `unknown`: HERE evolves its schemas and a
 * new field must never crash a tool. Everything is read defensively.
 */
import {
  decodeFlexiblePolyline,
  formatDistance,
  formatDuration,
} from './geo.js';

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pick<T extends keyof JsonObject>(
  source: JsonObject | undefined,
  keys: readonly T[] | readonly string[],
): JsonObject {
  const out: JsonObject = {};
  if (!source) return out;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

function pickDefined(source: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

export interface LatLngOut {
  lat: number;
  lng: number;
}

export function shapePosition(value: unknown): LatLngOut | undefined {
  const position = asObject(value);
  const lat = asNumber(position?.lat);
  const lng = asNumber(position?.lng);
  if (lat === undefined || lng === undefined) return undefined;
  return { lat: round(lat, 6), lng: round(lng, 6) };
}

function shapeAccess(value: unknown): LatLngOut[] | undefined {
  const points = asArray(value)
    .map((entry) => shapePosition(entry))
    .filter((entry): entry is LatLngOut => entry !== undefined);
  return points.length > 0 ? points : undefined;
}

const ADDRESS_FIELDS = [
  'label',
  'countryCode',
  'countryName',
  'stateCode',
  'state',
  'county',
  'city',
  'district',
  'subdistrict',
  'street',
  'block',
  'postalCode',
  'houseNumber',
  'houseNumberType',
] as const;

export function shapeAddress(value: unknown): JsonObject | undefined {
  const address = asObject(value);
  if (!address) return undefined;
  const shaped = pick(address, ADDRESS_FIELDS);
  return Object.keys(shaped).length > 0 ? shaped : undefined;
}

function shapeBoundingBox(value: unknown): JsonObject | undefined {
  const bbox = asObject(value);
  if (!bbox) return undefined;
  const west = asNumber(bbox.west);
  const south = asNumber(bbox.south);
  const east = asNumber(bbox.east);
  const north = asNumber(bbox.north);
  if (west === undefined || south === undefined || east === undefined || north === undefined) {
    return undefined;
  }
  return { west, south, east, north };
}

function shapeCategories(value: unknown): JsonObject[] | undefined {
  const categories = asArray(value)
    .map((entry) => asObject(entry))
    .filter((entry): entry is JsonObject => entry !== undefined)
    .map((entry) => pickDefined(entry, ['id', 'name', 'primary']))
    .filter((entry) => Object.keys(entry).length > 0);
  return categories.length > 0 ? categories : undefined;
}

function shapeContacts(value: unknown): JsonObject | undefined {
  const contacts = asObject(value);
  if (!contacts) return undefined;
  const out: JsonObject = {};
  for (const [key, raw] of Object.entries(contacts)) {
    const entries = asArray(raw)
      .map((entry) => {
        const record = asObject(entry);
        return record ? asString(record.value) ?? undefined : asString(entry);
      })
      .filter((entry): entry is string => entry !== undefined);
    if (entries.length > 0) out[key] = entries;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* ------------------------------------------------------------------ */
/* Geocoding                                                          */
/* ------------------------------------------------------------------ */

export interface PlaceLikeItem {
  title?: string;
  id?: string;
  resultType?: string;
  address?: JsonObject;
  position?: LatLngOut;
  access?: LatLngOut[];
  distanceMeters?: number;
  bbox?: JsonObject;
  categories?: JsonObject[];
  openingHours?: unknown;
  contacts?: JsonObject;
  highlights?: JsonObject;
  /** Present for autosuggest query-term suggestions. */
  queryTerm?: string;
}

function shapeCommonItem(raw: unknown): PlaceLikeItem | undefined {
  const item = asObject(raw);
  if (!item) return undefined;
  const shaped: PlaceLikeItem = {};
  const title = asString(item.title);
  if (title) shaped.title = title;
  const id = asString(item.id);
  if (id) shaped.id = id;
  const resultType = asString(item.resultType);
  if (resultType) shaped.resultType = resultType;
  const address = shapeAddress(item.address);
  if (address) shaped.address = address;
  const position = shapePosition(item.position);
  if (position) shaped.position = position;
  const access = shapeAccess(item.access);
  if (access) shaped.access = access;
  const distance = asNumber(item.distance);
  if (distance !== undefined) shaped.distanceMeters = round(distance, 1);
  const bbox = shapeBoundingBox(item.mapView);
  if (bbox) shaped.bbox = bbox;
  const categories = shapeCategories(item.categories);
  if (categories) shaped.categories = categories;
  if (item.openingHours !== undefined) shaped.openingHours = item.openingHours;
  const contacts = shapeContacts(item.contacts);
  if (contacts) shaped.contacts = contacts;
  const highlights = asObject(item.highlights);
  if (highlights) shaped.highlights = highlights;
  const queryTerm = asString(item.queryTerm);
  if (queryTerm) shaped.queryTerm = queryTerm;
  return Object.keys(shaped).length > 0 ? shaped : undefined;
}

export interface GeocodeShaped {
  count: number;
  items: PlaceLikeItem[];
}

/** Shape a `/v1/geocode` or `/v1/revgeocode` response. */
export function shapeGeocodeResponse(json: unknown): GeocodeShaped {
  const root = asObject(json) ?? {};
  const items = asArray(root.items)
    .map((item) => shapeCommonItem(item))
    .filter((item): item is PlaceLikeItem => item !== undefined);
  return { count: items.length, items };
}

/** Shape a `/v1/discover` or `/v1/browse` response. */
export function shapePlacesResponse(json: unknown): GeocodeShaped {
  const root = asObject(json) ?? {};
  const items = asArray(root.items)
    .map((item) => shapeCommonItem(item))
    .filter((item): item is PlaceLikeItem => item !== undefined);
  return { count: items.length, items };
}

/** Shape a `/v1/autosuggest` response. */
export function shapeAutosuggestResponse(json: unknown): GeocodeShaped {
  return shapePlacesResponse(json);
}

/* ------------------------------------------------------------------ */
/* Routing                                                            */
/* ------------------------------------------------------------------ */

export interface RouteSummaryOut {
  distanceMeters: number;
  distanceKm: number;
  distanceText: string;
  durationSeconds: number;
  durationText: string;
  baseDurationSeconds?: number;
  trafficDelaySeconds?: number;
  typicalDurationSeconds?: number;
  travelDurationSeconds?: number;
}

function shapeSummary(value: unknown): RouteSummaryOut | undefined {
  const summary = asObject(value);
  if (!summary) return undefined;
  const distance = asNumber(summary.length) ?? 0;
  const duration = asNumber(summary.duration) ?? 0;
  const baseDuration = asNumber(summary.baseDuration);
  const typicalDuration = asNumber(summary.typicalDuration);
  const out: RouteSummaryOut = {
    distanceMeters: round(distance, 1),
    distanceKm: round(distance / 1000, 3),
    distanceText: formatDistance(distance),
    durationSeconds: round(duration, 1),
    durationText: formatDuration(duration),
  };
  if (baseDuration !== undefined) {
    out.baseDurationSeconds = round(baseDuration, 1);
    out.trafficDelaySeconds = round(Math.max(0, duration - baseDuration), 1);
  }
  if (typicalDuration !== undefined) out.typicalDurationSeconds = round(typicalDuration, 1);
  const travelDuration = asNumber(summary.travelDuration);
  if (travelDuration !== undefined) out.travelDurationSeconds = round(travelDuration, 1);
  return out;
}

function shapeEndpoint(value: unknown): JsonObject | undefined {
  const endpoint = asObject(value);
  if (!endpoint) return undefined;
  const out: JsonObject = {};
  const time = asString(endpoint.time);
  if (time) out.time = time;
  const place = asObject(endpoint.place);
  if (place) {
    const location = shapePosition(place.location);
    if (location) out.position = location;
    const type = asString(place.type);
    if (type) out.placeType = type;
    const name = asString(place.name);
    if (name) out.name = name;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const NOTICE_DETAIL_LIMIT = 3;

export function shapeNotices(value: unknown, limit = 50): JsonObject[] {
  return asArray(value)
    .slice(0, limit)
    .map((entry) => {
      const notice = asObject(entry);
      if (!notice) return undefined;
      const out: JsonObject = {};
      const code = asString(notice.code);
      if (code) out.code = code;
      const title = asString(notice.title) ?? asString(notice.message);
      if (title) out.message = title;
      const severity = asString(notice.severity);
      if (severity) out.severity = severity;
      const details = asArray(notice.details)
        .slice(0, NOTICE_DETAIL_LIMIT)
        .map((detail) => {
          const record = asObject(detail);
          if (!record) return asString(detail);
          return pickDefined(record, ['code', 'title', 'message', 'value', 'type']);
        })
        .filter((detail) => detail !== undefined);
      if (details.length > 0) out.details = details;
      return Object.keys(out).length > 0 ? out : undefined;
    })
    .filter((notice): notice is JsonObject => notice !== undefined);
}

const INSTRUCTION_KEYS = [
  'action',
  'instruction',
  'direction',
  'severity',
  'turnAngle',
  'duration',
  'length',
  'offset',
  'nextRoadName',
  'currentRoadName',
  'roadName',
  'remainDistance',
  'exitNumber',
  'signpost',
] as const;

const SPAN_KEYS = [
  'offset',
  'length',
  'duration',
  'baseDuration',
  'typicalDuration',
  'names',
  'routeNumbers',
  'functionalClass',
  'countryCode',
  'maxSpeed',
  'dynamicSpeedInfo',
  'gate',
  'railwayCrossing',
  'streetAttributes',
  'truckAttributes',
  'notices',
] as const;

export interface RouteShapingOptions {
  includePolyline?: boolean;
  includePolylinePoints?: boolean;
  includeSpans?: boolean;
  spansMax?: number;
  includeTolls?: boolean;
}

export interface ShapedRoute {
  id?: string;
  routeHandle?: string;
  routeLabels?: JsonObject[];
  summary: RouteSummaryOut;
  legs: JsonObject[];
  instructions?: JsonObject[];
  turnByTurnActions?: JsonObject[];
  spans?: JsonObject[];
  polyline?: JsonObject[];
  tolls?: ShapedTolls;
  notices: JsonObject[];
}

export function shapePolyline(
  encoded: string,
  includePoints: boolean,
): JsonObject {
  const out: JsonObject = { encoded };
  if (includePoints) {
    try {
      out.points = decodeFlexiblePolyline(encoded).points;
    } catch (error) {
      out.decodeError = (error as Error).message;
    }
  }
  return out;
}

function shapeTollsForSections(sections: JsonObject[], currencyFallback?: string): ShapedTolls {
  const details: JsonObject[] = [];
  let totalMin = 0;
  let totalMax = 0;
  let currency: string | undefined;
  sections.forEach((section, legIndex) => {
    for (const rawToll of asArray(section.tolls)) {
      const toll = asObject(rawToll);
      if (!toll) continue;
      const fareValues: number[] = [];
      const fares = asArray(toll.fares)
        .map((rawFare) => {
          const fare = asObject(rawFare) ?? {};
          const price = asObject(fare.price) ?? {};
          const value = asNumber(price.value);
          const priceCurrency = asString(price.currency);
          if (value === undefined) return undefined;
          if (priceCurrency) currency = priceCurrency;
          fareValues.push(value);
          const converted = asObject(fare.convertedPrice);
          const convertedValue = asNumber(converted?.value);
          const convertedCurrency = asString(converted?.currency);
          const pass = asObject(fare.pass);
          const validity = asObject(pass?.validityPeriod);
          return {
            id: asString(fare.id),
            name: asString(fare.name),
            reason: asString(fare.reason),
            price: {
              type: asString(price.type) ?? "value",
              value: round(value, 2),
              currency: priceCurrency ?? currencyFallback ?? "GBP",
            },
            ...(convertedValue !== undefined
              ? {
                  convertedPrice: {
                    type: asString(converted?.type) ?? "value",
                    value: round(convertedValue, 2),
                    currency: convertedCurrency ?? currencyFallback ?? "GBP",
                  },
                }
              : {}),
            ...(validity
              ? { validityPeriod: { period: asString(validity.period), count: asNumber(validity.count) } }
              : {}),
            ...(Array.isArray(fare.paymentMethods)
              ? { paymentMethods: fare.paymentMethods.filter((item) => typeof item === "string") }
              : {}),
          };
        })
        .filter((fare) => fare !== undefined);

      const min = fareValues.length > 0 ? Math.min(...fareValues) : 0;
      const max = fareValues.length > 0 ? Math.max(...fareValues) : 0;
      totalMin += min;
      totalMax += max;
      details.push({
        legIndex,
        countryCode: asString(toll.countryCode),
        tollSystem: asString(toll.tollSystem),
        tollSystemRef: asNumber(toll.tollSystemRef),
        fareCount: fares.length,
        sectionTotalMin: round(min, 2),
        sectionTotalMax: round(max, 2),
        fares,
      });
    }
  });

  return {
    totalCost: round(totalMin, 2),
    totalCostMax: round(totalMax, 2),
    currency: currency ?? currencyFallback ?? "GBP",
    sections: details,
    tolled: totalMin > 0,
  };
}

export interface ShapedTolls {
  totalCost: number;
  totalCostMax: number;
  currency: string;
  sections: JsonObject[];
  tolled: boolean;
}



/** Shape a `/v8/routes` response. */
export function shapeRouteResponse(
  json: unknown,
  options: RouteShapingOptions = {},
): { routes: ShapedRoute[]; notices: JsonObject[]; requestId?: string } {
  const root = asObject(json) ?? {};
  const routes = asArray(root.routes)
    .map((rawRoute) => {
      const route = asObject(rawRoute);
      if (!route) return undefined;
      const sections = asArray(route.sections)
        .map((section) => asObject(section))
        .filter((section): section is JsonObject => section !== undefined);

      const summary = sections.reduce<RouteSummaryOut>(
        (totals, section) => {
          const part = shapeSummary(section.summary);
          if (!part) return totals;
          totals.distanceMeters = round(totals.distanceMeters + part.distanceMeters, 1);
          totals.distanceKm = round(totals.distanceMeters / 1000, 3);
          totals.distanceText = formatDistance(totals.distanceMeters);
          totals.durationSeconds = round(totals.durationSeconds + part.durationSeconds, 1);
          totals.durationText = formatDuration(totals.durationSeconds);
          if (part.baseDurationSeconds !== undefined) {
            totals.baseDurationSeconds = round(
              (totals.baseDurationSeconds ?? 0) + part.baseDurationSeconds,
              1,
            );
          }
          if (part.typicalDurationSeconds !== undefined) {
            totals.typicalDurationSeconds = round(
              (totals.typicalDurationSeconds ?? 0) + part.typicalDurationSeconds,
              1,
            );
          }
          return totals;
        },
        {
          distanceMeters: 0,
          distanceKm: 0,
          distanceText: '0 m',
          durationSeconds: 0,
          durationText: '0 s',
        },
      );
      if (summary.baseDurationSeconds !== undefined) {
        summary.trafficDelaySeconds = round(
          Math.max(0, summary.durationSeconds - summary.baseDurationSeconds),
          1,
        );
      }

      const legs = sections.map((section, index) => ({
        index,
        type: asString(section.type),
        summary: shapeSummary(section.summary),
        travelSummary: shapeSummary(section.travelSummary),
        departure: shapeEndpoint(section.departure),
        arrival: shapeEndpoint(section.arrival),
        notices: shapeNotices(section.notices, 20),
        ...(Array.isArray(section.incidents) && section.incidents.length > 0
          ? { incidentCount: section.incidents.length }
          : {}),
      }));

      const instructions: JsonObject[] = [];
      const turnByTurn: JsonObject[] = [];
      sections.forEach((section, legIndex) => {
        for (const rawAction of asArray(section.actions)) {
          const action = asObject(rawAction);
          if (!action) continue;
          const shaped = pickDefined(action, INSTRUCTION_KEYS);
          if (Object.keys(shaped).length > 0) instructions.push({ legIndex, ...shaped });
        }
        for (const rawAction of asArray(section.turnByTurnActions)) {
          const action = asObject(rawAction);
          if (!action) continue;
          const shaped = pickDefined(action, INSTRUCTION_KEYS);
          if (Object.keys(shaped).length > 0) turnByTurn.push({ legIndex, ...shaped });
        }
      });

      const spans: JsonObject[] = [];
      if (options.includeSpans) {
        const max = options.spansMax ?? 200;
        sections.forEach((section, legIndex) => {
          for (const rawSpan of asArray(section.spans)) {
            if (spans.length >= max) break;
            const span = asObject(rawSpan);
            if (!span) continue;
            spans.push({ legIndex, ...pickDefined(span, SPAN_KEYS) });
          }
        });
      }

      const polyline: JsonObject[] = options.includePolyline
        ? sections
            .map((section, index): JsonObject | undefined => {
              const encoded = asString(section.polyline);
              return encoded
                ? { legIndex: index, ...shapePolyline(encoded, options.includePolylinePoints ?? false) }
                : undefined;
            })
            .filter((entry): entry is JsonObject => entry !== undefined)
        : [];

      const shaped: ShapedRoute = {
        summary,
        legs,
        notices: shapeNotices(route.notices),
      };
      const id = asString(route.id);
      if (id) shaped.id = id;
      const handle = asString(route.routeHandle);
      if (handle) shaped.routeHandle = handle;
      const labels = asArray(route.routeLabels)
        .map((label) => asObject(label))
        .filter((label): label is JsonObject => label !== undefined);
      if (labels.length > 0) shaped.routeLabels = labels;
      if (instructions.length > 0) shaped.instructions = instructions;
      if (turnByTurn.length > 0) shaped.turnByTurnActions = turnByTurn;
      if (spans.length > 0) shaped.spans = spans;
      if (polyline.length > 0) shaped.polyline = polyline;
      if (options.includeTolls) shaped.tolls = shapeTollsForSections(sections);
      return shaped;
    })
    .filter((route): route is ShapedRoute => route !== undefined);

  const out: { routes: ShapedRoute[]; notices: JsonObject[]; requestId?: string } = {
    routes,
    notices: shapeNotices(root.notices),
  };
  const requestId = asString(root.requestId);
  if (requestId) out.requestId = requestId;
  return out;
}

/** Compact human one-liner for a shaped route. */
export function routeHumanSummary(route: ShapedRoute): string {
  const parts = [
    `${route.summary.distanceText} / ${route.summary.durationText}`,
  ];
  if (route.summary.trafficDelaySeconds !== undefined && route.summary.trafficDelaySeconds > 30) {
    parts.push(`traffic +${formatDuration(route.summary.trafficDelaySeconds)}`);
  }
  if (route.tolls) {
    parts.push(
      route.tolls.tolled
        ? `tolls ${route.tolls.currency} ${route.tolls.totalCost.toFixed(2)}`
        : 'no tolls',
    );
  }
  if (route.legs.length > 1) parts.push(`${route.legs.length} legs`);
  return parts.join(', ');
}

/* ------------------------------------------------------------------ */
/* Matrix                                                             */
/* ------------------------------------------------------------------ */

export interface MatrixShaped {
  numOrigins: number;
  numDestinations: number;
  origins: JsonObject[];
  destinations: JsonObject[];
  durationsSeconds: (number | null)[][];
  distancesMeters?: (number | null)[][];
  errorCodes?: number[][];
  matrixId?: string;
}

function chunkMatrix(
  flat: unknown,
  numOrigins: number,
  numDestinations: number,
): (number | null)[][] {
  const values = asArray(flat);
  const rows: (number | null)[][] = [];
  for (let row = 0; row < numOrigins; row += 1) {
    const entries: (number | null)[] = [];
    for (let column = 0; column < numDestinations; column += 1) {
      const index = row * numDestinations + column;
      entries.push(asNumber(values[index]) ?? null);
    }
    rows.push(entries);
  }
  return rows;
}

/** Shape a Matrix v8 result (synchronous response or the async result body). */
export function shapeMatrixResult(
  json: unknown,
  origins: JsonObject[],
  destinations: JsonObject[],
  matrixId?: string,
): MatrixShaped {
  const envelope = asObject(json) ?? {};
  const root = asObject(envelope.matrix) ?? envelope;
  const numOrigins = asNumber(root.numOrigins) ?? origins.length;
  const numDestinations = asNumber(root.numDestinations) ?? destinations.length;
  const shaped: MatrixShaped = {
    numOrigins,
    numDestinations,
    origins,
    destinations,
    durationsSeconds: chunkMatrix(root.travelTimes, numOrigins, numDestinations),
  };
  if (root.distances !== undefined) {
    shaped.distancesMeters = chunkMatrix(root.distances, numOrigins, numDestinations);
  }
  if (Array.isArray(root.errorCodes)) {
    shaped.errorCodes = chunkMatrix(root.errorCodes, numOrigins, numDestinations) as number[][];
  }
  if (matrixId) shaped.matrixId = matrixId;
  return shaped;
}

/* ------------------------------------------------------------------ */
/* Isoline                                                            */
/* ------------------------------------------------------------------ */

export interface IsolineShaped {
  count: number;
  isolines: JsonObject[];
  departure?: JsonObject;
}

/** Shape an `/v8/isolines` response, optionally decoding polygon geometry. */
export function shapeIsolineResponse(json: unknown, includePoints = false): IsolineShaped {
  const root = asObject(json) ?? {};
  const isolines = asArray(root.isolines).map((rawIsoline) => {
    const isoline = asObject(rawIsoline) ?? {};
    const range = asObject(isoline.range);
    const polygons = asArray(isoline.polygons).map((rawPolygon, index) => {
      const polygon = asObject(rawPolygon) ?? {};
      const outerEncoded = asString(polygon.outer);
      const holes = asArray(polygon.inner)
        .map((hole) => asString(hole))
        .filter((hole): hole is string => hole !== undefined);
      const shaped: JsonObject = { index };
      if (outerEncoded) {
        shaped.outer = includePoints
          ? shapePolyline(outerEncoded, true)
          : { encoded: outerEncoded };
      }
      if (holes.length > 0) {
        shaped.holes = includePoints
          ? holes.map((hole) => shapePolyline(hole, true))
          : holes.map((hole) => ({ encoded: hole }));
      }
      return shaped;
    });
    const shaped: JsonObject = {
      range: {
        type: asString(range?.type),
        value: asNumber(range?.value),
      },
      polygonCount: polygons.length,
      polygons,
    };
    if (Array.isArray(isoline.connections) && isoline.connections.length > 0) {
      shaped.connectionCount = isoline.connections.length;
    }
    return shaped;
  });
  const shaped: IsolineShaped = { count: isolines.length, isolines };
  const departure = asObject(root.departure);
  if (departure) {
    shaped.departure = {
      time: asString(departure.time),
      position: shapePosition(asObject(departure.place)?.location),
    };
  }
  return shaped;
}

/* ------------------------------------------------------------------ */
/* Waypoint sequence                                                  */
/* ------------------------------------------------------------------ */

export interface WaypointSequenceShaped {
  order: JsonObject[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  legs: JsonObject[];
  description?: string;
}

/** Shape a Waypoints Sequence `/v8/findsequence2` response. */
export function shapeWaypointSequenceResponse(json: unknown): WaypointSequenceShaped {
  const root = asObject(json) ?? {};
  const result = asObject(asArray(root.results)[0]) ?? {};
  const order = asArray(result.waypoints).map((rawWaypoint) => {
    const waypoint = asObject(rawWaypoint) ?? {};
    return pickDefined(waypoint, [
      'id',
      'sequence',
      'lat',
      'lng',
      'estimatedArrival',
      'estimatedDeparture',
      'cluster',
    ]);
  });
  const legs = asArray(result.interconnections).map((rawLeg) => {
    const leg = asObject(rawLeg) ?? {};
    return {
      fromWaypoint: asString(leg.fromWaypoint),
      toWaypoint: asString(leg.toWaypoint),
      distanceMeters: asNumber(leg.distance),
      durationSeconds: asNumber(leg.time),
      breakSeconds: asNumber(leg.break),
      restSeconds: asNumber(leg.rest),
      waitingSeconds: asNumber(leg.waiting),
      warnings: shapeNotices(leg.warnings),
    };
  });
  const shaped: WaypointSequenceShaped = {
    order,
    totalDistanceMeters: asNumber(result.distance) ?? 0,
    totalDurationSeconds: asNumber(result.time) ?? 0,
    legs,
  };
  const description = asString(result.description);
  if (description) shaped.description = description;
  return shaped;
}

/* ------------------------------------------------------------------ */
/* Traffic                                                            */
/* ------------------------------------------------------------------ */

function shapeDescription(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const record = asObject(value);
  if (!record) return undefined;
  return asString(record.value) ?? asString(record.text) ?? asString(record.label);
}

export function shapeTrafficIncidents(
  json: unknown,
  limit = 50,
): { count: number; incidents: JsonObject[]; summary: JsonObject } {
  const root = asObject(json) ?? {};
  const rawIncidents = asArray(root.results) .length > 0 ? asArray(root.results) : asArray(root.incidents);
  const incidents = rawIncidents
    .slice(0, limit)
    .map((rawIncident) => {
      const incident = asObject(rawIncident) ?? {};
      const details = asObject(incident.incidentDetails) ?? incident;
      const location = asObject(incident.location);
      const typeDescription = asObject(details.typeDescription);
      const description = asObject(details.description);
      const summary = asObject(details.summary);
      const shaped: JsonObject = {
        id: asString(details.id),
        hrn: asString(details.hrn),
        originalId: asString(details.originalId),
        type: asString(details.type),
        typeDescription: asString(typeDescription?.value) ?? asString(details.typeDescription),
        criticality: asString(details.criticality),
        description: asString(description?.value) ?? shapeDescription(details.description),
        summary: asString(summary?.value),
        startTime: asString(details.startTime),
        endTime: asString(details.endTime),
        roadClosed: asBoolean(details.roadClosed) ?? asBoolean(location?.roadClosed),
        lengthMeters: asNumber(location?.length) ?? asNumber(details.length),
        locationReference: asString(location?.olr),
        codes: Array.isArray(details.codes) ? details.codes : undefined,
      };
      return Object.fromEntries(Object.entries(shaped).filter(([, value]) => value !== undefined));
    });

  const byCriticality: Record<string, number> = {};
  let closures = 0;
  for (const incident of incidents) {
    const criticality = asString(incident.criticality) ?? "unknown";
    byCriticality[criticality] = (byCriticality[criticality] ?? 0) + 1;
    if (incident.roadClosed === true) closures += 1;
  }

  return {
    count: incidents.length,
    incidents,
    summary: {
      total: rawIncidents.length,
      returned: incidents.length,
      byCriticality,
      roadClosures: closures,
    },
  };
}

export function shapeTrafficFlow(
  json: unknown,
  limit = 100,
): { count: number; flow: JsonObject[]; summary: JsonObject } {
  const root = asObject(json) ?? {};
  const rawFlow = asArray(root.results).length > 0 ? asArray(root.results) : asArray(root.flow);
  const flow = rawFlow
    .slice(0, limit)
    .map((rawItem) => {
      const item = asObject(rawItem) ?? {};
      const location = asObject(item.location);
      const currentFlow = asObject(item.currentFlow);
      const shape = asObject(location?.shape);
      const firstLink = asObject(asArray(shape?.links)[0]);
      const firstPoint =
        shapePosition(asArray(firstLink?.points)[0]) ??
        shapePosition(location?.firstPoint);
      const shaped: JsonObject = {
        jamFactor: asNumber(currentFlow?.jamFactor),
        speedKph: asNumber(currentFlow?.speed),
        speedUncappedKph: asNumber(currentFlow?.speedUncapped),
        freeFlowKph: asNumber(currentFlow?.freeFlow),
        confidence: asNumber(currentFlow?.confidence),
        traversability: asString(currentFlow?.traversability),
        roadClosed: asBoolean(location?.roadClosed),
        locationDescription: asString(location?.description),
        lengthMeters: asNumber(location?.length),
        locationReference: asString(location?.olr),
        firstPoint,
      };
      return Object.fromEntries(Object.entries(shaped).filter(([, value]) => value !== undefined));
    });

  const jams = flow
    .map((item) => asNumber(item.jamFactor))
    .filter((jam): jam is number => jam !== undefined);
  const averageJamFactor =
    jams.length > 0 ? round(jams.reduce((sum, jam) => sum + jam, 0) / jams.length, 2) : undefined;

  return {
    count: flow.length,
    flow,
    summary: {
      total: rawFlow.length,
      returned: flow.length,
      averageJamFactor,
      congestedSegments: jams.filter((jam) => jam >= 5).length,
    },
  };
}


/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
