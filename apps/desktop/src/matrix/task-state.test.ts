// M4 C.5 Phase 1 — task-card state mapping. RED FIRST.
//
// WHY A SEPARATE PURE MODULE (and why this test file touches no React): the
// mapping is a decision about what a free-text wire string MEANS, and every way
// it can rot is a semantic rot, not a layout rot. A `render` in the same file
// would let a mapping bug hide behind a class name, and would let a class-name
// change look like a mapping change.
//
// The vocabulary tested here is NOT invented for this test. It comes from the
// tree, and the load-bearing entry is `client.ts:106` (`sessionState`): the live
// `/api/session` list row carries NO `state` field at all — it carries
// `outcome` (verified live as the literal "succeeded"), and when neither is
// present the client returns the literal "idle". So a real inventory frame
// mostly says `succeeded` or `idle`, and `idle` from that function means "we
// could not read a state", NOT "the session is resting".
//
// That single fact is why the mapping has an `unknown` arm at all, and why it
// is the DEFAULT. Colouring `idle` green would be a colour chosen by guess —
// the exact defect this item is scoped to avoid.
//
// Every guard below was broken by hand and watched fail; see the report.

import { describe, expect, test } from 'vitest';
import {
  MAX_TASK_CARDS,
  TASK_CARD_OVERFLOW_KEY,
  TASK_CHIP_CLASS,
  TASK_LABEL_AR,
  TASK_STATES,
  TASK_TONE,
  isKnownTaskState,
  queuedCard,
  taskCardsFromInventory,
  taskStateFor,
  type TaskCard,
} from './task-state.js';

/** The colour tokens the HUD already uses for meaning, not decoration. */
const SEMANTIC_COLOURS = ['#34d399', '#f87171', '#fbbf24', '#38bdf8', '#2563eb'];

describe('taskStateFor: the vocabulary that IS ours', () => {
  // Table-driven on purpose: a mapping with 20 rows must be readable as 20 rows.
  const RUNNING = ['running', 'starting', 'creating', 'working', 'busy', 'in_progress', 'in-progress'];
  const DONE = ['succeeded', 'success', 'complete', 'completed', 'done', 'finished'];
  const FAILED = ['error', 'errored', 'failed', 'failure', 'aborted', 'cancelled', 'canceled'];

  test.each(RUNNING)('%s -> running', (raw) => {
    expect(taskStateFor(raw)).toBe('running');
  });

  test.each(DONE)('%s -> done', (raw) => {
    expect(taskStateFor(raw)).toBe('done');
  });

  test.each(FAILED)('%s -> failed', (raw) => {
    expect(taskStateFor(raw)).toBe('failed');
  });

  test('case and surrounding whitespace are normalised, because identity is not a guess', () => {
    expect(taskStateFor('  RUNNING ')).toBe('running');
    expect(taskStateFor('Succeeded')).toBe('done');
  });
});

