/**
 * here_autosuggest — partial-query suggestions with a UK bias.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HereValidationError } from '../errors.js';
import { shapeAutosuggestResponse } from '../util/shape.js';
import { jsonResult, runTool, type ToolContext } from './shared.js';

export function registerAutosuggestTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_autosuggest',
    {
      title: 'HERE autosuggest (typed-ahead suggestions)',
      description: [
        'Turn a partial address/POI query into ranked suggestions using the HERE Autosuggest v7 API — the right tool when the user has typed only part of a name ("Manch", "Traff", "M6 Toll").',
        'UK bias by default: without at, suggestions are restricted to a Great Britain bounding box (HERE Autosuggest does not accept a country-code filter). Pass at="lat,lng" to rank suggestions near a point (e.g. the driver\'s current location) instead.',
        'Suggestions include addresses, places, and query terms. Use here_geocode afterwards to resolve a chosen suggestion to coordinates if it has no position.',
        'For complete addresses or coordinates use here_geocode; for places around a point use here_search_places.',
      ].join(' '),
      inputSchema: {
        q: z.string().min(1).max(200).describe('Partial free-text query, e.g. "Manch", "Trafford P", "M6 Toll".'),
        at: z
          .string()
          .regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/)
          .optional()
          .describe('Optional "lat,lng" to rank suggestions by proximity (strongly recommended for in-cab use).'),
        countryFocus: z
          .string()
          .regex(/^[A-Za-z]{3}$/)
          .optional()
          .describe('ISO 3166-1 alpha-3 country filter, default GBR. Use "ANY" for worldwide. Ignored when at is supplied.'),
        limit: z.number().int().min(1).max(100).default(8).describe('Maximum suggestions (default 8).'),
        lang: z.string().optional().describe('BCP-47 language, default en-GB.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        const country = (args.countryFocus ?? context.config.defaults.country).toUpperCase();
        const lang = args.lang ?? context.config.defaults.lang;
        // HERE Autosuggest needs a ranking area: at, or in=bbox/circle/ring.
        // countryCode is not accepted here, so the UK default uses a GB bbox.
        const UK_BBOX = 'bbox:-8.65,49.90,1.77,60.86';
        let area: string | undefined;
        if (!args.at) {
          if (country === 'GBR' || country === 'ANY') {
            area = UK_BBOX;
          } else {
            throw new HereValidationError(
              `HERE Autosuggest cannot filter to ${country} without a point. Supply at="lat,lng" or use countryFocus="GBR".`,
            );
          }
        }
        const response = await context.client.requestJson('autosuggest', '/v1/autosuggest', {
          query: {
            q: args.q,
            at: args.at,
            in: area,
            limit: args.limit,
            lang,
          },
        });
        const shaped = shapeAutosuggestResponse(response.data);
        const first = shaped.items[0];
        const human =
          shaped.count === 0
            ? `No suggestions for "${args.q}".`
            : `💡 ${shaped.count} suggestion(s), top: ${first?.title ?? first?.queryTerm ?? 'unknown'}.`;
        return jsonResult(
          {
            query: { q: args.q, at: args.at, area, countryFocus: country, limit: args.limit, lang },
            ...shaped,
          },
          human,
        );
      }),
  );
}
