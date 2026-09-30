// Serve-health → reconnect banner, from OBSERVED FRAMES ONLY.
//
// ── THE GAP THIS FILE EXISTS TO STATE, NOT TO HIDE ───────────────────────────
//
// `ReconnectBanner` is for `opencode serve` on 4096 dropping, and it is already
// built, wired and tested (`components/bento/ReconnectBanner.tsx`). What it does
// not have — and what App cannot manufacture for it — is a SOURCE.
//
// `src/runtime/serve-health.ts` is the module that owns the answer. Its own
// header says it plainly: "it is not wired into the daemon at all yet", and
// `daemon.ts` still runs the one-shot boot probe and throws
// `SERVE_UNREACHABLE` instead. So today NO producer emits a serve-health signal,
// and a renderer that hard-coded one would be reporting a condition nobody has
// observed. That is the `layaReady: true` defect wearing a health banner's
// clothes: a surface that reads as live when it is not.
//
// So this file is a PLACEHOLDER WITH A REAL SHAPE. It names the exact contract
// the daemon owner has to satisfy, and it folds ONLY frames the shell actually
// receives:
//
//   LOSS     — a `notice` frame whose `code` is one of `SERVE_HEALTH_CODES`.
//              Those three literals are not invented here: they are
//              `SERVE_BLOCKED_DETAIL_DEGRADED` / `..._RECONNECTING` /
//              `..._EXHAUSTED` and `SERVE_NOTICE_RECONNECTING` from
//              `src/runtime/serve-health.ts:207-212`.
//   RECOVERY — an `ack` with `ok: true` for a command that provably reaches
//              serve (below). This arm does NOT wait for the daemon to grow a
//              second notice code, because a successful round-trip to a dead
//              port is not a thing that can be fabricated.
//
// UNTIL THE DAEMON EMITS THOSE CODES: `reconnectFromNotice` returns its input
// unchanged, the banner never appears, and the action surface is never blocked.
// That is the absence of evidence, and it is deliberately NOT rendered as
// "connected" — the HUD's own status pill reports the WS-4097 socket, which is
// the one transport the shell can actually observe, and this module says nothing
// about 4096 either way.
//
// ── WHY `ack` IS NOT A FAKE HEALTH SOURCE ─────────────────────────────────────
//
// An `ack` is the daemon's own answer to a command the shell sent, so an `ok`
// is evidence about the system the daemon just talked to. It is only evidence
// about serve for commands whose router arm actually awaits `deps.client.*`.
//
// THAT SET IS A SUBSET OF THE COMPLEMENT, NOT THE COMPLEMENT, and the
// difference is load-bearing: `SERVE_LOCAL_ONLY_COMMANDS` (`serve-health.ts:250`,
// mirrored verbatim below) has nine members — `switchSession` mutates
// daemon-local state, `setPersona` publishes two local frames, `saveApiKeys`
// writes the encrypted vault, and `mute`/`deafen`/`arm` return `{ok:true}` with
// no dependency call at all — so folding ANY of those in as a health signal
// would produce a banner that flaps on a keystroke. The complement is therefore
// SEVEN kinds, and the probe set below is SIX of them: `confirm` reaches serve
// only when something is actually parked, so it is excluded on purpose. A
// comment in this file used to call the probe set "the exact complement"; that
// was wrong by one member and the test that pinned it inherited the claim.
//
// ── WHAT THE ALLOWLIST IS FOR, BEYOND THE RECOVERY FOLD ──────────────────────
//
// The mirror has a second, larger job: it is the specification the renderer
// checks its own layout against. `BentoGrid`'s blocked slot is an `inert`
// attribute, and `inert` is inherited by the whole subtree — so one control
// placed on the wrong side of that line takes out every control below it. When
// serve drops, the STOP control and the MUTE control must be on the other side
// of the line, because the daemon's allowlist is what says the router will still
// honour them. `App.escape.test.tsx` mounts the shell, clicks every control in
// the escape slot, and asserts each command it sends is in this set — so the
// mirror is load-bearing at runtime (in `reconnectFromAck` below), at compile
// time (`SERVE_COMMAND_CLASS` is an exhaustive `Record`), and in the DOM.
import { reconnectReducer, type ReconnectState } from './components/bento/ReconnectBanner.js';
import type { CommandKind } from './bridge/ws.js';

/**
 * The three literals `src/runtime/serve-health.ts` defines. Copied as literals,
 * not imported: the root `src/` tree is outside the desktop tsconfig's `include`
 * and importing the real module would drag zod into the Vite bundle — the same
 * read-only rule `TerminalDrawer.OutputFrameLike` follows.
 *
 * RECONCILE: if `serve-health.ts` renames one of these, this set is the place
 * that has to change. Nothing else in the renderer hard-codes them.
 */
