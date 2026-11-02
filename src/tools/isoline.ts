/**
 * here_isoline — reachable area polygons (isochrones / isodistances), truck aware.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HereValidationError } from '../errors.js';
import { formatDuration, formatDistance } from '../util/geo.js';
import { shapeIsolineResponse } from '../util/shape.js';
import {
  assertNotBoth,
  avoidOptionsSchema,
  buildAvoidParams,
  buildRoutingTruckParams,
  jsonResult,
  resolvePlace,
  runTool,
  truckProfileSchema,
  validateDateTime,
  type ToolContext,
} from './shared.js';

const DEFAULT_TIME_RANGES = [900, 1800, 2700];
const DEFAULT_DISTANCE_RANGES = [5000, 10_000, 15_000];

export function registerIsolineTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_isoline',
    {
      title: 'HERE isoline (reachable area by time or distance)',
      description: [
        'Calculate the area reachable from a point within one or more time or distance ranges (isochrone/isodistance) using HERE Isoline Routing v8.',
        'HGV support: transportMode="truck" plus the same "truck" profile as here_route (metres/kg) so reachability respects height/weight/hazmat/tunnel restrictions.',
        'rangeType="time" (ranges in seconds, default [900,1800,2700] = 15/30/45 min) or "distance" (ranges in metres, default [5000,10000,15000]).',
        'Returns one polygon per range as HERE Flexible Polyline geometry; set includePolygonPoints=true to also get decoded [lat,lng] rings (larger).',
        'UK defaults: departure now with live traffic, en-GB notices, metric.',
      ].join(' '),
      inputSchema: {
        origin: z.string().min(2).max(300).describe('Centre point: "lat,lng" or an address (auto-geocoded, UK focus).'),
        rangeType: z.enum(['time', 'distance']).default('time').describe('Range unit: time (seconds) or distance (metres).'),
        ranges: z
          .array(z.number().positive())
          .min(1)
          .max(7)
          .optional()
          .describe('1-7 ranges. Time: seconds, max 32400 (9 h). Distance: metres, max 1000000 (1000 km). Defaults: [900,1800,2700] s or [5000,10000,15000] m.'),
        transportMode: z
          .enum(['car', 'truck', 'pedestrian', 'bicycle', 'scooter'])
          .default('car')
          .describe('Travel mode (default car). Use "truck" for HGV reachability.'),
        truck: truckProfileSchema.optional(),
        departureTime: z
          .string()
          .optional()
          .describe('Departure time (RFC 3339 WITH offset, e.g. "2026-11-03T08:30:00+00:00"). Omit to use "now" with live traffic.'),
        arrivalTime: z.string().optional().describe('Instead of departureTime: area from which the origin is reachable by this time.'),
        traffic: z.boolean().default(true).describe('Consider live traffic (default true).'),
        optimizeFor: z
          .enum(['quality', 'performance', 'balanced'])
          .default('balanced')
          .describe('Isoline calculation optimisation (default balanced).'),
        avoid: avoidOptionsSchema.optional(),
        includePolygonPoints: z
          .boolean()
          .default(false)
          .describe('Decode polygons to [lat,lng] rings in the response (default false; encoded geometry is always returned).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        if (args.departureTime && args.arrivalTime) {
          assertNotBoth(args.departureTime, args.arrivalTime);
        }
        if (args.departureTime) validateDateTime(args.departureTime, 'departureTime');
        if (args.arrivalTime) validateDateTime(args.arrivalTime, 'arrivalTime');

        const ranges =
          args.ranges && args.ranges.length > 0
            ? args.ranges
            : args.rangeType === 'time'
              ? DEFAULT_TIME_RANGES
              : DEFAULT_DISTANCE_RANGES;
        const maxRange = args.rangeType === 'time' ? 32_400 : 1_000_000;
        for (const range of ranges) {
          if (range > maxRange) {
            throw new HereValidationError(
              `Range ${range} exceeds HERE's maximum of ${maxRange} for rangeType="${args.rangeType}".`,
            );
          }
        }

        const place = await resolvePlace(context, args.origin);
        const truck = buildRoutingTruckParams(args.truck, args.transportMode);
        const avoid = buildAvoidParams(args.avoid);

        const response = await context.client.requestJson('isoline', '/v8/isolines', {
          query: {
            origin: `${place.point.lat},${place.point.lng}`,
            'range[type]': args.rangeType,
            'range[values]': ranges.join(','),
            transportMode: args.transportMode,
            departureTime: args.departureTime,
            arrivalTime: args.arrivalTime,
            optimizeFor: args.optimizeFor,
            traffic: args.traffic ? undefined : { mode: 'disabled' },
            ...truck.params,
            ...avoid.params,
          },
        });

        const shaped = shapeIsolineResponse(response.data, args.includePolygonPoints);
        const label =
          args.rangeType === 'time'
            ? ranges.map((value) => formatDuration(value)).join(', ')
            : ranges.map((value) => formatDistance(value)).join(', ');
        return jsonResult(
          {
            origin: { label: place.label, lat: place.point.lat, lng: place.point.lng, geocoded: place.geocoded },
            transportMode: args.transportMode,
            rangeType: args.rangeType,
            ranges,
            traffic: args.traffic,
            ...shaped,
            notices: [...truck.notices, ...avoid.notices],
          },
          `🗺️ ${shaped.count} isoline(s) from ${place.label} (${args.transportMode}, ${args.rangeType}): ${label}.`,
        );
      }),
  );
}
