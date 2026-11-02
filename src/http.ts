/**
 * Streamable HTTP transport (POST /mcp) for the gateway / Omb bots.
 *
 * stdio remains the default so the gateway supervisor can speak MCP over
 * stdin/stdout; this listener only starts when HTTP_PORT / MCP_HTTP_PORT is set
 * (or --http is passed). GET /health is always available for readiness probes.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { createLogger } from './logger.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { TOOL_NAMES } from './tools/index.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_IDLE_MS = 30 * 60 * 1000;

export interface HttpServerOptions {
  config: Config;
  fetchImpl?: typeof fetch;
  host?: string;
  port?: number;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const { config } = options;
  const logger = createLogger(config.logLevel).child('http');
  const sessions = new Map<string, SessionEntry>();
  const startedAt = Date.now();
  const host = options.host ?? config.httpHost;
  const port = options.port ?? config.httpPort ?? 8840;

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        throw new Error('Request body too large');
      }
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text.length === 0) return undefined;
    return JSON.parse(text);
  };

  const sendJsonRpcError = (
    res: ServerResponse,
    status: number,
    code: number,
    message: string,
    id: unknown = null,
  ): void => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id }));
  };

  const applyCors = (res: ServerResponse): void => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
    );
    res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
  };

  const createSession = async (): Promise<SessionEntry> => {
    let entry: SessionEntry;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, entry);
        logger.debug('MCP session initialised', { sessionId, sessions: sessions.size });
      },
    });
    const { server } = buildServer(
      options.fetchImpl
        ? { config, fetchImpl: options.fetchImpl }
        : { config },
    );
    entry = { server, transport, lastUsed: Date.now() };
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
    };
    await server.connect(transport);
    return entry;
  };

  const handleMcpPost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJsonRpcError(res, 400, -32700, `Parse error: ${(error as Error).message}`);
      return;
    }
    if (body === undefined || typeof body !== 'object') {
      sendJsonRpcError(res, 400, -32600, 'Invalid Request: expected a JSON-RPC message body');
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    const headerSession = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    if (config.statelessHttp) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const { server } = buildServer(options.fetchImpl ? { config, fetchImpl: options.fetchImpl } : { config });
      await server.connect(transport);
      res.on('close', () => {
        void transport.close();
      });
      await transport.handleRequest(req, res, body);
      return;
    }

    if (headerSession) {
      const entry = sessions.get(headerSession);
      if (!entry) {
        sendJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      entry.lastUsed = Date.now();
      await entry.transport.handleRequest(req, res, body);
      return;
    }

    const method = (body as { method?: unknown }).method;
    if (method !== 'initialize') {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: missing mcp-session-id (send initialize first)');
      return;
    }
    const entry = await createSession();
    await entry.transport.handleRequest(req, res, body);
  };

  const handleMcpGet = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawSession = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;
    if (!sessionId) {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: mcp-session-id header is required for GET /mcp');
      return;
    }
    const entry = sessions.get(sessionId);
    if (!entry) {
      sendJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    entry.lastUsed = Date.now();
    await entry.transport.handleRequest(req, res);
  };

  const handleMcpDelete = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawSession = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;
    if (!sessionId) {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: mcp-session-id header is required');
      return;
    }
    const entry = sessions.get(sessionId);
    if (!entry) {
      sendJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    sessions.delete(sessionId);
    await entry.transport.handleRequest(req, res);
  };

  const server: Server = createServer((req, res) => {
    applyCors(res);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    const handle = async (): Promise<void> => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            name: SERVER_NAME,
            version: SERVER_VERSION,
            transport: 'http',
            toolCount: TOOL_NAMES.length,
            sessions: sessions.size,
            uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          }),
        );
        return;
      }
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            name: SERVER_NAME,
            version: SERVER_VERSION,
            mcpEndpoint: 'POST /mcp',
            healthEndpoint: 'GET /health',
            transports: ['stdio (default)', 'streamable-http'],
          }),
        );
        return;
      }
      if (path === '/mcp') {
        if (req.method === 'POST') {
          await handleMcpPost(req, res);
          return;
        }
        if (req.method === 'GET') {
          await handleMcpGet(req, res);
          return;
        }
        if (req.method === 'DELETE') {
          await handleMcpDelete(req, res);
          return;
        }
        res.writeHead(405, { allow: 'GET, POST, DELETE, OPTIONS' });
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    };

    handle().catch((error: unknown) => {
      logger.error('HTTP request failed', {
        path,
        method: req.method,
        error: error instanceof Error ? error.message : String(error),
      });
      sendJsonRpcError(res, 500, -32603, 'Internal server error');
    });
  });

  const idleTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [sessionId, entry] of sessions) {
      if (entry.lastUsed < cutoff) {
        sessions.delete(sessionId);
        void entry.transport.close();
      }
    }
  }, 5 * 60 * 1000);
  idleTimer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${actualPort}`;
  logger.info('HTTP transport listening', { url, mcp: `${url}/mcp`, health: `${url}/health` });

  return {
    url,
    port: actualPort,
    close: async () => {
      clearInterval(idleTimer);
      for (const entry of sessions.values()) {
        await entry.transport.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
