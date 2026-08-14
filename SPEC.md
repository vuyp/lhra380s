# Whale Watch LHR — Build Spec

The single source of truth for this repo. Every module must conform to it.

## 1. Product

**Whale Watch LHR** is a free, keyless, no-login web app that tracks every Airbus A380
arriving at and departing from London Heathrow (EGLL / LHR), in real time, for planespotters
and passengers standing at the fence.

Design values, in priority order:

1. **Answer the spotter's question in under 2 seconds.** "Is a whale coming, when, and where do I stand?"
2. **Mobile-first.** The primary user is outdoors, one-handed, on 4G, in bright sun or dark.
3. **Sleek and calm.** Dense information, zero clutter, no ads, no dead space, no cartoon.
4. **Free and unlimited.** No API keys, no accounts, no rate-limited client calls — one shared
   server poller fans out to unlimited browsers over SSE.

## 2. Architecture

```
adsb.lol  ─┐
           ├─► server (Node 22 + TS, single shared poller, in-memory state + JSONL log)
METAR API ─┘        │
                    ├── GET  /api/snapshot     full state (JSON)
                    ├── GET  /api/stream       SSE, pushes snapshot deltas
                    ├── GET  /api/movements    today's + historical movement log
                    ├── GET  /api/aircraft/:hex single airframe + trail
                    └── static  client/dist    (Vite + React + Leaflet PWA)
```

- Upstream is polled **once per process**, never per client. Clients are unlimited.
- All upstream calls are cached + rate-limited server-side. No client ever touches a third party
  except map tiles (CARTO basemaps, keyless, attributed).
- The server must survive upstream outages: serve last-good state, mark it `stale`, never crash.

### Upstream contracts (verified live)

| Source | URL | Notes |
|---|---|---|
| Global A380 fleet | `https://api.adsb.lol/v2/type/A388` | ~30–60 live airframes. Poll every 5s. |
| Traffic near LHR | `https://api.adsb.lol/v2/point/51.4706/-0.4619/60` | Used to derive the active runway config. Poll every 15s. |
| Weather | `https://aviationweather.gov/api/data/metar?ids=EGLL&format=json` | Poll every 5 min. |

`adsb.lol` returns `{ ac: Aircraft[], now: number, ... }`. Fields seen in the wild:
`hex, flight, r` (registration), `t` (type), `alt_baro` (number **or** the string `"ground"`),
`alt_geom, gs, track, true_heading, baro_rate, geom_rate, squawk, lat, lon, seen, seen_pos,
category, nav_altitude_mcp, emergency`. **Any field may be missing.** Never assume presence.
Aircraft outside ADS-B receiver coverage (mid-Atlantic) simply vanish from the feed and
reappear later — the state machine must coast through gaps, not delete the flight.

No `Access-Control-Allow-Origin` header is returned by adsb.lol, so the browser **cannot** call it
directly. That is why the server proxy exists. Send a descriptive `User-Agent` upstream.

## 3. Repo layout

```
shared/types.ts        # the wire contract — imported by BOTH server and client
data/*.json            # curated static reference data (fleet, routes, spots, runways)
server/src/…           # Node service
client/src/…           # React app
```

Scripts (root `package.json`): `npm run dev` (server + vite concurrently), `npm run build`,
`npm start` (serves built client + API on one port), `npm run typecheck`.

## 4. Wire contract

`shared/types.ts` is authoritative — read it before writing any code. Summary:

- `Snapshot` — everything the UI needs for a frame. Delivered by `/api/snapshot` and pushed on
  `/api/stream` as `event: snapshot`.
- `Movement` — one A380 with a relationship to LHR (arriving, on the ground, or departing),
  carrying `phase`, `eta`, `route`, `runway`, and live telemetry.
- `RunwayConfig` — which runways are landing/departing right now, derived from observed traffic.
- `SpotEvaluation` — a spotting location scored for the current config and sun position.

## 5. Domain rules (implement exactly)

**Airport constants** live in `data/airport.json`. EGLL, ARP `51.4706, -0.4619`, elevation 83 ft.
Runways: `09L/27R` (thresholds 09L `51.4775,-0.4845` / 27R `51.4779,-0.4334`) and
`09R/27L` (thresholds 09R `51.4647,-0.4825` / 27L `51.4650,-0.4341`). True bearings 89.7° / 269.7°.

