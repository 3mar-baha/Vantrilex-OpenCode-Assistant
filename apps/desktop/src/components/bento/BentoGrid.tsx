// The bento: the base 440 × 600 layout, composed.
//
// ── WHAT THIS FILE IS FOR ────────────────────────────────────────────────────
//
// Four surfaces, one window, and a width budget that is smaller than most
// people's idea of a usable app. This composes the session bar, the task strip
// and the terminal drawer into a single column, holds the height budget, and
// applies the reconnect block. It is deliberately NOT the HUD: the action
// surface (the mic control, the wave, the mute toggles) belongs to `App`, so
// that lands as `children` in a slot this grid can BLOCK without owning.
//
// ── THE HEIGHT BUDGET IS THE WHOLE REASON THE DRAWER IS COLLAPSIBLE ─────────
//
// The window used to size itself to its content, so an in-flow element that grew
// with the log just made the window taller and nothing had to be bounded. It does
// not any more: `tauri.conf.json` now sets `minWidth: 440` / `minHeight: 600` and
// `resizable: true`, so the frame is at least 600 px tall forever and only grows
// when the user drags it.
//
// The consequence is that "let the drawer expand" now means "expand INSIDE the
// window", and that is a real layout obligation, not a slogan:
//
//   · the root is `flex h-full min-h-0 flex-col` — `min-h-0` on every flex child
//     in the chain is what actually allows a child to SHRINK below its content
//     size. Without it a flex child refuses to shrink and the column overflows
//     the window, which is the same defect as the horizontal overflow the
//     440 px audit guards, on the other axis.
//   · the scrollable middle carries `flex-1 min-h-0 overflow-y-auto`, so
//     overflow goes to a SCROLL CONTAINER the user owns rather than to the
//     window frame they did not ask to resize.
//   · the drawer itself is capped (`max-h-[220px]`, and a fixed-height rail when
//     closed), so it takes a bounded slice of the middle region and cannot
//     become the entire window.
//
// ── WHY NOTHING HERE FIXES A WIDTH ───────────────────────────────────────────
//
// Deliberately no `w-[440px]` and no `overflow-x-hidden` on the root. The first
// would break the moment the user drags the window wider — the bento has to fill
// whatever it is given — and the second would MASK horizontal overflow rather
// than prevent it, which would make the 440 px audit in `layoutBudget.ts` pass
// by hiding the thing it exists to catch. If a future change needs clipping to
// make the audit green, the layout is wrong and the clipping is the bug.
// ── THE BLOCK IS SCOPED, AND THE ESCAPE SLOT IS WHY ───────────────────────────
//
// `actionsBlocked(state)` returns `state.dropped` and this file used to put the
// result on ONE `inert` attribute around the whole action surface. `inert` is
// INHERITED: a descendant of an inert node is inert, and nothing can re-enable
// it. So the block took out the STOP control along with the microphone — and
// `src/runtime/serve-health.ts` says in its own words that this is the failure
// the allowlist exists to prevent: blocking `abort` would "strand a mid-utterance
// user behind a dead port with no way to make it stop". The daemon would have
// let that `abort` through; the renderer made it unclickable. Both agents were
// right about their own layer, and the user lost the one control the outage did
// not take away.
//
// The fix is structural rather than conditional, because a conditional is a
// blocklist and a blocklist drifts. `escape` is a SIBLING slot, rendered outside
// the `inert` subtree, and it is always live: there is no `inert` check on it,
// so no serve state can disable the escape controls — including one nobody has
// written yet.
//
// WHAT GOES IN EACH SLOT, and the rule:
//
//   blocked — controls that CONFIGURE OR START a turn. A dead 4096 means the
//             turn cannot complete, so pressing these is the false affordance
//             the block exists to remove.
//   escape  — controls whose only purpose is to STOP, CANCEL or SILENCE what is
//             already happening. Nothing they do needs the port.
//
// The line is drawn at the AFFORDANCE rather than at the command kind, and that
// departure is worth stating plainly: `deafen` is on the daemon's allowlist and
// the microphone is still blocked. Whether a command is honoured is a transport
// fact; "speak and OpenCode will answer" is the affordance, and the affordance
// is what a dead port breaks. What the mirror in `serve-health-signal.ts` pins
// is the property that matters at THIS boundary — every control in the escape
// slot sends a daemon-local command, or none at all — and `App.escape.test.tsx`
// clicks them all and checks.
import { ReconnectBanner, actionsBlocked, type ReconnectState } from './ReconnectBanner.js';
import { SessionBar } from '../session/SessionBar.js';
import { TaskCards } from '../session/TaskCards.js';
import { TerminalDrawer, type TerminalLine } from '../terminal/TerminalDrawer.js';
import { BENTO_BASE_HEIGHT_PX, BENTO_BASE_WIDTH_PX } from './layoutBudget.js';
import type { TaskCard } from '../../matrix/task-state.js';
import type { ChipSession } from '../session/SessionChip.js';

