import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { startHttpServer, type RunningHttpServer } from '../src/http.js';
import { TOOL_NAMES } from '../src/tools/index.js';

const API_KEY = 'test-key-000000000000000000000000000';

const GEOCODE_FIXTURE = {
  items: [
    {
      title: 'Trafford Park, Manchester',
      id: 'here:pa:1',
      resultType: 'locality',
      address: { label: 'Trafford Park, Manchester, England, United Kingdom', countryCode: 'GBR', city: 'Manchester' },
      position: { lat: 53.46813, lng: -2.30835 },
      distance: 500,
    },
  ],
};

const ROUTE_FIXTURE = {
  routes: [
    {
      id: 'route-1',
      notices: [],
      sections: [
        {
          id: 's1',
          type: 'vehicle',
          transport: { mode: 'truck' },
          departure: { time: '2026-11-03T08:30:00Z' },
          arrival: { time: '2026-11-03T09:44:00Z' },
          summary: { duration: 4492, length: 68477, baseDuration: 3856 },
          polyline: 'BFoz5xJ67i1B1B7PzIhaxL7Y',
          actions: [{ action: 'depart', instruction: 'Head south', offset: 0, duration: 10, length: 120 }],
          tolls: [
            {
              countryCode: 'GBR',
              tollSystem: 'UK HGV LEVY ENGLAND',
              fares: [
                { id: 'f1', name: 'day', price: { type: 'value', currency: 'GBP', value: 10.36 } },
                { id: 'f2', name: 'month', price: { type: 'value', currency: 'GBP', value: 77.6 } },
              ],
            },
          ],
        },
      ],
      routeLabels: [{ name: 'M62' }],
    },
  ],
  notices: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseConfig(env: Record<string, string> = {}) {
  return loadConfig({
    HERE_API_KEY: API_KEY,
    HERE_LOG_LEVEL: 'silent',
    HERE_MAX_RETRIES: '0',
    HERE_RETRY_BASE_MS: '1',
    ...env,
  });
}

function createFakeFetch() {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname === '/v1/geocode') return jsonResponse(GEOCODE_FIXTURE);
    if (url.pathname === '/v8/routes') return jsonResponse(ROUTE_FIXTURE);
    return jsonResponse({ error: 'not found' }, 404);
  });
}

async function connectInMemory(fetchImpl: typeof fetch, config = baseConfig()) {
  const { server } = buildServer({ config, fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('MCP tool surface (in-memory transport)', () => {
  it('exposes exactly the required tool set, each with a rich schema', async () => {
    const { client, server } = await connectInMemory(createFakeFetch());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of listed.tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(200);
      expect(tool.inputSchema.type).toBe('object');
    }
    await client.close();
    await server.close();
  });

  it('calls here_geocode and returns a structured JSON result plus human summary', async () => {
    const { client, server } = await connectInMemory(createFakeFetch());
    const result = await client.callTool({
      name: 'here_geocode',
      arguments: { q: 'Trafford Park, Manchester', limit: 1 },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.items[0].position).toEqual({ lat: 53.46813, lng: -2.30835 });
    expect((result.content as { text: string }[])[1]!.text).toContain('Trafford Park');
    await client.close();
    await server.close();
  });

  it('sends the HGV profile as HERE vehicle[...] params and shapes the truck route', async () => {
    const fetchImpl = createFakeFetch();
    const { client, server } = await connectInMemory(fetchImpl);
    const result = await client.callTool({
      name: 'here_route',
      arguments: {
        origin: '53.4808,-2.2426',
        destination: '53.8008,-1.5491',
        transportMode: 'truck',
        truck: { heightM: 4.2, grossWeightKg: 44000, axleCount: 6, tunnelCategory: 'C' },
        departureTime: '2026-11-03T08:30:00+00:00',
        includeTolls: true,
        includeInstructions: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.transportMode).toBe('truck');
    expect(payload.routes[0].summary).toMatchObject({
      distanceMeters: 68477,
      durationSeconds: 4492,
      trafficDelaySeconds: 636,
    });
    expect(payload.routes[0].tolls.totalCost).toBe(10.36);
    expect(payload.routes[0].instructions[0].instruction).toBe('Head south');

    const calledUrl = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(calledUrl.searchParams.get('transportMode')).toBe('truck');
    expect(calledUrl.searchParams.get('vehicle[height]')).toBe('420');
    expect(calledUrl.searchParams.get('vehicle[grossWeight]')).toBe('44000');
    expect(calledUrl.searchParams.get('vehicle[axleCount]')).toBe('6');
    expect(calledUrl.searchParams.get('vehicle[tunnelCategory]')).toBe('C');
    expect(calledUrl.searchParams.get('return')).toContain('summary');
    expect(calledUrl.searchParams.get('return')).toContain('tolls');
    expect(calledUrl.searchParams.get('currency')).toBe('GBP');
    expect(calledUrl.searchParams.get('departureTime')).toBe('2026-11-03T08:30:00+00:00');
    await client.close();
    await server.close();
  });

  it('decodes a flexible polyline without calling the HERE API', async () => {
    const fetchImpl = createFakeFetch();
    const { client, server } = await connectInMemory(fetchImpl);
    const result = await client.callTool({
      name: 'here_flexible_polyline_decode',
      arguments: { encoded: 'BFoz5xJ67i1B1B7PzIhaxL7Y' },
    });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.pointCount).toBe(4);
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('turns a HERE 401 into a structured tool error without leaking the key', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: 'apiKey invalid', error_description: 'apiKey not found' }, 401));
    const { client, server } = await connectInMemory(fetchImpl);
    const result = await client.callTool({ name: 'here_geocode', arguments: { q: 'London' } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain('API_ERROR');
    expect(text).toContain('apiKey not found');
    expect(text).not.toContain(API_KEY);
    await client.close();
    await server.close();
  });
});

describe('Streamable HTTP transport', () => {
  let running: RunningHttpServer;

  beforeAll(async () => {
    running = await startHttpServer({
      config: baseConfig({ HTTP_PORT: '0' }),
      fetchImpl: createFakeFetch(),
      port: 0,
    });
  });

  afterAll(async () => {
    await running.close();
  });

  it('answers GET /health with {ok:true} and the tool count', async () => {
    const response = await fetch(`${running.url}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; toolCount: number; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('here-hgv');
    expect(body.toolCount).toBe(TOOL_NAMES.length);
  });

  it('serves MCP JSON-RPC at POST /mcp (initialize, tools/list, tools/call)', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`));
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);

    const result = await client.callTool({ name: 'here_geocode', arguments: { q: 'Trafford Park' } });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.ok).toBe(true);

    await client.close();
  });
});
