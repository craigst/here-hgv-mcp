/**
 * here_route_tolls — dedicated toll cost analysis for an HGV route.
 *
 * HERE returns several *alternative* fare products per toll (UK HGV Levy day /
 * week / month passes). The response keeps them all and reports the cheapest
 * (totalCost) and dearest (totalCostMax) option — they are not cumulative.
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

export function registerRouteTollsTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_route_tolls',
    {
      title: 'HERE route tolls (HGV toll costs and toll roads)',
      description: [
        'Calculate the toll cost and toll systems for an HGV route using HERE Routing v8 return=tolls.',
        'Returns totalCost (cheapest fare option per toll), totalCostMax (dearest), currency, and per-section toll details including toll system names, country, and every fare product with its validity period and payment methods.',
        'Typical UK results include "UK HGV LEVY ENGLAND" (day/week/month passes) and motorway tolls such as the M6 Toll. Passes are alternatives — do NOT sum them; use totalCost for the trip cost.',
        'Uses the same "truck" profile (metres/kg) as here_route so toll class is based on real dimensions/axles/emissions. emissionType maps to HERE tolls[emissionType] for Euro-class discounts.',
        'For a route summary without tolls use here_route; for traffic incidents on the corridor use here_traffic_incidents.',
      ].join(' '),
      inputSchema: {
        origin: z.string().min(2).max(300).describe('Start: "lat,lng" or address (auto-geocoded, UK focus).'),
        destination: z.string().min(2).max(300).describe('End: "lat,lng" or address.'),
        via: z.array(z.string().min(2).max(300)).max(10).optional().describe('Up to 10 intermediate waypoints.'),
        transportMode: z.enum(['truck', 'car']).default('truck').describe('Travel mode (default truck for HGV tolls; car also accepted).'),
        truck: truckProfileSchema.optional(),
        avoid: avoidOptionsSchema.optional(),
        departureTime: z.string().optional().describe('Departure time (RFC 3339 with offset) for traffic-aware tolls.'),
        arrivalTime: z.string().optional().describe('Arrival time (RFC 3339 with offset). Cannot be combined with departureTime.'),
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('ISO 4217 currency for toll prices, default GBP.'),
        emissionType: z
          .enum(EMISSION_TYPES)
          .optional()
          .describe('Toll emission class (Euro standard), e.g. euro6 — sent as tolls[emissionType].'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        if (args.departureTime && args.arrivalTime) assertNotBoth(args.departureTime, args.arrivalTime);
        if (args.departureTime) validateDateTime(args.departureTime, 'departureTime');
        if (args.arrivalTime) validateDateTime(args.arrivalTime, 'arrivalTime');

        const [origin, destination, vias] = await Promise.all([
          resolvePlace(context, args.origin),
          resolvePlace(context, args.destination),
          resolvePlaces(context, args.via ?? [], { max: 10 }),
        ]);
        const truck = buildRoutingTruckParams(args.truck, args.transportMode);
        const avoid = buildAvoidParams(args.avoid);
        const currency = (args.currency ?? context.config.defaults.currency).toUpperCase();

        const response = await context.client.requestJson('routing', '/v8/routes', {
          query: {
            transportMode: args.transportMode,
            origin: formatPlace(origin),
            destination: formatPlace(destination),
            departureTime: args.departureTime,
            arrivalTime: args.arrivalTime,
            units: 'metric',
            lang: context.config.defaults.lang,
            currency,
            return: 'summary,tolls',
            'tolls[summaries]': 'total,tollSystem,country',
            ...(args.emissionType ? { 'tolls[emissionType]': args.emissionType } : {}),
            ...truck.params,
            ...avoid.params,
          },
          ...(vias.length > 0 ? { repeatQuery: { via: vias.map((place) => formatPlace(place)) } } : {}),
        });

        const shaped = shapeRouteResponse(response.data, { includeTolls: true });
        const route = shaped.routes[0];
        const tolls = route?.tolls;
        if (!route || !tolls) {
          throw new HereValidationError(
            'HERE did not return toll data for this route (the route may not use toll roads, or tolls are unavailable in the covered country).',
            { notices: shaped.notices },
          );
        }

        const systems = new Set<string>();
        for (const section of tolls.sections) {
          const system = typeof section.tollSystem === 'string' ? section.tollSystem : undefined;
          if (system) systems.add(system);
        }
        const notices = [...truck.notices, ...avoid.notices, ...shaped.notices.map((notice) => notice.message ?? notice.code ?? 'notice')];

        return jsonResult(
          {
            currency,
            transportMode: args.transportMode,
            origin: describePlace(origin),
            destination: describePlace(destination),
            via: vias.map((place) => describePlace(place)),
            routeSummary: route.summary,
            tolled: tolls.tolled,
            totalCost: tolls.totalCost,
            totalCostMax: tolls.totalCostMax,
            tollSystems: [...systems],
            sections: tolls.sections,
            notices,
          },
          tolls.tolled
            ? `💷 Tolls ${currency} ${tolls.totalCost.toFixed(2)} (up to ${currency} ${tolls.totalCostMax.toFixed(2)} depending on pass)${systems.size > 0 ? ` — ${[...systems].join(', ')}` : ''}. Route: ${routeHumanSummary(route)}.`
            : `💷 No tolls on this route. ${routeHumanSummary(route)}.`,
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
  };
}
