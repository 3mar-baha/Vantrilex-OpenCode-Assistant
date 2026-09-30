// HEADLESS REPORT — one print layer, used by every subcommand.
//
// The rule this file exists to enforce: a number is printed next to the module it
// came from, and an absence is printed as an absence. There is no branch anywhere
// below that formats a missing value as `0`, `ok` or `unknown` on its own — those
// all have to be asked for by name, so a reader can tell a measured zero from a
// value nobody looked up.

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const CYAN = '\u001b[36m';

function paint(text: string, code: string): string {
  return process.stdout.isTTY === true ? `${code}${text}${RESET}` : text;
}

export function heading(text: string): void {
  console.log('');
  console.log(paint(text, CYAN));
  console.log(paint('─'.repeat(Math.min(text.length + 4, 78)), DIM));
}

export function field(label: string, value: string): void {
  // 26, not 22: `return { kind: 'proceed'` is 24 characters and a label that
  // overflows its column collides with its value, which is the one way a report
  // can print a count and a reader cannot tell which is which.
  console.log(`  ${label.padEnd(26)}${value}`);
}

export function note(text: string): void {
  console.log(paint(`  ${text}`, DIM));
}

export function warnLine(text: string): void {
  console.log(paint(`  ! ${text}`, YELLOW));
}

export function pass(text: string): void {
  console.log(paint(`  PASS  ${text}`, GREEN));
}

export function fail(text: string): void {
  console.log(paint(`  FAIL  ${text}`, RED));
}

export function verdict(ok: boolean, text: string): void {
  if (ok) pass(text);
  else fail(text);
}

/** One row per provenance line. Prints a claim only when the value exists. */
export function source(modulePath: string, detail: string): void {
  field('module', `${modulePath} — ${detail}`);
}

export function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** A bounded one-liner for a string that may be long or non-ASCII. */
export function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * THE TRUTH LINE for a dispatch. Extracted from the printer so it can be guarded.
 *
 * This is the single most important string in the runner, because it is the one
 * place where a report could describe work that did not happen. There are exactly
 * three states and no fourth:
 *
 *   `NOTHING`            — `deps.dispatch` was never called. The gate refused, the
 *                          plan was invalid, or there was no session.
 *   `ATTEMPTED, FAILED`  — the call was made and threw. Serve never acknowledged it.
 *   `DELIVERED`          — the call returned. With the receipt serve sent.
 *
 * Anything that would render a refusal, a transport failure or an absent ledger as
 * a success is not representable here, and `dispatch.test.ts` breaks each of the
 * three to prove the mapping is not doing its job by accident.
 */
export interface DispatchTruth {
  /** The word that goes in the report. Never `ok`, never `success`. */
  readonly headline: 'NOTHING' | 'ATTEMPTED, FAILED' | 'DELIVERED';
  /** A sentence naming WHY, chosen from the facts available. */
  readonly why: string;
  /** False for anything other than a delivered dispatch. Drives the exit code. */
  readonly ok: boolean;
}

export function dispatchTruth(input: {
  readonly attempts: number;
  readonly delivered: number;
  readonly failure: string | null;
  readonly resultDetail: string | null;
  readonly needsPermission: boolean;
}): DispatchTruth {
  if (input.attempts === 0) {
    return {
      headline: 'NOTHING',
      // `refused` rather than `skipped`: a turn that ends without a dispatch is
      // the gate doing its job, and calling it skipped would report a product
      // decision as an omission by the harness.
      why:
        input.resultDetail ??
        (input.needsPermission ? 'permission required, not granted' : 'the chain never reached a dispatch'),
      ok: false,
    };
  }
  if (input.delivered === 0) {
    return { headline: 'ATTEMPTED, FAILED', why: input.failure ?? 'the dispatch call threw with no error message', ok: false };
  }
  if (input.delivered < input.attempts) {
    return { headline: 'ATTEMPTED, FAILED', why: `${input.attempts - input.delivered} of ${input.attempts} attempts did not land`, ok: false };
  }
  if (input.delivered > input.attempts) {
    // An IMPOSSIBLE ledger: more deliveries than attempts means the counts came
    // from somewhere other than the dispatch records, and a report built on them
    // would be describing work it has no record of. Fail closed on the same state
    // as a partial delivery rather than adding a fourth headline.
    return {
      headline: 'ATTEMPTED, FAILED',
      why: `INCONSISTENT LEDGER — ${input.delivered} deliveries recorded against ${input.attempts} attempts; the counts are not from the dispatch ledger`,
      ok: false,
    };
  }
  return { headline: 'DELIVERED', why: `${input.delivered} of ${input.attempts} attempts acknowledged by serve`, ok: true };
}
