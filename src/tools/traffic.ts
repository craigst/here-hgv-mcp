/**
 * here_traffic_incidents and here_traffic_flow — HERE Traffic API v7.
 *
 * Both endpoints require a geographic area via `in=` and a
 * `locationReferencing` scheme; flow additionally defaults to
 * maxJamFactor=10 because HERE's own default of 1.0 hides congestion.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HereValidationError } from '../errors.js';
import { shapeTrafficFlow, shapeTrafficIncidents } from '../util/shape.js';
import { jsonResult, runTool, validateDateTime, type ToolContext } from './shared.js';

const LOCATION_REFERENCING = ['olr', 'tmc', 'shape', 'none'] as const;

const areaShape = {
  bbox: z
    .array(z.number())
    .length(4)
    .optional()
    .describe('Bounding box [west, south, east, north] in degrees, e.g. [-2.35,53.42,-1.50,53.83] for Greater Manchester.'),
  at: z
    .string()
    .regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/)
    .optional()
    .describe('Centre "lat,lng" for a circular area. Requires radiusM.'),
  radiusM: z
    .number()
    .min(50)
    .max(100_000)
    .optional()
    .describe('Radius in metres for the circular area around "at" (used only with at).'),
  corridorPolyline: z
    .string()
    .optional()
    .describe('HERE Flexible Polyline for a corridor filter (e.g. a here_route includePolyline result). Requires corridorRadiusM.'),
  corridorRadiusM: z
    .number()
    .min(10)
    .max(10_000)
    .optional()
    .describe('Corridor half-width in metres (used only with corridorPolyline).'),
} as const;

function resolveArea(args: {
  bbox?: number[];
  at?: string;
  radiusM?: number;
  corridorPolyline?: string;
  corridorRadiusM?: number;
}): string {
  if (args.bbox) {
    const [west, south, east, north] = args.bbox as [number, number, number, number];
    if (west >= east || south >= north) {
      throw new HereValidationError('bbox must be [west, south, east, north] with west<east and south<north');
    }
    return `bbox:${west},${south},${east},${north}`;
  }
  if (args.at && args.radiusM !== undefined) {
    return `circle:${args.at};r=${Math.round(args.radiusM)}`;
  }
  if (args.corridorPolyline && args.corridorRadiusM !== undefined) {
    return `corridor:${args.corridorPolyline};r=${Math.round(args.corridorRadiusM)}`;
  }
  throw new HereValidationError(
    'A geographic area is required: provide bbox [west,south,east,north], or at + radiusM, or corridorPolyline + corridorRadiusM.',
  );
}

export function registerTrafficIncidentsTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_traffic_incidents',
    {
      title: 'HERE traffic incidents (closures, accidents, roadworks)',
      description: [
        'List live traffic incidents within a bounding box, circle or corridor using HERE Traffic API v7.',
        'Returns incident id, type (accident/construction/roadClosure/roadHazard/…), criticality (low/minor/major/critical), localised description and summary, start/end time, road-closed flag, affected length and an OLR location reference.',
        'Filter by criticality and type. locationReferencing defaults to ["olr"]; use ["shape"] if you need geometry points (adds size).',
        'For HGV planning: roadClosures and critical incidents are the ones to surface to a driver first — combine with here_route avoid areas if a closure blocks the planned corridor.',
        'Note: HERE returns all matching incidents; limit truncates the returned list only.',
      ].join(' '),
      inputSchema: {
        ...areaShape,
        locationReferencing: z
          .array(z.enum(LOCATION_REFERENCING))
          .default(['olr'])
          .describe('Location referencing scheme(s) to include (default ["olr"]). Use ["shape"] for geometry.'),
        criticality: z
          .array(z.enum(['low', 'minor', 'major', 'critical']))
          .optional()
          .describe('Filter by severity, e.g. ["major","critical"].'),
        types: z
          .array(
            z.enum([
              'accident',
              'construction',
              'congestion',
              'disabledVehicle',
              'massTransit',
              'plannedEvent',
              'roadHazard',
              'roadClosure',
              'weather',
              'laneRestriction',
              'other',
            ]),
          )
          .optional()
          .describe('Filter by incident type, e.g. ["roadClosure","accident"].'),
        lang: z.string().optional().describe('BCP-47 language for descriptions, default en-GB.'),
        units: z.enum(['metric', 'imperial']).default('metric').describe('Units for descriptions (default metric).'),
        functionalClasses: z
          .array(z.number().int().min(1).max(5))
          .optional()
          .describe('Filter to road functional classes 1-5 (1 = motorways/major roads).'),
        earliestStartTime: z
          .string()
          .optional()
          .describe('Only incidents starting at/after this RFC 3339 UTC time (e.g. "2026-11-02T00:00:00Z").'),
        latestEndTime: z
          .string()
          .optional()
          .describe('Only incidents ending at/before this RFC 3339 UTC time.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum incidents to return (default 50).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        const area = resolveArea(args);
        if (args.earliestStartTime) validateDateTime(args.earliestStartTime, 'earliestStartTime');
        if (args.latestEndTime) validateDateTime(args.latestEndTime, 'latestEndTime');
        const lang = args.lang ?? context.config.defaults.lang;
        const response = await context.client.requestJson('traffic', '/v7/incidents', {
          query: {
            in: area,
            locationReferencing: args.locationReferencing.join(','),
            criticality: args.criticality?.join(','),
            type: args.types?.join(','),
            lang,
            units: args.units,
            functionalClasses: args.functionalClasses?.join(','),
            earliestStartTime: args.earliestStartTime,
            latestEndTime: args.latestEndTime,
          },
        });
        const shaped = shapeTrafficIncidents(response.data, args.limit);
        const critical = (shaped.summary.byCriticality as Record<string, number>) ?? {};
        return jsonResult(
          { area, query: { criticality: args.criticality, types: args.types, lang }, ...shaped },
          `🚧 ${shaped.count} incident(s) in area: ${critical.critical ?? 0} critical, ${critical.major ?? 0} major, ${shaped.summary.roadClosures as number} road closure(s).`,
        );
      }),
  );
}

export function registerTrafficFlowTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_traffic_flow',
    {
      title: 'HERE traffic flow (speeds and jam factor)',
      description: [
        'Read live traffic flow for roads within a bounding box, circle or corridor using HERE Traffic API v7.',
        'Returns jamFactor (0 = free flow, 10 = blocked), current speed, uncapped speed, free-flow speed, confidence and traversability per road segment, plus a location description and OLR reference.',
        'locationReferencing is MANDATORY for flow (default ["olr"]). maxJamFactor defaults to 10 so congestion is NOT hidden (HERE\'s own default of 1.0 would only return free-flowing roads).',
        'For HGV route risk assessment: average jam factor and count of jams ≥5 across the corridor is a quick congestion indicator before calling here_route.',
        'Note: HERE returns all matching segments; limit truncates the returned list only.',
      ].join(' '),
      inputSchema: {
        ...areaShape,
        locationReferencing: z
          .array(z.enum(LOCATION_REFERENCING))
          .default(['olr'])
          .describe('Location referencing scheme(s); flow requires at least one (default ["olr"]).'),
        minJamFactor: z.number().min(0).max(10).default(0).describe('Only segments with jam factor ≥ this (default 0).'),
        maxJamFactor: z
          .number()
          .min(0)
          .max(10)
          .default(10)
          .describe('Only segments with jam factor ≤ this (default 10 = include congestion; HERE default 1 would hide jams).'),
        functionalClasses: z
          .array(z.number().int().min(1).max(5))
          .optional()
          .describe('Filter to road functional classes (1 = motorways; 1-3 keeps the HGV trunk network).'),
        advancedFeatures: z
          .array(z.enum(['deepCoverage', 'lanes']))
          .optional()
          .describe('HERE advanced features (may be billed separately by HERE).'),
        limit: z.number().int().min(1).max(500).default(100).describe('Maximum flow segments to return (default 100).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        const area = resolveArea(args);
        // Guard: HERE requires locationReferencing for /flow (400 E608051 otherwise).
        if (args.locationReferencing.length === 0) {
          throw new HereValidationError('locationReferencing must contain at least one scheme for traffic flow (e.g. ["olr"]).');
        }
        const response = await context.client.requestJson('traffic', '/v7/flow', {
          query: {
            in: area,
            locationReferencing: args.locationReferencing.join(','),
            minJamFactor: args.minJamFactor,
            maxJamFactor: args.maxJamFactor,
            functionalClasses: args.functionalClasses?.join(','),
            advancedFeatures: args.advancedFeatures?.join(','),
          },
        });
        const shaped = shapeTrafficFlow(response.data, args.limit);
        return jsonResult(
          { area, ...shaped },
          `🚦 ${shaped.count} segment(s): avg jam factor ${shaped.summary.averageJamFactor ?? 'n/a'}, ${shaped.summary.congestedSegments as number} congested (jam ≥ 5).`,
        );
      }),
  );
}
