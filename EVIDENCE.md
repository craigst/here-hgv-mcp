# EVIDENCE — here-hgv-mcp live verification

All results below were produced on **2026-11-02** with Node **v26.12.1** (≥ 22) against the real HERE Platform APIs, using an entitled HERE API key supplied by the gateway operator via a **gitignored `.env.local`** (mode 0600). The key value is not reproduced anywhere in this file or in the repository.

## 0. API key note (honesty check)

The API key originally quoted in the build brief was rejected upstream by HERE on every service:

```
GET https://geocode.search.hereapi.com/v1/geocode?q=London&apiKey=<brief-key-from-the-task>
HTTP 401
{"error":"Unauthorized","error_description":"apiKey invalid. apiKey not found."}
```

It also failed on `router.hereapi.com/v8/routes`, `discover.search.hereapi.com`, and as an `Authorization: Bearer` token (`unrecognized kid null`). A working key was subsequently provided out-of-band and loads the same way (`set -a; . ./.env.local; set +a`). Nothing in the server special-cases either key.

## 1. Build, typecheck, tests

```
$ node -v && npm -v
v26.12.1
12.2.1

$ npm run build
> here-hgv-mcp@1.0.0 build
> tsc -p tsconfig.json
(exit 0; dist/ = 444 KiB)

$ npm run typecheck
(exit 0)

$ npm test
 ✓ tests/geo.test.ts (6 tests) 7ms
 ✓ tests/shape.test.ts (9 tests) 12ms
 ✓ tests/truck.test.ts (5 tests) 4ms
 ✓ tests/client.test.ts (8 tests) 129ms
 ✓ tests/integration.test.ts (7 tests) 139ms

 Test Files  5 passed (5)
      Tests  35 passed (35)
   Duration  458ms
```

The integration tests exercise both transports: an in-memory MCP transport (exact 14-tool surface, `tools/call`, structured errors) and a real Streamable HTTP listener on an ephemeral port (`initialize`, `tools/list`, `tools/call`, `GET /health`).

## 2. Transport: stdio default + Streamable HTTP

`node dist/index.js --check` with no key fails fast (exit 1) without leaking anything:

```
{"ok":false,"error":{"type":"CONFIG_ERROR","message":"HERE_API_KEY is required. Set it in the environment (or in a gitignored .env file) — it is never logged."}}
```

With an entitled key, HTTP mode on a spare port:

```
$ HTTP_PORT=8841 node dist/index.js
$ curl -sS http://127.0.0.1:8841/health
{"ok":true,"name":"here-hgv","version":"1.0.0","transport":"http","toolCount":14,"sessions":0,"uptimeSeconds":1}
```

Raw JSON-RPC over HTTP (no SDK involved), captured with curl:

```
POST /mcp initialize           -> 200, mcp-session-id: f51c66cd…,
                                  serverInfo {name:"here-hgv",version:"1.0.0"}
POST /mcp notifications/initialized -> 202
POST /mcp tools/list           -> 14 tools:
  here_geocode, here_reverse_geocode, here_search_places, here_autosuggest,
  here_route, here_route_matrix, here_isoline, here_waypoint_sequence,
  here_traffic_incidents, here_traffic_flow, here_map_image,
  here_route_tolls, here_api_health, here_flexible_polyline_decode
POST /mcp tools/call here_geocode {q:"Trafford Park, Manchester"} ->
  ok:true, count:1,
  title:"Trafford Park, Manchester, England, United Kingdom",
  position:{lat:53.46813,lng:-2.30835}
POST /mcp tools/call here_route {truck, 4.2 m, 44 t, departure 2026-11-03T08:30:00+00:00} ->
  ok:true, summary:{distanceMeters:68477, durationSeconds:4492,
                    baseDurationSeconds:3856, trafficDelaySeconds:636},
  tolls: 10.36 GBP
  human: "🚚 … (truck 4.2 m / 44 t): 68.5 km / 1 h 14 min, traffic +10 min, tolls GBP 10.36."
```

## 3. Live tool results (all 14 tools)

Harness: `node .scratch/live-e2e.mjs` → starts the real HTTP transport, connects the official MCP SDK client, and calls every tool once with the working key.

