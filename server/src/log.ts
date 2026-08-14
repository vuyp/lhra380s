/**
 * Whale Watch LHR — the logger.
 *
 * Deliberately tiny: no dependencies, no transports, no async. One record is one line on one
 * stream, so `npm start | grep` works and so a crash can never interleave half a stack trace into
 * the middle of another record. Anything multi-line (an Error stack, a pretty-printed object) is
 * folded onto a single line before it is written.
 *
 * The level comes from `config.ts` (`LOG_LEVEL`, default `info`) and can be moved at runtime with
 * `setLogLevel` — used by the tests and by the shutdown path, never by request handling.
 *
 * Diagnostics go to stdout, problems go to stderr, so a supervisor can route them separately.
 */

import type { LogLevel } from './config.ts';

export type { LogLevel };

/** Every level except `silent` can actually be emitted. */
export type EmittableLevel = Exclude<LogLevel, 'silent'>;

const WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Beyond this a single argument is truncated — logs are for humans, not for dumps. */
const MAX_ARG_CHARS = 2000;

/**
 * The level is read straight from the environment rather than from `CONFIG`, because config.ts
 * logs while it is still being evaluated and importing it here at runtime would make that a
 * circular import. config.ts calls `setLogLevel` with the parsed value as soon as it has one, so
 * this bootstrap value is only ever used for records emitted during module initialisation.
 */
function levelFromEnv(): LogLevel {
  const raw = process.env['LOG_LEVEL']?.trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'silent') return raw;
  return 'info';
}

let currentLevel: LogLevel = levelFromEnv();

/** Move the threshold at runtime. Anything below it is dropped without being formatted. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** True when a record at this level would be written. Guard expensive formatting with it. */
export function isEnabled(level: EmittableLevel): boolean {
  return WEIGHT[level] >= WEIGHT[currentLevel];
}

function truncate(text: string): string {
  return text.length > MAX_ARG_CHARS ? `${text.slice(0, MAX_ARG_CHARS)}…[+${text.length - MAX_ARG_CHARS}]` : text;
}

/** Fold every line break (and stray carriage return) so one record is one line. */
function flatten(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ⏎ ').replace(/\t/g, ' ');
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) {
    const cause = value.cause;
    const suffix = cause instanceof Error && cause.message !== value.message ? ` (cause: ${cause.message})` : '';
    return `${value.name}: ${value.message}${suffix}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    // Circular structures, BigInt fields, hostile toJSON — none of it may take the server down.
    return '[unserialisable]';
  }
}

function render(level: EmittableLevel, scope: string | null, args: readonly unknown[]): string {
  const parts: string[] = [];
  for (const arg of args) parts.push(truncate(format(arg)));
  const body = flatten(parts.join(' '));
  const label = scope === null ? '' : `[${scope}] `;
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${label}${body}\n`;
}

function emit(level: EmittableLevel, scope: string | null, args: readonly unknown[]): void {
  if (!isEnabled(level)) return;
  const line = render(level, scope, args);
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  try {
    stream.write(line);
  } catch {
    // A closed or broken stdio pipe must never propagate into the caller.
  }
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** A logger that prefixes every record with `[scope]`. */
  child(scope: string): Logger;
}

/** Create a logger, optionally scoped: `createLogger('tracker').info('…')`. */
export function createLogger(scope?: string): Logger {
  const label = typeof scope === 'string' && scope.trim().length > 0 ? scope.trim() : null;
  return {
    debug: (...args: unknown[]): void => emit('debug', label, args),
    info: (...args: unknown[]): void => emit('info', label, args),
    warn: (...args: unknown[]): void => emit('warn', label, args),
    error: (...args: unknown[]): void => emit('error', label, args),
    child: (child: string): Logger => createLogger(label === null ? child : `${label}:${child}`),
  };
}

/** The unscoped logger. */
export const log: Logger = createLogger();

export default log;
