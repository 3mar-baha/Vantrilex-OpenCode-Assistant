// M4 C.5 Phase 1 — task-card state mapping. Pure: no React, no DOM, no I/O.
// Local precedent for a renderer-pure helper is `looksNonArabic` in this folder.
//
// ── WHY INVENTORY AND NOT `event` ────────────────────────────────────────────
// The `event` frame has ZERO production producers: `broadcast()` in
// `src/ipc/ui-server.ts` is called only by tests and the E2E stub. A card strip
// driven by `event` would be a green test over a call the daemon never makes —
// the exact "green tests beside dead production" trap. `inventory` is different
// and that difference is the whole reason this item is scoped to it: the daemon
// really does publish it, from two live sources (`publishSessions` in
// `daemon.ts` on a 15 s interval, and `SessionInventory`'s own 15 s poll through
// `ui.publishInventory`), both reading the serve API through `ServeClient`.
//
// Phase 2 adds the `event` caller in the daemon (M2 producer). Until then there
// is deliberately NO `event` input here, and no test pretending to one.
//
// ── WHAT AN INVENTORY SNAPSHOT CAN AND CANNOT TELL YOU ───────────────────────
// The row is `{ sessionId, state }` where `state` is `z.string().min(1)` — an
// OPEN string, deliberately, because it belongs to OpenCode, not to us.
//
// IT CAN tell you:
//   · which sessions the daemon can enumerate, as of the moment it polled;
//   · one free-text state token per session.
//
// IT CANNOT tell you:
//   · PROGRESS. There is no percentage, no step, no elapsed time anywhere in the
//     frame. A snapshot is a LEVEL, not a rate: `running` means "running at the
//     poll", never "60% through".
//   · FRESHNESS. The row carries no timestamp — the client's `SessionInfo` has
//     `time.updated`, and `buildInventoryFrame` drops it. The frame's `seq` is
//     a position in the resume space, not a clock. So `running` can be up to
//     ~15 s stale: a session that finished 200 ms after the poll keeps reading
//     `running` until the next tick, and a card that has gone green is not
//     evidence it is still working.
//   · WHICH SESSION YOUR LAST UTTERANCE BECAME. There is no correlation id
//     between a transcript and a serve session anywhere in the frame. This is
//     the reason the `queued` receipt below is local and is never reconciled to
//     a row by guessing.
//   · WHAT THE STATE MEANS. The vocabulary is OpenCode's and it is free text.
//
// ── THE MEASURED VOCABULARY, AND WHY `unknown` IS THE DEFAULT ────────────────
// `ServeClient.sessionState` (`src/runtime/client.ts:106`) is the load-bearing
// line: the live `/api/session` list row carries NO `state` field. It carries
// `outcome` — verified live as the literal `"succeeded"` — and when neither
// `state` nor `outcome` is present the function returns the literal `"idle"`.
//
// So in production most rows arrive as `succeeded` or `idle`, and the `idle`
// half of that is the client's own "I could not read a state" fallback, NOT
// OpenCode's "the session is resting". Mapping `idle` onto a green `done` chip
// would assert a success nobody measured — a colour chosen by guess, which is
// the one thing this item forbids. `idle` therefore lands in `unknown` and
// renders NEUTRAL.
//
// The honest consequence, stated rather than discovered later: on a real
// workspace this strip is frequently neutral. That is the correct reading of an
// open vocabulary, not a bug, and the alternative — inventing a confident colour
// for a string nobody has measured — is the defect.
//
// Case and whitespace are normalised because identity is not a guess; nothing
// else is. A token this file does not recognise stays `unknown` instead of
// being folded into the nearest arm.

/** What a card can say. `queued` is the ONLY locally-synthesised arm. */
export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'unknown';

/** The four arms an `inventory` row can map to. `queued` is never derived. */
export type InventoryTaskState = Exclude<TaskState, 'queued'>;

/**
 * Visual weight, and the vocabulary a test may assert on a rendered chip.
 * `neutral` is reserved for "we do not know", which is why it is a separate
 * value rather than a fifth colour.
 */
export type TaskTone = 'pending' | 'busy' | 'good' | 'bad' | 'neutral';

/** Every arm, in the order a reader meets them. Also the exhaustiveness gate. */
export const TASK_STATES: readonly TaskState[] = ['queued', 'running', 'done', 'failed', 'unknown'];

