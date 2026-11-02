/**
 * here_route — HERE Routing v8, with a full HGV (truck) profile.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HereValidationError } from '../errors.js';
import { routeHumanSummary, shapeRouteResponse } from '../util/shape.js';
import {
  EMISSION_TYPES,
  assertNotBoth,
  avoidOptionsSchema,
  buildAvoidParams,
  buildRoutingTruckParams,
  jsonResult,
  resolvePlace,
  resolvePlaces,
  runTool,
  truckProfileSchema,
  validateDateTime,
  type ResolvedPlace,
  type ToolContext,
} from './shared.js';

/** `return` values HERE Routing v8 accepts, in the order they are sent. */
const RETURN_ORDER = [
  'summary',
  'polyline',
  'actions',
  'instructions',
  'turnByTurnActions',
  'tolls',
  'routeLabels',
  'routeHandle',
  'typicalDuration',
  'travelSummary',
  'elevation',
  'incidents',
  'routingZones',
  'truckRoadTypes',
  'passthrough',
  'noThroughRestrictions',
  'potentialTimeDependentViolations',
] as const;

const RETURN_VALUES = RETURN_ORDER as unknown as readonly [string, ...string[]];

const SPAN_ATTRIBUTES = [
  'duration',
  'baseDuration',
  'length',
  'maxSpeed',
  'names',
  'routeNumbers',
  'functionalClass',
  'countryCode',
  'dynamicSpeedInfo',
  'truckAttributes',
  'notices',
] as const;

