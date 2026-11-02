# here-hgv-mcp

A production-grade [Model Context Protocol](https://modelcontextprotocol.io) server for **HERE Platform location services, specialised for HGV (heavy goods vehicle) navigation**. TypeScript, Node ≥ 22, the official `@modelcontextprotocol/sdk`, with **both** transports:

- **stdio** — the default, for the MCP gateway supervisor and harnesses that spawn the process
- **Streamable HTTP** — `POST /mcp` (plus `GET /health`), enabled with `HTTP_PORT`/`MCP_HTTP_PORT`

14 tools cover the whole logistics workflow: geocoding, place search, truck routing with a full vehicle profile, many-to-many matrices, reachable-area isolines, multi-stop order optimisation, live traffic incidents/flow, HGV toll costs, static maps and a self-contained polyline decoder — plus an entitlement/health prober.

> **Why not HERE's own hosted MCP?** HERE publishes an official *Location Reasoning* MCP and a documentation MCP at <https://docs.here.com/mcp>. Neither exposes truck/HGV specific routing (height/width/weight/axle/hazmat/tunnel restrictions) or UK HGV toll analysis. This server is the HGV-specific layer over the same HERE APIs.

---

## Tools

| Tool | What it does |
|---|---|
| `here_geocode` | Free-text address/place → coordinates, structured address parts, bbox. UK focus by default (`countryCode:GBR`), `limit`, `lang`, result `types`. |
| `here_reverse_geocode` | Coordinates → nearest address(es), optional search radius, language. |
| `here_search_places` | Places around a point (Discover v7) or HERE category browse (Browse v7); radius, categories, `openNow` (best-effort), language. |
| `here_autosuggest` | Typed-ahead address/POI suggestions, GB bbox bias by default, optional proximity point. |
| `here_route` | HERE Routing v8: `car \| truck \| pedestrian \| bicycle \| scooter`. Full HGV profile (`vehicle[...]`), avoid features/areas/countries, departure/arrival time, metric units, en-GB, GBP, tolls, instructions, spans, polylines (opt-in). |
| `here_route_matrix` | Many origins × destinations travel times. Runs HERE's async job flow (submit → poll status → gzip result) and returns a 2-D durations matrix. Resumable by `matrixId`. |
| `here_isoline` | Reachable area (isochrone/isodistance) polygons by time or distance, truck profile aware, multiple ranges. |
| `here_waypoint_sequence` | Multi-stop order optimisation (`findsequence2`): depot, optional end, up to 50 stops, truck profile, `improveFor` time/distance. |
| `here_traffic_incidents` | Live incidents (closures, accidents, roadworks…) in a bbox/circle/corridor, filter by criticality/type, OLR references. |
| `here_traffic_flow` | Live speeds and jam factor per segment in a bbox/circle/corridor; `maxJamFactor` defaults to 10 so congestion is not hidden. |
| `here_map_image` | Static PNG/JPEG map with markers and an optional route line. Saved server-side; the API key is never returned. |
| `here_route_tolls` | Toll cost and toll-system detail for an HGV route, e.g. **UK HGV Levy England**; fares are returned as alternatives (cheapest vs dearest). |
| `here_api_health` | Probes every HERE service with the configured key and reports status, latency, entitlement errors and rate-limit headers. |
| `here_flexible_polyline_decode` | Decode HERE Flexible Polyline geometry to `[lat,lng]` — local computation, no API call, no quota. |

Every tool returns **structured JSON text first** (stable shape, `ok: true|false`) and, where useful, a **compact human summary** as a second text block. All failures are structured (`{ok:false,error:{type,message,status,service,retryable}}`) instead of thrown protocol errors.

---

## Quick start

```bash
npm install
npm run build

# stdio (default) — what the gateway/harnesses use
HERE_API_KEY=... node dist/index.js

# Streamable HTTP on http://127.0.0.1:8840 (POST /mcp, GET /health)
HERE_API_KEY=... HTTP_PORT=8840 node dist/index.js

# validate configuration + tool wiring without starting a transport
HERE_API_KEY=... node dist/index.js --check
```

For local development keep the key in a gitignored `.env.local` and let Node load it:

```bash
set -a; . ./.env.local; set +a
npm run build && node dist/index.js --check
# or: node --env-file=.env.local dist/index.js
```

Never commit a key. The server reads `HERE_API_KEY` from the environment only.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `HERE_API_KEY` | **yes** | — | HERE API key. Never logged, never returned, never written to disk by this server. |
| `HTTP_PORT` / `MCP_HTTP_PORT` | no | unset | Set to run Streamable HTTP instead of stdio (e.g. `8840`). |
| `MCP_HTTP_HOST` | no | `0.0.0.0` | HTTP bind address. |
| `MCP_TRANSPORT` | no | auto | Force `http` or `stdio`. CLI flags `--http` / `--stdio` also work. |
| `MCP_STATELESS` | no | `false` | HTTP mode without session ids (one transport per request). |
| `HERE_TIMEOUT_MS` | no | `20000` | Per-request timeout. |
| `HERE_MAX_RETRIES` | no | `2` | Retries on 429/5xx/network errors (exponential backoff + `Retry-After`). |
| `HERE_RETRY_BASE_MS` | no | `250` | Base backoff delay. |
| `HERE_DEFAULT_COUNTRY` | no | `GBR` | Country focus for geocode/autosuggest. |
| `HERE_DEFAULT_LANG` | no | `en-GB` | Instruction/name language. |
| `HERE_DEFAULT_CURRENCY` | no | `GBP` | Toll currency. |
| `HERE_DEFAULT_UNITS` | no | `metric` | `metric`/`imperial` guidance units. |
| `HERE_MAP_OUTPUT_DIR` | no | `<tmp>/here-hgv-mcp-maps` | Where `here_map_image` writes saved images. |
| `HERE_LOG_LEVEL` | no | `warn` | `debug\|info\|warn\|error\|silent` (all logs go to **stderr**). |
| `HERE_BASE_<SERVICE>` | no | HERE production | Override a base URL (e.g. `HERE_BASE_ROUTING`) — for tests/proxies. |

---

## Transports

### stdio (default)

The gateway import starts managed servers with `std::process` pipes, so **stdio is the default**. The process writes MCP on stdout; all logs go to stderr (a stray stdout log would corrupt the protocol).

`mcp-manifest.json`:

```json
{
  "name": "here-hgv",
  "version": "1.0.0",
  "runtime": "node22",
  "build_command": "npm install && npm run build",
  "start_command": "node dist/index.js",
  "required_secrets": ["HERE_API_KEY"],
  "capabilities": { "high_privilege_tools": [], "delegation_supported": false }
}
```

The gateway injects `HERE_API_KEY` from its vault at process start. The server fails fast with a clear JSON error if it is missing.

### Streamable HTTP

Only when `HTTP_PORT`/`MCP_HTTP_PORT` is set (or `--http`):

- `POST /mcp` — MCP JSON-RPC (sessions via `mcp-session-id`, `initialize` first)
- `GET /health` — `{"ok":true,"name":"here-hgv","version":"1.0.0","transport":"http","toolCount":14,...}`
- `GET /mcp` — SSE stream for an existing session; `DELETE /mcp` — terminate a session
- CORS headers and `OPTIONS` are handled so browser/Omb clients can connect

Verify with curl:

```bash
# 1) initialize — save the mcp-session-id response header
curl -sS -D headers.txt \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' \
  http://127.0.0.1:8840/mcp
SID=$(grep -i '^mcp-session-id:' headers.txt | tr -d '\r' | awk '{print $2}')

# 2) send the initialized notification
curl -sS -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  http://127.0.0.1:8840/mcp

# 3) list tools
curl -sS -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  http://127.0.0.1:8840/mcp

# 4) call a tool (truck route, 4.2 m / 44 t)
curl -sS -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"here_route","arguments":{"origin":"53.4808,-2.2426","destination":"53.8008,-1.5491","transportMode":"truck","truck":{"heightM":4.2,"grossWeightKg":44000,"axleCount":6},"departureTime":"2026-11-03T08:30:00+00:00","includeTolls":true}}}' \
  http://127.0.0.1:8840/mcp
```

---

## HGV / UK notes

- **Dimensions are metres, weights kilograms** in the tool API (e.g. `heightM: 4.2`, `grossWeightKg: 44000`). They are sent to HERE in the units HERE expects: `vehicle[height]` etc. in **centimetres**, weights in kg.
- HERE Routing v8 uses `vehicle[...]` parameters (`truck[...]` is the deprecated spelling). The profile supports height, width, length, gross weight, weight per axle, axle count, trailer count, trailer axle count, hazardous goods, tunnel category, vehicle category and licence plate.
- **Tunnel categories** are ADR cargo codes: `A` unrestricted, `B`–`E` increasingly restrictive. The router only uses tunnels of a *less* restrictive category.
- **Hazardous goods** are sent as `vehicle[shippedHazardousGoods]`; any real class makes the router apply hazmat restrictions. `none` is dropped.
- **Emissions are a toll attribute**, not a vehicle one in HERE v8: `here_route`/`here_route_tolls` send `tolls[emissionType]` (e.g. `euro6`). There is deliberately no `vehicle[emissionType]`/`limitedWeight` — HERE silently ignores unknown parameters, so advertising them would be misleading.
- UK defaults: `units=metric`, `lang=en-GB`, `currency=GBP`, country focus `GBR`.
- **Tolls**: `here_route_tolls` returns the fare *products* HERE reports. For the UK HGV Levy these are alternative day/week/month passes, so `totalCost` is the cheapest product for the trip and `totalCostMax` the dearest — do **not** sum the fares. `tolls[summaries]=total,tollSystem,country` is requested.
- **Traffic**: `here_traffic_flow` defaults `maxJamFactor=10` (HERE's default of 1.0 hides congestion) and always sends `locationReferencing` (mandatory for `/v7/flow`).
- Departure/arrival times must be RFC 3339 **with an explicit UTC offset** (`2026-11-03T08:30:00+00:00` or `...Z`); a bare local time is rejected with an actionable message.

---

## Design notes

- **One client** (`src/client.ts`) owns base URLs, `apiKey` injection, timeouts, bounded retries with exponential backoff + jitter on 429/5xx/network errors (honouring `Retry-After`), and typed errors. URLs are redacted before they reach a log line or error message.
- **Response shaping** (`src/util/shape.ts`) projects HERE's verbose payloads into stable, agent-friendly structures: metres + km, seconds + human duration, traffic delay computed as `duration − baseDuration`, polylines opt-in, large span/instruction lists capped.
- **Place resolution**: every tool that needs a point accepts either `"lat,lng"` or free-text (auto-geocoded with the configured country focus), so an agent never has to chain geocode → route manually.
- **Matrix** uses the verified minimal body `{origins,destinations,regionDefinition:{type:"world"}}` (never `matrixAttributes`, which HERE v8 rejects), submits with `async=true`, polls the status URL with redirects **manual** so the key survives HERE's 303, then fetches the gzip result. `transportMode`/`vehicle` are only sent when explicitly requested.
- **Static maps** are downloaded server-side and written inside `HERE_MAP_OUTPUT_DIR`; the returned URL is credential-free by design.
- **Health** uses HERE's `/health` endpoints where they exist and minimal real queries otherwise. HERE does not expose remaining monthly quota per key over these APIs, so quota is reported as "not exposed"; `x-ratelimit-*` headers are surfaced when present.

---

## Security

- `HERE_API_KEY` is read from the environment only; it is never logged, never returned in tool output, and errors are scrubbed of it.
- All log output goes to stderr, never stdout (stdio transport integrity).
- `.env*` is gitignored; only `.env.example` is committed.
- `here_map_image` will not write outside the configured output directory, and only writes a file when the bytes really are a PNG/JPEG.
- Tool annotations mark every tool read-only except `here_map_image` (local file write). No HERE data is mutated by this server.

---

## Tests

```bash
npm test        # 35 unit + integration tests (vitest, mocked fetch)
npm run build   # tsc → dist/
npm run typecheck
```

Coverage includes: URL/parameter building (deep objects, repeated `via`, keyless URLs, S3 redirects), retries/429, 4xx typed errors, timeouts, binary map responses, the full `vehicle[...]` truck mapping, avoid-feature aliases, response shaping (route summaries, traffic delay, fares-as-alternatives, matrix envelope, traffic `results[]`), the Flexible Polyline reference vector, and end-to-end tests over both an in-memory transport and real Streamable HTTP (initialize → tools/list → tools/call → health).

Live verification against the real HERE APIs (all 14 tools) is recorded in [EVIDENCE.md](./EVIDENCE.md).

---

## Known limitations

- **Matrix v8 is effectively car-based.** The verified async flow accepts origins/destinations/regionDefinition; truck `vehicle` options are sent only when explicitly requested and may be rejected — use `here_route` for per-route HGV restrictions.
- **`openNow` is best-effort.** HERE Geocoding & Search v7 does not return opening hours, so the tool reports `openNowApplied:false` with a warning when it cannot filter.
- HERE silently ignores unknown parameters, so this server validates and documents every parameter it sends rather than trusting a 200.
- No static "truck restriction lookup" tool: HERE's restriction data is exposed through routing (`vehicle[...]`, avoid features) and map image `vehicle_restrictions`, not a queryable endpoint. `here_map_image` with `style`/`features` can render them visually.
- `here_waypoint_sequence` has no HERE `/health` endpoint; `here_api_health` only probes it with `probeCalculations=true` (real calculation, consumes quota).

---

## Licence

MIT — see [LICENSE](./LICENSE). The Flexible Polyline decoder in `src/util/geo.ts` is a TypeScript port of [HERE's reference implementation](https://github.com/heremaps/flexible-polyline) (MIT, © HERE Europe B.V.).
