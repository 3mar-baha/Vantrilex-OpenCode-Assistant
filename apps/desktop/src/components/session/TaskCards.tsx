// The task-card strip as a COMPONENT, extracted from `App.tsx`'s inline JSX.
//
// ── WHY THIS EXISTS AND WHY IT IS NOT A SECOND TASK LIST ─────────────────────
//
// `matrix/task-state.ts` is the single owner of the task vocabulary: the
// `queued → running → done | failed | unknown` mapping, the Arabic labels, the
// chip classes and the trim policy. This file adds NO state logic of its own —
// it imports that module and renders what it already decided. A second mapper
// would be the exact defect the header of `task-state.ts` warns about twice
// (an open vocabulary folded into a nearest arm by guesswork), so there is
// deliberately no local `switch` on state anywhere in this file.
//
// THE DOM CONTRACT IS PINNED BY AN EXISTING SUITE, and that is the reason the
// markup below looks like a transcription rather than a design. `App` renders
// this strip today (`data-testid="task-strip"`, `[data-task-card]`,
// `[data-testid="task-chip"]`, and `chip.className === TASK_CHIP_CLASS[state]`),
// and `App.task-cards.test.tsx` asserts all of it against the mounted `App`.
// So this component reproduces those attributes exactly and the wiring wave can
// swap one for the other without that suite noticing. Changing an attribute
// here is a breaking change to a tested contract, not a local refactor.
//
// ── THE ONE THING THIS ADDS: STATE WITHOUT COLOUR ────────────────────────────
//
// The brief requires that a card's state be legible without colour, because
// colour-only state is unreadable to a red-green colourblind reader and
// illegible in a 440 px window. The existing chip was already colour + an
// Arabic word (good), and this component adds a third, independent channel: a
// per-state GLYPH whose silhouette differs by FILL or by an unrelated outline —
//
//     queued   ○  hollow ring     (nothing has happened)
//     running  ◐  half ring       (in progress)
//     done     ●  full disc       (complete)
//     failed   ✕  cross           (a silhouette found in no other arm)
//     unknown  ?  question       (a silhouette found in no other arm)
//
// `✕` and `?` are distinguishable from every other arm in pure greyscale and
// under any colour vision; `○`/`◐`/`●` differ by FILL, which survives
// greyscale because it is a coverage difference and not a hue difference. The
// glyph is `aria-hidden`, because the Arabic word is the accessible name and
// reading "circle في الانتظار" aloud would be noise, not information.
//
// The chip's own class string is passed through UNCHANGED from
// `TASK_CHIP_CLASS`, because `App.task-cards.test.tsx` asserts class equality —
// so the glyph is a child, never a class on the chip.
import {
  LOCAL_TASK_KEY,
  TASK_CARD_OVERFLOW_KEY,
  TASK_CHIP_CLASS,
  TASK_LABEL_AR,
  TASK_STRIP_MAX_HEIGHT_PX,
  TASK_TONE,
  type TaskCard,
  type TaskState,
} from '../../matrix/task-state.js';

/**
 * The shape channel. Keyed by `TaskState`, so adding an arm to
 * `task-state.ts` without a glyph here is a COMPILE error rather than a card
 * that silently loses its non-colour channel.
 */
export const TASK_GLYPH: Readonly<Record<TaskState, string>> = {
  queued: '○',
  running: '◐',
  done: '●',
  failed: '✕',
  unknown: '?',
};

export interface TaskCardsProps {
  /** Pre-mapped cards, from `taskCardsFromInventory` or `queuedCard`. */
  readonly cards: readonly TaskCard[];
}

/**
 * @returns the strip, or `null` when there is nothing to show. NOT an empty
 *   box: an empty in-flow element still takes a row of the HUD's height for
 *   every user with no live work, which is most of them.
 */
export function TaskCards({ cards }: TaskCardsProps): JSX.Element | null {
  if (cards.length === 0) return null;

  return (
    <div
      data-testid="task-strip"
      dir="rtl"
      title="حالة المهام — محدّثة كل ١٥ ثانية"
      // BOUNDED, and the bound is load-bearing. It was originally load-bearing
      // because the window auto-sized to `scrollHeight`; it is now load-bearing
      // because the window has a fixed 600 px minimum and a drawer that has to
      // fit inside it. Either way an unbounded in-flow list is a defect, so the
      // rows live INSIDE this scroll container.
      //
      // The inline `maxHeight` duplicates the Tailwind class on purpose: the
      // class is what the real renderer compiles, and the inline value is what
      // a test can read as a RESOLVED style.
      className={`max-h-[${TASK_STRIP_MAX_HEIGHT_PX}px] overflow-y-auto rounded-[6px] border border-[#26282e] bg-[#0e0f12] p-1`}
      style={{ maxHeight: TASK_STRIP_MAX_HEIGHT_PX }}
    >
      {cards.map((card) => (
        <div
          key={card.key}
          data-task-card=""
          data-task-key={card.key}
          data-state={card.state}
          data-tone={TASK_TONE[card.state]}
          // Arabic, and the raw wire token goes in the title so the verdict is
          // auditable on hover without a second wording of it.
          title={`${TASK_LABEL_AR[card.state]}${
            card.key === LOCAL_TASK_KEY || card.key === TASK_CARD_OVERFLOW_KEY ? '' : ` — ${card.rawState}`
          }`}
          className="flex items-center gap-2 px-1 py-0.5"
        >
          {card.key === TASK_CARD_OVERFLOW_KEY ? (
            <span className="truncate text-[10px] text-[#71717a]">
              {card.count ?? 0} جلسة أخرى غير معروضة
            </span>
          ) : (
            <>
              {/* The label carries the long Arabic string. `min-w-0` on a flex
                  child is what lets `truncate` actually engage — without it the
                  item refuses to shrink below its content and pushes the row,
                  and then the window, wider. This is the 440 px mechanism. */}
              <span className="vx-mono-metric min-w-0 flex-1 truncate text-[10px] text-[#a1a1aa]">
                {card.key === LOCAL_TASK_KEY ? (card.transcript ?? '') : card.key}
              </span>
              <span
                data-testid="task-chip"
                data-tone={TASK_TONE[card.state]}
                data-glyph={TASK_GLYPH[card.state]}
                className={TASK_CHIP_CLASS[card.state]}
              >
                <span aria-hidden className="me-1">
                  {TASK_GLYPH[card.state]}
                </span>
                {TASK_LABEL_AR[card.state]}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