export const SERVE_HEALTH_CODES = ['serve-degraded', 'serve-reconnecting', 'serve-reconnect-exhausted'] as const;

export type ServeHealthCode = (typeof SERVE_HEALTH_CODES)[number];

/** True only for a code this shell has agreed to treat as a serve-health report. */
export function isServeHealthCode(code: string): code is ServeHealthCode {
  return (SERVE_HEALTH_CODES as readonly string[]).includes(code);
}

/**
 * The daemon's own allowlist, MIRRORED. This is `SERVE_LOCAL_ONLY_COMMANDS`
 * from `src/runtime/serve-health.ts`, copied member for member and with the
 * same per-member justification, at the same point in the file's story (after
 * the health codes, before the probe set).
 *
 * WHY THE MIRROR IS AN ALLOWLIST AND NOT A BLOCKLIST. The renderer used to have
 * no list at all, which meant "the action surface is one undifferentiated block"
 * — and the very first thing that block removed was the STOP control. The
 * daemon's own comment on the gate names the failure and the fix in one line:
 * blocking `abort` would "strand a mid-utterance user behind a dead port with no
 * way to make it stop". A blocklist ("these kinds may still be clicked") drifts
 * in the opposite direction to an allowlist: a NEW command kind is unlisted, so a
 * blocklist silently treats it as permitted while the daemon default-denies it,
 * and the UI offers a control the router will refuse. The complement is the only
 * shape where the two halves agree about a kind neither of them has heard of —
 * the daemon refuses it, and the renderer does not offer it as an escape.
 *
 * Every member is justified by the router's own body, not by assumption (line
 * numbers as read on 2026-09-30, `src/orchestrator/command-router.ts`):
 *   - `abort`            → calls `deps.onAbort?.()` only.
 *   - `stopSpeech`       → calls `deps.onStopSpeech?.()` only.
 *   - `playbackStarted`  → calls `deps.onPlaybackStarted?.()` only.
 *   - `mute`/`deafen`/`arm` → return `{ ok: true }` with no dependency call
 *                           whatsoever.
 *   - `switchSession`    → mutates daemon-local state.
 *   - `setPersona`       → calls `deps.setPersona?.()`, which the daemon wires to
 *                          `ui.setPersona` / `ui.notice` — both local frames.
 *   - `saveApiKeys`      → calls `deps.saveKeys`, wired to `writeKeyPools`, which
 *                          reaches only the encrypted vault. No network.
 *
 * NOT in the list, and why each matters:
 *   - `setSessionAgent`, `setSessionModel`, `toggleSessionSkill`,
 *     `execSessionShell` and `sessionContext` all `await deps.client.*`.
 *   - `createSession` calls `deps.client.createSession`.
 *   - `confirm` calls `execute(parked.cmd)`, which re-enters the blocked cases.
 *
 * RECONCILE: if `serve-health.ts` renames, adds or drops a member, this is the
 * place that has to change, and the tests below are what says so out loud.
 */
export const SERVE_LOCAL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'abort',
  'stopSpeech',
  'playbackStarted',
  'mute',
  'deafen',
  'arm',
  'switchSession',
  'setPersona',
  'saveApiKeys',
]);

/**
 * Every `CommandKind` classified, EXHAUSTIVELY.
 *
 * The type is the pin, and it is a compile-time one: `Record<CommandKind, …>`
 * has no index signature, so adding a seventeenth kind to the bridge's `CommandKind`
 * union fails `npx tsc --noEmit` until somebody decides which side it is on and
 * writes the reason down. That is the renderer's half of the daemon's own
 * discipline, where the equivalent is a test re-derived from the live
 * `UiCommandSchema`.
 *
 * It is a MAP rather than a lookup into `SERVE_LOCAL_ONLY_COMMANDS` on purpose:
 * the two can then disagree, and `serve-health-signal.test.ts` asserts that they
 * do not. A single structure cannot be checked against itself.
 */
export const SERVE_COMMAND_CLASS: Readonly<Record<CommandKind, 'local' | 'serve'>> = {
  // Allowlisted: provably never touch 4096.
  abort: 'local',
  stopSpeech: 'local',
  playbackStarted: 'local',
  mute: 'local',
  deafen: 'local',
  arm: 'local',
  switchSession: 'local',
  setPersona: 'local',
  saveApiKeys: 'local',
  // The complement: every one of these `await`s a `deps.client.*` call.
  setSessionAgent: 'serve',
  setSessionModel: 'serve',
  toggleSessionSkill: 'serve',
  execSessionShell: 'serve',
  sessionContext: 'serve',
  createSession: 'serve',
  confirm: 'serve',
};

