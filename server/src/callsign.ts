/**
 * ADS-B callsign parsing.
 *
 * The `flight` field from adsb.lol is an 8-character field padded with trailing
 * spaces, and it carries whatever the crew typed into the FMS. In practice it is
 * one of:
 *
 *   - an ICAO airline designator plus the flight number, optionally with a
 *     one or two letter suffix: `UAE1`, `UAE98P`, `BAW216`, `SIA308A`
 *   - the aircraft registration, for positioning/test/private flights:
 *     `G-XLEL`, `N123AB`, and sometimes without the hyphen: `GXLEL`
 *   - junk: an empty field, all zeroes, or a partially decoded frame
 *
 * This module never throws and never guesses: if the string does not clearly carry
 * an airline designator, `airlineIcao` and `number` are null and the raw (trimmed)
 * callsign is passed through unchanged.
 */

/** ICAO designator + flight number + optional operational suffix. */
const AIRLINE_CALLSIGN = /^([A-Z]{3})(\d{1,4})([A-Z]{0,2})$/;

/**
 * Registrations that would otherwise look like an airline callsign.
 *
 * Hyphenated registrations are rejected by the pattern above anyway, but ADS-B
 * feeds sometimes strip the hyphen. A three-letter/digits shape is only ambiguous
 * for a handful of prefixes; the ones that matter for A380 operators are the
 * British `G-` and French `F-` blocks, which always start with a single letter and
 * therefore cannot produce a valid three-letter designator followed by digits.
 * The genuinely ambiguous case is a US registration such as `N12` — too short to
 * match the pattern — so no extra exclusions are needed. This constant documents
 * why the naive pattern is safe rather than adding rules that would misfire.
 */
const REGISTRATION_HINT = /-/;

export interface ParsedCallsign {
  /** The cleaned callsign, e.g. "UAE1". Null when nothing usable was transmitted. */
  callsign: string | null;
  /** ICAO airline designator, e.g. "UAE". Null for registrations and junk. */
  airlineIcao: string | null;
  /**
   * The flight number as flown, including any operational suffix:
   * "1" for UAE1, "98P" for UAE98P, "308A" for SIA308A. Null when unknown.
   */
  number: string | null;
}

const EMPTY: ParsedCallsign = { callsign: null, airlineIcao: null, number: null };

export function parseCallsign(raw: string | null | undefined): ParsedCallsign {
  if (typeof raw !== 'string') return { ...EMPTY };

  // Uppercase, drop every character that cannot appear in a callsign (including
  // the trailing padding spaces and any stray control bytes from a bad decode).
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (cleaned.length === 0) return { ...EMPTY };

  // Feeds emit "00000000" and bare hyphens when the field is unset.
  if (/^[-0]+$/.test(cleaned)) return { ...EMPTY };

  if (REGISTRATION_HINT.test(cleaned)) {
    return { callsign: cleaned, airlineIcao: null, number: null };
  }

  const match = AIRLINE_CALLSIGN.exec(cleaned);
  if (!match) {
    return { callsign: cleaned, airlineIcao: null, number: null };
  }

  const [, icao, digits, suffix] = match;
  if (icao === undefined || digits === undefined) {
    return { callsign: cleaned, airlineIcao: null, number: null };
  }

  // Crews sometimes file with leading zeros ("UAE0001"). The callsign is passed
  // through exactly as transmitted, but the flight number is the human one.
  const significantDigits = digits.replace(/^0+(?=\d)/, '');

  return {
    callsign: cleaned,
    airlineIcao: icao,
    number: `${significantDigits}${suffix ?? ''}`,
  };
}