export function registerRouteTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_route',
    {
      title: 'HERE route (car/truck/bike/pedestrian, HGV profile)',
      description: [
        'Calculate a route with HERE Routing v8. Supports transportMode car | truck | pedestrian | bicycle | scooter.',
        'HGV routing: set transportMode="truck" and pass "truck" — e.g. {"heightM":4.2,"widthM":2.55,"lengthM":16.5,"grossWeightKg":44000,"weightPerAxleKg":11500,"axleCount":6,"trailerCount":1} — to honour height/width/weight/axle/hazmat/tunnel restrictions. Dimensions are metres and weights kg; they are converted to HERE vehicle[height] centimetres etc.',
        'Origin/destination/via accept either "lat,lng" or a free-text address (auto-geocoded, UK focus).',
        'departureTime or arrivalTime (RFC 3339 WITH offset, e.g. "2026-11-03T08:30:00+00:00") makes the route traffic-aware; without it the route is traffic-free (baseDuration == duration).',
        'By default returns a compact summary only (distance, duration, traffic delay, legs, critical notices). Opt in to polyline, turn-by-turn instructions, spans and tolls with the include* flags — polylines are large.',
        'UK defaults: units=metric, lang=en-GB, currency=GBP.',
      ].join(' '),
      inputSchema: {
        origin: z.string().min(2).max(300).describe('Start point: "lat,lng" (e.g. "53.4808,-2.2426") or an address (auto-geocoded, UK focus).'),
        destination: z.string().min(2).max(300).describe('End point: "lat,lng" or an address.'),
        via: z
          .array(z.string().min(2).max(300))
          .max(10)
          .optional()
          .describe('Up to 10 intermediate waypoints ("lat,lng" or addresses), visited in order.'),
        transportMode: z
          .enum(['car', 'truck', 'pedestrian', 'bicycle', 'scooter'])
          .default('car')
          .describe('Travel mode (default car). Use "truck" for HGV routing with the truck profile.'),
        truck: truckProfileSchema.optional(),
        avoid: avoidOptionsSchema.optional(),
        departureTime: z
          .string()
          .optional()
          .describe('Departure time, RFC 3339 with offset, e.g. "2026-11-03T08:30:00+00:00". Makes the route traffic-aware. Cannot be combined with arrivalTime.'),
        arrivalTime: z
          .string()
          .optional()
          .describe('Desired arrival time, RFC 3339 with offset. Cannot be combined with departureTime.'),
        routingMode: z.enum(['fast', 'short']).default('fast').describe('Optimise for fastest (default) or shortest route.'),
        alternatives: z.number().int().min(0).max(6).default(0).describe('Number of alternative routes to return in addition to the best one (0-6).'),
        units: z.enum(['metric', 'imperial']).default('metric').describe('Instruction units (default metric).'),
        lang: z.string().optional().describe('BCP-47 instruction language, default en-GB.'),
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('ISO 4217 currency for toll costs, default GBP.'),
        emissionType: z
          .enum(EMISSION_TYPES)
          .optional()
          .describe('Toll emission class (sent as tolls[emissionType]). Only meaningful together with includeTolls=true.'),
        traffic: z.boolean().default(true).describe('Use live/typical traffic (default true). Set false for a traffic-free baseline.'),
        includePolyline: z.boolean().default(false).describe('Include the HERE Flexible Polyline per leg (encoded). Large — opt in.'),
        includePolylinePoints: z.boolean().default(false).describe('Also decode the polyline into [lat,lng] points (requires includePolyline).'),
        includeInstructions: z.boolean().default(false).describe('Include manoeuvre actions/instructions with offsets.'),
        includeTurnByTurn: z.boolean().default(false).describe('Include HERE turn-by-turn action objects (advanced).'),
        includeSpans: z.boolean().default(false).describe('Include route spans (speed limits, road names, functional class).'),
        spansMax: z.number().int().min(1).max(2000).default(200).describe('Maximum spans to return when includeSpans=true (default 200).'),
        includeTolls: z.boolean().default(false).describe('Include toll costs for this route (UK HGV Levy, M6 Toll, etc.).'),
        returnAttributes: z
          .array(z.enum(RETURN_VALUES))
          .optional()
          .describe('Advanced: extra HERE "return" attributes to request verbatim (e.g. ["routeLabels","typicalDuration"]).'),
        billingTag: z.string().max(100).optional().describe('Optional HERE billing tag for cost allocation.'),
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
        if (args.includePolylinePoints && !args.includePolyline) {
          throw new HereValidationError('includePolylinePoints requires includePolyline=true.');
        }
        if (args.emissionType && !args.includeTolls) {
          // We still send it (harmless) but tell the agent why it has no effect.
        }

        const [origin, destination, vias] = await Promise.all([
          resolvePlace(context, args.origin),
          resolvePlace(context, args.destination),
          resolvePlaces(context, args.via ?? [], { max: 10 }),
        ]);

        const truck = buildRoutingTruckParams(args.truck, args.transportMode);
        const avoid = buildAvoidParams(args.avoid);
        const lang = args.lang ?? context.config.defaults.lang;
        const currency = (args.currency ?? context.config.defaults.currency).toUpperCase();

        const requested = new Set<string>(['summary']);
        for (const attribute of args.returnAttributes ?? []) requested.add(attribute);
        if (args.includePolyline) requested.add('polyline');
        if (args.includeInstructions) {
          requested.add('actions');
          requested.add('instructions');
          requested.add('polyline');
        }
        if (args.includeTurnByTurn) {
          requested.add('turnByTurnActions');
          requested.add('polyline');
        }
        if (args.includeSpans) {
          requested.add('polyline');
        }
        if (args.includeTolls) requested.add('tolls');
        const returns = RETURN_ORDER.filter((value) => requested.has(value));

        const query: Record<string, import('../util/params.js').QueryValue> = {
          transportMode: args.transportMode,
          origin: formatPlace(origin),
          destination: formatPlace(destination),
          departureTime: args.departureTime,
          arrivalTime: args.arrivalTime,
          routingMode: args.routingMode,
          alternatives: args.alternatives > 0 ? args.alternatives : undefined,
          units: args.units,
          lang,
          currency: args.includeTolls ? currency : undefined,
          return: returns.join(','),
          traffic: args.traffic ? undefined : { mode: 'disabled' },
          billingTag: args.billingTag,
          ...truck.params,
          ...avoid.params,
        };
        if (args.includeSpans) query['spans'] = SPAN_ATTRIBUTES.join(',');
        if (args.includeTolls) {
          query['tolls[summaries]'] = 'total,tollSystem,country';
          if (args.emissionType) query['tolls[emissionType]'] = args.emissionType;
        }

        const response = await context.client.requestJson('routing', '/v8/routes', {
          query,
          ...(vias.length > 0 ? { repeatQuery: { via: vias.map((place) => formatPlace(place)) } } : {}),
        });

        const shaped = shapeRouteResponse(response.data, {
          includePolyline: args.includePolyline,
          includePolylinePoints: args.includePolylinePoints,
          includeSpans: args.includeSpans,
          spansMax: args.spansMax,
          includeTolls: args.includeTolls,
        });

        const notices = [
          ...truck.notices,
          ...avoid.notices,
          ...(args.emissionType && !args.includeTolls
            ? ['emissionType only affects toll calculation: set includeTolls=true to use it.']
            : []),
          ...shaped.notices.map((notice) => notice.message ?? notice.code ?? 'route notice'),
        ];

        const best = shaped.routes[0];
        const modeLabel =
          args.transportMode === 'truck' && args.truck
            ? `truck${args.truck.heightM ? ` ${args.truck.heightM} m` : ''}${args.truck.grossWeightKg ? ` / ${Math.round(args.truck.grossWeightKg / 1000)} t` : ''}`
            : args.transportMode;
        const human = best
          ? `🚚 ${origin.label} → ${destination.label} (${modeLabel}): ${routeHumanSummary(best)}.`
          : `No route found (${args.transportMode}) — see notices.`;

        return jsonResult(
          {
            transportMode: args.transportMode,
            units: args.units,
            currency: args.includeTolls ? currency : undefined,
            traffic: args.traffic,
            origin: describePlace(origin),
            destination: describePlace(destination),
            via: vias.map((place) => describePlace(place)),
            routeCount: shaped.routes.length,
            routes: shaped.routes,
            notices,
            ...(shaped.requestId ? { requestId: shaped.requestId } : {}),
          },
          human,
        );
      }),
  );
}

function formatPlace(place: ResolvedPlace): string {
  return `${place.point.lat},${place.point.lng}`;
}

function describePlace(place: ResolvedPlace): Record<string, unknown> {
  return {
    label: place.label,
    lat: place.point.lat,
    lng: place.point.lng,
    geocoded: place.geocoded,
    ...(place.countryCode ? { countryCode: place.countryCode } : {}),
  };
}
