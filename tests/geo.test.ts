import { describe, expect, it } from 'vitest';
import {
  decodeFlexiblePolyline,
  formatDistance,
  formatDuration,
  parseLatLng,
} from '../src/util/geo.js';

describe('parseLatLng', () => {
  it('parses coordinate pairs with optional whitespace', () => {
    expect(parseLatLng('53.4808,-2.2426')).toEqual({ lat: 53.4808, lng: -2.2426 });
    expect(parseLatLng(' 51.5 , -0.12 ')).toEqual({ lat: 51.5, lng: -0.12 });
  });

  it('rejects addresses, out-of-range values and malformed input', () => {
    expect(parseLatLng('Manchester')).toBeNull();
    expect(parseLatLng('91,0')).toBeNull();
    expect(parseLatLng('0,181')).toBeNull();
    expect(parseLatLng('1,2,3')).toBeNull();
  });
});

describe('decodeFlexiblePolyline', () => {
  it('decodes the reference HERE example', () => {
    // Documented HERE test vector.
    const decoded = decodeFlexiblePolyline('BFoz5xJ67i1B1B7PzIhaxL7Y');
    expect(decoded.precision).toBe(5);
    expect(decoded.thirdDim).toBe(0);
    expect(decoded.points).toHaveLength(4);
    expect(decoded.points[0]![0]).toBeCloseTo(50.10228, 5);
    expect(decoded.points[0]![1]).toBeCloseTo(8.69821, 5);
    expect(decoded.points[3]![0]).toBeCloseTo(50.09878, 5);
    expect(decoded.points[3]![1]).toBeCloseTo(8.68752, 5);
  });

  it('rejects invalid encodings rather than inventing coordinates', () => {
    expect(() => decodeFlexiblePolyline('')).toThrow();
    expect(() => decodeFlexiblePolyline('!!!')).toThrow();
    expect(() => decodeFlexiblePolyline('X')).toThrow();
  });
});

describe('human formatting', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(4492)).toBe('1 h 14 min');
  });

  it('formats distances compactly', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(68477)).toBe('68.5 km');
    expect(formatDistance(250_000)).toBe('250 km');
  });
});
