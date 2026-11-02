/**
 * here_api_health — entitlement / connectivity probe for the configured key.
 *
 * Each service is probed with the cheapest call available: HERE's own /health
 * endpoints where they exist, otherwise the smallest real query. Rate-limit
 * headers are surfaced when HERE returns them. HERE does not expose remaining
 * monthly quota per key over these APIs, so quota is reported as "not exposed".
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Service } from '../config.js';
import { jsonResult, runTool, type ToolContext } from './shared.js';

interface ProbeDefinition {
  service: string;
  hereService: Service;
  path: string;
  query: Record<string, string | number>;
  /** Requires probeCalculations=true because it consumes real routing quota. */
  expensive?: boolean;
  note?: string;
}

const PROBES: ProbeDefinition[] = [
  { service: 'geocode', hereService: 'geocode', path: '/v1/geocode', query: { q: 'London', in: 'countryCode:GBR', limit: 1 } },
  { service: 'reverseGeocode', hereService: 'reverseGeocode', path: '/v1/revgeocode', query: { at: '51.5007,-0.1246', limit: 1 } },
  { service: 'discover', hereService: 'discover', path: '/v1/discover', query: { at: '51.5007,-0.1246', q: 'coffee', limit: 1 } },
  { service: 'autosuggest', hereService: 'autosuggest', path: '/v1/autosuggest', query: { q: 'Manch', at: '53.4808,-2.2426', limit: 2 } },
  { service: 'routing', hereService: 'routing', path: '/v8/health', query: {} },
  { service: 'matrix', hereService: 'matrix', path: '/v8/health', query: {} },
  { service: 'isoline', hereService: 'isoline', path: '/v8/health', query: {} },
  { service: 'traffic', hereService: 'traffic', path: '/v7/health', query: {} },
  { service: 'mapImage', hereService: 'mapImage', path: '/health', query: {} },
  {
    service: 'waypointSequence',
    hereService: 'waypointSequence',
    path: '/v8/findsequence2',
    query: {
      start: 'Health;53.4808,-2.2426',
      destination0: 'Probe;53.49,-2.25',
      mode: 'fastest;car;traffic:disabled',
      departure: 'now',
    },
    expensive: true,
    note: 'No /health endpoint exists; a minimal real sequence calculation is used (consumes quota).',
  },
];

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (/^x-ratelimit-/i.test(key) || key.toLowerCase() === 'retry-after' || key.toLowerCase() === 'x-request-id') {
      out[key.toLowerCase()] = value;
    }
  });
  return out;
}

export function registerHealthTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'here_api_health',
    {
      title: 'HERE API health and entitlement probe',
      description: [
        'Probe the configured HERE API key against every service this server uses and report connectivity, HTTP status, latency and any rate-limit headers.',
        'Services probed: geocode, reverseGeocode, discover, autosuggest, routing, matrix, isoline, traffic, mapImage; waypointSequence only when probeCalculations=true (it has no /health endpoint and would consume routing quota).',
        'Use this first when a HERE tool fails: it distinguishes a bad/expired key (401/403), a missing entitlement (403), an outage (5xx) and a network problem, service by service.',
        'Note: HERE does not expose remaining monthly quota per key through these APIs; x-ratelimit-* headers are reported when present. HERE_API_KEY values are never returned — only whether one is configured.',
      ].join(' '),
      inputSchema: {
        services: z
          .array(z.string())
          .optional()
          .describe('Optional subset of services to probe (default: all). e.g. ["routing","traffic"].'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(30_000)
          .default(8000)
          .describe('Per-service timeout in milliseconds (default 8000).'),
        probeCalculations: z
          .boolean()
          .default(false)
          .describe('Also probe waypointSequence with a real (tiny) calculation — consumes quota (default false).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(context, async () => {
        const selected = PROBES.filter((probe) => {
          if (args.services && args.services.length > 0 && !args.services.includes(probe.service)) return false;
          if (probe.expensive && !args.probeCalculations) return false;
          return true;
        });

        const results = await Promise.all(
          selected.map(async (probe) => {
            const started = Date.now();
            try {
              const response = await context.client.requestJson(probe.hereService, probe.path, {
                query: probe.query,
                timeoutMs: args.timeoutMs,
                retries: 0,
              });
              const latencyMs = Date.now() - started;
              const rateLimit = collectHeaders(response.headers);
              return {
                service: probe.service,
                ok: true,
                status: response.status,
                latencyMs,
                endpoint: response.url,
                ...(Object.keys(rateLimit).length > 0 ? { rateLimit } : {}),
                ...(probe.note ? { note: probe.note } : {}),
              };
            } catch (error) {
              const latencyMs = Date.now() - started;
              const typed = error as {
                status?: number;
                message?: string;
                code?: string;
                type?: string;
              };
              return {
                service: probe.service,
                ok: false,
                status: typed.status ?? 0,
                latencyMs,
                errorType: typed.type ?? 'ERROR',
                error: typed.message ?? String(error),
                ...(probe.note ? { note: probe.note } : {}),
              };
            }
          }),
        );

        const succeeded = results.filter((result) => result.ok).length;
        const failed = results.length - succeeded;
        const allOk = failed === 0;
        return jsonResult(
          {
            ok: allOk,
            apiKeyConfigured: true,
            checked: results.length,
            succeeded,
            failed,
            services: results,
            defaults: context.config.defaults,
            notes: [
              'HERE does not expose remaining monthly quota per key; x-ratelimit-* headers are shown when returned.',
              ...(args.probeCalculations
                ? []
                : ['waypointSequence not probed (set probeCalculations=true to include a real calculation).']),
            ],
          },
          allOk
            ? `✅ HERE API key healthy: ${succeeded}/${results.length} services OK.`
            : `⚠️ HERE API check: ${succeeded}/${results.length} OK, ${failed} failing — see services[] for status/error per service.`,
        );
      }),
  );
}
