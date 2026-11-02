import { describe, expect, it } from 'vitest';
import {
  shapeGeocodeResponse,
  shapeIsolineResponse,
  shapeMatrixResult,
  shapeRouteResponse,
  shapeTrafficFlow,
  shapeTrafficIncidents,
} from '../src/util/shape.js';

describe('shapeGeocodeResponse', () => {
  it('projects address components, position and distance', () => {
    const shaped = shapeGeocodeResponse({
      items: [
        {
          title: 'Trafford Park, Manchester',
          id: 'here:pa:1',
          resultType: 'locality',
          address: {
            label: 'Trafford Park, Manchester, England, United Kingdom',
            countryCode: 'GBR',
            city: 'Manchester',
            postalCode: 'M17',
          },
          position: { lat: 53.46813, lng: -2.30835 },
          distance: 1234.56,
          mapView: { west: -2.4, south: 53.4, east: -2.2, north: 53.5 },
        },
        { title: 'ignored — no position or id' },
      ],
    });
    expect(shaped.count).toBe(2);
    expect(shaped.items[0]).toMatchObject({
      title: 'Trafford Park, Manchester',
      resultType: 'locality',
      distanceMeters: 1234.6,
      address: { countryCode: 'GBR', city: 'Manchester' },
      position: { lat: 53.46813, lng: -2.30835 },
    });
    expect(shaped.items[1]).toMatchObject({ title: 'ignored — no position or id' });
  });
});

const ROUTE_FIXTURE = {
  routes: [
    {
      id: 'route-1',
      notices: [],
      sections: [
        {
          id: 's1',
          type: 'vehicle',
          transport: { mode: 'truck' },
          departure: { time: '2026-11-03T08:30:00Z', place: { location: { lat: 53.4808, lng: -2.2426 } } },
          arrival: { time: '2026-11-03T09:44:00Z' },
          summary: { duration: 4492, length: 68477, baseDuration: 3856 },
          polyline: 'BFoz5xJ67i1B1B7PzIhaxL7Y',
          actions: [{ action: 'depart', instruction: 'Head south', duration: 10, length: 120, offset: 0 }],
          tolls: [
            {
              countryCode: 'GBR',
              tollSystem: 'UK HGV LEVY ENGLAND',
              fares: [
                { id: 'f1', name: 'day', price: { type: 'value', currency: 'GBP', value: 10.36 }, paymentMethods: ['creditCard'] },
                { id: 'f2', name: 'month', price: { type: 'value', currency: 'GBP', value: 77.6 } },
              ],
            },
          ],
        },
        {
          id: 's2',
          type: 'vehicle',
          summary: { duration: 0, length: 0, baseDuration: 0 },
        },
      ],
    },
  ],
  notices: [{ code: 'violatedAvoidTollRoad', severity: 'info', title: 'Avoided feature could not be honoured' }],
};

describe('shapeRouteResponse', () => {
  it('aggregates section summaries and computes the traffic delay', () => {
    const shaped = shapeRouteResponse(ROUTE_FIXTURE);
    expect(shaped.routes).toHaveLength(1);
    const route = shaped.routes[0]!;
    expect(route.summary.distanceMeters).toBe(68477);
    expect(route.summary.durationSeconds).toBe(4492);
    expect(route.summary.baseDurationSeconds).toBe(3856);
    expect(route.summary.trafficDelaySeconds).toBe(636);
    expect(route.legs).toHaveLength(2);
    expect(route.instructions?.[0]).toMatchObject({ legIndex: 0, action: 'depart', instruction: 'Head south' });
    expect(shaped.notices[0]?.code).toBe('violatedAvoidTollRoad');
  });

  it('never includes a polyline unless requested', () => {
    const shaped = shapeRouteResponse(ROUTE_FIXTURE);
    expect(shaped.routes[0]!.polyline).toBeUndefined();
  });

  it('decodes polylines when requested', () => {
    const shaped = shapeRouteResponse(ROUTE_FIXTURE, { includePolyline: true, includePolylinePoints: true });
    const polyline = shaped.routes[0]!.polyline?.[0] as {
      legIndex: number;
      encoded: string;
      points: number[][];
    };
    expect(polyline.legIndex).toBe(0);
    expect(polyline.points).toHaveLength(4);
  });

  it('treats fares as alternatives: totalCost is the cheapest, totalCostMax the dearest', () => {
    const shaped = shapeRouteResponse(ROUTE_FIXTURE, { includeTolls: true });
    const tolls = shaped.routes[0]!.tolls!;
    expect(tolls.tolled).toBe(true);
    expect(tolls.totalCost).toBe(10.36);
    expect(tolls.totalCostMax).toBe(77.6);
    expect(tolls.currency).toBe('GBP');
    const section = tolls.sections[0]!;
    expect(section.tollSystem).toBe('UK HGV LEVY ENGLAND');
    expect((section.fares as unknown[]).length).toBe(2);
  });
});