describe('taskStateFor: the vocabulary that is NOT ours', () => {
  // THE load-bearing test of the file. If `idle` ever gains a colour, this is
  // what notices, and the reason is written here so the next editor cannot
  // "tidy" it away.
  test('the client\'s own "no state readable" fallback maps to unknown, never to done', () => {
    // `client.ts:111` returns the literal 'idle' when a row has neither `state`
    // nor `outcome`. Painting that green asserts a success nobody measured.
    expect(taskStateFor('idle')).toBe('unknown');
  });

  test.each([
    ['an unrecognised future token', 'thinking-hard'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a non-string at the boundary', undefined],
    ['a number from a mis-typed producer', 7],
  ])('%s maps to unknown', (_label, raw) => {
    expect(taskStateFor(raw as unknown as string)).toBe('unknown');
  });

  test('the two MEASURED live values map as the tree says they do', () => {
    // `succeeded` is the verified-live `outcome` value.
    expect(taskStateFor('succeeded')).toBe('done');
    // `idle` is the verified-live fallback when the row carries nothing.
    expect(taskStateFor('idle')).toBe('unknown');
  });
});

describe('the chip table', () => {
  test('every task state has a distinct chip class and a non-empty Arabic label', () => {
    const classes = TASK_STATES.map((s) => TASK_CHIP_CLASS[s]);
    expect(new Set(classes).size).toBe(TASK_STATES.length);
    for (const s of TASK_STATES) {
      expect(TASK_LABEL_AR[s].trim().length).toBeGreaterThan(0);
      // The label is user-facing copy and this surface is Arabic-only.
      expect(TASK_LABEL_AR[s]).toMatch(/\p{sc=Arabic}/u);
    }
  });

  test('unknown is a NEUTRAL chip: it carries no semantic colour at all', () => {
    // Asserted on the CLASS STRING, not on a name: a test that only checked
    // `TASK_TONE.unknown === 'neutral'` would still pass if a coloured class
    // were pasted into the chip.
    expect(TASK_TONE.unknown).toBe('neutral');
    for (const colour of SEMANTIC_COLOURS) {
      expect(TASK_CHIP_CLASS.unknown).not.toContain(colour);
    }
  });

  test('the four decided states DO carry a semantic colour, so `unknown` is not just "everyone is grey"', () => {
    // Without this the test above would pass on a table where nothing is
    // coloured and `unknown` is unique by accident.
    for (const s of ['queued', 'running', 'done', 'failed'] as const) {
      expect(SEMANTIC_COLOURS.some((c) => TASK_CHIP_CLASS[s].includes(c))).toBe(true);
    }
  });

  test('isKnownTaskState is a total guard, not a truthiness check', () => {
    expect(isKnownTaskState('unknown')).toBe(true);
    expect(isKnownTaskState('toString')).toBe(false);
    expect(isKnownTaskState('constructor')).toBe(false);
  });
});

describe('taskCardsFromInventory: what the strip shows', () => {
  const row = (sessionId: string, state: string) => ({ sessionId, state });

  test('the ACTIVE session, plus every running and failed row', () => {
    const cards = taskCardsFromInventory(
      [
        row('ses_active', 'succeeded'),
        row('ses_run', 'running'),
        row('ses_fail', 'error'),
        row('ses_old', 'succeeded'),
        row('ses_mystery', 'wat'),
      ],
      'ses_active',
    );
    expect(cards.map((c) => c.key)).toEqual(['ses_active', 'ses_run', 'ses_fail']);
    expect(cards.map((c) => c.state)).toEqual(['done', 'running', 'failed']);
  });

  test('a non-active done/unknown row is omitted on purpose, and says so', () => {
    // History is already reachable through the session chip's dropdown; a strip
    // full of finished sessions is noise. The omission is documented, not silent.
    const cards = taskCardsFromInventory([row('ses_old', 'succeeded'), row('ses_x', 'wat')], 'ses_active');
    expect(cards).toEqual([]);
  });

  test('a local queued receipt is carried through and de-duplicated against a real row', () => {
    // The receipt is keyed `local`, so it can never collide with a real session
    // id; if a future phase wants to reconcile it to a real row, this is the
    // place that has to change.
    const cards = taskCardsFromInventory([row('ses_run', 'running')], null, queuedCard('افتح المنفذ'));
    expect(cards.map((c) => c.state)).toEqual(['queued', 'running']);
    expect(cards[0]?.key).toBe('local');
  });

  test('the strip is TRIMMED, and the trim is visible rather than silent', () => {
    // The lesson is `totalSessions` in `protocol.ts`: a silent trim looks
    // exactly like a small workspace.
    const many = Array.from({ length: MAX_TASK_CARDS + 7 }, (_, i) => row(`ses_${i}`, 'running'));
    const cards = taskCardsFromInventory(many, null);
    expect(cards).toHaveLength(MAX_TASK_CARDS + 1);
    const last = cards[cards.length - 1] as TaskCard;
    expect(last.key).toBe(TASK_CARD_OVERFLOW_KEY);
    // The marker is NEUTRAL, and it owns the count rather than hiding it.
    expect(last.state).toBe('unknown');
    expect(last.count).toBe(7);
    expect(cards.filter((c) => c.key !== TASK_CARD_OVERFLOW_KEY)).toHaveLength(MAX_TASK_CARDS);
  });

  test('the raw wire string is carried verbatim and never re-derived into a label', () => {
    const card = taskCardsFromInventory([row('ses_a', 'RUNNING')], null)[0] as TaskCard;
    expect(card.rawState).toBe('RUNNING');
    expect(card.state).toBe('running');
  });
});

describe('queuedCard: a LOCAL receipt, not a round-trip', () => {
  test('it is constructible from nothing but the user\'s own words', () => {
    const card = queuedCard('افتح المنفذ ٤٠٩٦') as TaskCard;
    expect(card.key).toBe('local');
    expect(card.state).toBe('queued');
    expect(card.transcript).toBe('افتح المنفذ ٤٠٩٦');
    // No session id, because at utterance time there is not one: the shell has
    // no correlation id between a transcript and a serve session. Inventing one
    // would be a fabricated server round-trip.
    expect(card.rawState).toBe('');
  });

  test('an empty transcript is a no-op, not a blank card', () => {
    expect(queuedCard('   ')).toBeNull();
  });
});