// The recognised vocabulary, and NOTHING else. The `done` set is anchored on
// `succeeded` because that is the value verified live out of `/api/session`;
// the rest are the same words OpenCode's own session lifecycle uses, listed so
// a build that starts sending them does not paint everything neutral. Adding a
// token here is a claim someone has to have measured — that is the cost.
const RUNNING_TOKENS: ReadonlySet<string> = new Set([
  'running',
  'starting',
  'creating',
  'working',
  'busy',
  'in_progress',
  'in-progress',
]);
const DONE_TOKENS: ReadonlySet<string> = new Set([
  'succeeded',
  'success',
  'complete',
  'completed',
  'done',
  'finished',
]);
const FAILED_TOKENS: ReadonlySet<string> = new Set([
  'error',
  'errored',
  'failed',
  'failure',
  'aborted',
  'cancelled',
  'canceled',
]);

/**
 * Map one raw `inventory` state token to a card state.
 *
 * Never throws and never returns `queued`: that arm is synthesised locally and
 * reaching it from the wire would mean the daemon and the shell disagreed about
 * what a card is.
 *
 * @param raw the `state` string from an `inventory` row; a non-string is
 *   treated as absent, because the bridge boundary is a runtime check and a
 *   mis-typed producer must not crash the HUD.
 */
export function taskStateFor(raw: string): InventoryTaskState {
  if (typeof raw !== 'string') return 'unknown';
  const token = raw.trim().toLowerCase();
  if (token.length === 0) return 'unknown';
  if (RUNNING_TOKENS.has(token)) return 'running';
  if (DONE_TOKENS.has(token)) return 'done';
  if (FAILED_TOKENS.has(token)) return 'failed';
  // Everything else, `idle` FIRST among them, is `unknown`. See the header.
  return 'unknown';
}

/** Total guard, not truthiness — `isKnownTaskState('toString')` must be false. */
export function isKnownTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

/**
 * The chip class per arm. This is the whole point of the module: `unknown` owns
 * a grey that appears NOWHERE in the semantic set, so a test can assert the
 * absence of a meaning rather than the presence of a name.
 *
 * Colours are the HUD's existing tokens (`#34d399` success, `#f87171` danger,
 * `#fbbf24` waiting, `#38bdf8` active) plus `#a1a1aa`/`#26282e`, which are
 * already this HUD's muted pair and carry no verdict.
 */
export const TASK_CHIP_CLASS: Readonly<Record<TaskState, string>> = {
  // "We sent it and have no evidence yet" — a local fact, not a verdict, and
  // deliberately not green.
  queued: 'rounded-[6px] border border-[#fbbf24]/40 bg-[#0e0f12] px-1.5 py-0.5 text-[10px] text-[#fbbf24]',
  running: 'rounded-[6px] border border-[#38bdf8]/40 bg-[#0b1418] px-1.5 py-0.5 text-[10px] text-[#38bdf8]',
  done: 'rounded-[6px] border border-[#34d399]/40 bg-[#0c1512] px-1.5 py-0.5 text-[10px] text-[#34d399]',
  failed: 'rounded-[6px] border border-[#f87171]/40 bg-[#1a1012] px-1.5 py-0.5 text-[10px] text-[#f87171]',
  // NEUTRAL. No semantic token appears here, and a test asserts exactly that.
  unknown: 'rounded-[6px] border border-[#26282e] bg-[#0e0f12] px-1.5 py-0.5 text-[10px] text-[#a1a1aa]',
};

export const TASK_TONE: Readonly<Record<TaskState, TaskTone>> = {
  queued: 'pending',
  running: 'busy',
  done: 'good',
  failed: 'bad',
  unknown: 'neutral',
};

/** Arabic label per arm. The wire token itself is NEVER shown as a label. */
export const TASK_LABEL_AR: Readonly<Record<TaskState, string>> = {
  queued: 'في الانتظار',
  running: 'جارٍ التنفيذ',
  done: 'اكتملت',
  failed: 'فشلت',
  unknown: 'غير معروف',
};

/** One rendered row. Nothing here is a control: a card is not clickable. */
export interface TaskCard {
  /** Stable React key. `local` for the receipt, a session id, or the marker. */
  readonly key: string;
  readonly state: TaskState;
  /** The wire token, verbatim and untouched. Present only on a real row. */
  readonly rawState: string;
  /** The user's own words. Present only on the local receipt. */
  readonly transcript?: string;
  /** How many rows the trim dropped. Present only on the overflow marker. */
  readonly count?: number;
}

