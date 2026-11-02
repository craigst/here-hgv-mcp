/**
 * here_geocode — free-text address / place search.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shapeGeocodeResponse } from '../util/shape.js';
import { jsonResult, runTool, type ToolContext } from './shared.js';

const GEOCODE_TYPES = [
  'address',
  'area',
  'city',
  'houseNumber',
  'place',
  'postalCode',
  'street',
] as const;

export function registerGeocodeTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_geocode',
    {
      title: 'HERE geocode (address → coordinates)',
      description: [
        'Resolve a free-text address or place to WGS84 coordinates using the HERE Geocoding & Search v7 API.',
        'Use this first when you only have an address and need a point for routing, search or mapping.',
        'UK defaults: a country focus of GBR (set countryFocus to another ISO-3166-1 alpha-3 code, or "ANY" to search worldwide) and lang=en-GB.',
        'Examples: {"q":"10 Downing Street, London"}, {"q":"Trafford Park, Manchester"}, {"q":"M6 Toll","types":["place"]}.',
        'Returns a ranked list with formatted address components, lat/lng, bounding box and match score. Empty results are a success with count=0.',
      ].join(' '),
      inputSchema: {
        q: z
          .string()
          .min(2)
          .max(300)
          .describe('Free-text query: full address, postcode, place or landmark, e.g. "10 Downing Street, London" or "Trafford Park".'),
        countryFocus: z
          .string()
          .regex(/^[A-Za-z]{3}$/)
          .optional()
          .describe('ISO 3166-1 alpha-3 country to filter results, e.g. GBR. Defaults to the server default (GBR). Use "ANY" to search all countries.'),
        at: z
          .string()
          .regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/)
          .optional()
          .describe('Optional context point "lat,lng" used to rank nearby matches (e.g. "53.4808,-2.2426").'),
        bbox: z
          .array(z.number())
          .length(4)
          .optional()
          .describe('Optional bounding box filter [west, south, east, north] in degrees. Overrides countryFocus.'),
        limit: z.number().int().min(1).max(100).default(5).describe('Maximum results to return (1-100, default 5).'),
        lang: z
          .string()
          .optional()
          .describe('BCP-47 language for returned names, default en-GB (e.g. "cy" for Welsh labels where available).'),
        types: z
          .array(z.enum(GEOCODE_TYPES))
          .optional()
          .describe('Restrict result types, e.g. ["address","street"]. Omit for all types.'),
        politicalView: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional()
          .describe('Optional ISO 3166-1 alpha-3 political view, e.g. CYP for a CYPRUS-specific view.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        const country = (args.countryFocus ?? context.config.defaults.country).toUpperCase();
        const bbox = args.bbox as [number, number, number, number] | undefined;
        let area: string | undefined;
        if (bbox) {
          area = `bbox:${bbox.map((value) => value.toString()).join(',')}`;
        } else if (country !== 'ANY') {
          area = `countryCode:${country}`;
        }
        const lang = args.lang ?? context.config.defaults.lang;
        const response = await context.client.requestJson('geocode', '/v1/geocode', {
          query: {
            q: args.q,
            in: area,
            at: args.at,
            limit: args.limit,
            lang,
            types: args.types?.join(','),
            politicalView: args.politicalView,
          },
        });
        const shaped = shapeGeocodeResponse(response.data);
        const first = shaped.items[0];
        const human =
          shaped.count === 0
            ? `No geocode results for "${args.q}". Try a more specific address or countryFocus="ANY".`
            : `📍 ${first?.title ?? args.q}${first?.position ? ` (${first.position.lat.toFixed(5)}, ${first.position.lng.toFixed(5)})` : ''} — ${shaped.count} result(s).`;
        return jsonResult(
          {
            query: {
              q: args.q,
              countryFocus: country,
              area,
              limit: args.limit,
              lang,
            },
            ...shaped,
          },
          human,
        );
      }),
  );
}
