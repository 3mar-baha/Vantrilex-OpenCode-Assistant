// The session bar: current session by name, the others one tap away.
//
// ── WHY THIS COMPOSES `SessionChip` INSTEAD OF REPLACING IT ──────────────────
//
// `SessionChip` is the canonical session switcher and it is already wired at
// `App.tsx:709`. It owns the full list, the dropdown, outside-click dismissal
// and Escape dismissal, and — importantly for a window with a fixed minimum —
// it renders the list in a floating overlay so the history can never stretch
// the layout (that is what its `.vx-session-bar` 48 px ceiling is for). This
// component does not re-implement any of that, and it does NOT define a second
// shape for a session row: the type it consumes is `SessionChip`'s own exported
// `ChipSession`, so a session is one object with one identity across the HUD.
//
// The two surfaces are DELIBERATELY different affordances over the same data,
// and the overlap is intentional rather than accidental:
//
//   · the TAB ROW is direct access — every session you might switch to is a
//     single tap, with no menu to open first. It is the fast path for the 2–4
//     sessions a person actually alternates between.
//   · `SessionChip`'s DROPDOWN is the complete set, unbounded by the tab
//     budget, for the long tail.
//
// If there were only the tabs, a workspace with nine sessions would hide five
// behind a budget; if there were only the dropdown, every switch costs two
// taps. The tab budget is a DISPLAY budget and the overflow is stated out loud
// (the `+N` chip) rather than silently trimmed — the `totalSessions` lesson
// from `protocol.ts`, applied to a surface I own instead of a frame I don't.
//
// ── WHY TABS ARE A CONTROL AND CARDS ARE NOT ─────────────────────────────────
//
// A tab calls `onSelect` and is a real button. A task card renders state and
// is not clickable — `App.task-cards.test.tsx` asserts no card contains a
// button, and that asymmetry is deliberate: a card is a report, a tab is a
// destination. Do not "helpfully" make the cards clickable.
import { SessionChip, type ChipSession } from './SessionChip.js';

export interface SessionBarProps {
  /** Every session, exactly as `SessionChip` takes them. */
  readonly sessions: readonly ChipSession[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  /**
   * How many tabs to show. This is a WIDTH budget, not a list limit: the tabs
   * are one horizontally-scrolling row, so a larger value is safe on a wide
   * window and the 440 px base is what this number has to respect. Default 3
   * fits a 440 px row with the `+N` chip visible alongside.
   */
  readonly maxVisibleTabs?: number;
}

/** Default tab budget at the 440 px base width. */
export const DEFAULT_MAX_VISIBLE_TABS = 3;

export function SessionBar({
  sessions,
  activeId,
  onSelect,
  maxVisibleTabs = DEFAULT_MAX_VISIBLE_TABS,
}: SessionBarProps): JSX.Element {
  const active = sessions.find((s) => s.id === activeId) ?? null;
  const activeLabel = active !== null ? active.id : (activeId ?? 'لا جلسة');

  // The active session is named above, so it does not need a tab of its own;
  // a tab for the session already in front of you is a no-op control.
  const others = sessions.filter((s) => s.id !== activeId);
  const budget = Math.max(0, maxVisibleTabs);
  const shown = others.slice(0, budget);
  const hidden = others.length - shown.length;

  return (
    <section
      data-testid="session-bar"
      dir="rtl"
      aria-label="شريط الجلسات"
      className="flex min-w-0 flex-col gap-1"
    >
      {/* The canonical switcher, untouched. It is the only element in the bar
          that knows the full list, and it stays mounted and reachable whatever
          the tab budget does — which is why a trimmed tab row can never hide a
          session. */}
      <SessionChip sessions={sessions} activeId={activeId} onSelect={onSelect} />

      <div className="flex min-w-0 items-center gap-1">
        <h2
          data-testid="session-bar-current"
          title={`الجلسة الحالية: ${activeLabel}`}
          className="vx-mono-metric min-w-0 flex-1 truncate text-xs text-[#f4f4f5]"
        >
          {activeLabel}
        </h2>

        {/* One row, scrolls sideways, never wraps. `overflow-x-auto` on a
            `min-w-0` flex child is what keeps 12 sessions from becoming 12
            rows of window height — the same containment argument as the task
            strip, on the other axis. */}
        <div
          data-testid="session-tabs"
          role="tablist"
          aria-label="جلسات أخرى"
          className="flex min-w-0 shrink items-center gap-1 overflow-x-auto"
        >
          {shown.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              data-testid={`session-tab-${s.id}`}
              aria-selected={false}
              title={`تبديل إلى الجلسة ${s.id} (${s.state})`}
              onClick={() => onSelect(s.id)}
              className="vx-mono-metric max-w-[140px] shrink-0 truncate rounded-[6px] border border-[#26282e] bg-[#0e0f12] px-2 py-1 text-[10px] text-[#a1a1aa] hover:border-[#2563eb] hover:text-[#f4f4f5]"
            >
              {s.id}
            </button>
          ))}

          {/* The trim is SHOWN. A silent trim is indistinguishable from a
              workspace that only has three other sessions. */}
          {hidden > 0 && (
            <span
              data-testid="session-tabs-overflow"
              title={`${hidden} جلسة أخرى في القائمة المنسدلة`}
              className="vx-mono-metric shrink-0 truncate rounded-[6px] border border-[#26282e] px-2 py-1 text-[10px] text-[#71717a]"
            >
              +{hidden}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
