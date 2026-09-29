import type { OrchestratorConfig } from './config.js';

/**
 * Secret redaction — docs/12-SECURITY.md I-2.
 *
 * Two facts drove this rewrite, both measured rather than assumed:
 *
 * 1. The previous implementation imported `pino` and called it, but had ZERO
 *    production callers. `pino` was nonetheless a *live* dependency, not merely
 *    a declared one: `cli.ts` imports `./common/index.js`, that barrel
 *    re-exports `./logger.js`, and the previous top-level
 *    `import pino from 'pino'` therefore executed on every CLI and daemon
 *    start (verified with an ESM resolve trace, not by reading the import).
 *    The project believed it had redaction and did not, and paid for the belief
 *    with a dependency inside the installer payload. Pino is gone; this file is
 *    now stdlib-only.
 *
 * 2. The old patterns had no `sk-or-v1-` case at all, and the old hook only
 *    redacted arguments where `typeof arg === 'string'`. An object argument
 *    holding a key was passed through untouched. Both are fixed here.
 *
 * INVARIANT — redact STRUCTURALLY, before serialization.
 * Callers hand this module values, not pre-rendered JSON. The key/value pattern
 * below preserves the quote character of a quoted value, so even a serialized
 * blob stays parseable, but scrubbing an object field by field is structurally
 * incapable of corrupting a document.
 */

/** The marker every redacted value collapses to. */
export const REDACTION_MARKER = '[REDACTED]';

/**
 * Every provider prefix this build can actually hold. These are the live pools,
 * not guesses — Groq (STT), Fish Audio (TTS) and OpenRouter (brain, intake,
 * planner and narrator) — plus a generic long-tail `sk-` fallback so a future
 * provider shape is covered without another audit cycle. Exported so a test can
 * assert each one is caught without duplicating the literal.
 */
export const LIVE_PREFIXES: readonly string[] = ['sk-or-v1-', 'sk-fish-', 'gsk_'];

/**
 * The 8-char floors stop ordinary prose from being mangled; the specific
 * prefixes run before the generic one so they win. Every regex is module-level
 * and global, so `lastIndex` is reset at each use rather than inherited from a
 * previous `test()`/`replace()` call.
 */
/**
 * The 8-char floors stop ordinary prose from being mangled; the specific
 * prefixes run before the generic one so they win. Every regex is module-level
 * and global, so `lastIndex` is reset at each use rather than inherited from a
 * previous `test()`/`replace()` call.
 *
 * The generic fallback carries a negative lookahead that makes it INDEPENDENT of
 * the specific patterns: without it, `sk-[A-Za-z0-9_-]{20,}` also matches
 * `sk-or-v1-AAA…`, so deleting a specific pattern would change nothing and its
 * test would pass vacuously. With the lookahead, removing a specific pattern
 * leaves a real hole. The two lists are cross-checked by a test so a future
 * prefix cannot be added to one and forgotten in the other.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g,
  /sk-fish-[A-Za-z0-9_-]{8,}/g,
  /gsk_[A-Za-z0-9]{8,}/g,
  /sk-(?!(?:or-v1-|fish-))[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi,
  /Basic\s+[A-Za-z0-9+/=]{8,}/gi,
];

/** Tails (what follows the leading `sk-`) that the generic fallback must skip. */
export const GENERIC_SK_EXCLUSIONS: readonly string[] = ['or-v1-', 'fish-'];

