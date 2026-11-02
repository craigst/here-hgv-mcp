/**
 * here_route_matrix — many origins × destinations, HERE Matrix Routing v8.
 *
 * The async flow is mandatory in practice because matrix calculation is slow:
 *   POST /v8/matrix?async=true        -> 202 {matrixId, statusUrl}
 *   GET  statusUrl                    -> {status:"completed", resultUrl}
 *   GET  resultUrl (gzip, redirect)   -> {matrix:{numOrigins,numDestinations,travelTimes}}
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HereApiError, HereValidationError } from '../errors.js';
import { asString, shapeMatrixResult, type JsonObject } from '../util/shape.js';
import {
  jsonResult,
  resolvePlaces,
  runTool,
  truckProfileSchema,
  validateDateTime,
  type TruckProfile,
  type ToolContext,
} from './shared.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface MatrixStatusBody {
  matrixId?: string;
  status?: string;
  statusUrl?: string;
  resultUrl?: string;
  matrix?: JsonObject;
  error?: unknown;
}

function toMatrixVehicle(profile: TruckProfile): JsonObject {
  const vehicle: JsonObject = {};
  if (profile.heightM !== undefined) vehicle.height = Math.round(profile.heightM * 100);
  if (profile.widthM !== undefined) vehicle.width = Math.round(profile.widthM * 100);
  if (profile.lengthM !== undefined) vehicle.length = Math.round(profile.lengthM * 100);
  if (profile.grossWeightKg !== undefined) vehicle.grossWeight = Math.round(profile.grossWeightKg);
  if (profile.weightPerAxleKg !== undefined) vehicle.weightPerAxle = Math.round(profile.weightPerAxleKg);
  if (profile.axleCount !== undefined) vehicle.axleCount = profile.axleCount;
  if (profile.trailerCount !== undefined) vehicle.trailerCount = profile.trailerCount;
  if (profile.trailerAxleCount !== undefined) vehicle.trailerAxleCount = profile.trailerAxleCount;
  if (profile.shippedHazardousGoods && profile.shippedHazardousGoods.length > 0) {
    vehicle.shippedHazardousGoods = profile.shippedHazardousGoods
      .filter((good) => good !== 'none')
      .join(',');
  }
  if (profile.tunnelCategory !== undefined) vehicle.tunnelCategory = profile.tunnelCategory;
  if (profile.category !== undefined) vehicle.category = profile.category;
  if (profile.licensePlate !== undefined) vehicle.licensePlate = profile.licensePlate;
  return vehicle;
}

export function registerRouteMatrixTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_route_matrix',
    {
      title: 'HERE route matrix (origins × destinations)',
      description: [
        'Calculate travel times (and distances when available) between many origins and destinations with HERE Matrix Routing v8.',
        'Handles the HERE async job flow internally: submits the matrix, polls the status URL, downloads the gzip result, and returns a 2D durations matrix in seconds. If the job is still running after waitSeconds it returns matrixId + status so you can call again with {"matrixId":"..."} to resume.',
        'Locations are "lat,lng" or addresses (UK focus auto-geocode). Origins and destinations are ordered as supplied and echoed in the response so rows/columns are unambiguous.',
        'VERIFIED CAVEAT: HERE Matrix v8 is car-based in practice. transportMode and the HGV "truck" profile are only sent when you explicitly ask for them; if HERE rejects them, retry without them. For per-route HGV restrictions use here_route (truck) instead.',
        'The request body is the minimal verified payload: origins, destinations and regionDefinition {type:"world"}. matrixAttributes is never sent (v8 rejects it).',
      ].join(' '),
      inputSchema: {
        origins: z
          .array(z.string().min(2).max(300))
          .min(1)
          .max(25)
          .describe('Origin points ("lat,lng" or addresses), 1-25. Row order is preserved.'),
        destinations: z
          .array(z.string().min(2).max(300))
          .min(1)
          .max(25)
          .optional()
          .describe('Destination points (1-25). Omit for a square origins×origins matrix.'),
        transportMode: z
          .enum(['car', 'truck'])
          .optional()
          .describe('Optional. Only sent when provided; HERE Matrix v8 is car-based in practice (see tool description).'),
        truck: truckProfileSchema.optional(),
        departureTime: z
          .string()
          .optional()
          .describe('Optional departure time (RFC 3339 with offset). Improves traffic accuracy but is not part of the minimal verified body.'),
        routingMode: z.enum(['fast', 'short']).optional().describe('Optional HERE routingMode.'),
        matrixId: z
          .string()
          .optional()
          .describe('Resume polling an async matrix started earlier (skips submission).'),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(300)
          .default(60)
          .describe('How long to wait for completion before returning a pending result (default 60 s).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        const originPlaces = await resolvePlaces(context, args.origins, { max: 25 });
        const destinationInputs = args.destinations ?? args.origins;
        const destinationPlaces = await resolvePlaces(context, destinationInputs, { max: 25 });
        const originsShaped = originPlaces.map((place) => ({
          label: place.label,
          lat: place.point.lat,
          lng: place.point.lng,
          geocoded: place.geocoded,
        }));
        const destinationsShaped = destinationPlaces.map((place) => ({
          label: place.label,
          lat: place.point.lat,
          lng: place.point.lng,
          geocoded: place.geocoded,
        }));

        let matrixId = args.matrixId;
        let statusUrl: string | undefined;

        if (!matrixId) {
          const body: Record<string, unknown> = {
            origins: originPlaces.map((place) => ({
              lat: place.point.lat,
              lng: place.point.lng,
            })),
            destinations: destinationPlaces.map((place) => ({
              lat: place.point.lat,
              lng: place.point.lng,
            })),
            regionDefinition: { type: 'world' },
          };
          // Only include optional routing inputs when explicitly requested.
          if (args.transportMode) body.transportMode = args.transportMode;
          if (args.truck) {
            const vehicle = toMatrixVehicle(args.truck);
            if (Object.keys(vehicle).length > 0) body.vehicle = vehicle;
          }
          if (args.departureTime) {
            validateDateTime(args.departureTime, 'departureTime');
            body.departureTime = args.departureTime;
          }
          if (args.routingMode) body.routingMode = args.routingMode;

          const submission = await context.client.requestJson<MatrixStatusBody>('matrix', '/v8/matrix', {
            method: 'POST',
            query: { async: 'true' },
            body,
          });
          matrixId = asString(submission.data.matrixId);
          statusUrl = asString(submission.data.statusUrl);
          if (!matrixId) {
            throw new HereApiError(
              'HERE Matrix did not return a matrixId',
              submission.status,
              'matrix',
              false,
              'matrixSubmissionFailed',
              submission.data,
            );
          }
          if (submission.data.matrix) {
            const shaped = shapeMatrixResult(submission.data, originsShaped, destinationsShaped, matrixId);
            return jsonResult(matrixPayload(shaped, 'completed', matrixId), humanSummary(shaped, matrixId));
          }
          if (!statusUrl) {
            statusUrl = `https://matrix.router.hereapi.com/v8/matrix/${matrixId}/status`;
          }
        } else {
          statusUrl = `https://matrix.router.hereapi.com/v8/matrix/${matrixId}/status`;
        }

        const deadline = Date.now() + args.waitSeconds * 1000;
        let lastStatus = 'inProgress';
        while (true) {
          // Poll with redirects DISABLED: HERE answers 303 + Location once the
          // job is done, and following that redirect would drop the apiKey.
          const response = await context.client.requestJson<MatrixStatusBody>('matrix', statusUrl, {
            redirect: 'manual',
            acceptStatus: [301, 302, 303, 307, 308],
          });
          const location = response.headers.get('location');
          if (location) {
            const result = await context.client.requestJson<MatrixStatusBody>('matrix', location);
            const shaped = shapeMatrixResult(result.data, originsShaped, destinationsShaped, matrixId);
            return jsonResult(matrixPayload(shaped, 'completed', matrixId), humanSummary(shaped, matrixId));
          }
          const body = response.data;

          if (body.matrix) {
            const shaped = shapeMatrixResult(body, originsShaped, destinationsShaped, matrixId);
            return jsonResult(matrixPayload(shaped, 'completed', matrixId), humanSummary(shaped, matrixId));
          }
          lastStatus = asString(body.status) ?? lastStatus;
          if (lastStatus === 'completed') {
            const resultUrl = asString(body.resultUrl);
            if (!resultUrl) {
              throw new HereApiError(
                'Matrix completed but no resultUrl was returned',
                response.status,
                'matrix',
                false,
                'missingResultUrl',
                body,
              );
            }
            const result = await context.client.requestJson<MatrixStatusBody>('matrix', resultUrl);
            const shaped = shapeMatrixResult(result.data, originsShaped, destinationsShaped, matrixId);
            return jsonResult(matrixPayload(shaped, 'completed', matrixId), humanSummary(shaped, matrixId));
          }
          if (lastStatus === 'error' || lastStatus === 'timeout') {
            throw new HereApiError(
              `HERE Matrix job ${matrixId} finished with status "${lastStatus}"`,
              200,
              'matrix',
              false,
              'matrixFailed',
              body,
            );
          }
          if (Date.now() >= deadline) {
            return jsonResult(
              {
                pending: true,
                matrixId,
                status: lastStatus,
                origins: originsShaped,
                destinations: destinationsShaped,
                hint: 'Matrix still calculating. Call here_route_matrix again with the same matrixId to resume polling.',
              },
              `⏳ Matrix ${matrixId} still ${lastStatus} after ${args.waitSeconds}s — poll again with matrixId.`,
            );
          }
          await sleep(1000);
        }
      }),
  );
}

function matrixPayload(
  shaped: ReturnType<typeof shapeMatrixResult>,
  status: string,
  matrixId: string,
): Record<string, unknown> {
  return {
    status,
    matrixId,
    ...shaped,
  };
}

function humanSummary(
  shaped: ReturnType<typeof shapeMatrixResult>,
  matrixId: string,
): string {
  const values: number[] = [];
  for (const row of shaped.durationsSeconds) {
    for (const value of row) {
      if (typeof value === 'number' && value > 0) values.push(value);
    }
  }
  if (values.length === 0) return `Matrix ${matrixId}: no populated durations.`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const format = (seconds: number): string =>
    seconds >= 3600
      ? `${Math.floor(seconds / 3600)}h${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}m`
      : `${Math.round(seconds / 60)}m`;
  return `🧮 Matrix ${shaped.numOrigins}×${shaped.numDestinations}: durations ${format(min)}–${format(max)} (avg ${format(avg)}), ${values.length} populated pairs.`;
}