/** The local receipt's key. Cannot collide with a `ses_`-prefixed id. */
export const LOCAL_TASK_KEY = 'local';

/** The key of the "…and N more" row, so a trim is never silent. */
export const TASK_CARD_OVERFLOW_KEY = 'overflow';

/**
 * Rows the strip will render before it trims. The strip is 88px tall, so this
 * is a DOM-size guard, not a display budget — the box scrolls.
 */
export const MAX_TASK_CARDS = 24;

/**
 * The scroll box height, in pixels. Duplicated as an inline style at the render
 * site so a test can read a RESOLVED value; happy-dom has no layout engine, so
 * `scrollHeight` is always 0 there and the bound cannot be proven by measuring.
 * The Tailwind `max-h-[88px]` class ships alongside it for the real renderer.
 *
 * WHY IT IS BOUNDED AT ALL, in one sentence: the window AUTO-SIZES to its
 * content (`useAutoSize` measures the root's `scrollHeight`), so an in-flow
 * element that grows with the session list resizes the OS window on every 15 s
 * tick, forever, with no user action.
 */
export const TASK_STRIP_MAX_HEIGHT_PX = 88;

/**
 * The local `queued` receipt — a DISPLAY-ONLY card placed the moment the daemon
 * reports the turn has started (`voice` phase `thinking`, carrying the user's
 * transcript).
 *
 * It is constructible from nothing but the user's own words, and that is the
 * design: at utterance time the shell has no session id for the turn, because
 * nothing in the frame correlates a transcript to a serve session. Inventing one
 * would be a fabricated server round-trip, which is the failure this item is
 * scoped to prevent. So the receipt is keyed `local`, emits no command, and is
 * retired by the next non-empty snapshot (or by any later `voice` phase) rather
 * than being reconciled to a row by guesswork.
 *
 * @returns the card, or `null` for a blank transcript — a no-op beats a card
 *   with nothing in it.
 */
export function queuedCard(transcript: string): TaskCard | null {
  if (typeof transcript !== 'string' || transcript.trim().length === 0) return null;
  return { key: LOCAL_TASK_KEY, state: 'queued', rawState: '', transcript };
}

/** One `inventory` row, shaped as the bridge hands it over. */
export interface InventoryRow {
  readonly sessionId: string;
  readonly state: string;
}

/**
 * The rows worth a card, in producer order, plus the local receipt first.
 *
 * THE FILTER, and it is a judgement worth stating: the ACTIVE session always
 * gets a card, and so does every session that is `running` or `failed` — a
 * non-active `done` or `unknown` row is omitted, because finished history is
 * already reachable through the session chip's dropdown and a strip full of it
 * is noise. The omission is deliberate and documented here, not silent.
 *
 * The trim keeps the HEAD, for the same reason `buildInventoryFrame` does: the
 * producer's order is the daemon's inventory order, so the head is what the
 * daemon already considered front-of-house. A tail or a sort would silently
 * change which sessions a user sees. The dropped count is emitted as a visible
 * marker row, because the lesson of `totalSessions` in `protocol.ts` is that a
 * silent trim is indistinguishable from a small workspace.
 *
 * @param sessions the raw snapshot, untouched.
 * @param activeId the shell's active session, or null.
 * @param receipt the local `queued` card, if one is live.
 */
export function taskCardsFromInventory(
  sessions: readonly InventoryRow[],
  activeId: string | null,
  receipt: TaskCard | null = null,
): TaskCard[] {
  const cards: TaskCard[] = [];
  if (receipt !== null) cards.push(receipt);

  // Rows emitted, counted SEPARATELY from the receipt: the receipt is a local
  // card, not a session, and it must not eat one of the row budget.
  let emitted = 0;
  let dropped = 0;
  for (const row of sessions) {
    if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) continue;
    const state = taskStateFor(row.state);
    const isActive = row.sessionId === activeId;
    if (!isActive && state !== 'running' && state !== 'failed') continue;
    if (emitted >= MAX_TASK_CARDS) {
      dropped += 1;
      continue;
    }
    emitted += 1;
    cards.push({ key: row.sessionId, state, rawState: row.state });
  }

  if (dropped > 0) {
    cards.push({ key: TASK_CARD_OVERFLOW_KEY, state: 'unknown', rawState: '', count: dropped });
  }
  return cards;
}