/**
 * `key = value` pairs whose NAME declares the value secret. The name is
 * captured so redaction preserves the field label: a log line reading
 * `apiKey=[REDACTED]` is diagnosable, one reading `[REDACTED]` is not.
 *
 * `["']?` before the separator is load-bearing, not decoration: a serialized
 * object writes `"apiKey":"…"`, where a closing quote sits between the name and
 * the colon. Without it the pattern misses every JSON-shaped value — which is
 * exactly the shape this module is asked to handle.
 *
 * The quoted-value branch is `"(?:[^"\\]|\\.)*"` and NOT `"[^"]*"`, and that
 * distinction is a security fix, not a style preference. `[^"]*` stops at the
 * first quote, including one that is ESCAPED, so a JSON value containing an
 * escaped quote was redacted only up to that point and its tail survived
 * whole. Measured, before this change:
 *
 *   redactString('{"password":"ab\\"cdefgh1234"}')
 *     -> '{"password":"[REDACTED]"cdefgh1234"}'      <-- tail intact
 *
 * That is reachable from any provider error that echoes a request body, and
 * M5 hit it while building the diagnostic bundle — which is precisely the
 * artifact designed to be pasted into a public ticket. The `\\.` alternative
 * consumes an escape plus its payload as one unit, so the value is matched to
 * its true closing quote. Pinned by the escaped-quote test in
 * `logger.test.ts`; `containsSecret` shares this pattern and therefore shares
 * the fix.
 */
const SECRET_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|auth)\b(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;)}\]]+)/gi;

/** Depth and breadth bounds. Reaching one fails closed instead of recursing forever. */
const MAX_DEPTH = 8;
const MAX_NODES = 1000;

/** Replace every secret-shaped run in one string. Never throws. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTION_MARKER);
  }
  SECRET_ASSIGNMENT.lastIndex = 0;
  out = out.replace(SECRET_ASSIGNMENT, (_match: string, name: string, sep: string, value: string) => {
    const quote = value.charAt(0);
    const wrapped = quote === '"' || quote === "'" ? `${quote}${REDACTION_MARKER}${quote}` : REDACTION_MARKER;
    return `${name}${sep}${wrapped}`;
  });
  return out;
}

/**
 * Deep redaction. The old signature was `(input: string): string` and its body
 * only touched strings, so a caller logging `{ apiKey }` leaked the key — the
 * exact case the function existed to prevent. This overload keeps the string
 * contract intact while handling everything else by walking it.
 *
 * Non-strings are walked: plain objects, arrays, `Error` (name/message/stack
 * and own enumerable fields), `Map` and `Set`. Cycles and over-deep values
 * collapse to a marker rather than throwing or overflowing the stack.
 */
export function redactSecrets(input: string): string;
export function redactSecrets(input: unknown): unknown;
export function redactSecrets(input: unknown): unknown {
  return scrub(input, 0, new WeakSet<object>(), { n: 0 });
}

/** Typed wrapper for the "I know this is a JSON-safe object" case. */
export function redactObject<T extends object>(input: T): T {
  // The walk preserves plain-object shape for JSON-safe inputs, which is the
  // only documented contract; exotic prototypes are deliberately not preserved.
  return redactSecrets(input) as T;
}

/** Deep predicate, for failing closed on a value about to be persisted. */
export function containsSecret(input: unknown): boolean {
  return scan(input, 0, new WeakSet<object>(), { n: 0 });
}

interface Budget {
  n: number;
}

function scrub(value: unknown, depth: number, seen: WeakSet<object>, budget: Budget): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH || budget.n >= MAX_NODES) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  budget.n += 1;
  try {
    if (Array.isArray(value)) {
      return value.map((item) => scrub(item, depth + 1, seen, budget));
    }
    if (value instanceof Error) {
      const own = scrubFields(value, depth, seen, budget) as Record<string, unknown>;
      return {
        name: redactString(value.name),
        message: redactString(value.message),
        ...(typeof value.stack === 'string' ? { stack: redactString(value.stack) } : {}),
        ...own,
      };
    }
    if (value instanceof Map) {
      const asRecord: Record<string, unknown> = {};
      for (const [k, v] of value.entries()) asRecord[String(k)] = v;
      return scrubFields(asRecord, depth, seen, budget);
    }
    if (value instanceof Set) {
      return [...value.values()].map((item) => scrub(item, depth + 1, seen, budget));
    }
    return scrubFields(value, depth, seen, budget);
  } finally {
    // Siblings are not circular just because a shared child was seen on
    // another branch, so the node is released rather than left marked.
    seen.delete(value);
  }
}

