/**
 * Build a fully configured MCP server (transport-agnostic).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HereClient } from './client.js';
import type { Config } from './config.js';
import { registerAllTools, type ToolContext } from './tools/index.js';

export const SERVER_NAME = 'here-hgv';
export const SERVER_VERSION = '1.0.0';

export interface BuildServerOptions {
  config: Config;
  /** Inject a client (tests) instead of constructing one from the config. */
  client?: HereClient;
  /** Inject a fetch implementation (tests). */
  fetchImpl?: typeof fetch;
}

export interface BuiltServer {
  server: McpServer;
  client: HereClient;
  context: ToolContext;
}

export function buildServer(options: BuildServerOptions): BuiltServer {
  const client =
    options.client ??
    new HereClient(options.config, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  const context: ToolContext = { client, config: options.config };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'HERE location services for HGV navigation (UK-focused). Use here_geocode/here_autosuggest to resolve addresses, here_route with transportMode="truck" for restricted HGV routes, here_route_tolls for toll costs, here_route_matrix for many-to-many times, here_isoline for reachable areas, here_waypoint_sequence for multi-drop ordering, here_traffic_* for live conditions, and here_api_health to diagnose key/entitlement problems. Dimensions are metres, weights kilograms.',
    },
  );
  registerAllTools(server, context);
  return { server, client, context };
}
