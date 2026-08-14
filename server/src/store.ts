/**
 * Whale Watch LHR — the movement log.
 *
 * Completed arrivals and departures are appended to a JSONL file (one JSON object per line) under
 * `data/runtime/`. The file is the only mutable state the server owns, so it is treated with
 * suspicion: corrupt lines are skipped, entries are validated on the way in and on the way out,
 * the log is capped, and rewrites go through a temp file + rename so a crash mid-write cannot
 * truncate history.
 *
 * "Today" is the Europe/London calendar day — London is on BST for half the year, so the day
 * boundary is resolved with Intl, never with a hardcoded UTC offset.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LoggedMovement } from '../../shared/types.ts';
import { CONFIG, log } from './config.ts';

const LONDON_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` for the given instant, in London local time. */
function londonDay(epochMs: number): string {
  return LONDON_DAY.format(new Date(epochMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Coerce an unknown value into a LoggedMovement, or reject it. `id`, `kind` and `at` are the
 * identity of an event and must be present and sane; everything else degrades to null.
 */
function toEntry(value: unknown): LoggedMovement | null {
  if (!isRecord(value)) return null;

  const id = optionalString(value['id']);
  if (id === null) return null;

  const kindRaw = optionalString(value['kind']);
  if (kindRaw !== 'arrival' && kindRaw !== 'departure') return null;

  const at = typeof value['at'] === 'number' ? value['at'] : Number(value['at']);
  if (!Number.isFinite(at) || at <= 0) return null;

  const operator = optionalString(value['operator']);
  const color = optionalString(value['operatorColor']);

  return {
    id: id.toLowerCase(),
    kind: kindRaw,
    at: Math.round(at),
    callsign: optionalString(value['callsign']),
    flightNumber: optionalString(value['flightNumber']),
    registration: optionalString(value['registration']),
    operator: operator ?? 'Unknown',
    operatorColor: color ?? '#8A94A6',
    runway: optionalString(value['runway']),
    city: optionalString(value['city']),
  };
}

/** Index of the first entry with `at` greater than the probe (entries are kept ascending). */
function upperBound(entries: LoggedMovement[], at: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const probe = entries[mid];
    if (probe === undefined || probe.at <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class MovementStore {
  private readonly file: string;

  /** Oldest first, always sorted by `at`. Capped at `CONFIG.movementLogMax`. */
  private entries: LoggedMovement[] = [];

  constructor(file: string) {
    this.file = resolve(file);
    this.load();
  }

  /** Append a completed movement. Duplicate events inside the dedupe window are a no-op. */
  append(entry: LoggedMovement): void {
    const clean = toEntry(entry);
    if (clean === null) {
      log.warn('movement log: refusing to append a malformed entry');
      return;
    }
    if (this.isDuplicate(clean)) return;

    this.entries.splice(upperBound(this.entries, clean.at), 0, clean);

    try {
      appendFileSync(this.file, `${JSON.stringify(clean)}\n`, 'utf8');
    } catch (err) {
      log.warn(`movement log: could not write ${this.file}: ${message(err)}`);
    }

    if (this.entries.length > CONFIG.movementLogMax) {
      this.entries = this.entries.slice(this.entries.length - CONFIG.movementLogMax);
      this.rewrite();
    }
  }

  /** Movements from the last `hours` hours, newest first. */
  recent(hours: number): LoggedMovement[] {
    const span = Number.isFinite(hours) ? Math.max(0, hours) : 0;
    const cutoff = Date.now() - span * 3_600_000;
    const out: LoggedMovement[] = [];
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry === undefined) continue;
      if (entry.at < cutoff) break;
      out.push({ ...entry });
    }
    return out;
  }

  /** Every logged movement for one airframe, newest first. */
  forAirframe(hex: string): LoggedMovement[] {
    const id = hex.trim().toLowerCase();
    if (id === '') return [];
    const out: LoggedMovement[] = [];
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry !== undefined && entry.id === id) out.push({ ...entry });
    }
    return out;
  }

  /** Counts for the current Europe/London calendar day. */
  todayCounts(): { arrivals: number; departures: number; airframes: number } {
    const now = Date.now();
    const today = londonDay(now);
    // A London day can only overlap the last 48 h, so we never have to scan the whole log.
    const horizon = now - 48 * 3_600_000;

    let arrivals = 0;
    let departures = 0;
    const airframes = new Set<string>();

    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry === undefined) continue;
      if (entry.at < horizon) break;
      if (londonDay(entry.at) !== today) continue;

      if (entry.kind === 'arrival') arrivals += 1;
      else departures += 1;
      airframes.add(entry.registration ?? entry.id);
    }

    return { arrivals, departures, airframes: airframes.size };
  }

  /** Total entries currently held. */
  get size(): number {
    return this.entries.length;
  }

  /* ---------------------------------------------------------------- */

  private isDuplicate(candidate: LoggedMovement): boolean {
    const window = CONFIG.movementDedupeMs;
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry === undefined) continue;
      const gap = candidate.at - entry.at;
      // Entries are ascending: once we are a whole window behind, nothing older can match.
      if (gap > window) break;
      if (Math.abs(gap) > window) continue;
      if (entry.id === candidate.id && entry.kind === candidate.kind) return true;
    }
    return false;
  }

  private load(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch (err) {
      log.warn(`movement log: could not create ${dirname(this.file)}: ${message(err)}`);
    }

    if (!existsSync(this.file)) {
      this.entries = [];
      return;
    }

    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      log.warn(`movement log: could not read ${this.file}: ${message(err)} — starting empty`);
      this.entries = [];
      return;
    }

    const parsed: LoggedMovement[] = [];
    let skipped = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        skipped += 1;
        continue;
      }
      const entry = toEntry(value);
      if (entry === null) skipped += 1;
      else parsed.push(entry);
    }

    parsed.sort((a, b) => a.at - b.at);

    const overflow = Math.max(0, parsed.length - CONFIG.movementLogMax);
    this.entries = overflow > 0 ? parsed.slice(overflow) : parsed;

    if (skipped > 0) {
      log.warn(`movement log: skipped ${skipped} unreadable line(s) in ${this.file}`);
    }
    if (skipped > 0 || overflow > 0) {
      // Compact the file so the damage/overflow is not re-read on every boot.
      this.rewrite();
    }
    log.info(`movement log: ${this.entries.length} entries loaded from ${this.file}`);
  }

  private rewrite(): void {
    const body = this.entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, body, 'utf8');
      renameSync(temp, this.file);
    } catch (err) {
      log.warn(`movement log: could not compact ${this.file}: ${message(err)}`);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
