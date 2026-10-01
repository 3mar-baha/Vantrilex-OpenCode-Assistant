import { useCallback, useEffect, useRef, useState } from 'react';
import { VoxauraBridge, type BridgeOptions } from './bridge/ws.js';
import { BotGlyph, BotOffGlyph, MicGlyph, MicOffGlyph } from './components/icons/ControlGlyphs.js';
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
import { envToken, resolveIpcTokenWithRetry } from './settings/ipc-token.js';
import { ensureServices } from './settings/services.js';
import { openKeysWindow, openSettingsWindow } from './settings/open-settings.js';
import { Orb } from './orb/Orb.js';
import type { OrbPhase } from './orb/palette.js';
import './index.css';

// ── THE COMPANION WIDGET ──────────────────────────────────────────────────────
//
// A 380x380 dark square: a centred orb, a transport line, at most one message
// line, and a floating pill with EXACTLY three buttons. Nothing else renders.
//
// ── WHAT WAS REMOVED, AND WHERE IT WENT ───────────────────────────────────────
//
// The bento column is gone, and with it the surfaces it owned: session bar and
// chips, the agent/model badge, the context gauge, the task-card strip, the
// terminal drawer, the persona radio pair, the calibration trigger, the
// reconnect banner and the abort button. Every one of those COMPONENTS is still
// in the tree with its own suite (`BentoGrid`, `SessionBar`, `SessionChip`,
// `AgentModelBadge`, `ContextGauge`, `TaskCards`, `TerminalDrawer`,
// `SiriWaveCanvas`, `CalibrationWizard`, `ReconnectBanner`, `WaveformEmblem`,
// `ConfirmPortal`) — this file stopped rendering them. Only
// `App.bento.test.tsx`, `App.escape.test.tsx` and `App.task-cards.test.tsx`
// asserted them THROUGH the shell, and those three were composition suites
// rather than component suites; they were replaced by `App.shell.test.tsx`,
// `App.controls.test.tsx` and `App.orb.test.tsx`.
//
// CONSEQUENCES THAT ARE REAL, so nobody reads this shell as feature-complete:
//
//   · PERSONA IS NOT SWITCHABLE FROM HERE. `persona` is still synced BOTH ways
//     with the daemon (adopt on `hello`, follow `persona-changed`, and never
//     echoed back), so the orb always wears whoever is actually speaking — but
//     the switch itself lives in the settings window, reachable from this
//     widget by `Ctrl+,` only. The pill's third button opens the API-keys
//     window, not the settings window, which is what the brief specifies.
//   · THE CONFIRM PORTAL IS GONE. FR-12 parks a command only on
//     `tierOf(cmd.kind) === 'state-mutating'`, and this shell sends exactly one
//     command — `deafen`, which is serve-local and never gated. So the portal
//     could not be reached from here and is not rendered. Voice-initiated
//     destructive intent is unaffected: the daemon asks on its own turn and the
//     user answers with their voice (`command-router.ts` "the ask, ON THIS TURN").
//   · AN ABORT BUTTON NO LONGER EXISTS. Nothing in the shell can cancel a turn;
//     barge-in (`stopSpeech`) still can, from the microphone's frame handler.
//
// ── WHY THE ROOT IS `fixed … overflow-hidden`, AND WHY THAT IS SAFE HERE ──────
//
// `useAutoSize` is gone (the window is min-bounded and square, so content must
// not drive the OS frame) which means there is no longer anything that GROWS
// the window, and `overflow: hidden` on a fixed root is therefore a hard clip.
// The old comment justifying `overflow-hidden` for rounded corners is gone with
// it: this root has no rounded card to clip, and the clip exists for one
// reason — to stop a flex child from ever painting outside a fixed frame.
//
// The clip is made SAFE by three properties, not by hope:
//
//   1. There is NO scroll container in this tree any more, so nothing can be
//      pushed out of reach by content above it. The old design's overflow risk
//      was a growing column; a column of three regions does not grow.
//   2. Every region below the orb is `shrink-0` and its text `truncate`s, so a
//      long Arabic message can never push the pill down. The full string is on
//      `title`, so truncation costs the user a hover, never the text.
//   3. The orb's region is `flex-1 min-h-0`, so it is the ONLY element that can
//      yield, and it yields BEFORE anything else is clipped.
//
// The height arithmetic that makes (3) true at rest, in CSS px against the
// window's 380:
//     root padding-bottom (pb-3) ......... 12
//     pill .............................. 56   (h-14)
//     transport line (text-[11px]/4) .... 16 +  4 (pb-1)
//     message line (text-[11px]/4 + py-1)  16 +  8
//     credit banner (text-xs + py-2) ..... 16 + 16 +  1 (border)
//                                       ----
//     worst case ........................ 129   →  380 − 129 = 251 px of orb
// The credit banner and the message line are MUTUALLY EXCLUSIVE by
// construction — `onNotice` returns early for a credit code and never writes the
// generic notice — so 251 is the true floor, not an unreachable sum. `ORB_SIZE`
// is 232, which leaves 19 px of slack inside that floor. A taller orb would be
// clipped in exactly the state where the user most needs to read the message, so
// the slack is deliberate rather than leftover.
/**
 * The window edge this shell is composed for, and the orb's box inside it.
 *
 * Exported so `App.shell.test.tsx` can assert them against `tauri.conf.json`
 * rather than against a comment: a silent drift between the window the user
 * gets and the layout the code composes is invisible until a message gets
 * clipped, which is the one failure this shell cannot afford.
 */