**Phase classification** for each A380 (`shared/types.ts#FlightPhase`):

| phase | rule of thumb |
|---|---|
| `inbound` | airborne, converging on LHR (closing distance, bearing-to-LHR within ~60° of track), >25 nm out |
| `approach` | airborne, within 25 nm, descending or below 6 000 ft, aligned with an LHR runway |
| `landed` | was `approach`, now on ground within the airport polygon |
| `stand` | on ground at LHR, groundspeed < 3 kt for > 3 min |
| `taxi_out` | on ground at LHR, moving, after having been at a stand |
| `departing` | on ground, groundspeed > 60 kt, on a runway centreline |
| `climb_out` | airborne, within 30 nm, climbing, departed LHR in this session |
| `outbound` | airborne, diverging from LHR, last seen departing LHR (keep for 90 min) |
| `elsewhere` | any other A380 in the world — powers the global fleet view |

Hysteresis is mandatory: a phase must be confirmed by 2 consecutive polls before it flips, and a
flight must not be dropped for **20 minutes** of no data (ADS-B coverage gaps).

**ETA**: great-circle distance to LHR ÷ groundspeed, plus a phase-dependent pad for the approach
(sequencing/holding): +6 min beyond 80 nm, +3 min inside. Round to the minute; never show a
negative or absurd (>16 h) ETA — show `—` instead. Recompute every frame, but **smooth** it
(exponential moving average) so the countdown never jitters.

**Runway prediction** for an arrival: whichever landing runway of the active config the aircraft's
current track and position best line up with; before that is knowable, use the config default
(27R for arrivals under westerly ops when LHR alternates — note alternation only as a hint, never
as fact). Always label predictions as predictions.

**Active runway config** is derived, not guessed: take LHR-area traffic below 4 000 ft within 15 nm,
project onto each runway axis, and classify by direction of travel. Westerly ops if the majority
of low approaches are heading ~270°. Cross-check against METAR wind. Report a `confidence`.

**Route inference**: match the callsign against `data/routes.json` (curated LHR A380 rotations,
e.g. `UAE1` → DXB–LHR). If no match, infer direction from the great-circle track and state the
origin/destination as `unknown` — **never fabricate a city**. Every inferred field carries
`source: 'schedule' | 'inferred' | 'unknown'` so the UI can mark it honestly.

**Sun position** (for photography advice) is computed locally with a standard NOAA solar-position
algorithm — no network, no library.

## 6. UI contract

Four tabs, mobile bottom bar / desktop side rail:

1. **Board** — the hero. Next-arrival countdown at the top, then arrival cards, then departures.
2. **Map** — Leaflet + CARTO tiles, LHR-centred, live aircraft with heading-rotated icons, trails,
   runway overlay showing the live config, spot pins.
3. **Spots** — spotting locations ranked *for right now* (active runways, sun, wind), with what
   you'll see, how to get there, and sun/light quality.
4. **Fleet** — today's movement log + the A380 world fleet reference (who flies the whale, which
   airframes have visited).

Design tokens live in `client/src/styles/tokens.css` — **use them, never hardcode a colour**.
Dark theme is the default (spotters at dusk); light theme fully supported and auto-detected.
Everything must be legible at arm's length in sunlight: min 15px body text, high-contrast chips.
Motion: 150–250 ms, `cubic-bezier(.22,.61,.36,1)`, and every animation respects
`prefers-reduced-motion`. No layout shift when data updates — numbers tick in place.

Accessibility is not optional: semantic landmarks, focus rings, `aria-live="polite"` on the
countdown, 44px minimum touch targets, full keyboard navigation.

## 7. Non-negotiables

- **No fabricated data, ever.** If a field is unknown, the UI says so. No fake schedules, no
  invented origins, no placeholder flights. A trustworthy "unknown" beats a plausible lie.
- No API keys, no auth, no tracking, no ads, no client-side rate limits.
- The app must work with zero A380s in the sky (common at 03:00) — the empty state is a designed,
  useful screen (next expected rotations, fleet browser), not a spinner.
- TypeScript strict everywhere. `npm run typecheck` and `npm run build` must pass clean.
