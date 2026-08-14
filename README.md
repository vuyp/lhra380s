<div align="center">

# 🐋 Whale Watch LHR

**Every Airbus A380 into and out of London Heathrow, live.**

Countdowns, the active runway configuration, and the best place to stand — free, unlimited,
no account, no API key, no ads.

</div>

---

## What it is

A tool for the people standing on Myrtle Avenue at half past six with a camera, and for anyone
who just wants to know when the big one is landing.

The A380 is the reason people come to Heathrow with a lens. Generic flight trackers bury it under
a thousand A320s, hide the good parts behind a subscription, and cannot tell you the one thing
that actually decides your evening — **which runway is in use right now**. This does exactly that
job and nothing else.

| | |
|---|---|
| **Board** | The next whale as a live countdown, then every arrival, departure and A380 on stand at Heathrow. |
| **Map** | Live positions on a dark map, interpolated between updates, with the runways in use and their extended centrelines drawn out to 10 nm. |
| **Spots** | Eleven real spotting locations, scored *for right now* against the live runway config, the sun angle and the wind — with honest notes on what each one is actually like. |
| **Fleet** | Today's movement log, and every A380 airborne on earth, searchable by registration. |

## How it works

```
adsb.lol  ─┐                      ┌── /api/snapshot   full state
           ├─► one shared poller ─┼── /api/stream     SSE push to unlimited clients
METAR API ─┘   (Node 22 + TS)     ├── /api/spots      ranked spotting locations
                                  ├── /api/movements  the day's log
                                  └── /api/aircraft/:hex
```

**Free and unlimited is an architectural choice, not a promise.** Upstream is polled **once per
server process** — every browser is fed from that one shared stream over server-sent events, so
adding users costs the upstream feeds nothing and no client is ever rate-limited. There are no
API keys anywhere in the stack; the only third party a browser talks to is the map tile CDN.

### The interesting parts

**Live runway configuration.** Heathrow alternates its runways, and the direction flips with the
wind. Rather than guess, the server watches every aircraft below 4 000 ft within 15 nm, projects
each onto both runway centrelines, and tallies which direction the low approaches are flying —
then cross-checks that against the METAR wind. It reports a confidence, and when the evidence is
thin it says *"unconfirmed"* instead of bluffing. This single line drives the whole Spots ranking.

**Coasting through coverage gaps.** ADS-B does not reach the middle of the Atlantic. An inbound
A380 simply vanishes for an hour and comes back. The tracker keeps its state for 20 minutes of
silence (90 for departures), marks it `coasting`, and shows the age of the data — rather than
deleting the flight and re-adding it as if it were new.

**Honest arrivals.** The hard case is not the A380 over Singapore — that one fails on distance and
heading alone. It is the Emirates DXB–JFK and the Lufthansa FRA–LAX, which cross southern England
at cruise, closing on Heathrow and pointing straight at it, for the better part of an hour. So a
flight reaches the arrivals board only if it is closing, with the bearing to the airport within
~55° of its track, **and** it is inside 175 nm having visibly left its cruise — an overflight holds
its level all the way across, an arrival does not. Beyond that radius the only thing that may board
an aircraft is the curated timetable naming `EGLL`, and even then it is shown as unconfirmed until
the aeroplane's own behaviour corroborates it. Once confirmed an arrival is sticky, so vectors and
holds do not drop it off the board. Both halves of this are replayed in the test suite against
recorded tracks of a real arrival and a real overflight.

**Smoothed countdowns.** ETAs are exponentially smoothed so the number counts down instead of
flickering, and absurd values collapse to `—` rather than rendering a lie to the minute.

**Sun geometry for photographers.** Each spot stores the compass bearing you look along. The
server computes the solar azimuth and elevation locally (NOAA algorithm, no network) and tells you
whether you will be shooting with the light or straight into it.

### The rule the whole thing is built on

> **No fabricated data, ever.** If a field is unknown, the UI says it is unknown. No invented
> origins, no fake schedules, no plausible-looking placeholder flights.

Curated reference data — the world A380 fleet, the Heathrow rotations, the airport geometry, the
spotting locations — is static and checked in. Everything else comes from the live feed or is not
shown. The 253 airframes in `data/fleet.json` were validated against the live ADS-B feed:
registrations and ICAO 24-bit addresses match on every aircraft observed.

## Run it

```bash
npm install
npm run dev        # server on :8787, client on :5173 with live reload
```

Production — one process serves the API and the built client:

```bash
npm run build
npm start          # http://localhost:8787   (PORT to override)
```

No configuration, no keys, no database. Movement history is appended to a JSONL file under
`data/runtime/`, and the app is fully functional the moment it boots.

```bash
npm run typecheck  # strict TS across server and client
npm test           # 192 server tests: geo, sun, runway derivation, the HTTP and SSE layer,
                   # upstream failure handling, and the arrival classifier replayed against
                   # recorded ADS-B tracks of a real arrival and a real overflight
```

## Layout

```
shared/types.ts   the wire contract, imported by both sides
data/*.json       curated reference: fleet, routes, places, airport geometry, spots
server/src/       poller, state machine, runway derivation, HTTP + SSE
client/src/       React 19 + Leaflet PWA — tokens.css is the single source of visual truth
SPEC.md           the product and engineering contract every module was built against
```

## Data sources

- **[adsb.lol](https://adsb.lol)** — community-run ADS-B aggregation. Live positions.
- **[aviationweather.gov](https://aviationweather.gov)** — NOAA. EGLL METAR.
- **[CARTO](https://carto.com/basemaps)** / **OpenStreetMap** — map tiles.

All free, all keyless. Please do not point a swarm of scrapers at the first two — they are
volunteer infrastructure, which is precisely why this app polls them once and fans out.

## Spotting responsibly

Stay off private land and airport operational areas, do not block driveways or roads, be visible
at night, and **never fly a drone near the airport** — it is a criminal offence and it closes the
airport for everyone.

---

<div align="center">
<sub>Not affiliated with Heathrow Airport, Airbus, or any airline. For spotting and interest only —
never for operational use.</sub>
</div>
