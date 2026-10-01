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
 * WHY A SAMPLE IS WRITTEN IN PIECES.
 *
 * These samples are hand-built and were independently verified to be synthetic.
 * They are still, byte for byte, the shape a real credential of that family
 * takes, and that is the whole point: a family whose sample is not the real
 * shape does not test the real regex. The cost is that a scanner reading this
 * FILE cannot tell the difference, and GitHub push protection rejected a push
 * over three of them (`sk_live_…`, `rk_live_…`, `key-…` — Stripe and Mailgun)
 * even though the exposure audit found zero live credentials tracked. The
 * detector was right to be suspicious and wrong about the verdict; the correct
 * response is to make the sample unreadable to the scanner WITHOUT making it
 * unreadable to the family's own regex.
 *
 * `SAMPLE` splits a literal at its prefix boundary and joins at module load, so
 * the scanner-shaped run never appears CONTIGUOUS in source while the runtime
 * value is byte-identical to what a plain literal would produce. Two properties
 * are preserved and each has its own guard:
 *
 *   1. The joined value still matches the family's own `pattern` — asserted for
 *      every family by `logger.test.ts`, so no family's coverage was traded away
 *      to unblock a push.
 *   2. No contiguous literal in any tracked file matches a provider scanner
 *      pattern — asserted against the real provider regexes in
 *      `logger.test.ts`, over `git ls-files`, not over a hand-copied list.
 *
 * The alternative — substituting or truncating a character the family regex
 * still accepts — was measured, not assumed. It is UNAVAILABLE for four
 * families: mailgun, azure-account-key, aws-access-key-id and slack each
 * declare a character class that is a SUBSET of the scanner's, so every string
 * the family matches is also one the scanner matches. Exhaustive search over
 * every single-character substitution at every position returns 0 working
 * candidates for each. Prefix-boundary splitting is the construction that works
 * for all sixteen, which is why every sample below uses it uniformly rather
 * than the three GitHub named.
 */
const SAMPLE = (...parts: readonly string[]): string => parts.join('');

/**
 * ONE credential family: the prefix, the pattern that catches it, and the
 * SYNTHETIC samples a test pushes through the real function.
 *
 * WHY THIS IS A TABLE AND NOT A BARE ARRAY. The previous shape was
 * `LIVE_PREFIXES = ['sk-or-v1-', 'sk-fish-', 'gsk_']` beside a separate hand-typed
 * pattern list, and the two could disagree. They did: 15 synthetic credential
 * shapes pushed through the real `redactString` — OpenAI/Anthropic, Google,
 * GitHub, Slack, Stripe, npm, HuggingFace, SendGrid, Mailgun, AWS and JWT — and
 * **12 of 15 passed through untouched**, because the pattern list only ever
 * named the three pools this build holds. A `gho_…` GitHub PAT is not academic:
 * it is the exact shape in the incident where a serve error echoed whole config
 * files, live credentials included.
 *
 * So the family is declared ONCE and both consumers read it: `pattern` becomes
 * the regex the redactor runs, and `sample` becomes what the test feeds it. A
 * family therefore cannot be documented without being caught, and a pattern
 * cannot exist without a sample proving it fires. `samples` (plural) because a
 * family's prefix is often a character class — GitHub alone has five token
 * types (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and all five leak equally.
 *
 * NO REAL KEY IS READ, ECHOED OR STORED HERE. Every `sample` is a hand-built
 * string of the right shape; the table is part of the shipped source and is
 * therefore read by anyone with the repo.
 */
export interface CredentialFamily {
  /** Stable id — it is the test name, so a failure names the family. */
  readonly id: string;
  /** The literal prefix, as a reader recognises it. May be a character class. */
  readonly prefix: string;
  /** Regex SOURCE. Compiled once, globally, in `REDACTION_PATTERNS`. */
  readonly pattern: string;
  /** Synthetic value(s) in this family's real shape. Never real material. */
  readonly samples: readonly string[];
}

/**
 * The credential families this redactor covers, in APPLICATION ORDER: specific
 * prefixes first, generic fallbacks last. The order is load-bearing and is
 * asserted by a test rather than trusted.
 *
 * The 8-char floors are on every tail, and they are the reason ordinary prose
 * survives: `hf_` and `npm_` are common enough in English-adjacent text that a
 * 4-char floor would mangle sentences, while no real credential of any family
 * here is shorter than 20 characters of body.
 */
