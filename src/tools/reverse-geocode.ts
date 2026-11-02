/**
 * here_reverse_geocode — coordinates → address(es).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shapeGeocodeResponse } from '../util/shape.js';
import { jsonResult, runTool, type ToolContext } from './shared.js';

const REVERSE_TYPES = ['address', 'area', 'city', 'houseNumber', 'place', 'street'] as const;

export function registerReverseGeocodeTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_reverse_geocode',
    {
      title: 'HERE reverse geocode (coordinates → address)',
      description: [
        'Convert WGS84 coordinates into the nearest address/street/locality using the HERE Reverse Geocoding v7 API.',
        'Useful for naming a route origin/destination or for reporting where an incident or vehicle is.',
        'radiusM limits the search around the point (HERE "circle" filter); omit it for the nearest match only.',
        'Returns formatted addresses with country/postcode/street/house number and the distance to the requested point.',
      ].join(' '),
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe('WGS84 latitude in decimal degrees, e.g. 53.4808.'),
        longitude: z.number().min(-180).max(180).describe('WGS84 longitude in decimal degrees, e.g. -2.2426.'),
        radiusM: z
          .number()
          .min(1)
          .max(5000)
          .optional()
          .describe('Search radius in metres around the point (1-5000). Omit for the nearest result only.'),
        limit: z.number().int().min(1).max(100).default(1).describe('Maximum addresses to return (default 1).'),
        lang: z.string().optional().describe('BCP-47 language for addresses, default en-GB.'),
        types: z
          .array(z.enum(REVERSE_TYPES))
          .optional()
          .describe('Restrict to result types, e.g. ["address","street"].'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        const at = `${args.latitude},${args.longitude}`;
        const lang = args.lang ?? context.config.defaults.lang;
        // HERE rejects at + in=circle together: use in=circle when a radius is
        // requested, otherwise the nearest match via at.
        const query =
          args.radiusM !== undefined
            ? {
                in: `circle:${at};r=${Math.round(args.radiusM)}`,
                limit: args.limit,
                lang,
                types: args.types?.join(','),
              }
            : { at, limit: args.limit, lang, types: args.types?.join(',') };
        const response = await context.client.requestJson('reverseGeocode', '/v1/revgeocode', { query });
        const shaped = shapeGeocodeResponse(response.data);
        const first = shaped.items[0];
        const human =
          shaped.count === 0
            ? `No address found near ${at}.`
            : `📍 ${at} → ${first?.address?.label ?? first?.title ?? 'unknown'}`;
        return jsonResult(
          {
            query: { at, radiusM: args.radiusM, limit: args.limit, lang },
            ...shaped,
          },
          human,
        );
      }),
  );
}
