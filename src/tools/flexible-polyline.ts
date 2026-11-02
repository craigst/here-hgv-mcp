/**
 * here_flexible_polyline_decode — decode HERE Flexible Polyline geometry with no
 * API call. Useful for turning a here_route / here_isoline polyline into
 * coordinates for maps, distance checks or downstream tools.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HereValidationError } from '../errors.js';
import { decodeFlexiblePolyline } from '../util/geo.js';
import { jsonResult, runTool, type ToolContext } from './shared.js';

export function registerFlexiblePolylineTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_flexible_polyline_decode',
    {
      title: 'Decode HERE Flexible Polyline',
      description: [
        'Decode a HERE Flexible Polyline (the compact geometry returned by HERE Routing v8, Isoline v8 and Map Image v3) into a [lat,lng] point list. Pure local computation — no HERE API call, no quota, no key.',
        'Use it when a route/isoline response includes "encoded" polylines and you need coordinates: distances, bounding boxes, drawing, or checking whether a stop lies on the route geometry.',
        'Also returns the encoding header (precision, third dimension type) and an optional GeoJSON LineString for direct rendering/mapping.',
        'Invalid encodings are rejected with a clear validation error rather than silently producing wrong coordinates.',
      ].join(' '),
      inputSchema: {
        encoded: z
          .string()
          .min(2)
          .max(500_000)
          .describe('HERE Flexible Polyline string, e.g. "BFoz5xJ67i1B1B7PzIhaxL7Y" or the "encoded" value from here_route includePolyline.'),
        includeGeoJson: z
          .boolean()
          .default(false)
          .describe('Also return a GeoJSON LineString (coordinates in [lng,lat] order per RFC 7946).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(context, async () => {
        let decoded;
        try {
          decoded = decodeFlexiblePolyline(args.encoded.trim());
        } catch (error) {
          throw new HereValidationError(
            `Invalid HERE Flexible Polyline: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const [first, last] = [decoded.points[0], decoded.points[decoded.points.length - 1]];
        const geoJson = args.includeGeoJson
          ? {
              type: 'LineString',
              coordinates: decoded.points.map((point) => [point[1], point[0]]),
            }
          : undefined;
        return jsonResult(
          {
            pointCount: decoded.points.length,
            precision: decoded.precision,
            thirdDim: decoded.thirdDim,
            thirdDimPrecision: decoded.thirdDimPrecision,
            hasThirdDimension: decoded.thirdDim !== 0,
            points: decoded.points,
            ...(first ? { firstPoint: { lat: first[0], lng: first[1] } } : {}),
            ...(last ? { lastPoint: { lat: last[0], lng: last[1] } } : {}),
            ...(geoJson ? { geoJson } : {}),
          },
          `📐 Decoded ${decoded.points.length} point(s), precision ${decoded.precision}${decoded.thirdDim ? `, third dimension type ${decoded.thirdDim}` : ''}.`,
        );
      }),
  );
}