export const SHELL_EDGE_PX = 380;
export const ORB_SIZE_PX = 232;

/**
 * Sample period for BOTH audio levels, in ms.
 *
 * The orb repaints at ~60 Hz and smooths internally (40 ms attack / 200 ms
 * release), so 12.5 Hz of input is far more than it can show, while a 60 Hz
 * analyser callback driving `setState` is a React render per frame for a
 * two-pixel difference.
 */
const LEVEL_SAMPLE_MS = 80;

/** Transport state, as the status line renders it. */
type BridgeState = 'connecting' | 'live' | 'degraded' | 'refused';

interface Notice {
  readonly code: string;
  readonly detail: string;
  readonly level: 'info' | 'warn' | 'error';
}

/**
 * The ONE line of message text, with its priority resolved.
 *
 * Priority is notice > announce, and both collapse into a single rendered line
 * so the widget has a hard height floor (see the root comment). `announce` is
 * the command-failure channel; a daemon notice about a real fault outranks a
 * failed command acknowledgement.
 *
 * `voice-disabled-no-keys` gets its sentence appended rather than a button. The
 * old strip carried a fourth control (`notice-open-keys`) for exactly this case;
 * this widget's pill has three buttons by specification, and the pill's third
 * button opens the SAME window that CTA opened. Naming it here is what keeps the
 * path discoverable — the strip is the thing that says a key is missing, so it
 * is where the instruction has to be.
 */
function noticeLineFor(notice: Notice | null, announce: string): Notice | null {
  if (notice !== null) {
    if (notice.code === 'voice-disabled-no-keys') {
      return {
        ...notice,
        detail: `${notice.detail} — افتح الإعدادات لإدخال المفاتيح`,
      };
    }
    return notice;
  }
  return announce.length > 0 ? { code: 'command', detail: announce, level: 'warn' } : null;
}

const FONT = 'var(--vx-font)';

