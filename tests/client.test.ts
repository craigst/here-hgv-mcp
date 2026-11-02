import { describe, expect, it, vi } from 'vitest';
import { HereClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { HereApiError, HereTimeoutError } from '../src/errors.js';

const API_KEY = 'test-key-000000000000000000000000000';

function testConfig(env: Record<string, string> = {}) {
  return loadConfig({
    HERE_API_KEY: API_KEY,
    HERE_LOG_LEVEL: 'silent',
    HERE_MAX_RETRIES: '0',
    HERE_RETRY_BASE_MS: '1',
    ...env,
  });
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('HereClient URL building', () => {
  it('builds service URLs with the api key, deep objects and comma lists', () => {
    const client = new HereClient(testConfig(), { fetchImpl: vi.fn() });
    const url = client.buildUrl('routing', '/v8/routes', {
      transportMode: 'truck',
      'vehicle[height]': 420,
      'vehicle[grossWeight]': 44000,
      return: 'summary,tolls',
      via: undefined,
    });
    expect(url.origin).toBe('https://router.hereapi.com');
    expect(url.pathname).toBe('/v8/routes');
    expect(url.searchParams.get('transportMode')).toBe('truck');
    expect(url.searchParams.get('vehicle[height]')).toBe('420');
    expect(url.searchParams.get('vehicle[grossWeight]')).toBe('44000');
    expect(url.searchParams.get('return')).toBe('summary,tolls');
    expect(url.searchParams.get('apiKey')).toBe(API_KEY);
  });

  it('supports repeated parameters (via) instead of comma-joining them', () => {
    const client = new HereClient(testConfig(), { fetchImpl: vi.fn() });
    const url = client.buildUrl(
      'routing',
      '/v8/routes',
      { origin: '1,2' },
      { repeatQuery: { via: ['3,4', '5,6'] } },
    );
    expect(url.searchParams.getAll('via')).toEqual(['3,4', '5,6']);
  });

  it('never puts the api key in a keyless URL', () => {
    const client = new HereClient(testConfig(), { fetchImpl: vi.fn() });
    const url = client.buildUrl('mapImage', '/base/mc/x/1x1/png8', { style: 'explore.day' }, { includeApiKey: false });
    expect(url.searchParams.has('apiKey')).toBe(false);
  });

  it('adds the api key to HERE-owned absolute URLs but not to S3 redirects', () => {
    const client = new HereClient(testConfig(), { fetchImpl: vi.fn() });
    const statusUrl = client.buildUrl(
      'matrix',
      'https://async-1.matrix.router.hereapi.com/v8/matrix/abc/status',
    );
    expect(statusUrl.searchParams.get('apiKey')).toBe(API_KEY);

    const s3Url = client.buildUrl(
      'matrix',
      'https://here-matrix.s3.eu-west-1.amazonaws.com/result.json?X-Amz-Signature=abc',
    );
    expect(s3Url.searchParams.has('apiKey')).toBe(false);
    expect(s3Url.searchParams.get('X-Amz-Signature')).toBe('abc');
  });
});

describe('HereClient error handling', () => {
  it('retries 429 and succeeds, honouring Retry-After', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ routes: [] }));
    const client = new HereClient(testConfig({ HERE_MAX_RETRIES: '1' }), { fetchImpl });

    const response = await client.requestJson('routing', '/v8/routes');
    expect(response.data).toEqual({ routes: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx and raises a typed, redacted API error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: 'apiKey invalid', error_description: `apiKey invalid: ${API_KEY}` },
        { status: 401 },
      ),
    );
    const client = new HereClient(testConfig(), { fetchImpl });

    const failure = client.requestJson('geocode', '/v1/geocode', { query: { q: 'x' } });
    await expect(failure).rejects.toBeInstanceOf(HereApiError);
    await failure.catch((error: HereApiError) => {
      expect(error.status).toBe(401);
      expect(error.retryable).toBe(false);
      expect(error.service).toBe('geocode');
      expect(error.message).not.toContain(API_KEY);
      expect(JSON.stringify(error.details)).not.toContain(API_KEY);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps an aborted request to a timeout error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError')),
          );
        }),
    );
    const client = new HereClient(testConfig({ HERE_MAX_RETRIES: '0' }), { fetchImpl });
    const failure = client.requestJson('traffic', '/v7/flow', { timeoutMs: 20 });
    await expect(failure).rejects.toBeInstanceOf(HereTimeoutError);
  });
});

describe('HereClient binary responses', () => {
  it('returns the buffer and content type for map images', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const client = new HereClient(testConfig(), { fetchImpl });
    const response = await client.requestBuffer('mapImage', '/base/mc/x/1x1/png8');
    expect(response.contentType).toBe('image/png');
    expect(response.buffer.subarray(0, 4).toString('hex')).toBe('89504e47');
  });
});
