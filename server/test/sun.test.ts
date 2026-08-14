import test from 'node:test';
import assert from 'node:assert/strict';

import { sunInfo, sunPosition, sunTimes } from '../src/sun.ts';

/** Heathrow ARP, per SPEC.md §5. */
const LAT = 51.4706;
const LON = -0.4619;

const MINUTE = 60_000;

function close(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ±${tolerance}, got ${actual}`,
  );
}

/** Assert two compass bearings agree, the short way round. */
function closeBearing(actual: number, expected: number, tolerance: number, label: string): void {
  const diff = Math.abs(((actual - expected) % 360 + 540) % 360 - 180);
  assert.ok(diff <= tolerance, `${label}: expected ${expected}° ±${tolerance}, got ${actual}°`);
}

/** UTC minutes past midnight of an epoch timestamp, for readable assertions. */
function utcMinutes(epochMs: number): number {
  const d = new Date(epochMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
}

/** Solar noon is the midpoint of sunrise and sunset. */
function solarNoon(year: number, monthIndex: number, day: number, lat = LAT, lon = LON): number {
  const times = sunTimes(new Date(Date.UTC(year, monthIndex, day, 12)), lat, lon);
  assert.ok(times.sunrise !== null && times.sunset !== null, 'expected a sunrise and a sunset');
  return (times.sunrise + times.sunset) / 2;
}

test('summer solstice noon over Heathrow is 62 degrees, due south', () => {
  const noon = solarNoon(2026, 5, 21);
  const { azimuth, elevation } = sunPosition(new Date(noon), LAT, LON);
  // Maximum elevation = 90 - latitude + obliquity = 90 - 51.4706 + 23.44 = 61.97.
  close(elevation, 61.97, 0.15, 'solstice noon elevation');
  closeBearing(azimuth, 180, 0.5, 'solstice noon azimuth');
});

test('winter solstice noon over Heathrow is 15 degrees, due south', () => {
  const noon = solarNoon(2026, 11, 21);
  const { azimuth, elevation } = sunPosition(new Date(noon), LAT, LON);
  // 90 - 51.4706 - 23.44 = 15.09.
  close(elevation, 15.09, 0.15, 'winter noon elevation');
  closeBearing(azimuth, 180, 0.5, 'winter noon azimuth');
});

test('June sunrise and sunset match the published Heathrow times', () => {
  const times = sunTimes(new Date(Date.UTC(2026, 5, 21, 12)), LAT, LON);
  assert.ok(times.sunrise !== null && times.sunset !== null, 'solstice must have both');
  // 04:44 and 21:22 British Summer Time.
  close(utcMinutes(times.sunrise), 3 * 60 + 44, 3, 'June sunrise (UTC)');
  close(utcMinutes(times.sunset), 20 * 60 + 22, 3, 'June sunset (UTC)');
  // 16 h 38 m of daylight.
  close((times.sunset - times.sunrise) / 3_600_000, 16.63, 0.1, 'June day length');
});

test('December sunrise and sunset match the published Heathrow times', () => {
  const times = sunTimes(new Date(Date.UTC(2026, 11, 21, 12)), LAT, LON);
  assert.ok(times.sunrise !== null && times.sunset !== null, 'winter solstice must have both');
  // 08:04 and 15:54 GMT.
  close(utcMinutes(times.sunrise), 8 * 60 + 4, 3, 'December sunrise (UTC)');
  close(utcMinutes(times.sunset), 15 * 60 + 54, 3, 'December sunset (UTC)');
  // 7 h 50 m of daylight — the whole point of the spotter's light warning.
  close((times.sunset - times.sunrise) / 3_600_000, 7.83, 0.1, 'December day length');
});

test('equinox day is a shade over twelve hours and the sun rises due east', () => {
  const times = sunTimes(new Date(Date.UTC(2026, 2, 20, 12)), LAT, LON);
  assert.ok(times.sunrise !== null && times.sunset !== null, 'equinox must have both');
  // Refraction and the sun's semi-diameter buy about nine extra minutes.
  close((times.sunset - times.sunrise) / 3_600_000, 12.17, 0.1, 'equinox day length');
  closeBearing(sunPosition(new Date(times.sunrise), LAT, LON).azimuth, 90, 2, 'equinox sunrise azimuth');
  closeBearing(sunPosition(new Date(times.sunset), LAT, LON).azimuth, 270, 2, 'equinox sunset azimuth');
});

test('midsummer sun rises in the north-east and sets in the north-west', () => {
  // The reason 09R departures are backlit at breakfast time in June.
  const times = sunTimes(new Date(Date.UTC(2026, 5, 21, 12)), LAT, LON);
  assert.ok(times.sunrise !== null && times.sunset !== null, 'solstice must have both');
  closeBearing(sunPosition(new Date(times.sunrise), LAT, LON).azimuth, 49, 2, 'June sunrise azimuth');
  closeBearing(sunPosition(new Date(times.sunset), LAT, LON).azimuth, 311, 2, 'June sunset azimuth');
});

test('the elevation at the returned sunrise and sunset is the -0.833 horizon', () => {
  for (const [month, day] of [[0, 15], [2, 20], [5, 21], [8, 23], [11, 21]] as const) {
    const times = sunTimes(new Date(Date.UTC(2026, month, day, 12)), LAT, LON);
    assert.ok(times.sunrise !== null && times.sunset !== null, `${month + 1}/${day} must have both`);
    close(sunPosition(new Date(times.sunrise), LAT, LON).elevation, -0.833, 0.02, `sunrise elevation ${month + 1}/${day}`);
    close(sunPosition(new Date(times.sunset), LAT, LON).elevation, -0.833, 0.02, `sunset elevation ${month + 1}/${day}`);
  }
});

test('the equation of time shifts solar noon by a quarter of an hour', () => {
  // Longitude alone puts Heathrow's mean solar noon at 12:01:51 UTC.
  const longitudeOffset = -4 * LON; // +1.85 minutes
  // Around 11 February the equation of time bottoms out near -14 minutes…
  close(utcMinutes(solarNoon(2026, 1, 11)), 720 + longitudeOffset + 14.3, 1, 'February solar noon');
  // …and around 3 November it peaks near +16.5 minutes.
  close(utcMinutes(solarNoon(2026, 10, 3)), 720 + longitudeOffset - 16.5, 1, 'November solar noon');
  // In late December and mid June it is small.
  close(utcMinutes(solarNoon(2026, 5, 21)), 720 + longitudeOffset + 1.7, 1, 'June solar noon');
});

test('polar day and polar night report no sunrise or sunset', () => {
  const midsummer = sunTimes(new Date(Date.UTC(2026, 5, 21, 12)), 80, 0);
  assert.equal(midsummer.sunrise, null);
  assert.equal(midsummer.sunset, null);
  const midwinter = sunTimes(new Date(Date.UTC(2026, 11, 21, 12)), 80, 0);
  assert.equal(midwinter.sunrise, null);
  assert.equal(midwinter.sunset, null);

  // Above the Arctic Circle the midnight sun is genuinely above the horizon.
  const tromso = sunPosition(new Date(Date.UTC(2026, 5, 21, 23)), 69.65, 18.96);
  assert.ok(tromso.elevation > 0, `Tromsø midnight sun should be up, got ${tromso.elevation}`);
  // …and in midwinter it never gets there.
  const tromsoWinter = sunPosition(new Date(Date.UTC(2026, 11, 21, 11)), 69.65, 18.96);
  assert.ok(tromsoWinter.elevation < 0, `Tromsø polar night, got ${tromsoWinter.elevation}`);
});

test('the southern hemisphere sun is in the north at noon', () => {
  // Sydney in January: high sun, azimuth through north — proof that nothing is
  // hard-coded for a northern observer.
  const noon = solarNoon(2026, 0, 15, -33.8688, 151.2093);
  const { azimuth, elevation } = sunPosition(new Date(noon), -33.8688, 151.2093);
  close(elevation, 77.4, 1, 'Sydney January noon elevation');
  closeBearing(azimuth, 0, 3, 'Sydney January noon azimuth');
});

test('azimuth and elevation stay in range all day, everywhere', () => {
  const dayStart = Date.UTC(2026, 5, 21);
  for (const lat of [-89, -51.5, 0, 51.4706, 89]) {
    for (let minute = 0; minute < 1440; minute += 7) {
      const { azimuth, elevation } = sunPosition(new Date(dayStart + minute * MINUTE), lat, LON);
      assert.ok(azimuth >= 0 && azimuth < 360, `azimuth out of range at lat ${lat}: ${azimuth}`);
      assert.ok(elevation >= -90 && elevation <= 90, `elevation out of range at lat ${lat}: ${elevation}`);
    }
  }
});

test('elevation over a Heathrow day peaks at solar noon and bottoms at solar midnight', () => {
  const dayStart = Date.UTC(2026, 5, 21);
  let max = -Infinity;
  let min = Infinity;
  for (let minute = 0; minute < 1440; minute += 1) {
    const { elevation } = sunPosition(new Date(dayStart + minute * MINUTE), LAT, LON);
    if (elevation > max) max = elevation;
    if (elevation < min) min = elevation;
  }
  close(max, 61.97, 0.15, 'daily maximum elevation');
  // At solar midnight the sun is as far below the horizon as it is above it in December.
  close(min, -15.09, 0.15, 'daily minimum elevation');
});

test('sunInfo assembles the wire contract and flags golden hour honestly', () => {
  const times = sunTimes(new Date(Date.UTC(2026, 5, 21, 12)), LAT, LON);
  assert.ok(times.sunrise !== null && times.sunset !== null, 'solstice must have both');

  const beforeSunset = sunInfo(times.sunset - 20 * MINUTE, LAT, LON);
  assert.equal(beforeSunset.isDaylight, true);
  assert.equal(beforeSunset.goldenHour, true);
  assert.ok(beforeSunset.elevation > 0 && beforeSunset.elevation < 8, `low sun expected, got ${beforeSunset.elevation}`);
  assert.equal(beforeSunset.sunriseAt, times.sunrise);
  assert.equal(beforeSunset.sunsetAt, times.sunset);

  // Just after sunset: still shootable light, but no longer daylight.
  const afterSunset = sunInfo(times.sunset + 5 * MINUTE, LAT, LON);
  assert.equal(afterSunset.isDaylight, false);
  assert.equal(afterSunset.goldenHour, true);

  // Well before sunrise: neither.
  const preDawn = sunInfo(times.sunrise - 30 * MINUTE, LAT, LON);
  assert.equal(preDawn.isDaylight, false);
  assert.equal(preDawn.goldenHour, false);

  // High summer noon: bright, harsh, not golden.
  const noon = sunInfo(solarNoon(2026, 5, 21), LAT, LON);
  assert.equal(noon.isDaylight, true);
  assert.equal(noon.goldenHour, false);
  closeBearing(noon.azimuth, 180, 0.5, 'noon azimuth');
});

test('sunInfo agrees with sunPosition and rounds cleanly', () => {
  const now = Date.UTC(2026, 5, 21, 15, 30);
  const info = sunInfo(now, LAT, LON);
  const pos = sunPosition(new Date(now), LAT, LON);
  close(info.azimuth, pos.azimuth, 0.005, 'azimuth agreement');
  close(info.elevation, pos.elevation, 0.005, 'elevation agreement');
  assert.equal(Math.round(info.azimuth * 100), info.azimuth * 100);
  assert.ok(Number.isInteger(info.sunriseAt), 'sunriseAt should be whole milliseconds');
  assert.ok(Number.isInteger(info.sunsetAt), 'sunsetAt should be whole milliseconds');
});

test('golden hour boundaries follow the specified elevation band', () => {
  // Scan a full day and check the flag exactly tracks -4° ≤ elevation ≤ +8°.
  const dayStart = Date.UTC(2026, 8, 15);
  let goldenMinutes = 0;
  for (let minute = 0; minute < 1440; minute += 1) {
    const at = dayStart + minute * MINUTE;
    const info = sunInfo(at, LAT, LON);
    const expected = info.elevation >= -4 && info.elevation <= 8;
    assert.equal(info.goldenHour, expected, `golden hour flag disagrees at minute ${minute}`);
    assert.equal(info.isDaylight, info.elevation > -0.833, `daylight flag disagrees at minute ${minute}`);
    if (info.goldenHour) goldenMinutes += 1;
  }
  // Mid-September at this latitude: roughly an hour of it at each end of the day.
  assert.ok(goldenMinutes > 60 && goldenMinutes < 240, `implausible golden window: ${goldenMinutes} min`);
});

test('invalid inputs never throw and never leak NaN', () => {
  const bad = sunPosition(new Date(Number.NaN), LAT, LON);
  assert.ok(Number.isFinite(bad.azimuth) && Number.isFinite(bad.elevation));
  assert.deepEqual(sunTimes(new Date(Number.NaN), LAT, LON), { sunrise: null, sunset: null });
  assert.deepEqual(sunTimes(new Date(Date.UTC(2026, 5, 21)), Number.NaN, LON), { sunrise: null, sunset: null });

  const info = sunInfo(Number.NaN, LAT, LON);
  assert.ok(Number.isFinite(info.azimuth) && Number.isFinite(info.elevation));
  assert.equal(typeof info.goldenHour, 'boolean');
  assert.equal(typeof info.isDaylight, 'boolean');
});

test('a whole year of Heathrow days produces ordered, plausible times', () => {
  for (let day = 0; day < 365; day += 1) {
    const at = Date.UTC(2026, 0, 1) + day * 86_400_000;
    const times = sunTimes(new Date(at), LAT, LON);
    assert.ok(times.sunrise !== null && times.sunset !== null, `day ${day} must have both`);
    assert.ok(times.sunrise < times.sunset, `day ${day}: sunrise after sunset`);
    const lengthHours = (times.sunset - times.sunrise) / 3_600_000;
    assert.ok(lengthHours > 7.5 && lengthHours < 17, `day ${day}: day length ${lengthHours}`);
    // Both events fall on the UTC day requested — true at Heathrow's longitude.
    assert.equal(new Date(times.sunrise).getUTCDate(), new Date(at).getUTCDate(), `day ${day} sunrise date`);
    assert.equal(new Date(times.sunset).getUTCDate(), new Date(at).getUTCDate(), `day ${day} sunset date`);
  }
});
