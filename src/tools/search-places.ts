/**
 * here_search_places — discover places around a point.
 *
 * Free-text place search uses HERE Discover v7; category browsing uses HERE
 * Browse v7 (Discover has no category filter, Browse does).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { asArray, asBoolean, asObject, shapePlacesResponse, type PlaceLikeItem } from '../util/shape.js';
import { HereValidationError } from '../errors.js';
import { jsonResult, runTool, type ToolContext } from './shared.js';

const LATLNG = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

/**
 * HERE Geocoding & Search v7 does not expose opening hours, so openNow is a
 * best-effort filter: it only filters when the response actually carries
 * openingHours/isOpen data. The response always says whether it was applied.
 */
function openNowStatus(item: PlaceLikeItem): boolean | undefined {
  const record = item as unknown as Record<string, unknown>;
  const explicit = asBoolean(record.openNow);
  if (explicit !== undefined) return explicit;
  const hours = asArray(record.openingHours);
  if (hours.length === 0) return undefined;
  let sawValue = false;
  let sawOpen = false;
  for (const raw of hours) {
    const entry = asObject(raw);
    const isOpen = entry ? asBoolean(entry.isOpen) : undefined;
    if (isOpen === undefined) continue;
    sawValue = true;
    if (isOpen) sawOpen = true;
  }
  if (!sawValue) return undefined;
  return sawOpen;
}

export function registerSearchPlacesTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_search_places',
    {
      title: 'HERE search places (discover / browse)',
      description: [
        'Find places around a coordinate — fuel stations, truck stops, depots, services, restaurants, etc.',
        'Free-text search uses HERE Discover v7 ("q"). If you pass "categories" it uses HERE Browse v7 with HERE Places category IDs (e.g. "700-7600-0116" for petrol stations) and "name" filtering.',
        'Always ranked by importance/distance from the supplied "at" point; radiusM is a hard circle filter.',
        'UK default: 2 km radius, en-GB names. HGV tip: combine with here_route to check whether the access is suitable for a large vehicle — place categories alone do not encode HGV access.',
        'openNow is best-effort: HERE GS7 returns no opening-hours data, so when it cannot be determined the response carries openNowApplied=false plus a warning and unfiltered items.',
      ].join(' '),
      inputSchema: {
        at: z
          .string()
          .regex(LATLNG)
          .describe('Search centre as "lat,lng", e.g. "53.4808,-2.2426". Required — HERE Discover/Browse rank by distance from it.'),
        q: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe('Free-text query, e.g. "petrol station", "truck stop", "M6 services". Required unless categories is supplied.'),
        categories: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('HERE Places category IDs (Browse). A "!" prefix excludes a category. Example: ["700-7600-0116"] for petrol stations.'),
        radiusM: z
          .number()
          .min(50)
          .max(50_000)
          .default(2000)
          .describe('Circle radius in metres around "at" (50-50000, default 2000).'),
        limit: z.number().int().min(1).max(100).default(10).describe('Maximum places to return (default 10).'),
        offset: z.number().int().min(0).max(99).optional().describe('Pagination offset (0-99).'),
        openNow: z.boolean().default(false).describe('Best-effort filter to currently-open places (see tool description).'),
        lang: z.string().optional().describe('BCP-47 language for names/addresses, default en-GB.'),
        mobilityMode: z
          .enum(['car', 'truck'])
          .optional()
          .describe('Improves result relevance for the travel mode; "truck" biases towards HGV-accessible places.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        const hasCategories = (args.categories?.length ?? 0) > 0;
        if (!args.q && !hasCategories) {
          throw new HereValidationError(
            'Provide either "q" (free-text search, Discover) or "categories" (HERE place category IDs, Browse).',
          );
        }
        const lang = args.lang ?? context.config.defaults.lang;
        // HERE treats at and in=circle as mutually exclusive. Discover accepts
        // in=circle alone; Browse requires at, so radius is a client-side filter there.
        const circle = `circle:${args.at};r=${Math.round(args.radiusM)}`;
        const endpoint = hasCategories ? ('browse' as const) : ('discover' as const);
        const response = hasCategories
          ? await context.client.requestJson('browse', '/v1/browse', {
              query: {
                at: args.at,
                name: args.q,
                categories: args.categories?.join(','),
                limit: args.limit,
                offset: args.offset,
                lang,
                mobilityMode: args.mobilityMode,
              },
            })
          : await context.client.requestJson('discover', '/v1/discover', {
              query: {
                q: args.q,
                in: circle,
                limit: args.limit,
                offset: args.offset,
                lang,
                mobilityMode: args.mobilityMode,
              },
            });

        const shaped = shapePlacesResponse(response.data);
        const warnings: string[] = [];
        let items = shaped.items;
        if (endpoint === 'browse') {
          const before = items.length;
          const filtered = items.filter(
            (item) => item.distanceMeters === undefined || item.distanceMeters <= args.radiusM,
          );
          if (filtered.length !== before) items = filtered;
          const distancesKnown = items.some((item) => item.distanceMeters !== undefined);
          if (!distancesKnown) {
            warnings.push('HERE Browse did not return distances; radiusM could not be enforced server-side.');
          }
        }
        let openNowApplied = false;
        if (args.openNow) {
          const statuses = items.map((item) => openNowStatus(item));
          const known = statuses.filter((status) => status !== undefined).length;
          if (known === 0) {
            warnings.push(
              'openNow could not be applied: HERE Geocoding & Search v7 does not return opening hours. Results are unfiltered — verify times directly with the venue.',
            );
          } else {
            const before = items.length;
            items = items.filter((_, index) => statuses[index] !== false);
            warnings.push(`openNow filtered ${before - items.length} closed place(s) using available opening-hours data.`);
            openNowApplied = true;
          }
        }

        const first = items[0];
        const human =
          items.length === 0
            ? `No places found for ${args.q ? `"${args.q}"` : 'those categories'} within ${Math.round(args.radiusM)} m of ${args.at}.`
            : `📍 ${items.length} place(s), nearest: ${first?.title ?? 'unknown'}${first?.distanceMeters !== undefined ? ` (${Math.round(first.distanceMeters)} m)` : ''}.`;
        return jsonResult(
          {
            query: {
              endpoint,
              at: args.at,
              q: args.q,
              categories: args.categories,
              radiusM: args.radiusM,
              limit: args.limit,
              openNow: args.openNow,
              lang,
            },
            count: items.length,
            items,
            ...(warnings.length > 0 ? { warnings } : {}),
            openNowApplied,
          },
          human,
        );
      }),
  );
}
