/**
 * here_map_image — static map (PNG/JPEG) with markers and an optional route line.
 *
 * The image is downloaded server-side and written to HERE_MAP_OUTPUT_DIR so the
 * API key never appears in a URL returned to an agent or a chat transcript.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HereValidationError } from '../errors.js';
import { jsonResult, runTool, type ToolContext } from './shared.js';

const FORMATS = ['png8', 'png24', 'jpeg'] as const;

const markerSchema = z.object({
  latitude: z.number().min(-90).max(90).describe('Marker latitude.'),
  longitude: z.number().min(-180).max(180).describe('Marker longitude.'),
  label: z.string().max(16).optional().describe('Marker label (short text or "$num"/"$alpha" for 1,2,3 / A,B,C).'),
  color: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional().describe('Marker colour as #RRGGBB.'),
  icon: z.enum(['pin', 'square', 'diamond', 'triangle', 'bubble', 'cp', 'poi']).optional().describe('Marker icon (default pin).'),
});

interface GeoJsonFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: Record<string, unknown>;
}

function buildGeoJson(
  markers: { latitude: number; longitude: number; label?: string; color?: string; icon?: string }[],
  routePoints: [number, number][] | undefined,
): string | undefined {
  const features: GeoJsonFeature[] = [];
  for (const marker of markers) {
    features.push({
      type: 'Feature',
      properties: {
        style: 'marker',
        icon: marker.icon ?? 'pin',
        size: 'medium',
        ...(marker.label ? { label: marker.label } : {}),
        ...(marker.color ? { color: marker.color.startsWith('#') ? marker.color : `#${marker.color}` } : {}),
      },
      geometry: { type: 'Point', coordinates: [marker.longitude, marker.latitude] },
    });
  }
  if (routePoints && routePoints.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { color: '#0044FF', width: '6m', 'outline-color': '#FFFFFF', 'outline-width': '2px' },
      geometry: { type: 'LineString', coordinates: routePoints },
    });
  }
  if (features.length === 0) return undefined;
  return JSON.stringify({ type: 'FeatureCollection', features });
}

function safeLang(lang: string | undefined, fallback: string): string {
  const candidate = (lang ?? fallback).split('-')[0] ?? 'en';
  // The Map Image API only accepts ISO 639-1 two-letter codes (lang=en-GB → 400).
  return /^[a-z]{2}$/i.test(candidate) ? candidate.toLowerCase() : 'en';
}

function sanitiseFilename(filename: string, extension: string): string {
  const base = basename(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  const withExtension = base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
  return withExtension.length > 0 ? withExtension : `here-map-${Date.now()}.${extension}`;
}

export function registerMapImageTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_map_image',
    {
      title: 'HERE static map image (markers + route line)',
      description: [
        'Render a static HERE map (Map Image API v3) centred on a point, with optional numbered/pinned markers and an optional route line, then save it as a PNG/JPEG and return the local file path.',
        'UK default style "explore.day". width/height default 800×600. zoom default 13 (city level); 9-10 gives a regional overview for a long HGV route.',
        'Route line: pass routePolyline (the encoded HERE Flexible Polyline returned by here_route includePolyline) — it is sent as HERE\'s compact overlay, so long routes do not overflow the URL — OR routePoints as [[lat,lng],…] (downsampled to 200 points). Markers are formatted as pinned labels.',
        'The saved file can be opened with an image viewer / read_image tool. The returned URL is credential-free; the HERE API key is never exposed (the image is fetched server-side and written to HERE_MAP_OUTPUT_DIR).',
        'For a simple “where is this?” image omit markers; for a delivery map pass markers for each stop.',
      ].join(' '),
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe('Map centre latitude, e.g. 53.4808.'),
        longitude: z.number().min(-180).max(180).describe('Map centre longitude, e.g. -2.2426.'),
        zoom: z.number().int().min(0).max(22).default(13).describe('Zoom level 0-22 (default 13). Use 9-10 for a whole-UK/HGV route overview.'),
        width: z.number().int().min(64).max(2048).default(800).describe('Image width in pixels (64-2048, default 800).'),
        height: z.number().int().min(64).max(2048).default(600).describe('Image height in pixels (64-2048, default 600).'),
        format: z.enum(FORMATS).default('png8').describe('Image format (default png8; use png24 for gradients or jpeg for photos).'),
        style: z.string().max(64).default('explore.day').describe('HERE map style (default explore.day; try "explore.night" or "satellite.day").'),
        lang: z.string().optional().describe('Map label language (ISO 639-1 two letters only, default "en" derived from en-GB).'),
        markers: z.array(markerSchema).max(20).optional().describe('Up to 20 markers to draw on the map.'),
        routePolyline: z
          .string()
          .optional()
          .describe('Encoded HERE Flexible Polyline to draw as a route line (e.g. from here_route includePolyline=true). Sent as a compact overlay, so long routes are safe.'),
        routePoints: z
          .array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]))
          .max(5000)
          .optional()
          .describe('Route line as explicit [[lat,lng],…] points (alternative to routePolyline).'),
        saveToFile: z.boolean().default(true).describe('Download and save the image locally (default true). Set false to only get the keyless URL.'),
        filename: z.string().max(120).optional().describe('Optional output filename (extension corrected automatically).'),
        hiRes: z.boolean().default(false).describe('Render at 2× scale for high-DPI displays (default false).'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        if (args.width > 2048 || args.height > 2048) {
          throw new HereValidationError('Map images are limited to 2048×2048 pixels.');
        }
        // Encoded polylines go through HERE's compact `overlay` parameter —
        // expanding hundreds of coordinates into GeoJSON overflows the URL
        // (414 Request-URI Too Large). Explicit point lists are downsampled.
        let routePoints = args.routePoints as [number, number][] | undefined;
        let overlay: string | undefined;
        if (args.routePolyline) {
          overlay = `line:${args.routePolyline};color=#0044FF;width=6m`;
          routePoints = undefined;
        } else if (routePoints && routePoints.length > 200) {
          const source = routePoints;
          const step = Math.ceil(source.length / 200);
          routePoints = source.filter(
            (_point, index) => index % step === 0 || index === source.length - 1,
          );
        }
        const markers = args.markers ?? [];
        const geojson = buildGeoJson(markers, routePoints);
        const hasRouteLine = Boolean(args.routePolyline || (routePoints && routePoints.length >= 2));

        const view = `center:${args.latitude},${args.longitude};zoom=${args.zoom}`;
        const size = `${args.width}x${args.height}`;
        const path = `/base/mc/${view}/${size}/${args.format}`;
        const query: Record<string, string | number | undefined> = {
          style: args.style,
          lang: safeLang(args.lang, context.config.defaults.lang),
          scale: args.hiRes ? 2 : undefined,
          geojson,
          overlay,
        };

        const keylessUrl = context.client
          .buildUrl('mapImage', path, query, { includeApiKey: false })
          .toString();

        if (!args.saveToFile) {
          return jsonResult(
            {
              saved: false,
              url: keylessUrl,
              centre: { lat: args.latitude, lng: args.longitude },
              zoom: args.zoom,
              size: { width: args.width, height: args.height },
              format: args.format,
              markerCount: markers.length,
              hasRouteLine,
              note: 'URL is credential-free by design. Call again with saveToFile=true to receive a local image file.',
            },
            `🗺️ Map URL ready (${args.width}×${args.height}, zoom ${args.zoom}); no file saved.`,
          );
        }

        const image = await context.client.requestBuffer('mapImage', path, { query });
        const extension = args.format === 'jpeg' ? 'jpg' : 'png';
        const filename = sanitiseFilename(
          args.filename ?? `here-map-${Date.now()}.${extension}`,
          extension,
        );
        const outputDir = resolvePath(context.config.mapOutputDir);
        await mkdir(outputDir, { recursive: true });
        const filePath = join(outputDir, filename);
        const resolvedFilePath = resolvePath(filePath);
        if (!resolvedFilePath.startsWith(`${outputDir}/`) && resolvedFilePath !== outputDir) {
          throw new HereValidationError('Refusing to write outside the configured map output directory.');
        }
        await writeFile(resolvedFilePath, image.buffer);
        const isPng = image.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const isJpeg = image.buffer[0] === 0xff && image.buffer[1] === 0xd8;
        if (!isPng && !isJpeg) {
          throw new HereValidationError('HERE returned bytes that are neither a PNG nor a JPEG image.', {
            contentType: image.contentType,
            bytes: image.buffer.length,
          });
        }
        return jsonResult(
          {
            saved: true,
            path: resolvedFilePath,
            bytes: image.buffer.length,
            contentType: image.contentType ?? (isPng ? 'image/png' : 'image/jpeg'),
            urlWithoutCredentials: keylessUrl,
            centre: { lat: args.latitude, lng: args.longitude },
            zoom: args.zoom,
            size: { width: args.width, height: args.height },
            format: args.format,
            markerCount: markers.length,
            hasRouteLine,
          },
          `🗺️ Saved ${isPng ? 'PNG' : 'JPEG'} map to ${resolvedFilePath} (${Math.round(image.buffer.length / 1024)} KiB, ${args.width}×${args.height}).`,
        );
      }),
  );
}
