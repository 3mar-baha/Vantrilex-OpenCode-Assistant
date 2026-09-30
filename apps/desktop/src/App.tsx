import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { VoxauraBridge, type BridgeOptions, type ContextMsg } from './bridge/ws.js';
import { WaveformEmblem } from './components/brand/WaveformEmblem.js';
import { SiriWaveCanvas, SPEAKER_PALETTE, type WaveSpeaker } from './components/waveform/SiriWaveCanvas.js';
import { AgentModelBadge } from './components/session/AgentModelBadge.js';
import { ContextGauge } from './components/session/ContextGauge.js';
import { BentoGrid } from './components/bento/BentoGrid.js';
import {
  INITIAL_RECONNECT,
  reconnectReducer,
  type ReconnectState,
} from './components/bento/ReconnectBanner.js';
import {
  appendTerminalLines,
  linesFromOutputFrame,
  type OutputFrameLike,
  type TerminalLine,
} from './components/terminal/TerminalDrawer.js';
import { ConfirmPortal } from './components/portals/ConfirmPortal.js';
import { CalibrationWizard } from './components/portals/CalibrationWizard.js';
import { MicGlyph, MicOffGlyph, BotGlyph, BotOffGlyph } from './components/icons/ControlGlyphs.js';
import {
  CreditBanner,
  INITIAL_CREDIT,
  creditDismiss,
  creditNotice,
  creditVoice,
  isCreditNotice,
  type CreditState,
} from './components/status/CreditBanner.js';
import { AudioCapture } from './audio/capture.js';
import { AudioPlayer, createDefaultPlayer } from './audio/playback.js';
import { micFailureNotice, micPolicy, UplinkGate } from './audio/vad.js';
import { matrixForDaemonState, type MatrixState } from './matrix/matrix-state.js';
import { queuedCard, taskCardsFromInventory, type TaskCard } from './matrix/task-state.js';
import { initialSessionsState, sessionsReducer } from './sessions/store.js';
import { envToken, resolveIpcTokenWithRetry } from './settings/ipc-token.js';
import { ensureServices } from './settings/services.js';
import { openKeysWindow, openSettingsWindow } from './settings/open-settings.js';
import { isServeHealthCode, reconnectFromAck, reconnectFromNotice } from './serve-health-signal.js';
import { useAutoSize } from './window/useAutoSize.js';
import './index.css';

// Voxaura companion HUD — one control per intent, no duplicated toolbars.
// Every interactive element carries an Arabic tooltip; the status pill is
// driven entirely by live daemon state, never local guesswork.
//
// ── THE LAYOUT, AND WHO OWNS WHICH PART OF IT ─────────────────────────────────
//
// `BentoGrid` owns the column: the reconnect banner, the blocked action slot and
// the bounded scroll region that holds the session bar, the task cards and the
// terminal drawer. It owns it for a measured reason — its suite pins the action
// slot OUTSIDE the scroll container, so a dead 4096 cannot block the session
// switcher or the log — and this file does not fork it.
//
// So the chrome AROUND the grid is App's, and it is deliberate which chrome:
//
//   · The window header (title, Ctrl+, hint, status pill) and the footer (the
//     three navigation buttons) are OUTSIDE, both `shrink-0`. Navigation that
//     scrolls away is navigation a user cannot find, and the status pill is the
//     one thing that must be readable while something is wrong.
//   · The agent/model badge, the context gauge and the empty-state hint are
//     OUTSIDE and directly above the grid, still `shrink-0`. They are
//     session-scoped controls, not voice controls, and a voice outage must not
//     be able to scroll the agent selector out of reach. They are NOT inside
//     `bento-actions`, because that slot goes `inert` when serve drops — and
//     `setSessionAgent` is one of the commands the daemon deliberately does NOT
//     gate (`serve-health.ts` allowlist). A renderer that blocked its own agent
//     selector would contradict the router.
//   · The mic, the bot mute, the wave, the announce line and the abort button
//     are INSIDE, as the action surface. That is the blockable set.
//
// WHY THE ROOT IS `h-full … min-w-0` AND CARRIES NO WIDTH. The window is now
// `resizable` with `minWidth: 440` / `minHeight: 600` (`tauri.conf.json`), so a
// hard `w-[440px]` would leave dead space the moment the user drags the window
// wider — and `BentoGrid` says the same thing about its own root: a fixed width
// breaks at the first resize and an `overflow-x-hidden` would MASK horizontal
// overflow rather than prevent it, making the 440 px audit pass by hiding the
// thing it exists to catch. `App.bento.test.tsx` audits this whole tree.
//
// The one clip that does remain is `overflow-hidden` on this root, for the
// rounded corners of `vx-sketch-card`. It is per-element in the audit
// (`layoutBudget.ts` judges each node by its OWN class), so it cannot mask an
// uncontained child, and no `overflow-x-hidden` — which would — appears here.
//
// The root's tone MATCHES `BentoGrid`'s (`#141413`) on purpose: the header, the
// session row and the footer sit beside the grid, and a one-value colour
// difference between them reads as a rendering bug rather than as a panel edge.
type BridgeState = 'connecting' | 'live' | 'degraded' | 'refused';
type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Notice {
  readonly code: string;
  readonly detail: string;
  readonly level: 'info' | 'warn' | 'error';
}

const FONT = 'var(--vx-font)';

/**
 * The bridge options this shell passes, plus the one branch the bridge does not
 * have yet.
 *
 * ── THE NAMED GAP ────────────────────────────────────────────────────────────
 *
 * `bridge/ws.ts` has no `output` branch: `onMessage` ends at `ack`/`error` and
 * an `output` frame is ignored like any other unknown type. `bridge/**` belongs
 * to another wave, so this file does not add it — it DECLARES the contract, so
 * the day that branch lands this call site is already correct and the change is
 * one line in `ws.ts`.
 *
 * `OutputFrameLike` is the projector contract from `TerminalDrawer.tsx`, which
 * is the SUBSET of the real `OutputFrame` (`src/ipc/protocol.ts:908`) that the
 * renderer reads. It is used rather than a local copy of the whole frame so
 * there is one shape in the renderer, not two that can drift; the real
 * `OutputFrame` satisfies it by construction, because every field it declares is
 * a field the protocol's zod schema declares.
 *
 * Until then this property is inert — an option nobody reads — which is the
 * recoverable direction: no drawer, no log, and the previous behaviour.
 */