describe('shapeMatrixResult', () => {
  it('unwraps the async {matrix:{...}} envelope into a 2D matrix', () => {
    const shaped = shapeMatrixResult(
      {
        matrixId: 'm1',
        matrix: { numOrigins: 2, numDestinations: 2, travelTimes: [0, 3620, 3830, 0] },
      },
      [{ label: 'Manchester' }, { label: 'Leeds' }],
      [{ label: 'Manchester' }, { label: 'Leeds' }],
      'm1',
    );
    expect(shaped.numOrigins).toBe(2);
    expect(shaped.durationsSeconds).toEqual([
      [0, 3620],
      [3830, 0],
    ]);
    expect(shaped.matrixId).toBe('m1');
  });
});

describe('shapeTrafficIncidents', () => {
  it('reads the v7 results[] array and flattens localised fields', () => {
    const shaped = shapeTrafficIncidents({
      results: [
        {
          location: { length: 8, olr: 'abc==' },
          incidentDetails: {
            id: '568777439121006711',
            type: 'roadClosure',
            typeDescription: { value: 'Road closure', language: 'en-GB' },
            criticality: 'critical',
            roadClosed: true,
            startTime: '2025-11-25T13:01:02Z',
            description: { value: 'Closed', language: 'en-GB' },
            summary: { value: 'Closed' },
          },
        },
      ],
    });
    expect(shaped.count).toBe(1);
    expect(shaped.incidents[0]).toMatchObject({
      type: 'roadClosure',
      typeDescription: 'Road closure',
      criticality: 'critical',
      roadClosed: true,
      lengthMeters: 8,
      summary: 'Closed',
    });
    expect(shaped.summary).toMatchObject({ total: 1, roadClosures: 1 });
  });
});

describe('shapeTrafficFlow', () => {
  it('reads v7 results[] and computes jam statistics', () => {
    const shaped = shapeTrafficFlow({
      results: [
        { location: { description: 'M60', length: 100 }, currentFlow: { jamFactor: 6, speed: 12.5, freeFlow: 30, traversability: 'open' } },
        { location: { description: 'A57' }, currentFlow: { jamFactor: 2, speed: 25 } },
      ],
    });
    expect(shaped.count).toBe(2);
    expect(shaped.flow[0]).toMatchObject({ jamFactor: 6, speedKph: 12.5, freeFlowKph: 30, locationDescription: 'M60' });
    expect(shaped.summary).toMatchObject({ averageJamFactor: 4, congestedSegments: 1 });
  });
});

describe('shapeIsolineResponse', () => {
  it('keeps the departure block and encoded polygons', () => {
    const shaped = shapeIsolineResponse({
      departure: { time: '2026-11-02T20:29:49Z', place: { location: { lat: 53.4808, lng: -2.2426 } } },
      isolines: [
        { range: { type: 'time', value: 900 }, polygons: [{ outer: 'BFoz5xJ67i1B1B7PzIhaxL7Y' }] },
      ],
    });
    expect(shaped.count).toBe(1);
    expect(shaped.departure).toMatchObject({ time: '2026-11-02T20:29:49Z', position: { lat: 53.4808, lng: -2.2426 } });
    expect(shaped.isolines[0]).toMatchObject({ range: { type: 'time', value: 900 }, polygonCount: 1 });
  });
});
