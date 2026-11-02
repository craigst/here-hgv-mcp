#!/usr/bin/env node
/**
 * here-hgv-mcp entry point.
 *
 * Default transport: stdio (what the MCP gateway supervisor and harnesses use).
 * HTTP: starts when HTTP_PORT / MCP_HTTP_PORT is set, or when --http is passed.
 *
 *   node dist/index.js            # stdio (gateway import)
 *   HTTP_PORT=8840 node dist/index.js   # Streamable HTTP on POST /mcp + GET /health
 *   node dist/index.js --check    # validate config without starting a transport
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, wantsHttp, ConfigError, type Config } from './config.js';
import { HereClient } from './client.js';
import { createLogger } from './logger.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { startHttpServer, type RunningHttpServer } from './http.js';

interface CliOptions {
  check: boolean;
  forceHttp: boolean;
  forceStdio: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { check: false, forceHttp: false, forceStdio: false, help: false };
  for (const arg of argv) {
    if (arg === '--check' || arg === '-c') options.check = true;
    else if (arg === '--http') options.forceHttp = true;
    else if (arg === '--stdio') options.forceStdio = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function printHelp(): void {
  process.stderr.write(
    [
      `${SERVER_NAME} ${SERVER_VERSION} — HERE location services MCP server for HGV navigation`,
      '',
      'Usage:',
      '  node dist/index.js                 Start with stdio transport (default, for gateways/harnesses)',
      '  HTTP_PORT=8840 node dist/index.js  Start Streamable HTTP on POST /mcp and GET /health',
      '  node dist/index.js --http          Force HTTP transport (default port 8840)',
      '  node dist/index.js --check         Validate configuration and print a JSON status, then exit',
      '',
      'Environment:',
      '  HERE_API_KEY            required; never logged or committed',
      '  HTTP_PORT/MCP_HTTP_PORT HTTP mode when set (e.g. 8840)',
      '  MCP_HTTP_HOST           bind address (default 0.0.0.0)',
      '  MCP_TRANSPORT           set to "http" or "stdio" to force a transport',
      '  HERE_TIMEOUT_MS         request timeout (default 20000)',
      '  HERE_MAX_RETRIES        retries on 429/5xx (default 2)',
      '  HERE_LOG_LEVEL          debug|info|warn|error|silent (default warn)',
      '  HERE_MAP_OUTPUT_DIR     directory for saved static maps',
      '',
    ].join('\n'),
  );
}

function resolveTransport(config: Config, options: CliOptions): 'http' | 'stdio' {
  const forced = process.env.MCP_TRANSPORT?.trim().toLowerCase();
  if (options.forceHttp || forced === 'http') return 'http';
  if (options.forceStdio || forced === 'stdio') return 'stdio';
  return wantsHttp(config) ? 'http' : 'stdio';
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { type: 'CONFIG_ERROR', message } })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel);
  const transport = resolveTransport(config, options);

  if (options.check) {
    // Used by the gateway import pipeline: prove config + tool wiring without
    // starting a long-running transport.
    const { server } = buildServer({ config });
    const status = {
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      apiKeyConfigured: true,
      transport,
      httpPort: transport === 'http' ? (config.httpPort ?? 8840) : null,
      defaults: config.defaults,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      mapOutputDir: config.mapOutputDir,
    };
    process.stdout.write(`${JSON.stringify(status)}\n`);
    await server.close().catch(() => undefined);
    return;
  }

  if (transport === 'http') {
    let running: RunningHttpServer | undefined;
    try {
      running = await startHttpServer({ config });
    } catch (error) {
      logger.error('Failed to start HTTP server', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
      return;
    }
    logger.info('here-hgv MCP server running', { transport: 'http', url: running.url });
    const shutdown = async (signal: string): Promise<void> => {
      logger.info('Shutting down', { signal });
      await running?.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    return;
  }

  const { server } = buildServer({ config });
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  logger.info('here-hgv MCP server running', { transport: 'stdio', timeoutMs: config.timeoutMs });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'unhandledRejection', error: reason instanceof Error ? reason.message : String(reason) })}\n`,
  );
});

process.on('uncaughtException', (error) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'uncaughtException', error: error.message })}\n`,
  );
  process.exitCode = 1;
});

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'fatal', error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});

// Expose the client factory for tests without starting a transport.
export { HereClient };
