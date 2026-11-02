/**
 * Geographic helpers: coordinate parsing, distance, and HERE Flexible Polyline
 * decoding (route/isoline geometry).
 *
 * The Flexible Polyline decoder is a TypeScript port of the reference
 * implementation published by HERE under the MIT licence:
 * https://github.com/heremaps/flexible-polyline (javascript/index.js)
 * Copyright (C) 2019 HERE Europe B.V. — MIT licensed.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DecodedPolyline {
  /** Number of decimal digits used for lat/lng in the encoding. */
  precision: number;
  /** Third dimension type: 0 none, 1 level, 2 altitude, 3 elevation. */
  thirdDim: number;
  thirdDimPrecision: number;
  /** Points as `[lat, lng]` or `[lat, lng, z]`. */
  points: number[][];
}

const DECODING_TABLE = [
  62, -1, -1, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1, -1,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, -1, -1, -1, -1, 63, -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
  36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51,
];

const FORMAT_VERSION = 1;

function decodeUnsignedValues(encoded: string): bigint[] {
  const result: bigint[] = [];
  let value = 0n;
  let shift = 0n;
  for (const char of encoded) {
    const charCode = char.charCodeAt(0);
    const decoded = charCode >= 45 ? DECODING_TABLE[charCode - 45] : undefined;
    if (decoded === undefined || decoded < 0) {
      throw new Error(`Invalid characters in encoded polyline (offset ${charCode})`);
    }
    const decodedBig = BigInt(decoded);
    value |= (decodedBig & 0x1fn) << shift;
    if ((decodedBig & 0x20n) === 0n) {
      result.push(value);
      value = 0n;
      shift = 0n;
    } else {
      shift += 5n;
    }
  }
  if (shift > 0n) throw new Error('Invalid encoding: truncated varint');
  return result;
}

function toSigned(value: bigint): number {
  let res = value;
  if ((res & 1n) === 1n) {
    res = ~res;
  }
  res >>= 1n;
  return Number(res);
}

/**
 * Decode a HERE Flexible Polyline string into coordinate points.
 *
 * @example decodeFlexiblePolyline('BFoz5xJ67i1B1B7PzIhaxL7Y').points
 *   => [[50.10228, 8.69821], [50.10201, 8.69567], [50.10063, 8.6915], [50.09878, 8.68752]]
 */
export function decodeFlexiblePolyline(encoded: string): DecodedPolyline {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('Encoded polyline must be a non-empty string');
  }
  const values = decodeUnsignedValues(encoded);
  if (values.length < 2) throw new Error('Encoded polyline is missing its header');

  const version = values[0]!;
  if (Number(version) !== FORMAT_VERSION) {
    throw new Error(`Unsupported Flexible Polyline version ${version}`);
  }
  const headerValue = Number(values[1]!);
  const precision = headerValue & 15;
  const thirdDim = (headerValue >> 4) & 7;
  const thirdDimPrecision = (headerValue >> 7) & 15;

  const factorDegree = 10 ** precision;
  const factorZ = 10 ** thirdDimPrecision;

  let lastLat = 0;
  let lastLng = 0;
  let lastZ = 0;
  const points: number[][] = [];
  let index = 2;

  while (index < values.length) {
    const deltaLat = toSigned(values[index++]!);
    const deltaLng = toSigned(values[index++]!);
    lastLat += deltaLat;
    lastLng += deltaLng;

    if (thirdDim !== 0) {
      const deltaZ = toSigned(values[index++]!);
      lastZ += deltaZ;
      points.push([lastLat / factorDegree, lastLng / factorDegree, lastZ / factorZ]);
    } else {
      points.push([lastLat / factorDegree, lastLng / factorDegree]);
    }
  }

  return { precision, thirdDim, thirdDimPrecision, points };
}

/** Parse a `"lat,lng"` pair (spaces tolerated). Returns null when not a coordinate pair. */
export function parseLatLng(input: string): LatLng | null {
  const match = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(input);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!isValidLat(lat) || !isValidLng(lng)) return null;
  return { lat, lng };
}

export function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

export function isValidLng(lng: number): boolean {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

/** Format a point the way HERE route parameters expect: `lat,lng`. */
export function formatLatLng(point: LatLng, decimals = 6): string {
  return `${point.lat.toFixed(decimals)},${point.lng.toFixed(decimals)}`;
}

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const earthRadius = 6_371_008.8;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Format seconds as a compact human duration, e.g. `1 h 12 min`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return `${minutes} min`;
  return `${total} s`;
}

/** Format metres as a compact human distance, e.g. `1.4 km` or `850 m`. */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return 'unknown';
  if (metres >= 1000) {
    const km = metres / 1000;
    return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km`;
  }
  return `${Math.round(metres)} m`;
}
