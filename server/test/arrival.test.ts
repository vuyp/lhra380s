/**
 * The arrivals board is the product. Everything else can be wrong and the app still half works;
 * an A380 that is not coming to Heathrow appearing on it makes the whole thing a liar.
 *
 * Every scenario below is built from a real position taken off the live adsb.lol A388 feed, or
 * from the published geometry of a Heathrow approach. The overflight cases are the ones that
 * matter: Emirates, Lufthansa and Qatar A380s cross southern England at cruise every day, closing
 * on Heathrow with their tracks pointing straight at it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { isTakeoffRoll, looksLikeArrival, type ArrivalEvidence, type RollEvidence } from '../src/tracker.ts';
import { lookupRoute } from '../src/reference.ts';
import { bearing, destinationPoint, distanceNm, type LatLon } from '../src/geo.ts';

const LHR: LatLon = { lat: 51.4706, lon: -0.4619 };

/** A position `distance` nm from Heathrow on the given radial, tracking straight back at it. */
function inboundFrom(radialFromAirport: number, distance: number, trackError = 0): { position: LatLon; track: number } {
  const position = destinationPoint(LHR, radialFromAirport, distance);
  return { position, track: bearing(position, LHR) + trackError };
}

function evidence(partial: Partial<ArrivalEvidence> & { position: LatLon; track: number }): ArrivalEvidence {
  return {
    distanceNm: distanceNm(partial.position, LHR),
    altitudeFt: null,
    verticalRateFpm: null,
    closing: true,
    scheduledToAirport: false,
    ...partial,
  };
}

describe('looksLikeArrival — genuine arrivals', () => {
  it('accepts a jet on a normal descent profile at every stage of the arrival', () => {
    // Range / altitude pairs an aircraft descending into Heathrow actually passes through.
    const profile: Array<[number, number, number]> = [
      [140, 33_000, -1200],
      [100, 27_000, -1500],
      [80, 22_000, -1400],
      [60, 17_000, -1200],
      [40, 11_000, -1000],
      [28, 7_000, -800],
    ];
    for (const [range, altitude, verticalRate] of profile) {
      const { position, track } = inboundFrom(90, range);
      assert.equal(
        looksLikeArrival(evidence({ position, track, altitudeFt: altitude, verticalRateFpm: verticalRate })),
        true,
        `${range} nm at ${altitude} ft should read as an arrival`,
      );
    }
  });

  it('accepts an aircraft levelled off mid-descent, which happens on every other approach', () => {
    const { position, track } = inboundFrom(270, 55);
    assert.equal(
      looksLikeArrival(evidence({ position, track, altitudeFt: 15_000, verticalRateFpm: 0 })),
      true,
    );
  });

  it('accepts an arrival aimed at a hold rather than at the field itself', () => {
    // Inbound from the east but tracking 12° off, as an aircraft routing to LAM/BIG would be.
    const { position, track } = inboundFrom(100, 120, 12);
    assert.equal(
      looksLikeArrival(evidence({ position, track, altitudeFt: 26_000, verticalRateFpm: -1100 })),
      true,
    );
  });

  it('accepts a timetabled Heathrow rotation from the far side of the world', () => {
    const { position, track } = inboundFrom(120, 2_100);
    assert.equal(
      looksLikeArrival(
        evidence({ position, track, altitudeFt: 39_000, verticalRateFpm: 0, scheduledToAirport: true }),
      ),
      true,
      'a curated EGLL-bound rotation is a published fact and may be shown from cruise',
    );
  });

  it('accepts an aircraft transmitting no altitude at all, provided it is close and closing', () => {
    const { position, track } = inboundFrom(45, 45);
    assert.equal(looksLikeArrival(evidence({ position, track })), true);
  });
});

describe('looksLikeArrival — the ones that must never reach the board', () => {
  it('rejects an A380 over Singapore', () => {
    const position: LatLon = { lat: 1.3502, lon: 103.9944 };
    assert.equal(
      looksLikeArrival(evidence({ position, track: bearing(position, LHR), altitudeFt: 38_000 })),
      false,
    );
  });

  it('rejects the cruising overflights seen live on the A388 feed', () => {
    // Taken off api.adsb.lol/v2/type/A388: all closing on Heathrow, all pointing at it, none of
    // them coming here — DLH3Y and DLH8P are Frankfurt–US, ETD1VT and SIA326 are eastbound
    // Europe–US crossings, UAE19 is a Dubai–North America sector.
    const overflights: Array<[string, LatLon, number, number, number]> = [
      ['DLH3Y', { lat: 49.921409, lon: 9.699592 }, 288.1, 33_975, 320],
      ['UAE70M', { lat: 49.478302, lon: 11.105009 }, 292.08, 40_000, 0],
      ['ETD1VT', { lat: 47.267212, lon: 13.471161 }, 301.41, 38_000, 0],
      ['SIA326', { lat: 46.493815, lon: 20.386986 }, 293.29, 38_000, 64],
      ['UAE19', { lat: 44.256821, lon: 21.574467 }, 297.1, 40_000, 0],
      ['UAE7V', { lat: 38.940811, lon: 21.86745 }, 322.05, 40_000, 256],
    ];
    for (const [label, position, track, altitudeFt, verticalRateFpm] of overflights) {
      assert.equal(
        looksLikeArrival(evidence({ position, track, altitudeFt, verticalRateFpm })),
        false,
        `${label} is crossing Europe at cruise, not arriving at Heathrow`,
      );
    }
  });

  it('rejects an overflight at cruise even directly over the approach', () => {
    // 90 nm out, dead on the extended centreline, closing, pointing straight at the field — and
    // 38 000 ft in level flight. No arrival is that high that close.
    const { position, track } = inboundFrom(90, 90);
    assert.equal(
      looksLikeArrival(evidence({ position, track, altitudeFt: 38_000, verticalRateFpm: 0 })),
      false,
    );
  });

  it('rejects an aircraft whose track passes well wide of the airport', () => {
    // 150 nm out with a 25° track error passes some 60 nm from Heathrow: pointing "roughly this
    // way" is not the same as coming here.
    const { position, track } = inboundFrom(180, 150, 25);
    assert.equal(
      looksLikeArrival(evidence({ position, track, altitudeFt: 24_000, verticalRateFpm: -1000 })),
      false,
    );
  });

  it('rejects an aircraft that is not closing', () => {
    const { position, track } = inboundFrom(90, 50);
    assert.equal(
      looksLikeArrival(evidence({ position, track, altitudeFt: 14_000, verticalRateFpm: -900, closing: false })),
      false,
    );
  });

  it('rejects an aircraft heading away from the field', () => {
    const position = destinationPoint(LHR, 90, 40);
    assert.equal(
      looksLikeArrival(evidence({ position, track: bearing(LHR, position), altitudeFt: 9_000 })),
      false,
    );
  });

  it('rejects an aircraft with no transmitted track', () => {
    const position = destinationPoint(LHR, 90, 40);
    assert.equal(
      looksLikeArrival({
        position,
        distanceNm: 40,
        track: null,
        altitudeFt: 9_000,
        verticalRateFpm: -900,
        closing: true,
        scheduledToAirport: false,
      }),
      false,
    );
  });

  it('rejects a timetabled rotation beyond the tracking horizon', () => {
    const { position, track } = inboundFrom(120, 3_000);
    assert.equal(
      looksLikeArrival(evidence({ position, track, altitudeFt: 39_000, scheduledToAirport: true })),
      false,
    );
  });
});