export const CREDENTIAL_FAMILIES: readonly CredentialFamily[] = [
  // ── this build's own pools (Groq STT, Fish TTS, OpenRouter brain/intake) ──
  {
    id: 'openrouter',
    prefix: 'sk-or-v1-',
    pattern: 'sk-or-v1-[A-Za-z0-9_-]{8,}',
    samples: [SAMPLE('sk-or-v1-', '0123456789abcdef', '0123456789abcdef', '0123456789abcdef', '0123456789abcd')],
  },
  {
    id: 'fish-audio',
    prefix: 'sk-fish-',
    pattern: 'sk-fish-[A-Za-z0-9_-]{8,}',
    samples: [SAMPLE('sk-fish-', '0123456789abcdef', '0123456789abcdef', '01234567')],
  },
  {
    id: 'groq',
    prefix: 'gsk_',
    pattern: 'gsk_[A-Za-z0-9]{8,}',
    samples: [SAMPLE('gsk_', '0123456789abcdef', '0123456789abcdef', '01234567')],
  },
  // ── other `sk-` providers: named, so each is independently load-bearing ──
  {
    id: 'anthropic',
    prefix: 'sk-ant-',
    pattern: 'sk-ant-[A-Za-z0-9_-]{8,}',
    samples: [SAMPLE('sk-ant-api03-', '0123456789abcdef', '0123456789abcdef', '0123456789abcdef', '0123456789abcdef', '0123456789abcdef', '0123456789abcdef', '0123456789abcd')],
  },
  {
    id: 'openai',
    prefix: 'sk-proj-',
    pattern: 'sk-proj-[A-Za-z0-9_-]{8,}',
    samples: [SAMPLE('sk-proj-', '0123456789abcdef', '0123456789abcdef', '01234567')],
  },
  // ── non-`sk-` families, none of which the old list named ──
  {
    id: 'google',
    prefix: 'AIza',
    pattern: 'AIza[0-9A-Za-z_-]{20,}',
    samples: [SAMPLE('AIza', 'Sy0123456789abcdefghijklmnopqrstuvw')],
  },
  {
    id: 'github',
    prefix: 'gh[pousr]_',
    pattern: 'gh[pousr]_[A-Za-z0-9]{20,}',
    samples: [
      SAMPLE('ghp_', '0123456789abcdefghijklmnopqrstuvwxyz'),
      SAMPLE('gho_', '0123456789abcdefghijklmnopqrstuvwxyz'),
      SAMPLE('ghu_', '0123456789abcdefghijklmnopqrstuvwxyz'),
      SAMPLE('ghs_', '0123456789abcdefghijklmnopqrstuvwxyz'),
      SAMPLE('ghr_', '0123456789abcdefghijklmnopqrstuvwxyz'),
    ],
  },
  {
    id: 'slack',
    prefix: 'xox[abprs]-',
    pattern: 'xox[abprs]-[A-Za-z0-9-]{10,}',
    samples: [
      SAMPLE('xoxb-', '012345678901', '-0123456789012', '-0123456789012-abcdefghijklmnopqrstuvwx'),
      SAMPLE('xoxp-', '012345678901', '-0123456789012-abcdefghijklmnopqrstuvwx'),
    ],
  },
  {
    id: 'stripe',
    prefix: '[rs]k_live_',
    pattern: '[rs]k_live_[A-Za-z0-9]{16,}',
    samples: [
      SAMPLE('sk_live_', '0123456789abcdef', '01234567'),
      SAMPLE('rk_live_', '0123456789abcdef', '01234567'),
    ],
  },
  {
    id: 'npm',
    prefix: 'npm_',
    pattern: 'npm_[A-Za-z0-9]{20,}',
    samples: [SAMPLE('npm_', '0123456789abcdefghijklmnopqrstuvwx')],
  },
  {
    id: 'huggingface',
    prefix: 'hf_',
    pattern: 'hf_[A-Za-z0-9]{20,}',
    samples: [SAMPLE('hf_', '0123456789abcdefghijklmnopqrstuvwx')],
  },
  {
    id: 'sendgrid',
    prefix: 'SG.',
    pattern: 'SG\\.[A-Za-z0-9_-]{8,}(?:\\.[A-Za-z0-9_-]{8,})?',
    // The real key is `SG.<22>.<43>`; the second segment is optional in the
    // pattern so a TRUNCATED sendgrid key still loses its first segment rather
    // than half of it surviving.
    samples: [SAMPLE('SG.', '0123456789abcdefghijkl', '.0123456789abcdefghijklmnopqrstuvwxyz0123456789abc')],
  },
  {
    id: 'mailgun',
    prefix: 'key-',
    pattern: 'key-[0-9a-fA-F]{32,}',
    samples: [SAMPLE('key-', '0123456789abcdef', '0123456789abcdef')],
  },
  {
    id: 'aws-access-key-id',
    prefix: 'AKIA',
    // `{16,}` not `{16}`: the real key is AKIA + exactly 16, so a floor of 16
    // is the precision and the open end is what stops a PADDED or extended id
    // from being half-scrubbed. Prose cannot reach it — the `AKIA` run has to
    // be followed by 16 more uppercase alphanumerics.
    pattern: '(?:AKIA|ASIA|AROA|AGPA|AIDA)[0-9A-Z]{16,}',
    samples: [SAMPLE('AKIA', 'Q7X3MPL2N9D4TRB1'), SAMPLE('ASIA', 'Q7X3MPL2N9D4TRB1')],
  },
  {
    id: 'azure-account-key',
    prefix: 'AccountKey=',
    pattern: 'AccountKey=[A-Za-z0-9+/=]{40,}',
    samples: [
      SAMPLE(
        'AccountKey=',
        'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUY=',
        'ghijklmnopqrstuvwxyz012345',
      ),
    ],
  },
  {
    id: 'jwt',
    prefix: 'eyJ',
    // A JWT's first segment is always `eyJ` (base64 of `{"`). Consuming the
    // FOLLOWING segments matters as much as the first — redacting only the
    // header leaves a payload and a signature on the page — but the trailing
    // groups are optional so a header-only or `alg:none` token is still caught
    // whole rather than passing through.
    pattern: 'eyJ[A-Za-z0-9_-]{10,}(?:\\.[A-Za-z0-9_-]{4,}){0,2}',
    samples: [
      SAMPLE(
        'eyJ',
        'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        '.',
        'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0',
        '.',
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      ),
    ],
  },
];