export interface BentoGridProps {
  readonly sessions: readonly ChipSession[];
  readonly activeSessionId: string | null;
  readonly onSelectSession: (id: string) => void;
  readonly taskCards: readonly TaskCard[];
  readonly terminalOpen: boolean;
  readonly onToggleTerminal: (next: boolean) => void;
  readonly terminalLines: readonly TerminalLine[];
  readonly reconnect: ReconnectState;
  readonly onDismissReconnect: () => void;
  readonly reconnectDetailAr?: string;
  /** The mic control / wave / persona. `App` owns these. */
  readonly children?: React.ReactNode;
  /**
   * The escape controls: stop, cancel, silence. Rendered OUTSIDE the blocked
   * slot and never `inert`, in every serve state. Optional, and a grid rendered
   * without one behaves exactly as it did before.
   */
  readonly escape?: React.ReactNode;
}

export function BentoGrid({
  sessions,
  activeSessionId,
  onSelectSession,
  taskCards,
  terminalOpen,
  onToggleTerminal,
  terminalLines,
  reconnect,
  onDismissReconnect,
  reconnectDetailAr,
  children,
  escape,
}: BentoGridProps): JSX.Element {
  const blocked = actionsBlocked(reconnect);
  const actionSlotRef = (el: HTMLDivElement | null): void => {
    if (el === null) return;
    // `inert` is the real mechanism, not a decoration: in a WebView2/Chromium
    // host it removes the subtree from the accessibility tree AND blocks focus,
    // pointer and click on it. `aria-hidden` alone hides it from a screen reader
    // while leaving every button still pressable, which is the "merely warns"
    // failure this component exists to avoid. `setAttribute` rather than the
    // `inert` IDL property, so it does not depend on the DOM lib typing it.
    if (blocked) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  };

  return (
    <div
      data-testid="bento-grid"
      data-base-width={String(BENTO_BASE_WIDTH_PX)}
      data-base-height={String(BENTO_BASE_HEIGHT_PX)}
      dir="rtl"
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-[#141413] text-[#f4f4f5]"
    >
      <ReconnectBanner
        state={reconnect}
        onDismiss={onDismissReconnect}
        {...(reconnectDetailAr !== undefined ? { detailAr: reconnectDetailAr } : {})}
      />

      {/* The action surface. `min-h-0` so it can yield, and `ref`d so the
          blocker is the real `inert` attribute rather than a class that only
          looks disabling. */}
      <div
        ref={actionSlotRef}
        data-testid="bento-actions"
        data-blocked={String(blocked)}
        className={`flex min-h-0 shrink-0 flex-col px-4 py-3 ${blocked ? 'pointer-events-none opacity-50' : ''}`}
      >
        {children}
      </div>

      {/* The escape slot. A SIBLING of the blocked slot, never a child, and it
          carries no `inert` and no `pointer-events-none` in any state - so the
          stop and silence controls cannot be taken away by a serve outage. See
          the header: this is the fix for the two agents disagreeing, and it is
          structural because the alternative (a conditional) is a blocklist. */}
      {escape !== undefined && escape !== null && (
        <div
          data-testid="bento-escape"
          className="flex min-h-0 min-w-0 shrink-0 items-center justify-center gap-3 px-4 pb-3"
        >
          {escape}
        </div>
      )}

      {/* The scrollable middle. `flex-1 min-h-0` is the pair that makes the
          column fit 600 px: `flex-1` claims the slack, `min-h-0` allows the
          box to be smaller than its content, and the overflow lands here. */}
      <div
        data-testid="bento-scroll"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
      >
        <SessionBar
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={onSelectSession}
        />
        <TaskCards cards={taskCards} />
        <TerminalDrawer
          open={terminalOpen}
          onToggle={onToggleTerminal}
          lines={terminalLines}
        />
      </div>
    </div>
  );
}