describe('lookupRoute — a suffixed callsign is not the flight it looks like', () => {
  it('resolves the curated Heathrow rotations exactly', () => {
    const ek1 = lookupRoute('UAE1');
    assert.equal(ek1?.origin?.icao, 'OMDB');
    assert.equal(ek1?.destination?.icao, 'EGLL');
    assert.equal(ek1?.source, 'schedule');

    const ek2 = lookupRoute('UAE2');
    assert.equal(ek2?.destination?.icao, 'OMDB');
  });

  it('tolerates leading zeros, which are the same flight written twice', () => {
    assert.deepEqual(lookupRoute('QTR004'), lookupRoute('QTR4'));
    assert.equal(lookupRoute('QTR004')?.destination?.icao, 'OTHH');
  });

  it('never treats an alphanumeric ATC callsign as a suffixed flight number', () => {
    // These all appeared live on the A388 feed. Emirates does not fly EK7 as "UAE7V", and
    // matching them put six A380s over the Aegean onto the Heathrow arrivals board.
    for (const callsign of ['UAE7V', 'UAE7TR', 'UAE1CL', 'UAE5T', 'UAE5GU', 'BAW3G', 'BAW7D']) {
      assert.equal(lookupRoute(callsign), null, `${callsign} must not resolve to a curated rotation`);
    }
  });

  it('returns null rather than inventing a city for an unknown callsign', () => {
    assert.equal(lookupRoute('XXX9999'), null);
    assert.equal(lookupRoute(null), null);
    assert.equal(lookupRoute('   '), null);
    assert.equal(lookupRoute('00000000'), null);
  });
});

describe('isTakeoffRoll — a landing roll-out is not a departure', () => {
  const NOW = 1_700_000_000_000;

  function roll(partial: Partial<RollEvidence> = {}): RollEvidence {
    return {
      loggedArrivalAt: null,
      hasBeenAtStand: false,
      lastOnGround: true,
      lastGroundSpeed: null,
      ...partial,
    };
  }

  it('never calls the frame straight after touchdown a take-off', () => {
    // The previous report had it airborne: 140 kt down the centreline is a roll-out.
    assert.equal(isTakeoffRoll(roll({ lastOnGround: false }), 140, NOW), false);
  });

  it('never calls a decelerating roll a take-off', () => {
    assert.equal(isTakeoffRoll(roll({ lastGroundSpeed: 140 }), 110, NOW), false);
  });

  it('never calls a repeated, unchanged report a take-off', () => {
    // adsb.lol replays the same position for several polls when the feeder goes quiet. Reading
    // "not decelerating" as "accelerating" put a freshly landed A380 on the departures board.
    assert.equal(isTakeoffRoll(roll({ lastGroundSpeed: 120 }), 120, NOW), false);
  });

  it('never lets an aircraft depart minutes after it landed', () => {
    assert.equal(
      isTakeoffRoll(roll({ loggedArrivalAt: NOW - 60_000, lastGroundSpeed: 40 }), 90, NOW),
      false,
      'no A380 turns round in a minute',
    );
  });

  it('accepts an accelerating roll from a taxi speed', () => {
    assert.equal(isTakeoffRoll(roll({ lastGroundSpeed: 35 }), 95, NOW), true);
  });

  it('accepts a departure by an aircraft that arrived earlier and has since been at a stand', () => {
    assert.equal(
      isTakeoffRoll(
        roll({ loggedArrivalAt: NOW - 4 * 3_600_000, hasBeenAtStand: true, lastGroundSpeed: 30 }),
        90,
        NOW,
      ),
      true,
    );
  });

  it('believes the centreline speed on first ever contact, having nothing else to go on', () => {
    assert.equal(isTakeoffRoll(roll({ lastGroundSpeed: null }), 110, NOW), true);
  });
});