/** True when the daemon will still honour this kind with 4096 dead. */
export function isServeLocalOnlyCommand(kind: string): boolean {
  return SERVE_LOCAL_ONLY_COMMANDS.has(kind);
}

/**
 * The complement, DERIVED from the classification rather than written out, so it
 * cannot drift from it. Exported for the tests that pin the two halves against
 * each other, and for any future code that needs "everything the gate refuses".
 */
export const SERVE_REACHING_COMMANDS: readonly CommandKind[] = Object.freeze(
  (Object.keys(SERVE_COMMAND_CLASS) as CommandKind[]).filter(
    (kind) => SERVE_COMMAND_CLASS[kind] === 'serve',
  ),
);

/**
 * Commands whose router arm reaches serve, so an `ok` is evidence the port
 * answered. Mirrors the blocked set documented at
 * `serve-health.ts:242-247`:
 *
 *   · `setSessionAgent` / `setSessionModel` / `toggleSessionSkill` (router
 *     lines 182/191/196) and `sessionContext` (line 241) — `await deps.client.*`
 *   · `execSessionShell` (line 205) — the `output`-frame producer
 *   · `createSession` (line 254) — `deps.client.createSession`
 *   · `confirm` (lines 269-277) — re-enters `execute(parked.cmd)`, so it is a
 *     real probe, but only once something is actually parked; a `confirm` that
 *     finds nothing pending never touches serve, and counting it would make an
 *     idle shell report serve healthy by asking it to confirm nothing.
 *
 * DELIBERATELY EXCLUDED are the allowlisted local commands, for the reason in
 * the header: their `ok` is manufactured by the router and says nothing about
 * a port.
 */
export const SERVE_PROBE_COMMANDS: ReadonlySet<string> = new Set([
  'setSessionAgent',
  'setSessionModel',
  'toggleSessionSkill',
  'execSessionShell',
  'sessionContext',
  'createSession',
]);

/**
 * Fold one `notice` into the reconnect state.
 *
 * A serve-health code while already dropped is a RE-NOTIFICATION of the outage in
 * progress — the second failed probe, or a second refused command — and must
 * not resurrect a banner the user already closed. The reducer's own identity
 * rule would handle the same episode; returning `state` here keeps that property
 * without inventing an episode counter for it.
 */
export function reconnectFromNotice(state: ReconnectState, code: string, detailAr: string): ReconnectState {
  if (!isServeHealthCode(code)) return state;
  if (state.dropped) return state;
  return reconnectReducer(state, { kind: 'dropped', episode: state.episode + 1, detailAr });
}

/**
 * Fold one command outcome into the reconnect state.
 *
 * `ok: false` is NOT evidence either way: the router refuses a command with
 * `ack.detail: 'serve-degraded'` when serve is down, and that refusal is a LOSS
 * signal handled by `reconnectFromNotice` via the notice frame — reading a
 * failure here as a drop would double-count one outage into two episodes.
 *
 * THE COMPLEMENT IS THE GATE, AND THE PROBE SET ONLY NARROWS IT. Two separate
 * checks, both needed, and NEITHER IS REDUNDANT:
 *
 *   1. `SERVE_LOCAL_ONLY_COMMANDS` — the daemon's own allowlist. If the daemon
 *      will still honour a kind with 4096 dead, that command's `ok` is
 *      manufactured by the router and says nothing about a port. Checking this
 *      means a local kind can never clear an outage even if somebody later adds
 *      it to `SERVE_PROBE_COMMANDS`, which is the direction of the mistake that
 *      matters: a false GREEN over a dead port. The suite proves this by
 *      adding `abort` to the probe set AT RUNTIME and asserting the outage
 *      survives.
 *   2. `SERVE_PROBE_COMMANDS` — the narrower allowlist, which excludes `confirm`.
 *      `confirm` reaches serve only when something is actually parked, so an idle
 *      shell must not "prove" a dead port healthy by confirming nothing.
 *
 * THE ORDER IS NOT LOAD-BEARING, and an earlier version of this comment implied
 * that it was. The two sets are disjoint, so `if (A) return; if (!B) return;` and
 * `if (!B) return; if (A) return;` are equivalent for EVERY kind — checked
 * exhaustively over all seventeen, including a kind forced into both sets. The
 * property that matters is that the allowlist check EXISTS, not where it sits.
 */
export function reconnectFromAck(state: ReconnectState, kind: string, ok: boolean): ReconnectState {
  if (!ok) return state;
  if (isServeLocalOnlyCommand(kind)) return state;
  if (!SERVE_PROBE_COMMANDS.has(kind)) return state;
  return reconnectReducer(state, { kind: 'restored' });
}
