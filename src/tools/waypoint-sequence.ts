/**
 * here_waypoint_sequence — multi-stop order optimisation (HERE Waypoints
 * Sequence API v8, `findsequence2`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatDistance, formatDuration } from '../util/geo.js';
import { shapeWaypointSequenceResponse } from '../util/shape.js';
import { HereApiError } from '../errors.js';
import {
  jsonResult,
  resolvePlaces,
  runTool,
  truckProfileSchema,
  validateDateTime,
  type TruckProfile,
  type ToolContext,
} from './shared.js';

const AVOID_FEATURES = ['tollroad', 'motorway', 'boatFerry', 'railFerry', 'tunnel', 'dirtRoad'] as const;

function waypointParam(label: string, lat: number, lng: number): string {
  // HERE format: `<name>;<lat>,<lng>`. Strip separators that would break it.
  const safeLabel = label.replace(/[;,|]/g, ' ').trim().slice(0, 80) || 'Waypoint';
  return `${safeLabel};${lat},${lng}`;
}

function truckSequenceParams(profile: TruckProfile | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  if (!profile) return params;
  if (profile.heightM !== undefined) params.height = `${profile.heightM}m`;
  if (profile.widthM !== undefined) params.width = `${profile.widthM}m`;
  if (profile.lengthM !== undefined) params.length = `${profile.lengthM}m`;
  if (profile.grossWeightKg !== undefined) params.limitedWeight = `${Math.round(profile.grossWeightKg)}kg`;
  if (profile.weightPerAxleKg !== undefined) params.weightPerAxle = `${Math.round(profile.weightPerAxleKg)}kg`;
  if (profile.trailerCount !== undefined) params.trailersCount = String(Math.min(4, profile.trailerCount));
  if (profile.tunnelCategory !== undefined) params.tunnelCategory = profile.tunnelCategory;
  if (profile.shippedHazardousGoods && profile.shippedHazardousGoods.length > 0) {
    const goods = profile.shippedHazardousGoods.filter((item) => item !== 'none');
    if (goods.length > 0) params.shippedHazardousGoods = goods.join(',');
  }
  return params;
}

export function registerWaypointSequenceTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_waypoint_sequence',
    {
      title: 'HERE waypoint sequence (multi-stop order optimisation)',
      description: [
        'Find the optimal visiting order for a multi-drop run using HERE Waypoints Sequence v8 (findsequence2).',
        'Provide a start (depot), an optional end, and the stops to visit. The response lists the optimised order with per-leg distance/time and totals — ideal for planning a delivery round for an HGV.',
        'improveFor="time" (default) or "distance". transportMode="truck" with the "truck" profile applies HGV restrictions for the whole sequence (metres/kg converted to HERE cm/kg with units).',
        'departureTime is RFC 3339 with offset; it defaults to "now" because live traffic is factored into the sequence.',
        'avoidFeatures uses HERE\'s mode route-features: tollroad, motorway, boatFerry, railFerry, tunnel, dirtRoad (strict avoidance).',
      ].join(' '),
      inputSchema: {
        start: z.string().min(2).max(300).describe('Depot/start location: "lat,lng" or address (auto-geocoded).'),
        end: z.string().min(2).max(300).optional().describe('Optional end location (e.g. return to depot).'),
        waypoints: z
          .array(z.string().min(2).max(300))
          .min(1)
          .max(50)
          .describe('Stops to visit, 1-50, in no particular order — HERE computes the optimal order.'),
        transportMode: z.enum(['car', 'truck']).default('car').describe('Travel mode (default car). Use "truck" for HGV sequence.'),
        truck: truckProfileSchema.optional(),
        improveFor: z.enum(['time', 'distance']).default('time').describe('Optimise for total travel time (default) or distance.'),
        departureTime: z
          .string()
          .optional()
          .describe('Departure time (RFC 3339 with offset) or "now". Defaults to "now" so traffic is considered.'),
        avoidFeatures: z
          .array(z.enum(AVOID_FEATURES))
          .max(6)
          .optional()
          .describe('Road features to strictly avoid for the whole sequence.'),
        excludeCountries: z
          .array(z.string().regex(/^[A-Za-z]{3}$/))
          .max(10)
          .optional()
          .describe('ISO 3166-1 alpha-3 countries to exclude from the sequence.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        const departure = args.departureTime
          ? validateDateTime(args.departureTime, 'departureTime', true)
          : 'now';
        const places = await resolvePlaces(
          context,
          [args.start, ...(args.end ? [args.end] : []), ...args.waypoints],
          { max: 52 },
        );
        const [startPlace, ...rest] = places;
        if (!startPlace) throw new Error('Start location did not resolve');
        const endIndex = args.end ? 0 : -1;
        const endPlace = endIndex === 0 ? rest[0] : undefined;
        const stops = args.end ? rest.slice(1) : rest;
        if (stops.length === 0) {
          throw new Error('At least one waypoint is required');
        }

        const modeType = args.improveFor === 'time' ? 'fastest' : 'shortest';
        const featureSuffix = (args.avoidFeatures ?? [])
          .map((feature) => `;${feature}:-3`)
          .join('');
        const mode = `${modeType};${args.transportMode};traffic:enabled${featureSuffix}`;

        const query: Record<string, string | undefined> = {
          start: waypointParam(startPlace.label, startPlace.point.lat, startPlace.point.lng),
          end: endPlace ? waypointParam(endPlace.label, endPlace.point.lat, endPlace.point.lng) : undefined,
          mode,
          departure,
          improveFor: args.improveFor,
          ...(args.transportMode === 'truck' ? truckSequenceParams(args.truck) : {}),
          excludeCountries: args.excludeCountries?.map((code) => code.toUpperCase()).join(','),
        };
        stops.forEach((stop, index) => {
          query[`destination${index}`] = waypointParam(stop.label, stop.point.lat, stop.point.lng);
        });

        const response = await context.client.requestJson<{
          results?: unknown[];
          errors?: string[];
          warnings?: unknown;
          responseCode?: string;
        }>('waypointSequence', '/v8/findsequence2', { query });

        const data = response.data;
        if (Array.isArray(data.errors) && data.errors.length > 0) {
          // findsequence2 returns HTTP 200 with an errors array on optimisation failures.
          const message = data.errors.join('; ');
          throw new HereApiError(
            `HERE waypoint sequence failed: ${message}`,
            response.status,
            'waypointSequence',
            false,
            'sequenceFailed',
            { errors: data.errors },
          );
        }
        const shaped = shapeWaypointSequenceResponse(data);
        const order = shaped.order
          .map((waypoint) => `${waypoint.sequence ?? '?'}:${waypoint.id ?? `${waypoint.lat},${waypoint.lng}`}`)
          .join(' → ');
        return jsonResult(
          {
            transportMode: args.transportMode,
            improveFor: args.improveFor,
            departure,
            stopCount: stops.length,
            ...shaped,
            ...(Array.isArray(data.errors) ? { errors: data.errors } : {}),
          },
          `🚚 Sequence: ${order} — ${formatDistance(shaped.totalDistanceMeters)} / ${formatDuration(shaped.totalDurationSeconds)}.`,
        );
      }),
  );
}