| Tool | Result (trimmed) |
|---|---|
| `here_api_health` | `✅ HERE API key healthy: 9/9 services OK` (geocode, reverseGeocode, discover, autosuggest, routing, matrix, isoline, traffic, mapImage) |
| `here_geocode` | 1 result — **Trafford Park, Manchester, England, United Kingdom** at `53.46813, -2.30835` |
| `here_reverse_geocode` | **73-79 King Street, Manchester, M2 4NG, United Kingdom** for `53.4808,-2.2426` (200 m radius) |
| `here_search_places` | 1 place — **AS24 (Trafford Park Truckstop)**, 5,781 m from the search centre |
| `here_autosuggest` | 3 suggestions, top **The Trafford Centre** |
| `here_route` (truck) | **68.5 km / 1 h 14 min**; base duration 3,856 s → **traffic delay 636 s**; 24 instructions; 200 spans; tolls **GBP 10.36** (UK HGV LEVY ENGLAND); 1 leg. Request used `vehicle[height]=420`, `vehicle[grossWeight]=44000`, `vehicle[axleCount]=6`, `vehicle[tunnelCategory]=C` |
| `here_route_tolls` | **GBP 9.33** cheapest product (**GBP 597.00** dearest) — UK HGV LEVY ENGLAND, **4 fare products** returned (day/week/month passes + …), `emissionType=euro6` applied via `tolls[emissionType]` |
| `here_route_matrix` | async job `f98e267b-…` completed; **2×2** matrix, `travelTimes = [[0,3610],[3809,0]]` seconds |
| `here_isoline` (truck) | **2 isolines** — 15 min and 30 min from Manchester, 1 polygon each; departure `2026-11-02T20:35:37Z` |
| `here_waypoint_sequence` (truck) | order **depot → 53.600,-2.000 → 53.700,-1.800 → Leeds**; **68.9 km / 1 h 35 min**, 3 legs |
| `here_traffic_incidents` | 5 returned (750 matching); **2 critical, 3 major, 1 road closure**; first: `construction`, major, 66 m |
| `here_traffic_flow` | 5 returned (555 matching); avg **jamFactor 0.54**, 0 congested; first: **M65 WESTBOUND**, jam 0.6, 17.2 km/h (free flow 19.4), traversability `open` |
| `here_map_image` | saved **PNG 800×500, 156,284 bytes** (`/tmp/here-hgv-mcp-maps/here-map-….png`), 2 labelled markers, `image/png` |
| `here_flexible_polyline_decode` | HERE reference vector `BFoz5xJ67i1B1B7PzIhaxL7Y` → **4 points**, precision 5: `[50.10228,8.69821] … [50.09878,8.68752]` |

## 4. Additional live checks (edge cases that bit)

Beyond the 14-tool sweep, three parameter combinations were exercised live and fixed where HERE behaved differently from the docs:

- **Category browse** — `here_search_places {at:"53.4808,-2.2426", categories:["700-7600-0116"], radiusM:5000}` → 3 places, nearest **ASDA Express (756 m)**. This path uses HERE **Browse v7** (Discover has no category filter) with `at` only, because `at` + `in=circle` is rejected as mutually exclusive.
- **Multi-via + avoid** — `here_route {via:["53.60,-2.00","53.70,-1.80"], avoid:{features:["tollRoad"], countries:["IRL"]}}` → **3 legs**, 68.9 km / 1 h 24 min, traffic +7 min; per-leg polylines returned 626 decoded points for leg 0. Confirms `via` is sent as **repeated** parameters (`via=…&via=…`), not comma-joined.
- **Route line on a static map** — original implementation expanded the 626-point polyline into a GeoJSON LineString, which HERE rejected with **414 Request-URI Too Large**. Fixed by sending the encoded polyline through HERE's compact `overlay=line:<flexpolyline>;color=#0044FF;width=6m` parameter instead. Re-test: **PNG 640×480, 123,244 bytes**, `hasRouteLine:true`. Explicit `routePoints` are now downsampled to ≤200 points for the same reason.

Final full sweep: **14/14 tools OK against the live HERE APIs, zero errors** (a second run repeated after the map fix).

## 5. Parameters verified against the live API (not just docs)

Several HERE docs/spec details were corrected by live behaviour and are reflected in the implementation:

1. **`return` must be comma-separated, not repeated.** `return=summary&return=tolls` → `400 E605001 Parameter 'return' specified more than once`; `return=summary,tolls` → 200.
2. **`spans` is not a valid `return` value** (`Invalid return type at 'spans'`). Spans are requested with `spans=duration,length,…` alongside `return=polyline`.
3. **HERE Routing v8 uses `vehicle[...]`** (`truck[...]` deprecated): height/width/length in **cm**, weights in kg; hazard/tunnel/axle fields confirmed accepted.
4. **Traffic v7 returns `results[]`**, not `flow`/`incidents`. `/v7/flow` **requires `locationReferencing`** and its default `maxJamFactor=1.0` would hide congestion — the tool defaults to 10.
5. **At most one area parameter**: `at` and `in=circle` are mutually exclusive (`400 Mutually exclusive parameters violated`) — reverse geocode and place search send exactly one.
6. **Autosuggest has no country-code area**: `in=countryCode:GBR` → 400; the UK default is a Great Britain `bbox`.
7. **Matrix v8 async flow**: `POST /v8/matrix?async=true` → `202 {matrixId,statusUrl}`; status answers **303 with a `Location`** to the result (following that redirect silently drops the apiKey → `401 No credentials found`), so the client polls with `redirect:"manual"`, appends the key to the HERE-hosted result URL, then follows the S3 redirect. Result envelope is `{matrix:{numOrigins,numDestinations,travelTimes}}`. `matrixAttributes` is never sent.
8. **Toll fares are alternatives**: one UK HGV Levy toll cost carries day/week/month products (10.36 / 38.80 / 77.60 / …), which must not be summed; `totalCost` takes the cheapest, `totalCostMax` the dearest.
9. **Map Image v3 only accepts ISO 639-1 two-letter `lang`** (`en-GB` → `400 E622002`); the tool derives `en` from `en-GB` and the image download was verified as a real PNG (magic bytes checked before writing).
10. **Waypoints Sequence requires `departure`** when traffic is enabled (`400 "Time for departure is missing"`); the tool defaults it to `now`.

## 6. Repro commands

```bash
cd here-hgv-mcp
npm install
npm run build
npm test

# add a gitignored .env.local containing HERE_API_KEY=…, then:
set -a; . ./.env.local; set +a
node dist/index.js --check
node .scratch/live-e2e.mjs          # full 14-tool live sweep (scratch script, gitignored)

# HTTP smoke test
HTTP_PORT=8841 node dist/index.js &
curl -sS http://127.0.0.1:8841/health
```