/**
 * The bridge options this shell passes.
 *
 * `onOutput` is no longer a locally-declared extra. `bridge/ws.ts` declares it on
 * `BridgeOptions` itself, so the declared seam and the consumed seam are one
 * type. It arrived here as an intersection while `bridge/**` belonged to another
 * wave, which is a shape that reads as a gap and is not one.
 *
 * The type is IMPORTED from the bridge rather than re-declared, and it is an
 * `import type`, so it is erased at compile time: nothing is added to the Vite
 * bundle and the `vi.mock('./bridge/ws.js')` in the shell suites (which supplies
 * only the class and two constants) is unaffected.
 */
type ShellBridgeOptions = BridgeOptions;

export function App(): JSX.Element {
  const [bridge, setBridge] = useState<BridgeState>(envToken() !== undefined ? 'connecting' : 'degraded');
  const [persona, setPersona] = useState<'kareem' | 'nour'>('kareem');
  const [matrix, setMatrix] = useState<MatrixState>(0);
  const [userMuted, setUserMuted] = useState(true);
  const [botMuted, setBotMuted] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  // M4 C.3 — the credit banner's own state, separate from `notice` so a credit
  // frame can NEVER be mistaken for a generic warn (see CreditBanner.tsx).
  const [credit, setCredit] = useState<CreditState>(INITIAL_CREDIT);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [lastTranscript, setLastTranscript] = useState('');
  const [micEnergy, setMicEnergy] = useState(0);
  const [pendingConfirm, setPendingConfirm] = useState<{ id: string; detail: string } | null>(null);
  // M4 C.6 — the calibration wizard is measure-and-ADVISE. It writes no
  // threshold, sends no command and touches `announce` never; see
  // CalibrationWizard.tsx for why persistence is deferred rather than merely
  // unfinished.
  const [calibrating, setCalibrating] = useState(false);
  const [sessionState, dispatchSession] = useReducer(sessionsReducer, initialSessionsState);
  const [agentModel, setAgentModel] = useState<{ agent: string | null; model: string | null }>({
    agent: null,
    model: null,
  });
  const [agents, setAgents] = useState<readonly { id: string; name: string }[]>([]);
  const [context, setContext] = useState<ContextMsg | null>(null);
  // M4 C.5 Phase 1 — the ONE locally-synthesised task card. It is a display-only
  // receipt placed when the daemon reports the turn started, and it emits no
  // command; see `matrix/task-state.ts` for why it can never be reconciled to a
  // real session row.
  const [taskReceipt, setTaskReceipt] = useState<TaskCard | null>(null);
  // Phase 1 of the agentic bridge, on the shell side. `terminalLines` is the
  // drawer log; `terminalOpen` is the drawer's own toggle, and the drawer is
  // COLLAPSED at rest because the window has a 600 px minimum and a log that
  // grows on every command would eat the HUD from below.
  const [terminalLines, setTerminalLines] = useState<readonly TerminalLine[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  // The reconnect state. `INITIAL_RECONNECT` is not "serve is healthy" — it is
  // "nothing has been reported yet". See `serve-health-signal.ts` for why there
  // is no source for that field today and what has to emit one.
  const [reconnect, setReconnect] = useState<ReconnectState>(INITIAL_RECONNECT);
  const activeSession = sessionState.activeId;
  const bridgeRef = useRef<VoxauraBridge | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  if (captureRef.current === null) captureRef.current = new AudioCapture();
  const playerRef = useRef<AudioPlayer | null>(null);
  const [speaking, setSpeaking] = useState(false);
  // Ref mirror of `speaking` for the mic-frame hot path (state is stale inside callbacks).
  const speakingRef = useRef(false);
  const setSpeakingState = (value: boolean): void => {
    speakingRef.current = value;
    setSpeaking(value);
  };
  const lastEnergyAt = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);
  // KEPT, and deliberately. `useAutoSize` is `enabled: false` by default, so
  // this is inert today and costs one `useEffect` that returns on its first
  // line. It stays because `voxaura-shell` is still the right thing to measure
  // IF the window ever becomes content-driven again — the settings and API-keys
  // portals still want that, and they still call this hook — and because the
  // stand-down is expressed by the missing flag, not by the absence of the call.
  useAutoSize(cardRef, { paddingY: 16 });
  const lastFrameAt = useRef<number>(Date.now());
  const personaRef = useRef(persona);
  const botMutedRef = useRef(botMuted);
  /**
   * A1 — the local uplink gate. One per component instance, held in a ref
   * because it is stateful (the post-utterance tail) and is read from the
   * microphone's hot path, where a re-created object would reset the tail and
   * starve the daemon's 5 s window mid-utterance.
   *
   * NOT the B.3 backpressure watermark. That is the daemon saying "I am
   * behind" (`hello.uplinkPaused` / `flow` frames) and it is applied inside
   * `VoxauraBridge.sendPcm`. This is the client saying "nobody is speaking".
   * They gate the same wire for entirely different reasons and neither one
   * knows about the other.
   */
  const uplinkGateRef = useRef<UplinkGate | null>(null);
  if (uplinkGateRef.current === null) uplinkGateRef.current = new UplinkGate();
  const cmdCounter = useRef(0);
  useEffect(() => {
    personaRef.current = persona;
  }, [persona]);

  /**
   * W6 — the assistant-mute button used to flip a boolean and send a command
   * the daemon discarded, so it muted nothing and acked `ok:true`.
   *
   * The ref exists because the player is created LAZILY, on the first downlink
   * chunk: a mute pressed before the assistant had ever spoken would otherwise
   * be lost, and the very next chunk would play through an "unmuted" player.
   * The effect is the player sync (an external system); the indicator is reset
   * in the event that caused the change, not here.
   */
  useEffect(() => {
    botMutedRef.current = botMuted;
    playerRef.current?.setMuted(botMuted);
  }, [botMuted]);

  const nextCmdId = (): string => {
    cmdCounter.current += 1;
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `cmd-${Date.now()}-${cmdCounter.current}-${Math.floor(Math.random() * 1e6)}`;
  };

  /**
   * One `output` frame in, the drawer log out.
   *
   * THE DEDUPE IS NOT HERE, ON PURPOSE. `linesFromOutputFrame` mints ids as
   * `${commandId}:${n}` and `appendTerminalLines` drops ids already held, which
   * is what makes a REPLAYED frame harmless. Frames really do re-deliver — the
   * `seq > lastSeq` resume filter in `ws.ts` exists precisely because they can —
   * so a second dedupe layer keyed on `commandId` would be a third opinion
   * about the same question, and the kind that silently eats a genuine second
   * result for the same command.
   *
   * Nor is there a second truncation. The producer owns the 32 KiB cap
   * (`OutputAssembler`) and says so on the frame: `truncated` / `droppedBytes`
   * become a VISIBLE Arabic marker line inside the projection. A renderer clamp
   * on top of that would hide the drop the producer reported and assert a
   * completeness the frame never claimed.
   *
   * The drawer opens ITSELF once, on the first frame, and never again: after
   * that the user owns it. A drawer that reopened on every command would fight
   * the collapse they just performed, which is why the "already opened" bit is
   * a ref and not a `setState` — a state flag read inside the updater would be a
   * state update during a state update.
   */
  const terminalAutoOpened = useRef(false);
  const handleOutputFrame = useCallback((frame: OutputFrameLike): void => {
    const incoming = linesFromOutputFrame(frame);
    setTerminalLines((current) => appendTerminalLines(current, incoming));
    if (terminalAutoOpened.current) return;
    terminalAutoOpened.current = true;
    setTerminalOpen(true);
  }, []);

  const dismissReconnect = useCallback((): void => {
    setReconnect((s) => reconnectReducer(s, { kind: 'dismissed' }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let client: VoxauraBridge | null = null;
    // Zero-click: bring the tiers up first (no-op off Tauri). The bridge also
    // retries with backoff, so a slow cold start converges without the user.
    void ensureServices().then((result) => {
      if (!disposed && result !== null && !result.ok) setAnnounce(`تعذّر بدء الخدمات: ${result.detail}`);
    });
    void resolveIpcTokenWithRetry().then((token) => {
      if (disposed || token === undefined) {
        if (!disposed && token === undefined) setBridge('degraded');
        return;
      }
      const options: ShellBridgeOptions = {
        token,
        contractVersion: '3.1.0',
        // Any inbound frame proves the socket is alive: promote to live and
        // stamp liveness. This is the recovery path the old watchdog lacked.
        onFrame: () => {
          lastFrameAt.current = Date.now();
          setBridge((s) => (s === 'refused' ? s : 'live'));
        },
        onHello: (h) => {
          setBridge('live');
          // L22: the daemon is the source of truth for persona. A shell that
          // connects (or reconnects) after a change adopts it here instead of
          // sitting on the `kareem` default.
          if (h.persona !== undefined && h.persona !== personaRef.current) {
            setPersona(h.persona);
          }
        },
        onNotice: (n) => {
          // Serve health, FIRST: a serve-health notice is a LOSS report and it
          // must reach `reconnect` whatever else it also is. It is folded
          // unconditionally rather than inside the credit branch below, and the
          // fold itself decides whether this is a new episode or a re-notification
          // of one already running — see `serve-health-signal.ts`.
          if (isServeHealthCode(n.code)) {
            setReconnect((s) => reconnectFromNotice(s, n.code, n.detail));
          }
          // C.3: a credit notice takes the dedicated banner INSTEAD of the
          // generic strip. Both would otherwise show the same Arabic sentence
          // twice, and the generic strip's dismiss would leave a stale copy —
          // and the latched overdue arm would be dismissible through it.
          if (isCreditNotice(n.code)) {
            setCredit((s) => creditNotice(s, n.code, n.detail));
            return;
          }
          setNotice({ code: n.code, detail: n.detail, level: n.level });
          // L22: follow a persona change made in the settings window.
          //
          // This handler sets local state and NOTHING else. It must not send
          // `setPersona` back: the daemon already applied it, and re-sending
          // would bounce the change between the two surfaces. The daemon's
          // equality guard makes that loop a no-op, but the correct behaviour
          // is to not start it — see the guard in daemon.ts.
          if (n.code === 'persona-changed' && (n.detail === 'kareem' || n.detail === 'nour')) {
            if (n.detail !== personaRef.current) setPersona(n.detail);
          }
        },
        onVoice: (v) => {
          setVoicePhase(v.phase);
          // C.3: the ONLY auto-clear. A `speaking` phase means the turn reached
          // TTS without the credit fault reproducing, so the banner stops
          // claiming voice is dead. A fault that still reproduces re-emits its
          // notice, which re-arms it. No command is sent and `announce` is not
          // written — a silent banner is not a status line.
          setCredit((s) => creditVoice(s, v.phase));
          if (v.transcript !== undefined && v.transcript.length > 0) setLastTranscript(v.transcript);
          // C.5: utterance time. `thinking` is the daemon reporting that it has
          // the turn and the user's words, which is the closest thing to "sent"
          // the shell can observe without inventing a round-trip. Any later
          // phase means the thinking window is over, so the receipt is retired.
          // Set state and NOTHING else — no command, no `announce` write.
          if (v.phase === 'thinking') {
            setTaskReceipt(queuedCard(v.transcript ?? ''));
          } else {
            setTaskReceipt(null);
          }
        },
        // Phase 4: context-window occupancy for the gauge.
        onContext: (c) => setContext(c),
        onErrorFrame: (detail) => setNotice({ code: 'transport', detail, level: 'error' }),
        onEvent: (event) => {
          const mapped = matrixForDaemonState(event.state, personaRef.current);
          if (mapped !== null) setMatrix(mapped);
          lastFrameAt.current = Date.now();
        },
        onInventory: (sessions) => {
          dispatchSession({ kind: 'replace', sessions: sessions.map((x) => ({ id: x.sessionId, state: x.state })) });
          // C.5: a real snapshot supersedes the local receipt, because the
          // receipt covers exactly the window before the next snapshot. An EMPTY
          // snapshot is the documented error/unready shape (`protocol.ts`), so it
          // carries no evidence and must NOT retire a live receipt.
          if (sessions.length > 0) setTaskReceipt(null);
        },
        onAgents: (list) => setAgents(list.map((a) => ({ id: a.id, name: a.name }))),
        // Phase 1 of the agentic bridge: streamed command output into the drawer.
        // `bridge/ws.ts` has the `output` branch, so this is a live seam and not
        // a declaration of one.
        onOutput: handleOutputFrame,
        onAudio: (bytes) => {
          if (playerRef.current === null) {
            try {
              playerRef.current = createDefaultPlayer({
                // M2 Pattern 3: this is the ONE place the renderer tells the
                // daemon audio actually started, and it fires ONCE per utterance
                // (see `AudioPlayer.onStart`). The daemon uses it as the only
                // evidence a live shell is taking audio, so a held FR-12
                // confirmation can be delivered instead of swallowed.
                //
                // Fire-and-forget on purpose: `void`, never awaited. A delivery
                // signal that can block audio playback is worse than a lost one —
                // the daemon also drains on its own quiet window, so dropping
                // this costs nothing but a slightly later delivery.
                onStart: (playbackId) => {
                  setSpeakingState(true);
                  const live = bridgeRef.current;
                  if (live !== null) {
                    void live.sendCommand({
                      id: nextCmdId(),
                      kind: 'playbackStarted',
                      ...(playbackId !== undefined ? { playbackId } : {}),
                    });
                  }
                },
                // Latch briefly so a fast queue doesn't flicker the indicator.
                onEnd: () => {
                  window.setTimeout(() => setSpeakingState(false), 1500);
                },
              });
              // The player did not exist when the user pressed mute, so it was
              // never told. Apply the persisted state before any chunk lands.
              playerRef.current.setMuted(botMutedRef.current);
            } catch {
              return;
            }
          }
          playerRef.current.enqueue(bytes);
        },
        // D3: release the AudioContext on unmount. The window can be reopened
        // many times per session; an un-closed context is a real leak.
        onDispose: () => {
          playerRef.current?.dispose();
          playerRef.current = null;
        },
        onClose: () => setBridge((s) => (s === 'live' ? 'degraded' : s)),
        onRefusal: () => setBridge('refused'),
      };
      const b = new VoxauraBridge(options);
      client = b;
      bridgeRef.current = b;
      b.connect();
    });
    return () => {
      disposed = true;
      client?.dispose();
      bridgeRef.current = null;
    };
    // `handleOutputFrame` is `useCallback(…, [])`, so it is referentially stable
    // for the lifetime of the component and naming it changes nothing — but it
    // is named rather than left to `[]` so that a future edit which gives it a
    // dependency cannot silently leave this mount effect closing over a stale
    // handler. That edit would otherwise tear down and rebuild the bridge on
    // every render, which is the failure the dependency list is there to stop.
  }, [handleOutputFrame]);

  // Transport-truth watchdog. The pill is driven by the socket's own state:
  // an idle-but-OPEN socket must never read as disconnected (the previous
  // time-only latch caused exactly that). Only a genuinely closed socket
  // demotes; any inbound frame promotes back to live via `onFrame`.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const client = bridgeRef.current;
      if (client === null) return;
      if (!client.live) setBridge((s) => (s === 'refused' ? s : 'degraded'));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        void openSettingsWindow(personaRef.current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Release the microphone when the shell unmounts (no dangling tracks).
  useEffect(() => () => captureRef.current?.stop(), []);

  /**
   * Start the capture pipeline.
   *
   * Extracted from `toggleUserMute` and held in a `useCallback` with no
   * dependencies: every value it closes over is a ref or a stable setter, so it
   * is safe to call from a `visibilitychange` handler. That matters because the
   * L19 fix has to be able to genuinely RE-acquire the hardware, not just flip a
   * piece of state — a mic that never restarts after a minimise is a mic the
   * user has to re-enable by hand, which is worse than the bug being fixed.
   */
  const startMic = useCallback((): void => {
    const capture = captureRef.current;
    if (capture === null) return;
    void capture
      .start({
        onEnergy: (energy) => {
          // Throttle: the worklet posts every few ms; 80 ms is plenty.
          const now = Date.now();
          if (now - lastEnergyAt.current > 80) {
            lastEnergyAt.current = now;
            setMicEnergy(energy);
          }
        },
        onFrame: (bytes) => {
          // A1 + barge-in, decided together by ONE function so the ordering
          // between them is in a file that can be read top to bottom:
          //
          //   1. an explicit user action transmits, whatever the energy is;
          //   2. an energy reading that cannot be taken transmits (fail open);
          //   3. while the assistant speaks, quiet frames are ducked locally
          //      and a voice burst stops playback, tells the daemon to stop
          //      SPEECH, and goes up immediately;
          //   4. otherwise a below-gate frame is dropped HERE, in the
          //      renderer, and never reaches the socket at all.
          //
          // M2 Pattern 2: the barge sends `stopSpeech`, not `abort`. A barge
          // used to cancel the whole turn, so the plan the user was already
          // paying for (free-tier p50 1,950 ms) was thrown away and they heard
          // nothing — the most natural way to use a voice product was the one
          // that made it go silent. The button (`abort-button`) is still the
          // full cancel.
          //
          // M3 B.3: `sendPcm`'s `false` means the daemon is applying
          // backpressure and the frame was dropped on purpose — see
          // `VoxauraBridge.sendPcm`. Do NOT "fix" that by stopping the
          // capture: the user's speech is already gone from the wire, and
          // silencing the microphone would also throw away the audio that
          // arrives after the resume. The barge above is unaffected either
          // way, because commands are never gated.
          const gate = uplinkGateRef.current;
          const verdict = gate?.decide(bytes, { speaking: speakingRef.current });
          if (verdict === undefined || !verdict.send) return;
          if (verdict.barge) {
            playerRef.current?.stop();
            setSpeakingState(false);
            const live = bridgeRef.current;
            if (live !== null) void live.sendCommand({ id: nextCmdId(), kind: 'stopSpeech' });
          }
          bridgeRef.current?.sendPcm(bytes);
        },
        onError: (err) => setAnnounce(micFailureNotice(err)),
      })
      .catch((err: unknown) => setAnnounce(micFailureNotice(err)));
  }, []);

  /**
   * L19 — the microphone stayed hot whenever the window was minimised or
   * covered. That is a standing privacy and battery cost for a user who never
   * asked for it, so a HIDDEN window releases the hardware track. `userMuted` is
   * deliberately untouched, so the user's own choice survives the window being
   * minimised and the mic comes back on its own when it returns.
   *
   * Only `hidden` releases it. A plain blur with the window still on screen is
   * not a reason to take the microphone away, and restarting on every focus
   * change would thrash the audio graph for nothing.
   */
  useEffect(() => {
    const onVisibility = (): void => {
      const action = micPolicy(document.visibilityState === 'hidden' ? 'hidden' : 'visible', userMuted);
      if (action === 'release') captureRef.current?.stop();
      else if (action === 'start') startMic();
    };
    // `blur` is registered too because a minimise does not always fire
    // `visibilitychange` in WebView2. The same guard applies, so a plain focus
    // change with the window still visible is a no-op.
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onVisibility);
    };
  }, [userMuted, startMic]);

  /**
   * Phase 5 — ZERO CANNED REPLIES.
   *
   * The success text used to be a literal passed by each call site ('تم تبديل
   * النموذج', 'تم تنفيذ الأمر بنجاح'), which is exactly why confirmations read
   * as robotic. There is no success string here any more: the daemon asks the
   * MODEL to write a line from the situation and publishes it as an
   * `assistant-said` notice, which is both spoken and displayed.
   *
   * Only the FAILURE text remains, and it is a genuine error path where there is
   * no model to consult — an error is not a conversational reply. Even that is
   * kept short and non-narrative.
   */
  const send = (cmd: Parameters<VoxauraBridge['sendCommand']>[0], fail: string): void => {
    const bridgeClient = bridgeRef.current;
    if (bridgeClient === null) {
      setAnnounce('الخادم غير متصل');
      return;
    }
    void bridgeClient.sendCommandDetailed(cmd).then((outcome) => {
      // Recovery is EVIDENCE, not optimism: an `ok` on a command that reaches
      // serve is a round-trip that could not have succeeded against a dead 4096.
      // A failure is folded as nothing — the daemon reports the loss on the
      // notice frame, and folding it twice would open two episodes per outage.
      setReconnect((s) => reconnectFromAck(s, cmd.kind, outcome.ok));
      // FR-12: a parked destructive action opens the confirmation portal.
      if (outcome.detail === 'confirmation-required') {
        setPendingConfirm({
          id: cmd.id,
          detail: typeof cmd.command === 'string' && cmd.command.length > 0 ? cmd.command : 'إجراء قد يكون مدمّراً',
        });
        return;
      }
      // On success the daemon supplies the spoken line; announcing it here
      // would race it and is not needed.
      if (!outcome.ok) setAnnounce(fail);
    });
  };

  const resolveConfirm = (approve: boolean): void => {
    const parked = pendingConfirm;
    if (parked === null) return;
    setPendingConfirm(null);
    const client = bridgeRef.current;
    if (client !== null) {
      void client.sendCommand({ id: nextCmdId(), kind: 'confirm', confirmId: parked.id, approve });
    }
  };

  const handleSelectPersona = (id: 'kareem' | 'nour'): void => {
    setPersona(id);
    setMatrix(id === 'kareem' ? 3 : 4);
    send({ id: nextCmdId(), kind: 'setPersona', persona: id }, 'تعذّر تبديل الشخصية');
  };

  const handleSelectSession = (id: string): void => {
    dispatchSession({ kind: 'select', id });
    send({ id: nextCmdId(), kind: 'switchSession', sessionId: id }, 'تعذّر تبديل الجلسة');
  };

  const promptTarget = (label: string): string | null => {
    const value = window.prompt(label)?.trim();
    return value !== undefined && value.length > 0 ? value : null;
  };

  const handleSelectAgent = (agentId: string): void => {
    const active = sessionState.activeId;
    setAgentModel((s) => ({ ...s, agent: agentId }));
    if (active === null) {
      setAnnounce('اختر جلسة أولاً');
      return;
    }
    send({ id: nextCmdId(), kind: 'setSessionAgent', sessionId: active, agent: agentId }, 'تعذّر تعيين الوكيل');
  };

  const handleSwitchAgent = (): void => {
    const active = sessionState.activeId;
    if (active === null) {
      setAnnounce('اختر جلسة أولاً');
      return;
    }
    const target = promptTarget('بدّل الوكيل (المعرف):');
    if (target === null) return;
    setAgentModel((s) => ({ ...s, agent: target }));
    send({ id: nextCmdId(), kind: 'setSessionAgent', sessionId: active, agent: target }, 'تعذّر تعيين الوكيل');
  };

  const handleSwitchModel = (): void => {
    const active = sessionState.activeId;
    if (active === null) {
      setAnnounce('اختر جلسة أولاً');
      return;
    }
    const target = promptTarget('بدّل النموذج (المعرف):');
    if (target === null) return;
    setAgentModel((s) => ({ ...s, model: target }));
    send({ id: nextCmdId(), kind: 'setSessionModel', sessionId: active, model: target }, 'تعذّر تبديل النموذج');
  };

  const toggleUserMute = (): void => {
    const next = !userMuted;
    setUserMuted(next);
    const capture = captureRef.current;
    if (capture !== null) {
      if (next) {
        capture.stop();
        // A1: the tail is a debt to the daemon's 5 s window, and a muted
        // microphone stops paying it. Carrying it across a mute would transmit
        // up to 5.6 s of room tone the moment the user unmutes, which is the
        // one moment they are most sure nobody is listening.
        uplinkGateRef.current?.reset();
      } else {
        startMic();
      }
    }
    send({ id: nextCmdId(), kind: 'deafen' }, 'تعذّر تغيير حالة الميكروفون');
  };

  /**
   * W6 — assistant mute is now RENDERER-LOCAL, and that is the whole fix.
   *
   * It used to `send({kind:'mute'})`. The daemon's router answers `mute`,
   * `deafen` and `arm` in one arm with no side effect at all
   * (`src/orchestrator/command-router.ts:227-230`) and returns `ok:true`, so
   * the button acknowledged a success it did not deliver and then cost a free-
   * tier Inkling narration describing a microphone that was never silenced.
   * A control the daemon does not own cannot be confirmed by the daemon, so
   * the renderer applies the mute itself and confirms it the only honest way:
   * the audio stops. No `ok:true`, no model call, no canned success string
   * (Phase 5 forbids those) — the glyph, the tooltip and `aria-pressed` are
   * the whole confirmation.
   */
  const toggleBotMute = (): void => {
    const next = !botMuted;
    setBotMuted(next);
    // Applied here as well as in the effect so the gate moves on the same tick
    // as the click, and so a mute pressed before the player exists is still
    // recorded for the lazy `onAudio` path.
    botMutedRef.current = next;
    playerRef.current?.setMuted(next);
    // `setMuted` fires `onEnd`, which only clears the indicator after a 1500 ms
    // latch — so for a second and a half a silenced shell would still claim to
    // be talking. Barge-in clears it outright for the same reason (`:235-236`).
    if (next) setSpeakingState(false);
  };

  /**
   * Phase 5 follow-up — feed the context gauge.
   *
   * The frame, the schema, the command and the gauge component all existed, but
   * nothing ever REQUESTED telemetry, so the gauge rendered nothing at all. It
   * is requested on the active-session change and on a slow interval, because
   * a window fills up while you are looking at it.
   */
  useEffect(() => {
    if (bridge !== 'live' || activeSession === null || activeSession === undefined) return;
    let cancelled = false;
    const request = (): void => {
      if (cancelled) return;
      void bridgeRef.current
        ?.sendCommandDetailed({ id: nextCmdId(), kind: 'sessionContext' })
        .then((outcome) => setReconnect((s) => reconnectFromAck(s, 'sessionContext', outcome.ok)));
    };
    request();
    const timer = window.setInterval(request, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bridge, activeSession]);

  // D8: the thread wears the active speaker's gradient. While the assistant
  // speaks it takes the persona's palette; otherwise the thread belongs to the
  // human at the microphone.
  //
  // W6: gated on `botMuted`. `speaking` already stays false while muted (the
  // player drops the chunk before `started` flips), but the daemon's `voice`
  // phase keeps reporting `speaking` for as long as it synthesises — so without
  // this the shell announces the assistant is talking out loud while the user
  // has explicitly silenced it. Muting must stop more than the sound.
  const audible = !botMuted && (speaking || voicePhase === 'speaking');
  const waveSpeaker: WaveSpeaker = audible ? (persona === 'nour' ? 'nour' : 'kareem') : 'user';

  const statusPill =
    bridge !== 'live'
      ? { text: '● غير متصل', state: 'offline' }
      : audible
        ? { text: '● يتحدث الآن…', state: 'speaking' }
        : voicePhase === 'thinking'
          ? { text: '● جارٍ التفكير…', state: 'processing' }
          : !userMuted || voicePhase === 'listening'
            ? { text: '● جارٍ الاستماع…', state: 'listening' }
            : matrix === 0
              ? { text: '● متصل وبانتظار الأوامر', state: 'ready' }
              : matrix === 2
                ? { text: '● جاري المعالجة...', state: 'processing' }
                : { text: '● متصل وبانتظار الأوامر', state: 'ready' };

  const live = matrix !== 0;
  const noSessions = sessionState.sessions.length === 0;

  /**
   * M4 C.5 Phase 1 — the task-card strip, derived from `inventory`.
   *
   * NOT from `event`: that frame has zero production producers
   * (`broadcast()` is called only by tests and the E2E stub), so a card strip
   * built on it would be green over a call the daemon never makes. The
   * `event` caller is Phase 2 (M2 producer) and ships nothing today.
   *
   * The RENDERING moved to `components/session/TaskCards.tsx`, which reproduces
   * this surface's DOM contract exactly (`task-strip`, `[data-task-card]`,
   * `task-chip`, and the exact `TASK_CHIP_CLASS[state]` class string). The cards
   * are still derived HERE, because that is the mapping the strip owns, and
   * `App.task-cards.test.tsx` asserts against the mounted App.
   */
  // The store names the id field `id`; the wire row names it `sessionId`
  // (`InventorySessionSchema`). Mapped here rather than by loosening the module,
  // which is written against the frame, not against this reducer.
  const taskCards = taskCardsFromInventory(
    sessionState.sessions.map((s) => ({ sessionId: s.id, state: s.state })),
    activeSession,
    taskReceipt,
  );

  return (
    <div
      ref={cardRef}
      dir="rtl"
      data-testid="voxaura-shell"
      data-tauri-drag-region
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-lg border border-[#26282e] bg-[#141413] text-[#f4f4f5] vx-sketch-card"
      style={{ fontFamily: FONT }}
    >
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-3 border-b border-[#26282e] px-4 py-3"
      >
        <WaveformEmblem />
        <h1 data-testid="app-title" className="text-base font-semibold">
          Voxaura
        </h1>
        <span className="vx-kbd ms-1" title="اختصار فتح الإعدادات">
          Ctrl + ,
        </span>
        <span
          data-testid="bridge-status"
          data-state={statusPill.state}
          role="status"
          aria-live="polite"
          title={`حالة الاتصال: ${statusPill.text.replace('● ', '')}`}
          className="vx-mono-metric ms-auto truncate text-sm text-[#a1a1aa]"
        >
          {statusPill.text}
        </span>
      </header>

      {/* C.3 — the credit banner and the generic strip live OUTSIDE the bento's
          action slot, on purpose, and for one reason: `voice-disabled-no-keys`
          puts an "enter your keys" button in the strip, and `saveApiKeys` is one
          of the commands `serve-health.ts` deliberately does NOT gate. A renderer
          that `inert`ed its own escape hatch out of a dead-4096 outage would
          strand exactly the user the banner is meant to help. */}
      <CreditBanner state={credit} onDismiss={() => setCredit((s) => creditDismiss(s))} />

      {notice !== null && (
        <p
          data-testid="notice-banner"
          data-level={notice.level}
          role="alert"
          title={notice.detail}
          className="flex shrink-0 items-center gap-2 border-b border-[#26282e] bg-[#0e0f12] px-4 py-2 text-xs text-[#fbbf24]"
        >
          <span className="min-w-0 flex-1 truncate">{notice.detail}</span>
          {notice.code === 'voice-disabled-no-keys' && (
            <button
              data-testid="notice-open-keys"
              title="افتح نافذة مفاتيح الـ API"
              onClick={() => void openKeysWindow()}
              className="shrink-0 rounded-[6px] border border-[#2563eb] px-2 py-1 text-[#f4f4f5] hover:bg-[#2563eb]/10"
            >
              أدخل المفاتيح
            </button>
          )}
          <button
            data-testid="notice-dismiss"
            aria-label="إغلاق التنبيه"
            title="إغلاق"
            onClick={() => setNotice(null)}
            className="shrink-0 px-1 text-[#71717a] hover:text-[#f4f4f5]"
          >
            ✕
          </button>
        </p>
      )}

      {/* The column that actually has to FIT 600 px. `flex-1 min-h-0` on this
          wrapper is what lets the bento shrink below its content, so the credit
          banner and the notice strip above it cost the drawer height rather than
          pushing it out of the window. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Session-scoped controls, deliberately ABOVE the grid and outside the
            blocked slot. See the header note: `setSessionAgent` is not gated by
            the daemon, so it must not be gated here either. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
          <AgentModelBadge
            agent={agentModel.agent}
            model={agentModel.model}
            agents={agents}
            onSwitchAgent={handleSwitchAgent}
            onSelectAgent={handleSelectAgent}
            onSwitchModel={handleSwitchModel}
            compact
          />
          <ContextGauge
            {...(context !== null
              ? {
                  sessionId: context.sessionId,
                  used: context.used,
                  limit: context.limit,
                  percent: context.percent,
                }
              : {})}
            {...(typeof activeSession === 'string' && activeSession.length > 0
              ? { activeSessionId: activeSession }
              : {})}
          />
          {noSessions && (
            <p data-testid="empty-sessions" title="لا توجد جلسات بعد" className="truncate text-xs text-[#71717a]">
              لا توجد جلسات بعد — افتح جلسة في OpenCode لتظهر هنا.
            </p>
          )}
        </div>

        <BentoGrid
          sessions={sessionState.sessions}
          activeSessionId={activeSession}
          onSelectSession={handleSelectSession}
          taskCards={taskCards}
          terminalOpen={terminalOpen}
          onToggleTerminal={setTerminalOpen}
          terminalLines={terminalLines}
          reconnect={reconnect}
          onDismissReconnect={dismissReconnect}
          escape={
            /* THE ESCAPE SLOT. Two controls, and both are here for one reason:
             * each one's whole job is to STOP or SILENCE something that is
             * already happening, and neither needs 4096. `abort` and `arm` are
             * the first two entries in `SERVE_LOCAL_ONLY_COMMANDS` precisely
             * because of it, and `bot-toggle` sends nothing at all (W6 made it
             * renderer-local), so it is the one control here that no daemon
             * could ever refuse. Inside the blocked slot these were the three
             * controls a dead 4096 removed, and the middle one - the microphone -
             * is the only control in the row whose affordance a dead port
             * actually breaks. See `BentoGrid.tsx` for the rule. */
            <div className="flex min-w-0 items-center justify-center gap-3">
              <button
                data-testid="bot-toggle"
                aria-pressed={botMuted}
                aria-label="صوت المساعد"
                title={botMuted ? 'صوت المساعد مكتوم — اضغط للتشغيل' : 'صوت المساعد يعمل — اضغط للكتم'}
                onClick={toggleBotMute}
                className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border transition ${
                  botMuted
                    ? 'border-[#f87171] text-[#f87171]'
                    : 'border-[#26282e] bg-[#0e0f12] text-[#a1a1aa] hover:border-[#2563eb] hover:text-[#f4f4f5]'
                }`}
              >
                {botMuted ? <BotOffGlyph /> : <BotGlyph />}
              </button>
              <button
                data-testid="abort-button"
                title={live ? 'إيقاف التوليد فوراً' : 'بدء توليد جديد'}
                onClick={() => {
                  if (live) {
                    setMatrix(0);
                    send({ id: nextCmdId(), kind: 'abort' }, 'تعذّر إيقاف التوليد');
                  } else {
                    setMatrix(1);
                    send({ id: nextCmdId(), kind: 'arm' }, 'تعذّرت إعادة التوليد');
                  }
                }}
                className={`truncate rounded-[6px] border px-3 py-1 text-xs transition ${
                  live
                    ? 'border-[#f87171] text-[#f87171] hover:bg-[#f87171]/10'
                    : 'border-[#26282e] text-[#a1a1aa] hover:border-[#3b82f6] hover:text-[#f4f4f5]'
                }`}
              >
                {live ? 'إيقاف التوليد' : 'إعادة التوليد'}
              </button>
            </div>
          }
        >
          {/* THE ACTION SURFACE — App's, and the only thing the reconnect block
              takes `inert`. It is `shrink-0` by way of BentoGrid's slot, so it
              is also the part of the HUD that may never scroll away: the mic,
              the wave, the transcript and the persona picker. The stop and
              silence controls are NOT here; they are in the escape slot above,
              which is the whole point of the slot. */}
          <div className="flex min-w-0 flex-col items-center gap-3">
            <SiriWaveCanvas
              mode={live ? 'active' : 'idle'}
              palette={SPEAKER_PALETTE[waveSpeaker]}
              energy={userMuted ? 0 : micEnergy}
            />
            <div className="flex items-center gap-3" data-testid="control-row">
              <button
                data-testid="mic-toggle"
                aria-pressed={userMuted}
                aria-label="ميكروفون المستخدم"
                title={userMuted ? 'الميكروفون مكتوم — اضغط للتشغيل' : 'الميكروفون يعمل — اضغط للكتم'}
                onClick={toggleUserMute}
                className={`flex h-14 w-14 items-center justify-center rounded-full border transition ${
                  userMuted
                    ? 'border-[#f87171] text-[#f87171]'
                    : 'border-[#26282e] bg-[#0e0f12] text-[#a1a1aa] hover:border-[#2563eb] hover:text-[#f4f4f5]'
                }`}
              >
                {userMuted ? <MicOffGlyph /> : <MicGlyph />}
              </button>
            </div>
            <p
              data-testid="announce"
              role="status"
              aria-live="polite"
              title="آخر نتيجة أمر"
              className="w-full min-h-[16px] truncate text-center text-xs text-[#71717a]"
            >
              {announce}
            </p>
            {lastTranscript.length > 0 && (
              <p
                data-testid="last-transcript"
                title="آخر ما سُمع"
                className="w-full truncate text-center text-xs text-[#a1a1aa]"
              >
                «{lastTranscript}»
              </p>
            )}
            {speaking && (
              <p data-testid="speaking-indicator" title="المساعد يتحدث الآن" className="truncate text-xs text-[#34d399]">
                ● يتحدث الآن…
              </p>
            )}
            <div role="radiogroup" aria-label="شخصية الصوت" className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-xs text-[#71717a]">الصوت</span>
              {(['kareem', 'nour'] as const).map((p) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={persona === p}
                  data-testid={`hud-persona-${p}`}
                  title={p === 'kareem' ? 'كريم — الصوت الافتراضي' : 'نور — الصوت البديل'}
                  onClick={() => handleSelectPersona(p)}
                  className={`truncate rounded-[6px] border px-3 py-1 text-xs ${
                    persona === p
                      ? 'border-[#2563eb] text-[#f4f4f5]'
                      : 'border-[#26282e] text-[#a1a1aa] hover:text-[#f4f4f5]'
                  }`}
                >
                  {p === 'kareem' ? 'كريم' : 'نور'}
                </button>
              ))}
            </div>
          </div>
        </BentoGrid>
      </div>

      {/* C.6 — a third footer cell. `truncate` is not decoration and it is not
          about the window growing: at a 440 px base a label that wrapped to two
          lines would push the drawer and the session bar down a row for every
          user, forever, on a window they cannot shrink below that width. */}
      <div className="flex shrink-0 border-t border-[#26282e]">
        <button
          data-testid="open-settings"
          title="الإعدادات العامة (Ctrl + ,)"
          onClick={() => void openSettingsWindow(persona)}
          className="min-w-0 flex-1 truncate px-4 py-2.5 text-sm text-[#a1a1aa] hover:bg-[#1d1e23] hover:text-[#f4f4f5]"
        >
          الإعدادات
        </button>
        <span className="w-px bg-[#26282e]" />
        <button
          data-testid="open-apikeys"
          title="نافذة مفاتيح الـ API"
          onClick={() => void openKeysWindow()}
          className="min-w-0 flex-1 truncate px-4 py-2.5 text-sm text-[#a1a1aa] hover:bg-[#1d1e23] hover:text-[#f4f4f5]"
        >
          مفاتيح الـ API
        </button>
        <span className="w-px bg-[#26282e]" />
        <button
          data-testid="open-calibration"
          title="معايرة الميكروفون — قياس ضجيج الغرفة مقابل عتبة الكلام"
          onClick={() => setCalibrating(true)}
          className="min-w-0 flex-1 truncate px-2 py-2.5 text-xs text-[#a1a1aa] hover:bg-[#1d1e23] hover:text-[#f4f4f5]"
        >
          معايرة الميكروفون
        </button>
      </div>

      {calibrating && <CalibrationWizard onClose={() => setCalibrating(false)} />}

      {pendingConfirm !== null && (
        <ConfirmPortal
          title="تأكيد قبل التنفيذ"
          detail={pendingConfirm.detail}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      )}
    </div>
  );
}
