/**
 * The curated reference data is the half of this app that no upstream can correct.
 *
 * A wrong runway threshold silently corrupts every approach prediction; a route pointing at an
 * airport the gazetteer has never heard of shows a spotter a blank origin; a boundary polygon
 * that swallows Hatton Cross turns every taxiing bus into a landed A380. None of that shows up
 * as a crash, so it is asserted here instead.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AIRPORT, getAirframe, getAirline, getSpots } from '../src/reference.ts';
import { CONFIG } from '../src/config.ts';
import { distanceNm, pointInPolygon } from '../src/geo.ts';

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(CONFIG.dataDir, name), 'utf8')) as unknown;
}

const airlines = load('airlines.json') as Record<string, { iata: string | null; name: string; color: string }>;
const fleet = load('fleet.json') as Array<Record<string, unknown>>;
const places = load('places.json') as Record<string, { iata: string; city: string; lat: number; lon: number }>;
const routes = load('routes.json') as Array<{ callsign: string; origin: string; destination: string; blockMinutes: number }>;

const ARP = { lat: AIRPORT.lat, lon: AIRPORT.lon };

describe('data/airport.json', () => {
  it('describes both parallel runways, in both directions', () => {
    assert.equal(AIRPORT.runways.length, 4);
    const designators = AIRPORT.runways.map((r) => r.designator).sort();
    assert.deepEqual(designators, ['09L', '09R', '27L', '27R']);
    for (const end of AIRPORT.runways) {
      // Heathrow is an east-west field: every end points within 1° of 090 or 270.
      const offset = Math.min(Math.abs(end.bearing - 89.7), Math.abs(end.bearing - 269.7));
      assert.ok(offset < 1, `${end.designator} bears ${end.bearing}, which is not an EGLL runway heading`);
      assert.ok(distanceNm({ lat: end.lat, lon: end.lon }, ARP) < 1.5, `${end.designator} threshold is not at Heathrow`);
    }
  });

  it('places the thresholds at the published landing distances apart', () => {
    const by = new Map(AIRPORT.runways.map((r) => [r.designator, r]));
    // EGLL AD 2.13: LDA 3595 m on 09L/27R and 3353 m on 09R/27L. Threshold to threshold is the
    // landing distance, not the (longer) declared take-off run.
    for (const [a, b, metres] of [
      ['09L', '27R', 3595],
      ['09R', '27L', 3353],
    ] as const) {
      const from = by.get(a);
      const to = by.get(b);
      assert.ok(from !== undefined && to !== undefined);
      const nm = distanceNm({ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon });
      assert.ok(
        Math.abs(nm - metres / 1852) < 0.06,
        `${a}/${b} thresholds are ${(nm * 1852).toFixed(0)} m apart, expected about ${metres} m`,
      );
    }
    const north = by.get('09L');
    const south = by.get('09R');
    assert.ok(north !== undefined && south !== undefined);
    const separation = distanceNm({ lat: north.lat, lon: north.lon }, { lat: south.lat, lon: south.lon }) * 1852;
    assert.ok(
      Math.abs(separation - 1415) < 120,
      `parallel runway separation is ${separation.toFixed(0)} m, expected about 1415 m`,
    );
  });

  it('closes its boundary polygon', () => {
    const boundary = AIRPORT.boundary;
    assert.ok(boundary.length >= 8, 'a boundary this coarse cannot describe Heathrow');
    assert.deepEqual(boundary[0], boundary[boundary.length - 1], 'the ring is not closed');
  });

  it('encloses the airfield and nothing beyond it', () => {
    const inside = (lat: number, lon: number): boolean => pointInPolygon({ lat, lon }, AIRPORT.boundary);

    assert.equal(inside(ARP.lat, ARP.lon), true, 'the aerodrome reference point is outside its own boundary');
    for (const end of AIRPORT.runways) {
      assert.equal(inside(end.lat, end.lon), true, `${end.designator} threshold is outside the boundary`);
    }
    assert.equal(inside(51.4723, -0.4881), true, 'Terminal 5 should be inside');
    assert.equal(inside(51.47, -0.454), true, 'the central terminal area should be inside');

    // Landside places that must never make an aircraft look "landed at Heathrow".
    assert.equal(inside(51.46655, -0.42315), false, 'Hatton Cross station is inside the boundary');
    assert.equal(inside(51.479, -0.5216), false, 'the M25 at junction 14 is inside the boundary');
    assert.equal(inside(51.461, -0.5228), false, 'the M25 at junction 15 is inside the boundary');
    assert.equal(inside(51.464, -0.4276), false, 'Myrtle Avenue is inside the boundary');
    assert.equal(inside(51.4432, -0.493), false, 'the Staines reservoirs are inside the boundary');
    assert.equal(inside(51.467, -0.375), false, 'Hounslow is inside the boundary');
  });
});

describe('data/routes.json', () => {
  it('never names an airport the gazetteer has never heard of', () => {
    for (const route of routes) {
      for (const key of ['origin', 'destination'] as const) {
        const icao = route[key];
        assert.match(icao, /^[A-Z]{4}$/, `${route.callsign}: ${key} "${icao}" is not an ICAO code`);
        assert.ok(icao in places, `${route.callsign}: ${key} ${icao} is missing from places.json`);
      }
    }
  });

  it('lists each callsign once, with a plausible block time', () => {
    const seen = new Set<string>();
    for (const route of routes) {
      assert.match(route.callsign, /^[A-Z]{3}\d{1,4}$/, `${route.callsign} is not an ATC callsign`);
      assert.equal(seen.has(route.callsign), false, `${route.callsign} is listed twice`);
      seen.add(route.callsign);
      assert.ok(
        route.blockMinutes >= 30 && route.blockMinutes <= 1200,
        `${route.callsign}: ${route.blockMinutes} min is not a plausible A380 sector`,
      );
      assert.notEqual(route.origin, route.destination, `${route.callsign} departs and arrives at the same airport`);
    }
  });

  it('carries non-Heathrow rotations too, because they are the veto', () => {
    // A curated route whose destination is not EGLL is what stops EK201 (DXB–JFK) appearing on
    // the arrivals board while it crosses the UK. Losing these silently re-opens that hole.
    const elsewhere = routes.filter((r) => r.origin !== 'EGLL' && r.destination !== 'EGLL');
    assert.ok(elsewhere.length > 0, 'no non-Heathrow rotations left to veto an overflight with');
  });

  it('describes real places', () => {
    for (const [icao, place] of Object.entries(places)) {
      assert.match(icao, /^[A-Z]{4}$/);
      assert.match(place.iata, /^[A-Z]{3}$/, `${icao} has no IATA code`);
      assert.ok(place.city.length > 0, `${icao} has no city`);
      assert.ok(Math.abs(place.lat) <= 90 && Math.abs(place.lon) <= 180, `${icao} has an impossible position`);
    }
    assert.equal(places['EGLL']?.iata, 'LHR');
  });
});

describe('data/fleet.json', () => {
  /** Hyphenated blocks, plus the US, Korean and Japanese registers, which carry no hyphen. */
  const REGISTRATION = /^(?:[A-Z0-9]{1,2}-[A-Z0-9]{3,5}|N\d{1,5}[A-Z]{0,2}|HL\d{4}|JA\d{2,4}[A-Z]?)$/;

  /** Where each operator's aircraft are registered. */
  const REGISTER: Record<string, string> = {
    UAE: 'A6',
    ETD: 'A6',
    QTR: 'A7',
    BAW: 'G',
    SIA: '9V',
    QFA: 'VH',
    KAL: 'HL',
    AAR: 'HL',
    DLH: 'D',
    MAS: '9M',
    THA: 'HS',
    CSN: 'B',
    AFR: 'F',
    ANA: 'JA',
    HFY: '9H',
    HFM: '9H',
  };

  it('gives every airframe a plausible, unique registration and ICAO address', () => {
    const registrations = new Set<string>();
    const addresses = new Set<string>();
    assert.ok(fleet.length > 200, 'the A380 fleet reference is implausibly short');

    for (const frame of fleet) {
      const reg = frame['reg'];
      assert.equal(typeof reg, 'string');
      assert.match(String(reg), REGISTRATION, `${String(reg)} is not a plausible registration`);
      assert.equal(registrations.has(String(reg)), false, `${String(reg)} appears twice`);
      registrations.add(String(reg));

      const hex = frame['hex'];
      assert.match(String(hex), /^[0-9a-f]{6}$/, `${String(reg)}: "${String(hex)}" is not an ICAO 24-bit address`);
      assert.equal(addresses.has(String(hex)), false, `${String(hex)} is shared by two airframes`);
      addresses.add(String(hex));
    }
  });

  it('registers each airframe in its operator’s own country', () => {
    for (const frame of fleet) {
      const icao = String(frame['operatorIcao']);
      const reg = String(frame['reg']);
      assert.ok(icao in airlines, `${reg}: operator ${icao} is missing from airlines.json`);
      const expected = REGISTER[icao];
      if (expected === undefined) continue;
      const prefix = reg.includes('-') ? reg.slice(0, reg.indexOf('-')) : reg.slice(0, 2);
      assert.equal(prefix, expected, `${reg} does not look like a ${icao} registration`);
    }
  });

  it('keeps optional detail within the bounds of the real aeroplane', () => {
    for (const frame of fleet) {
      const reg = String(frame['reg']);
      const delivered = frame['delivered'];
      if (delivered !== null && delivered !== undefined) {
        assert.ok(
          typeof delivered === 'number' && delivered >= 2005 && delivered <= 2022,
          `${reg}: delivered ${String(delivered)} is outside A380 production`,
        );
      }
      const seats = frame['seats'];
      if (seats !== null && seats !== undefined) {
        assert.ok(
          typeof seats === 'number' && seats >= 300 && seats <= 900,
          `${reg}: ${String(seats)} seats is not an A380 cabin`,
        );
      }
      const msn = frame['msn'];
      if (msn !== null && msn !== undefined) {
        assert.match(String(msn), /^\d{1,3}$/, `${reg}: MSN ${String(msn)} is not an A380 serial`);
      }
    }
  });

  it('resolves a known airframe to its operator, colour and cabin', () => {
    const frame = getAirframe('896456', 'A6-EUA');
    assert.equal(frame.registration, 'A6-EUA');
    assert.equal(frame.operator, 'Emirates');
    assert.ok(frame.seats !== null && frame.seats > 400);

    const airline = getAirline('UAE', 'A6-EUA');
    assert.equal(airline.name, 'Emirates');
    assert.equal(airline.iata, 'EK');
    assert.match(airline.color, /^#[0-9A-Fa-f]{6}$/);
  });

  it('says "Unknown" rather than guessing for an airframe it has never seen', () => {
    const frame = getAirframe('ffffff', null);
    assert.equal(frame.operator, null);
    assert.equal(frame.registration, null);
    assert.equal(getAirline(null, null).name, 'Unknown');
  });
});

