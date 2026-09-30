// The amber reconnect banner — for `serve` on 4096 dropping.
//
// ── THE REQUIREMENT THAT DECIDES THE DESIGN ─────────────────────────────────
//
// "Dismissible-but-persistent enough to stay honest, and must BLOCK the action
// surface rather than merely warn." Those two clauses pull against each other,
// and the tension is the design:
//
//   · If dismissal freed the actions, one click would make a broken HUD look
//     healthy and every action would fail against a dead 4096. That is the
//     false affordance `protocol.ts` keeps warning about — a surface that reads
//     as live when it is not.
//   · If dismissal did nothing, there is no dismissal, and a banner the user
//     cannot close is the thing people stop reading.
//
// So dismissal governs the WORDS and never the CONSEQUENCE:
//
//   `actionsBlocked(state) === state.dropped`
//
// …regardless of `dismissed`. Closing the banner hides the explanation; it does
// not unlock a dead port. The arm is tested directly, because that single
// asymmetry is the whole component and it is invisible in a screenshot.
//
// ── WHY A STATE MACHINE AND NOT A BOOLEAN ────────────────────────────────────
//
// The other half of the requirement is that a dismissal must not be permanent —
// otherwise "close it" is a lie in the other direction and the next outage is
// silent. So the state is a small pure reducer keyed on an OUTAGE EPISODE, and
// the rule is: a dismissal is scoped to the episode that was dismissed, and the
// NEXT drop re-arms. No `setTimeout`, so nothing re-appears while the same
// outage continues and the banner cannot nag, and nothing is forgotten once it
// does. `CreditBanner` solves the identical problem with a monotonic `nextId`;
// this is the same shape for the same reason, so the two banners cannot disagree
// about what "the same banner" means.
//
// ── WHY AMBER IS NOT ENOUGH ──────────────────────────────────────────────────
//
// Amber `#fbbf24` is the HUD's waiting token and is also what the generic
// notice strip already uses, so colour alone would make "credit exhausted" and
// "the server is gone" look like the same event. The arm is therefore distinct
// on four independent channels — hue, a DASHED border (a texture difference
// that survives greyscale and colour blindness), a `⇄` link glyph, and the word
// itself — while success (`#34d399`) and failure (`#f87171`) are never in this
// component's vocabulary at all.

/** A monotonically increasing id for one outage. Owned by the caller. */
export type ReconnectEpisode = number;

export interface ReconnectState {
  /** The outage this state describes. Bumped by the caller on each new drop. */
  readonly episode: ReconnectEpisode;
  /** True for the whole episode. The ONLY input to `actionsBlocked`. */
  readonly dropped: boolean;
  /** Whether the user closed the banner FOR THIS EPISODE. */
  readonly dismissed: boolean;
  /** Arabic detail, verbatim from whoever detected the drop. */
  readonly detailAr: string;
}

export const INITIAL_RECONNECT: ReconnectState = {
  episode: 0,
  dropped: false,
  dismissed: false,
  detailAr: '',
};

export type ReconnectEvent =
  | { readonly kind: 'dropped'; readonly episode: ReconnectEpisode; readonly detailAr?: string }
  | { readonly kind: 'restored' }
  | { readonly kind: 'dismissed' };

/**
 * Fold one event in. Pure, and the whole policy is four lines because the
 * policy IS four lines.
 *
 * A `dropped` with the SAME episode is a re-notification of the outage in
 * progress (a second failed probe), not a new one: it must not resurrect a
 * banner the user already closed, or a 15 s poll would re-open it forever. A
 * different episode is a new outage and always re-arms. `restored` clears
 * everything, so a clean reconnect never inherits the last episode's dismissal.
 */
export function reconnectReducer(state: ReconnectState, event: ReconnectEvent): ReconnectState {
  switch (event.kind) {
    case 'dropped': {
      if (event.episode === state.episode && state.dropped) return state;
      return {
        episode: event.episode,
        dropped: true,
        // A NEW episode re-arms; a repeat within the episode does not.
        dismissed: event.episode === state.episode ? state.dismissed : false,
        detailAr: event.detailAr ?? state.detailAr,
      };
    }
    case 'restored':
      return INITIAL_RECONNECT;
    case 'dismissed':
      // A dismissal with nothing to dismiss is returned by identity, so a
      // stray click cannot allocate a new object and re-render the HUD.
      if (!state.dropped || state.dismissed) return state;
      return { ...state, dismissed: true };
    default:
      return state;
  }
}

/**
 * Whether the action surface must be blocked. Deliberately ignores
 * `dismissed` — see the header. This is the component's load-bearing export.
 */
export function actionsBlocked(state: ReconnectState): boolean {
  return state.dropped;
}

/** The default Arabic line. A caller may supply a more specific one. */
export const RECONNECT_DETAIL_AR = 'انقطع الاتصال بالخادم على المنفذ ٤٠٩٦ — جارٍ إعادة المحاولة…';

export interface ReconnectBannerProps {
  readonly state: ReconnectState;
  readonly onDismiss: () => void;
  /** Optional, for a caller that wants to re-render the blocked surface. */
  readonly detailAr?: string;
}

export function ReconnectBanner({ state, onDismiss, detailAr }: ReconnectBannerProps): JSX.Element | null {
  if (!state.dropped || state.dismissed) return null;
  const detail = detailAr ?? (state.detailAr.length > 0 ? state.detailAr : RECONNECT_DETAIL_AR);

  return (
    <div
      data-testid="reconnect-banner"
      data-episode={String(state.episode)}
      data-blocks-actions={String(actionsBlocked(state))}
      role="alert"
      // Assertive, because a dead 4096 invalidates the whole control surface
      // and a polite announcement would arrive after the user had already
      // pressed something. Unlike the terminal, this announces ONCE per episode.
      aria-live="assertive"
      dir="rtl"
      title={detail}
      className="flex items-center gap-2 border-b border-dashed border-[#fbbf24]/60 bg-[#141310] px-4 py-2 text-xs text-[#fbbf24]"
    >
      <span aria-hidden className="shrink-0 select-none">
        ⇄
      </span>
      <span data-testid="reconnect-banner-text" className="min-w-0 flex-1 truncate">
        {detail}
      </span>
      <button
        type="button"
        data-testid="reconnect-dismiss"
        aria-label="إخفاء تنبيه انقطاع الاتصال"
        title="إخفاء"
        onClick={onDismiss}
        className="shrink-0 px-1 text-[#a1a1aa] hover:text-[#f4f4f5]"
      >
        ✕
      </button>
    </div>
  );
}
