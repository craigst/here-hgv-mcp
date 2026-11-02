/**
 * Tool registry — every tool this server exposes, registered in one place.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './shared.js';
import { registerGeocodeTool } from './geocode.js';
import { registerReverseGeocodeTool } from './reverse-geocode.js';
import { registerSearchPlacesTool } from './search-places.js';
import { registerAutosuggestTool } from './autosuggest.js';
import { registerRouteTool } from './route.js';
import { registerRouteMatrixTool } from './route-matrix.js';
import { registerIsolineTool } from './isoline.js';
import { registerWaypointSequenceTool } from './waypoint-sequence.js';
import { registerTrafficIncidentsTool, registerTrafficFlowTool } from './traffic.js';
import { registerMapImageTool } from './map-image.js';
import { registerRouteTollsTool } from './route-tolls.js';
import { registerHealthTool } from './health.js';
import { registerFlexiblePolylineTool } from './flexible-polyline.js';

/** Exact tool names (also asserted by the test suite). */
export const TOOL_NAMES = [
  'here_geocode',
  'here_reverse_geocode',
  'here_search_places',
  'here_autosuggest',
  'here_route',
  'here_route_matrix',
  'here_isoline',
  'here_waypoint_sequence',
  'here_traffic_incidents',
  'here_traffic_flow',
  'here_map_image',
  'here_route_tolls',
  'here_api_health',
  'here_flexible_polyline_decode',
] as const;

export function registerAllTools(server: McpServer, context: ToolContext): void {
  registerGeocodeTool(server, context);
  registerReverseGeocodeTool(server, context);
  registerSearchPlacesTool(server, context);
  registerAutosuggestTool(server, context);
  registerRouteTool(server, context);
  registerRouteMatrixTool(server, context);
  registerIsolineTool(server, context);
  registerWaypointSequenceTool(server, context);
  registerTrafficIncidentsTool(server, context);
  registerTrafficFlowTool(server, context);
  registerMapImageTool(server, context);
  registerRouteTollsTool(server, context);
  registerHealthTool(server, context);
  registerFlexiblePolylineTool(server, context);
}

export type { ToolContext } from './shared.js';