describe('data/airlines.json', () => {
  it('gives every operator a name and a real brand colour', () => {
    for (const [icao, airline] of Object.entries(airlines)) {
      assert.match(icao, /^[A-Z]{3}$/, `${icao} is not an ICAO airline designator`);
      assert.ok(airline.name.length > 0, `${icao} has no name`);
      assert.match(airline.color, /^#[0-9A-Fa-f]{6}$/, `${icao}: "${airline.color}" is not a hex colour`);
      if (airline.iata !== null) assert.match(airline.iata, /^[A-Z0-9]{2}$/, `${icao} has a bad IATA code`);
    }
  });
});

describe('data/spots.json', () => {
  const RUNWAY_ENDS = new Set(['09L', '09R', '27L', '27R']);

  it('places every spot in Greater London, within reach of the fence', () => {
    const spots = getSpots();
    assert.ok(spots.length >= 8, 'too few spotting locations to rank');
    for (const spot of spots) {
      assert.ok(
        spot.lat >= 51.28 && spot.lat <= 51.7 && spot.lon >= -0.56 && spot.lon <= 0.34,
        `${spot.id} at ${spot.lat},${spot.lon} is not in Greater London`,
      );
      const range = distanceNm({ lat: spot.lat, lon: spot.lon }, ARP);
      assert.ok(range < 6, `${spot.id} is ${range.toFixed(1)} nm from Heathrow — too far to be a Heathrow spot`);
    }
  });

  it('fills in every field of the SpotLocation contract', () => {
    const ids = new Set<string>();
    for (const spot of getSpots()) {
      assert.equal(ids.has(spot.id), false, `${spot.id} is listed twice`);
      ids.add(spot.id);
      for (const [field, value] of [
        ['name', spot.name],
        ['tagline', spot.tagline],
        ['access', spot.access],
        ['notes', spot.notes],
      ] as const) {
        assert.ok(typeof value === 'string' && value.trim().length > 0, `${spot.id}: ${field} is empty`);
      }
      assert.ok(spot.transport === null || spot.transport.length > 0);
      assert.ok(spot.facilities === null || spot.facilities.length > 0);
      assert.ok(
        ['public', 'airside'].includes(spot.accessType),
        `${spot.id}: accessType="${spot.accessType}"`,
      );
      assert.ok(spot.viewBearing >= 0 && spot.viewBearing < 360, `${spot.id}: viewBearing ${spot.viewBearing}`);
      assert.ok(
        spot.arrivalsFor.length + spot.departuresFor.length > 0,
        `${spot.id} covers no runway in either role`,
      );
      for (const end of [...spot.arrivalsFor, ...spot.departuresFor]) {
        assert.ok(RUNWAY_ENDS.has(end), `${spot.id}: "${end}" is not a Heathrow runway end`);
      }
      // A spot cannot be under both the approach and the climb-out of the same runway end: the
      // approach is off one end and the climb-out off the other, four kilometres apart. The
      // exception is a spot beside the runway itself, which watches the concrete rather than the
      // air over it — those list the same end twice on purpose.
      const besideTheRunway = spot.arrivalsFor.length > 1 && spot.departuresFor.length > 1;
      if (!besideTheRunway) {
        for (const end of spot.arrivalsFor) {
          assert.equal(
            spot.departuresFor.includes(end),
            false,
            `${spot.id} claims both ends of ${end} — the reason a spotter ends up at the wrong fence`,
          );
        }
      }
    }
  });

  it('covers both operating directions, so the list is never empty', () => {
    const covered = new Set(
      getSpots().flatMap((spot) => [...spot.arrivalsFor, ...spot.departuresFor]),
    );
    for (const end of RUNWAY_ENDS) {
      assert.ok(covered.has(end), `no curated spot covers ${end}`);
    }
  });
});