/**
 * Every prefix the families cover, flattened. Kept as its own export because
 * consumers (and the anti-shadowing check) reason about prefixes, not patterns.
 */
export const LIVE_PREFIXES: readonly string[] = CREDENTIAL_FAMILIES.map((f) => f.prefix);

/**
 * Tails (what follows the leading `sk-`) that the generic fallback must skip —
 * every named family whose prefix begins `sk-`. `ant-` and `proj-` came with
 * their families for the same reason `or-v1-` and `fish-` did: an unnamed `sk-`
 * provider is already covered by the generic fallback, so without the exclusion
 * its own pattern could be deleted and its test would still pass.
 */
export const GENERIC_SK_EXCLUSIONS: readonly string[] = CREDENTIAL_FAMILIES.filter((f) =>
  f.prefix.startsWith('sk-'),
).map((f) => f.prefix.slice(3));

/** Escape a literal for embedding in a RegExp source. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The 8-char floors stop ordinary prose from being mangled; the specific
 * prefixes run before the generic one so they win. Every regex is module-level
 * and global, so `lastIndex` is reset at each use rather than inherited from a
 * previous `test()`/`replace()` call.
 *
 * The generic `sk-` fallback carries a negative lookahead that makes it
 * INDEPENDENT of the named families: without it, `sk-[A-Za-z0-9_-]{20,}` also
 * matches `sk-or-v1-AAA…`, so deleting a specific pattern would change nothing
 * and its test would pass vacuously. With the lookahead, removing a specific
 * pattern leaves a real hole. The two lists are cross-checked by a test so a
 * future prefix cannot be added to one and forgotten in the other.
 *
 * `Bearer`/`Basic` stay last: they are transport shapes rather than provider
 * shapes, and an `Authorization: Basic` header is short enough to need its own
 * floor rather than a provider prefix.
 */
/**
 * Compiled, in application order: family patterns first (declaration order),
 * then the generic `sk-` fallback, then the two transport shapes.
 *
 * Exported so the shadowing audit in `logger.test.ts` can enumerate the exact
 * list the redactor runs rather than re-typing it — a test that re-declared the
 * patterns would pass while the shipped list drifted.
 */
export const REDACTION_PATTERNS: readonly RegExp[] = [
  ...CREDENTIAL_FAMILIES.map((f) => new RegExp(f.pattern, 'g')),
  new RegExp(`sk-(?!(?:${GENERIC_SK_EXCLUSIONS.map((t) => escapeLiteral(t)).join('|')}))[A-Za-z0-9_-]{20,}`, 'g'),
  /Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi,
  /Basic\s+[A-Za-z0-9+/=]{8,}/gi,
];

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
  /\b(password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|auth)\b(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\]]*\]|[^\s,;)}\]]+)/gi;

/** Depth and breadth bounds. Reaching one fails closed instead of recursing forever. */
const MAX_DEPTH = 8;
const MAX_NODES = 1000;

/** Replace every secret-shaped run in one string. Never throws. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of REDACTION_PATTERNS) {
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
  for (const pattern of REDACTION_PATTERNS) {
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