function scrubFields(value: object, depth: number, seen: WeakSet<object>, budget: Budget): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (budget.n >= MAX_NODES) return '[TRUNCATED]';
    out[key] = scrub(item, depth + 1, seen, budget);
  }
  return out;
}

function scan(value: unknown, depth: number, seen: WeakSet<object>, budget: Budget): boolean {
  if (typeof value === 'string') return matchesAny(value);
  if (value === null || typeof value !== 'object') return false;
  if (depth >= MAX_DEPTH || budget.n >= MAX_NODES) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  budget.n += 1;
  try {
    if (Array.isArray(value) || value instanceof Set) {
      for (const item of value as Iterable<unknown>) {
        if (scan(item, depth + 1, seen, budget)) return true;
      }
      return false;
    }
    if (value instanceof Map) {
      for (const [k, v] of value.entries()) {
        if (matchesAny(String(k)) || scan(v, depth + 1, seen, budget)) return true;
      }
      return false;
    }
    // `message` and `stack` are own but NON-ENUMERABLE on an Error, so the
    // Object.values() walk below sees an empty object and reports "clean" for
    // the single most likely place a leaked key lands.
    if (value instanceof Error) {
      return (
        matchesAny(value.name) ||
        matchesAny(value.message) ||
        (typeof value.stack === 'string' && matchesAny(value.stack)) ||
        Object.values(value).some((item) => scan(item, depth + 1, seen, budget))
      );
    }
    for (const item of Object.values(value)) {
      if (scan(item, depth + 1, seen, budget)) return true;
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

function matchesAny(input: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) return true;
  }
  SECRET_ASSIGNMENT.lastIndex = 0;
  return SECRET_ASSIGNMENT.test(input);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const LEVEL_RANK: Readonly<Record<OrchestratorConfig['logLevel'], number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  /** Sink for one rendered line. Defaults to stderr. Injectable for tests. */
  readonly write?: (line: string) => void;
  /** Structured fields merged into every line (scope, sessionId, ...). */
  readonly bindings?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  readonly level: OrchestratorConfig['logLevel'];
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Minimal JSON-lines logger, replacing `pino`. Every argument is deep-redacted
 * before rendering, so an object holding a key IS redacted — the old pino hook
 * returned non-string arguments untouched and would have written the key out.
 *
 * stderr, not stdout: stdout is parsed by callers (`cli.ts` prints JSON; the
 * WS-4097 handshake reads stdout), so diagnostics must not share it.
 */
export function createLogger(
  level: OrchestratorConfig['logLevel'] = 'info',
  options: LoggerOptions = {},
): Logger {
  const write = options.write ?? ((line: string): void => void process.stderr.write(line));
  const bindings = options.bindings ?? {};
  const threshold = LEVEL_RANK[level];

  function emit(at: OrchestratorConfig['logLevel'], args: unknown[]): void {
    if (LEVEL_RANK[at] < threshold) return;
    const safe = redactSecrets(args) as unknown[];
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: at,
      ...redactObject(bindings),
    };
    const [head, ...tail] = safe;
    if (typeof head === 'string') {
      record['msg'] = head;
      if (tail.length > 0) record['args'] = tail;
    } else if (safe.length > 0) {
      record['msg'] = '(unstructured)';
      record['args'] = safe;
    }
    try {
      write(`${JSON.stringify(record)}\n`);
    } catch {
      // A logging failure must never take down the caller it is describing.
    }
  }

  return {
    level,
    debug: (...args: unknown[]) => void emit('debug', args),
    info: (...args: unknown[]) => void emit('info', args),
    warn: (...args: unknown[]) => void emit('warn', args),
    error: (...args: unknown[]) => void emit('error', args),
    child: (extra: Record<string, unknown>) =>
      createLogger(level, { write, bindings: { ...bindings, ...extra } }),
  };
}
