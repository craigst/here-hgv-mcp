import { describe, expect, it } from 'vitest';
import { buildAvoidParams, buildRoutingTruckParams } from '../src/tools/shared.js';

describe('buildRoutingTruckParams (HGV profile → HERE vehicle[...] parameters)', () => {
  it('maps metres to centimetres, keeps kg, and uses the v8 vehicle[] prefix', () => {
    const { params, notices } = buildRoutingTruckParams(
      {
        heightM: 4.2,
        widthM: 2.55,
        lengthM: 16.5,
        grossWeightKg: 44_000,
        weightPerAxleKg: 11_500,
        axleCount: 6,
        trailerCount: 1,
        trailerAxleCount: 3,
        tunnelCategory: 'C',
        licensePlate: 'AB12CDE',
      },
      'truck',
    );
    expect(params).toEqual({
      'vehicle[height]': 420,
      'vehicle[width]': 255,
      'vehicle[length]': 1650,
      'vehicle[grossWeight]': 44000,
      'vehicle[weightPerAxle]': 11500,
      'vehicle[axleCount]': 6,
      'vehicle[trailerCount]': 1,
      'vehicle[trailerAxleCount]': 3,
      'vehicle[tunnelCategory]': 'C',
      'vehicle[licensePlate]': 'AB12CDE',
    });
    expect(notices).toEqual([]);
  });

  it('joins hazardous goods and drops the "none" sentinel', () => {
    const hazmat = buildRoutingTruckParams(
      { shippedHazardousGoods: ['explosive', 'gas', 'none'] },
      'truck',
    );
    expect(hazmat.params['vehicle[shippedHazardousGoods]']).toBe('explosive,gas');

    const none = buildRoutingTruckParams({ shippedHazardousGoods: ['none'] }, 'truck');
    expect(none.params['vehicle[shippedHazardousGoods]']).toBeUndefined();
    expect(none.notices.join(' ')).toContain('none');
  });

  it('does not invent unsupported v8 fields (emissionType/limitedWeight)', () => {
    const { params } = buildRoutingTruckParams({ heightM: 4 }, 'truck');
    const keys = Object.keys(params);
    expect(keys.some((key) => key.includes('emissionType'))).toBe(false);
    expect(keys.some((key) => key.includes('limitedWeight'))).toBe(false);
  });

  it('ignores the profile for non-truck transport modes with a clear notice', () => {
    const { params, notices } = buildRoutingTruckParams({ heightM: 4.2 }, 'car');
    expect(params).toEqual({});
    expect(notices[0]).toContain('transportMode="car"');
  });
});

describe('buildAvoidParams', () => {
  it('maps v7 aliases to the v8 feature names and builds exclude/areas params', () => {
    const { params, notices } = buildAvoidParams({
      features: ['tollroad', 'motorway', 'ferry'],
      areas: ['bbox:-2.4,53.4,-2.2,53.5'],
      countries: ['IRL'],
      tollTransponders: ['all'],
      truckRoadTypes: ['BK1'],
    });
    expect(params['avoid[features]']).toBe('tollRoad,controlledAccessHighway,ferry');
    expect(params['avoid[areas]']).toBe('bbox:-2.4,53.4,-2.2,53.5');
    expect(params['exclude[countries]']).toBe('IRL');
    expect(params['avoid[tollTransponders]']).toBe('all');
    expect(params['avoid[truckRoadTypes]']).toBe('BK1');
    expect(notices.join(' ')).toContain('mapped to HERE v8');
  });
});