export function App(): JSX.Element {
  const [bridge, setBridge] = useState<BridgeState>(envToken() !== undefined ? 'connecting' : 'degraded');
  const [persona, setPersona] = useState<'kareem' | 'nour'>('kareem');
  const [userMuted, setUserMuted] = useState(true);
  const [botMuted, setBotMuted] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  // M4 C.3 — the credit banner's own state, separate from `notice` so a credit
  // frame can NEVER be mistaken for a generic message (see CreditBanner.tsx).
  const [credit, setCredit] = useState<CreditState>(INITIAL_CREDIT);
  // `OrbPhase` and the bridge's own voice-phase union are the SAME four members,
  // so typing the state with the orb's type keeps the assignment checked in one
  // direction only: a daemon that grew a fifth phase would fail to compile here
  // rather than paint a colour the orb has no palette for.
  const [voicePhase, setVoicePhase] = useState<OrbPhase>('idle');
  const [micEnergy, setMicEnergy] = useState(0);
  const [outputEnergy, setOutputEnergy] = useState(0);
  /**
   * W23 — the daemon's backpressure latch, surfaced.
   *
   * The bridge already DROPPED every PCM chunk while paused (`ws.ts` `sendPcm`
   * returns false under the latch) and that drop is invisible from here: the mic
   * keeps running, the orb keeps saying `listening`, and the user is being
   * ignored with no indication that anything is wrong. That is the defect — not
   * the missing unsubscribe call, which is only how it was found.
   *
   * `null` means "the daemon has not said", which is a THIRD state and not
   * `false`. A daemon that predates the `flow` frame never reports either way,
   * and rendering "the uplink is fine" from an absent field is the same class of
   * false affordance as the `layaReady: true` claim. So the line below says
   * nothing about the uplink until the daemon has spoken.
   */
  const [uplinkPaused, setUplinkPaused] = useState<boolean | null>(null);

  const bridgeRef = useRef<VoxauraBridge | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  if (captureRef.current === null) captureRef.current = new AudioCapture();
  const playerRef = useRef<AudioPlayer | null>(null);
  // Ref mirror of "the assistant is audibly speaking", read from the
  // microphone's hot path where state is stale (the A1 barge gate).
  const speakingRef = useRef(false);
  const lastMicAt = useRef(0);
  const lastLevelAt = useRef(0);
  const personaRef = useRef(persona);
  const botMutedRef = useRef(botMuted);
  /**
   * A1 — the local uplink gate. One per component instance, held in a ref
   * because it is stateful (the post-utterance tail) and is read from the
   * microphone's hot path, where a re-created object would reset the tail and
   * starve the daemon's 5 s window mid-utterance.
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
   */
  useEffect(() => {
    botMutedRef.current = botMuted;
    playerRef.current?.setMuted(botMuted);
  }, [botMuted]);

  /**
   * Downlink energy into React state, sampled.
   *
   * A TERMINAL ZERO ALWAYS PASSES. `AudioPlayer.endLevel` publishes exactly `0`
   * when a run ends and on every `stop()` — which is also the path a mute and a
   * barge-in take — and it is the only thing that takes the orb's `speaking`
   * glow back down. Letting the throttle drop it would leave the widget showing
   * speech that ended minutes ago, so silence is exempt from the sampler and
   * every non-zero level is subject to it.
   */
  const pushOutputLevel = useCallback((level: number): void => {
    if (level !== 0) {
      const now = Date.now();
      if (now - lastLevelAt.current <= LEVEL_SAMPLE_MS) return;
      lastLevelAt.current = now;
    }
    setOutputEnergy(level);
  }, []);

  const nextCmdId = (): string => {
    cmdCounter.current += 1;
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `cmd-${Date.now()}-${cmdCounter.current}-${Math.floor(Math.random() * 1e6)}`;
  };

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
        if (!disposed) setBridge('degraded');
        return;
      }
      const options: BridgeOptions = {
        token,
        contractVersion: '3.1.0',
        // Any inbound frame proves the socket is alive: promote to live.
        onFrame: () => setBridge((s) => (s === 'refused' ? s : 'live')),
        onHello: (h) => {
          setBridge('live');
          // L22: the daemon is the source of truth for persona. A shell that
          // connects (or reconnects) after a change adopts it here instead of
          // sitting on the `kareem` default — the orb would otherwise paint the
          // wrong voice's colour for whoever is actually speaking.
          if (h.persona !== undefined && h.persona !== personaRef.current) {
            setPersona(h.persona);
          }
          // W23 — adopt the daemon's authoritative backpressure state on EVERY
          // connect, for the same reason the bridge latches it internally: a
          // `flow` frame raised while this shell was away is never retained, so
          // the first honest word about the uplink is the one in `hello`.
          // Presence-gated — an older daemon omits the field and the shell keeps
          // saying nothing, which is the pre-B.3 behaviour.
          if (typeof h.uplinkPaused === 'boolean') setUplinkPaused(h.uplinkPaused);
        },
        // W23 — the subscription that was missing. Without it the bridge's latch
        // still worked and the UI was still lying: the daemon asks the uplink to
        // pause, `sendPcm` starts dropping chunks, and nothing anywhere in the
        // renderer learns that the microphone it is showing as live is deaf.
        onFlow: (f) => setUplinkPaused(f.state === 'pause'),
        onNotice: (n) => {
          // C.3: a credit notice takes the dedicated banner INSTEAD of the
          // message line. Both would otherwise show the same Arabic sentence
          // twice, and it is this early return that makes the two mutually
          // exclusive — which the root comment's height arithmetic depends on.
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
          // notice, which re-arms it.
          setCredit((s) => creditVoice(s, v.phase));
        },
        onErrorFrame: (detail) => setNotice({ code: 'transport', detail, level: 'error' }),
        onAudio: (bytes) => {
          if (playerRef.current === null) {
            try {
              playerRef.current = createDefaultPlayer({
                // M2 Pattern 3: this is the ONE place the renderer tells the
                // daemon audio actually started, and it fires ONCE per run.
                // Fire-and-forget on purpose: `void`, never awaited.
                onStart: (playbackId) => {
                  speakingRef.current = true;
                  const live = bridgeRef.current;
                  if (live !== null) {
                    void live.sendCommand({
                      id: nextCmdId(),
                      kind: 'playbackStarted',
                      ...(playbackId !== undefined ? { playbackId } : {}),
                    });
                  }
                },
                onEnd: () => {
                  window.setTimeout(() => {
                    speakingRef.current = false;
                  }, 1500);
                },
                // The orb's output ring. `onLevel` and not a renamed
                // `onEnergy` on purpose — see `playback.ts`, which documents
                // why the two directions must not share one name at the one
                // call site that consumes both.
                onLevel: pushOutputLevel,
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
  }, [pushOutputLevel]);

  // Transport-truth watchdog. The line is driven by the socket's own state: an
  // idle-but-OPEN socket must never read as disconnected. Only a genuinely
  // closed socket demotes; any inbound frame promotes back to live.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const client = bridgeRef.current;
      if (client === null) return;
      if (!client.live) setBridge((s) => (s === 'refused' ? s : 'degraded'));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  // `Ctrl+,` is the ONLY route to the settings window from here, and therefore
  // the only route to the persona switch (see the header note). It is kept for
  // that reason alone; the widget itself carries no fourth button.
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
   * is safe to call from a `visibilitychange` handler.
   */
  const startMic = useCallback((): void => {
    const capture = captureRef.current;
    if (capture === null) return;
    void capture
      .start({
        onEnergy: (energy) => {
          const now = Date.now();
          if (now - lastMicAt.current > LEVEL_SAMPLE_MS) {
            lastMicAt.current = now;
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
          // M2 Pattern 2: the barge sends `stopSpeech`, not `abort`.
          //
          // M3 B.3: `sendPcm`'s `false` means the daemon is applying
          // backpressure and the frame was dropped on purpose. Do NOT "fix"
          // that by stopping the capture.
          const gate = uplinkGateRef.current;
          const verdict = gate?.decide(bytes, { speaking: speakingRef.current });
          if (verdict === undefined || !verdict.send) return;
          if (verdict.barge) {
            playerRef.current?.stop();
            speakingRef.current = false;
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
   * asked for it, so a HIDDEN window releases the hardware track. `userMuted`
   * is deliberately untouched, so the user's own choice survives.
   */
  useEffect(() => {
    const onVisibility = (): void => {
      const action = micPolicy(document.visibilityState === 'hidden' ? 'hidden' : 'visible', userMuted);
      if (action === 'release') captureRef.current?.stop();
      else if (action === 'start') startMic();
    };
    // `blur` is registered too because a minimise does not always fire
    // `visibilitychange` in WebView2.
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onVisibility);
    };
  }, [userMuted, startMic]);

  /**
   * Phase 5 — ZERO CANNED REPLIES. Only the FAILURE text is local; a success is
   * spoken by the daemon's own model and reaches this widget as a notice.
   */
  const toggleUserMute = (): void => {
    const next = !userMuted;
    setUserMuted(next);
    const capture = captureRef.current;
    if (capture !== null) {
      if (next) {
        capture.stop();
        // A1: the tail is a debt to the daemon's 5 s window, and a muted
        // microphone stops paying it. Carrying it across a mute would transmit
        // up to 5.6 s of room tone the moment the user unmutes.
        uplinkGateRef.current?.reset();
      } else {
        startMic();
      }
    }
    const client = bridgeRef.current;
    if (client === null) {
      setAnnounce('الخادم غير متصل');
      return;
    }
    void client.sendCommand({ id: nextCmdId(), kind: 'deafen' });
  };

  /**
   * W6 — assistant mute is RENDERER-LOCAL, and that is the whole fix.
   *
   * It used to `send({kind:'mute'})`. The daemon's router answers `mute`,
   * `deafen` and `arm` in one arm with no side effect at all
   * (`src/orchestrator/command-router.ts:227-230`) and returns `ok:true`, so
   * the button acknowledged a success it did not deliver and then cost a free-
   * tier Inkling narration describing a microphone that was never silenced.
   * A control the daemon does not own cannot be confirmed by the daemon, so the
   * renderer applies the mute itself.
   */
  const toggleBotMute = (): void => {
    const next = !botMuted;
    setBotMuted(next);
    // Applied here as well as in the effect so the gate moves on the same tick
    // as the click, and so a mute pressed before the player exists is still
    // recorded for the lazy `onAudio` path.
    botMutedRef.current = next;
    playerRef.current?.setMuted(next);
    // `setMuted` fires `onEnd`, which only clears the ref after a 1500 ms latch
    // — so for a second and a half a silenced widget would still claim to be
    // talking. Barge-in clears it outright for the same reason.
    if (next) speakingRef.current = false;
  };

  /**
   * `speaking` is what the orb and the line must agree on, so it is derived
   * once and both read the same value: the daemon's phase GATED ON AUDIBILITY.
   *
   * W6 again, in the phase domain: the daemon keeps reporting `speaking` for as
   * long as it synthesises, which after a mute is a claim about the future
   * rather than about the speakers. Muted, the orb holds `thinking` — the turn
   * is still real and still running, it is simply not audible — which is also
   * the only reading under which the orb's persona colours mean anything.
   */
  const orbPhase: OrbPhase = botMuted && voicePhase === 'speaking' ? 'thinking' : voicePhase;

  /**
   * The transport line. ONE line, so every state is a priority rather than a
   * layout — see the root comment's height arithmetic, which a second line would
   * break.
   *
   * W23, and the priority is the whole design. A paused uplink overrides
   * EXACTLY ONE branch: the one that claims the orb is listening. That claim is
   * the false one — the daemon has stopped accepting audio, so a live-looking
   * `listening` line is the user talking into a void. It does NOT override
   * `speaking` or `thinking`, because those are true while the uplink is paused
   * (the assistant is talking; the pause is about the user's audio, not the
   * assistant's) and overriding them would trade one lie for another. And it does
   * not override `offline`, which is the more severe truth.
   *
   * The text is deliberately explicit that the microphone is MUTED BY THE SERVER
   * rather than by the user, because the obvious user response is to press the
   * mic button — which would silence a microphone the daemon is already refusing.
   */
  const status =
    bridge !== 'live'
      ? { text: '● غير متصل', state: 'offline' }
      : orbPhase === 'speaking'
        ? { text: '● يتحدث الآن…', state: 'speaking' }
        : orbPhase === 'thinking'
          ? { text: '● جارٍ التفكير…', state: 'processing' }
          : uplinkPaused === true
            ? { text: '● الخادم علّق الميكروفون — الالتقاط متوقف مؤقتاً', state: 'uplink-paused' }
            : orbPhase === 'listening' || !userMuted
              ? { text: '● جارٍ الاستماع…', state: 'listening' }
              : { text: '● متصل وبانتظار الأوامر', state: 'ready' };

  const line = noticeLineFor(notice, announce);

  return (
    <div
      dir="rtl"
      data-testid="voxaura-shell"
      data-tauri-drag-region
      className="fixed inset-0 flex flex-col overflow-hidden bg-[#09090b] text-[#f4f4f5]"
      style={{ fontFamily: FONT }}
    >
      {/* The ONLY region that may shrink. Named so `App.shell.test.tsx` can
          assert the property the clip above depends on — that nothing else in
          this column can be pushed out of a 380 px frame. */}
      <div
        data-testid="orb-region"
        className="flex min-h-0 flex-1 items-center justify-center"
        data-tauri-drag-region
      >
        <Orb
          phase={orbPhase}
          persona={persona}
          // Both levels are gated on the mute that silences them. A muted mic
          // reports no energy, but the last reading it DID report is still in
          // state, and a lit input ring on a released microphone is the same
          // lie as a lit output ring on a muted speaker.
          inputLevel={userMuted ? 0 : micEnergy}
          outputLevel={botMuted ? 0 : outputEnergy}
          size={ORB_SIZE_PX}
        />
      </div>

      <p
        data-testid="bridge-status"
        data-state={status.state}
        role="status"
        aria-live="polite"
        title={`حالة الاتصال: ${status.text.replace('● ', '')}`}
        className="vx-mono-metric shrink-0 truncate px-4 pb-1 text-center text-[11px] leading-4 text-[#a1a1aa]"
      >
        {status.text}
      </p>

      <CreditBanner state={credit} onDismiss={() => setCredit((s) => creditDismiss(s))} />

      {line !== null && (
        <p
          data-testid="notice-banner"
          data-level={line.level}
          role="alert"
          // The full sentence, so a `truncate` costs a hover and never the text.
          title={line.detail}
          className="shrink-0 truncate px-4 py-1 text-center text-[11px] leading-4 text-[#fbbf24]"
        >
          {line.detail}
        </p>
      )}

      {/* EXACTLY THREE BUTTONS. The mic and the assistant's voice are the two
          directions the widget owns, and the third opens the keys window — the
          same window the removed `notice-open-keys` control opened, which is why
          dropping that control costs no capability. */}
      <div
        data-testid="control-row"
        className="flex shrink-0 items-center justify-center gap-2 px-4 pb-3 pt-1"
      >
        <button
          data-testid="mic-toggle"
          aria-pressed={userMuted}
          aria-label="ميكروفون المستخدم"
          title={userMuted ? 'الميكروفون مكتوم — اضغط للتشغيل' : 'الميكروفون يعمل — اضغط للكتم'}
          onClick={toggleUserMute}
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border transition ${
            userMuted
              ? 'border-[#f87171] text-[#f87171]'
              : 'border-[#26282e] bg-[#0e0f12] text-[#a1a1aa] hover:border-[#2563eb] hover:text-[#f4f4f5]'
          }`}
        >
          {userMuted ? <MicOffGlyph /> : <MicGlyph />}
        </button>
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
          data-testid="open-keys"
          aria-label="مفاتيح الـ API"
          title="مفاتيح الـ API — أضف مفاتيح Groq و Fish و OpenRouter لتفعيل الصوت"
          onClick={() => void openKeysWindow()}
          className="min-w-0 shrink-0 truncate rounded-full border border-[#26282e] bg-[#0e0f12] px-4 text-xs text-[#a1a1aa] transition hover:border-[#2563eb] hover:text-[#f4f4f5]"
        >
          مفاتيح الـ API
        </button>
      </div>
    </div>
  );
}