import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OrchestratorError } from './common/errors.js';
import { loadConfig } from './common/config.js';
import type { SessionId } from './common/brands.js';
import { VOICE_IDS } from './common/brands.js';
import { UiServer } from './ipc/index.js';
import { ServeClient } from './runtime/index.js';
import { SessionInventory } from './orchestrator/inventory.js';
import { AudioPipeline } from './orchestrator/audio-pipeline.js';
import { Coordinator, INTAKE_MODEL, type ChatFn } from './orchestrator/coordinator.js';
import { FishHttpTransport, isSpeakable, SpeechGate, splitSentences, stripSpeechText } from './voice/tts.js';
import { openRouterChat } from './voice/brain.js';
import { narrate, NARRATOR_MODEL, type NarratorChat } from './orchestrator/narrator.js';
import { OpenCodeBridge } from './runtime/opencode-bridge.js';
import { createCommandHandler } from './orchestrator/command-router.js';
import { describeSlashCommands, parseSlashCommand, slashCommandError } from './orchestrator/slash.js';
import { mentionSummary, resolveMentions } from './orchestrator/mentions.js';
import { isActionableInstruction, optimizePrompt } from './orchestrator/prompt-optimizer.js';
import { probeHealth } from './launcher/index.js';
import { FileVault } from './voice/vault.js';
import { Keyring, type AcquiredKey } from './voice/keyring.js';
import { GroqWhisperClient, transcribeStream } from './voice/stt.js';
import { bytesToFloat32, isLoudWindow } from './voice/ingest.js';
// NOT imported statically. `runtime/vad.js` pulls in `onnxruntime-node`, a
// native module the sidecar does not bundle, so a static import made a missing
// package a hard module-load failure: the daemon died with ERR_MODULE_NOT_FOUND
// and never bound 4097. Found by cold-launching the real installer, not by the
// gates. The dynamic import below degrades to the RMS energy gate instead, which
// is the fail-closed behaviour the design always intended.
// VAD_WINDOW_SAMPLES is a plain constant (512), mirrored here to keep the frame
// geometry local and avoid loading the module just to read a number.
const VAD_WINDOW_SAMPLES = 512;
type SileroVadLike = {
  isSpeech(window: Float32Array): Promise<boolean>;
  reset(): void;
};
import { writeKeyPools } from './voice/key-store.js';
import { TelemetryWriter } from './telemetry/index.js';
import type { SanitizedErrorClass, TelemetryInput } from './telemetry/index.js';

// Production daemon — the missing composition root. It adopts an already-running
// `opencode serve` (single-supervisor rule: it never fights one), owns the
// WS-4097 UiServer, streams session inventory to the shell, and executes renderer
// commands against the live ServeClient. Keys saved from the UI land in the
// encrypted vault through the key-store adapter (never in logs, never in memory
// longer than the call).
export interface DaemonOptions {
  readonly servePort: number;
  readonly servePassword: string;
  readonly ipcToken: string;
  readonly ipcPort: number;
  readonly contractVersion?: string;
  readonly inventoryIntervalMs?: number;
  readonly vaultPath: string;
  readonly directory?: string;
}

export interface DaemonHandle {
  readonly ipcPort: number;
  readonly servePort: number;
  readonly token: string;
  /** Publish a session snapshot to every connected shell. */
  publishSessions(): Promise<number>;
  /** The persona the daemon currently speaks with (real server-side state). */
  activePersona(): 'kareem' | 'nour';
  stop(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  if (options.servePassword.length === 0) {
    throw new OrchestratorError('CONFIG_INVALID', false, 'OPENCODE_SERVER_PASSWORD is required');
  }
  if (options.ipcToken.length === 0) {
    throw new OrchestratorError('CONFIG_INVALID', false, 'IPC token is required (fail-closed)');
  }
  if (!(await probeHealth(options.servePort, options.servePassword))) {
    throw new OrchestratorError(
      'SERVE_UNREACHABLE',
      true,
      `no healthy opencode serve on 127.0.0.1:${options.servePort}`,
    );
  }

  const client = new ServeClient(`http://127.0.0.1:${options.servePort}`, options.servePassword);
  // Phase 5: the 360° control surface over the same client.
  const bridge = new OpenCodeBridge(client, options.directory ?? process.cwd());
  // Mention resolution needs the agent/skill catalog. Fetched once and reused:
  // these change only on a config edit, and a turn that waited on two HTTP
  // round-trips before it could transcribe would blow the speech budget. A failed
  // fetch yields empty lists, which makes every `@name` fall through to the
  // file branch and then be rejected - degraded, never unsafe.
  let envCachePromise: Promise<{ agents: readonly string[]; skills: readonly string[] }> | null = null;
  const envCache = (): Promise<{ agents: readonly string[]; skills: readonly string[] }> => {
    if (envCachePromise === null) {
      envCachePromise = bridge
        .getEnvironmentStatus()
        .then((env) => ({ agents: env.agents.map((a) => a.id), skills: env.skills }))
        .catch(() => ({ agents: [], skills: [] }) as const);
    }
    return envCachePromise;
  };
  const ui = new UiServer({
    token: options.ipcToken,
    contractVersion: options.contractVersion ?? '3.1.0',
  });

  let activeSession: SessionId | undefined;
  // Prompt optimization is bounded: it is a cosmetic improvement on top of an
  // utterance that is already dispatchable, so a slow provider must never cost the
  // turn. 8 s sits under the 10 s intake budget and well over the 901 ms p50.
  const OPTIMIZER_TIMEOUT_MS = 8_000;
  let activePersona: 'kareem' | 'nour' = 'kareem';
  const vault = new FileVault(options.vaultPath);
  // Barge-in generation gate: trips on `abort` so stale reply sentences never
  // synthesize or broadcast afterwards. Plain state — safe before key setup.
  const speechGate = new SpeechGate();

  // Phase 5 — ZERO CANNED REPLIES.
  //
  // Previously each command site passed a literal like 'تم تبديل النموذج' as its
  // success message, so every confirmation was a template the user could recite.
  // Now the outcome of a command goes to the conversational model, which writes
  // the line from the situation, and THAT is what is spoken and shown.
  //
  // If the brain is unavailable the narration is simply skipped: a visible
  // silence beats a robotic sentence, and the notice banner still reports the
  // outcome.
  const narratorChat: NarratorChat = async (model, system, user, options) => {
    const ring = Keyring.load(vault);
    const key = ring.acquire('openrouter');
    try {
      return openRouterChat(
        keyMaterial(key),
        model,
        system,
        user,
        fetch,
        {
          temperature: 0.8,
          // 90 was sized for a bare prose line. The strict JSON wrapper plus a
          // ~20-word Arabic reply needs headroom: a truncation mid-JSON is an
          // unparseable reply, i.e. silence, so margin here is audibility.
          maxTokens: 120,
          timeoutMs: 8_000,
          // Inkling is a reasoning model: without effort:none it spends the
          // token budget thinking and returns finish=length with content=null
          // (measured live). Same suppression the Dots3 intake uses.
          reasoning: { effort: 'none' },
          ...(options?.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
        },
      );
    } finally {
      ring.release(key, true);
    }
  };

  const narrateOutcome = (action: string, outcomeOk: boolean, errorDetail?: string, target?: string): void => {
    void (async () => {
      let sessionTitle: string | undefined;
      let contextPercent: number | undefined;
      let currentModel: string | undefined;
      if (activeSession !== undefined) {
        try {
          const details = await bridge.getSessionDetails(activeSession);
          sessionTitle = details?.title;
          contextPercent = details?.tokens.percent ?? undefined;
          currentModel = details?.model ?? undefined;
        } catch {
          // Telemetry is decoration for the narrator; never fail the command.
        }
      }
      const line = await narrate(
        {
          action,
          outcome: outcomeOk ? 'ok' : 'error',
          ...(target !== undefined ? { target } : {}),
          ...(sessionTitle !== undefined ? { sessionTitle } : {}),
          ...(currentModel !== undefined ? { previousModel: currentModel } : {}),
          ...(contextPercent !== undefined ? { contextPercent } : {}),
          ...(errorDetail !== undefined ? { errorDetail } : {}),
        },
        narratorChat,
        NARRATOR_MODEL,
      );
      if (line === null) return;
      setVoicePhase('speaking', line);
      // The same generated line is both spoken and displayed: one source, so
      // the screen can never show a template the user did not hear.
      ui.notice('assistant-said', line, 'info');
    })();
  };

  ui.onCommand = createCommandHandler({
    client,
    // Phase 4: the project root serve is scoped to, and the directory a new
    // session is created in. Never taken from the command payload.
    projectDirectory: () => options.directory ?? process.cwd(),
    onContext: (sessionId, usage) => {
      ui.context(sessionId, usage.used, usage.limit, usage.percent, usage.messageCount);
    },
    onExecuted: (executed, outcome) => {
      const target =
        typeof executed.model === 'string'
          ? executed.model
          : typeof executed.agent === 'string'
            ? executed.agent
            : typeof executed.sessionId === 'string'
              ? executed.sessionId
              : undefined;
      narrateOutcome(
        executed.kind,
        outcome.ok,
        outcome.detail,
        target,
      );
    },
    switchSession: (id) => {      activeSession = id;
      audio?.reset();
    },
    activeSessionId: () => activeSession,
    setPersona: (persona) => {
      activePersona = persona;
    },
    onAbort: () => speechGate.abort(),
    saveKeys: {
      saveKeys: async (keys) => {
        writeKeyPools(vault, {
          groq: [keys.groq],
          fish: [keys.fish],
          openrouter: [keys.openrouter],
        });
        // Activate the voice loop immediately — no restart required.
        rebuildVoice();
        return { ok: true, detail: audio === null ? 'keys-saved-voice-unavailable' : 'keys-saved-voice-active' };
      },
    },
  });

  // Voice capture pipeline (P4+P5): binary PCM → Whisper transcript →
  // 3-agent chain (Dots3 intake → Inkling plan → Inkling handoff). Built from
  // the vault; kept REBUILDABLE so keys saved from the UI activate the voice
  // loop without a restart. A keyless daemon keeps the control plane up, drops
  // audio, and tells the shell to show the first-run call to action.
  const keyMaterial = (key: AcquiredKey): string => Buffer.from(key.material).toString('utf8');
  /**
   * Machine diagnostics (was built and never called — the observability hole
   * from the audit's §3.4).
   *
   * The schema is a closed union with NO transcript or free-text field, so
   * adversarial voice input cannot reach an agent through this channel. Every
   * call is wrapped: telemetry must never be able to break the voice loop it is
   * measuring, and a diagnostics bus that can crash the product is worse than
   * none.
   */
  const telemetry = new TelemetryWriter(join(homedir(), '.opencode-voice-runtime', 'voice-runtime.jsonl'));
  const record = (input: Omit<TelemetryInput, 'sessionId' | 'eventId'>): void => {
    try {
      telemetry.record({ sessionId: activeSession ?? 'none', eventId: randomUUID(), ...input });
    } catch {
      // Deliberately swallowed — see above.
    }
  };
  /** Map a thrown value to the closed error-class union. Never leaks a message. */
  const classify = (err: unknown): SanitizedErrorClass => {
    if (err instanceof OrchestratorError) {
      // Only reachable now that the brain stops reporting every failure as
      // BRAIN_TIMEOUT (L24). Before that, quota exhaustion — the live blocker —
      // was indistinguishable from a slow network here.
      if (err.code === 'RATE_LIMITED') return 'QuotaExceeded';
      if (err.code === 'BRAIN_AUTH') return 'AuthError';
      if (err.code === 'BRAIN_REJECTED') return 'FetchError';
      if (err.code === 'SERVE_UNREACHABLE' || err.code === 'SSE_DISCONNECTED') return 'FetchError';
      if (err.code === 'CONFIG_INVALID' || err.code === 'HIGH_STAKES_CONFIRM_REQUIRED') return 'AuthError';
      if (err.code === 'CONTRACT_DRIFT') return 'ContractDrift';
    }
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') return 'TimeoutError';
    if (name === 'ZodError') return 'ZodError';
    if (name === 'TypeError' && err instanceof Error && /fetch|network|socket/i.test(err.message)) return 'FetchError';
    return 'Unknown';
  };

  let audio: AudioPipeline | null = null;
  let voicePhase = 'idle';

  // D1 — the speech gate. `SileroVad` (src/runtime/vad.ts) and its ONNX model
  // were already built and tested, but nothing in production ever called them:
  // every 5 s window of room tone went straight to Whisper, which hallucinated,
  // and the assistant then reasoned about and spoke the invented text.
  //
  // The load is memoised and the gate is sync-constructible so
  // `buildVoicePipeline` (and therefore the saveApiKeys rebuild path) stays
  // synchronous. Fail-closed: a missing or unloadable model falls back to the
  // RMS energy gate in `ingest.ts`, never to "transcribe everything".
  let vadLoad: Promise<SileroVadLike | null> | null = null;
  const loadVad = (): Promise<SileroVadLike | null> => {
    if (vadLoad === null) {
      const cfg = loadConfig();
      // The import itself can fail (missing native package in the sidecar), so
      // it lives inside the promise where `.catch` can actually see it.
      vadLoad = import('./runtime/vad.js')
        .then((m) => m.SileroVad.load(cfg.vad.modelPath, { threshold: cfg.vad.threshold }) as Promise<SileroVadLike>)
        .catch(() => null);
    }
    return vadLoad;
  };

  const vadGate = async (window: Uint8Array): Promise<boolean> => {
    const vad = await loadVad();
    if (vad === null) return isLoudWindow(window);
    // A 5 s window is 156 Silero frames; any speech frame admits the window.
    const frames = Math.floor(window.byteLength / 2 / VAD_WINDOW_SAMPLES);
    for (let f = 0; f < frames; f += 1) {
      const frame = bytesToFloat32(window, f * VAD_WINDOW_SAMPLES * 2, VAD_WINDOW_SAMPLES);
      if (await vad.isSpeech(frame)) return true;
    }
    return false;
  };

  const setVoicePhase = (phase: 'idle' | 'listening' | 'thinking' | 'speaking', transcript?: string): void => {
    if (phase === voicePhase && transcript === undefined) return;
    voicePhase = phase;
    ui.voice(phase, transcript);
  };

  const buildVoicePipeline = (): AudioPipeline | null => {
    try {
      const ring = Keyring.load(vault);
      const fish = new FishHttpTransport(ring);
      const chat: ChatFn = async (model, system, user, options) => {
        const key = ring.acquire('openrouter');
        try {
          return await openRouterChat(keyMaterial(key), model, system, user, fetch, {
            ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
            ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options?.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
          });
        } finally {
          ring.release(key, true);
        }
      };
      const coordinator = new Coordinator({
        chat,
        // D4: deliberately no `speak` hook. It used to route the reply through
        // TtsEngine + FileAudioOut, which wrote an MP3 to %TEMP% that nothing
        // ever played — so every utterance was synthesised TWICE (double Fish
        // quota, ~1-2 s of dead work) and the coordinator awaited it before
        // planning. The single audible path is `onUtterance` below.
        dispatch: async (text) => {
          const session = activeSession as SessionId;
          return client.promptSession(session, text, { origin: 'voice', actor: 'capture' });
        },
        activeSessionId: () => activeSession,
      });
      return new AudioPipeline({
        speechGate: vadGate,
        transcribe: async (pcm) => {
          // D13: the phase moved to 'thinking' on EVERY incoming window, so the
          // HUD flickered listening→thinking 10×/s. It is now set in `think`,
          // which runs only for a window that survived the speech gate.
          const key = ring.acquire('groq');
          const t0 = Date.now();
          try {
            const res = await transcribeStream(pcm, new GroqWhisperClient(keyMaterial(key)));
            record({ subsystem: 'STT', status: 'OK', latencyMs: Date.now() - t0 });
            // D1: surface no_speech_prob so the pipeline can drop a window
            // Whisper itself believes was not speech.
            return res.noSpeechProb === undefined
              ? res.text
              : { text: res.text, noSpeechProb: res.noSpeechProb };
          } catch (err) {
            record({
              subsystem: 'STT',
              status: 'ERROR',
              latencyMs: Date.now() - t0,
              errorCode: 'STT_FAILED',
              sanitizedErrorClass: classify(err),
            });
            ui.notice('stt-failed', `تعذّر تحويل الكلام إلى نص: ${err instanceof Error ? err.message : 'خطأ'}`, 'error');
            throw err;
          } finally {
            ring.release(key, true);
          }
        },
        think: async (transcript) => {
          setVoicePhase('thinking', transcript);
          const t0 = Date.now();
          // A spoken `/command` is handled natively and NEVER reaches a model.
          // Forwarding `/rm -rf /` as prose to a planning agent is how a typo
          // becomes an incident. The HUD is voice-only, so a slash arrives here
          // as a transcript rather than as a WS command — which is exactly why
          // this seam is the daemon and not the command router.
          const slash = parseSlashCommand(transcript);
          if (slash !== null) {
            const invalid = slashCommandError(transcript);
            if (invalid !== null) {
              ui.notice('slash-invalid', invalid, 'warn');
              record({ subsystem: 'BRAIN', status: 'DEGRADED', latencyMs: Date.now() - t0, errorCode: 'CONFIG_INVALID' });
              return { reply: invalid };
            }
            if (slash.name === 'help') {
              const help = describeSlashCommands().join(' · ');
              ui.notice('slash-help', help, 'info');
              return { reply: help };
            }
            if (slash.name === 'compact') {
              if (activeSession === undefined) {
                const msg = 'ما في جلسة نشطة — ما في شي نضغطه';
                ui.notice('slash-no-session', msg, 'warn');
                return { reply: msg };
              }
              await client.compactSession(activeSession);
              record({ subsystem: 'BRAIN', status: 'OK', latencyMs: Date.now() - t0 });
              return { reply: 'ضغطنا الجلسة، نافذة السياق خفّت' };
            }
            if (slash.name === 'new') {
              const created = await client.createSession(options.directory ?? process.cwd());
              activeSession = created.sessionId;
              await publishSessions();
              record({ subsystem: 'BRAIN', status: 'OK', latencyMs: Date.now() - t0 });
              // ServeClient exposes no rename endpoint, so a trailing argument is
              // acknowledged but NOT persisted. Saying otherwise would be a lie
              // the user discovers on the next session list.
              const suffix = slash.args.length > 0 ? ` — ${slash.args.slice(0, 60)}` : '';
              return { reply: `فتحنا جلسة جديدة${suffix}` };
            }
            // Unreachable: slashCommandError rejects an unknown name first.
            const msg = 'أمر غير معروف';
            ui.notice('slash-invalid', msg, 'warn');
            return { reply: msg };
          }
          // `@file` / `@agent` / `@skill` are resolved BEFORE the text reaches
          // any model. A rejected token must never survive as prose — that is the
          // whole point of the resolver, and re-introducing the raw text here
          // would hand a traversal attempt straight to the planning agent.
          //
          // The catalog is memoised per daemon lifetime: a mention is resolved
          // at most once per turn, and re-fetching agents/skills on every
          // utterance would put two HTTP round-trips on the interactive path.
          let spoken = transcript;
          let resolvedMentions = '';
          if (transcript.includes('@')) {
            try {
              const env = await envCache();
              const mentions = resolveMentions(transcript, {
                root: options.directory ?? process.cwd(),
                agents: env.agents,
                skills: env.skills,
              });
              spoken = mentions.clean;
              resolvedMentions = mentionSummary(mentions);
              if (mentions.files.length > 0 || mentions.agents.length > 0 || mentions.skills.length > 0) {
                // Machine context, never a sentence for the user to hear.
                const attached = [
                  mentions.files.length > 0 ? `files=${mentions.files.join(',')}` : '',
                  mentions.agents.length > 0 ? `agents=${mentions.agents.join(',')}` : '',
                  mentions.skills.length > 0 ? `skills=${mentions.skills.join(',')}` : '',
                ]
                  .filter((s) => s.length > 0)
                  .join(' ');
                spoken = `${spoken}\n[mentions: ${attached}]`;
              }
            } catch (err) {
              // Telemetry is decoration; a catalog failure must not eat the turn.
              // Fall through with the raw transcript: degradation, not silence.
              spoken = transcript;
              record({
                subsystem: 'BRAIN',
                status: 'DEGRADED',
                latencyMs: Date.now() - t0,
                errorCode: 'SESSION_NOT_FOUND',
                sanitizedErrorClass: classify(err),
              });
            }
          }
          // A spoken instruction is messy: filler, pronouns, half-formed
          // references to what's on screen. The optimizer rewrites it into a
          // dispatchable brief.
          //
          // The gate is `isActionableInstruction`, and it is NOT optional: an
          // acknowledgement ("تمام") must never become a task, or the assistant
          // starts acting on the user's politeness. That check is synchronous
          // and free, so the common case costs one provider call less.
          let task = spoken;
          if (isActionableInstruction(spoken)) {
            const tOpt = Date.now();
            try {
              const key = ring.acquire('openrouter');
              try {
                task = await optimizePrompt(
                  spoken,
                  (model, system, user) =>
                    openRouterChat(keyMaterial(key), model, system, user, fetch, {
                      reasoning: { effort: 'none' },
                      timeoutMs: OPTIMIZER_TIMEOUT_MS,
                    }),
                  INTAKE_MODEL,
                  {},
                );
                record({ subsystem: 'BRAIN', status: 'OK', latencyMs: Date.now() - tOpt, remediationAttempted: 'None' });
              } finally {
                ring.release(key, true);
              }
            } catch (err) {
              // Graceful fallback is the USER'S OWN WORDS, never a template:
              // optimizePrompt already returns the utterance on failure, and a
              // degraded prompt is still honest.
              task = spoken;
              record({
                subsystem: 'BRAIN',
                status: 'DEGRADED',
                latencyMs: Date.now() - tOpt,
                errorCode: 'BRAIN_TIMEOUT',
                sanitizedErrorClass: classify(err),
              });
            }
          }
          try {
            const mission = await coordinator.run(task);
            record({
              subsystem: 'BRAIN',
              status: 'OK',
              latencyMs: Date.now() - t0,
              ...(resolvedMentions.length > 0 ? { remediationAttempted: 'None' as const } : {}),
            });
            const reply = mission.replyAr ?? '';
            return mission.receipt === null ? { reply } : { reply, receipt: mission.receipt };
          } catch (err) {
            record({
              subsystem: 'BRAIN',
              status: 'ERROR',
              latencyMs: Date.now() - t0,
              errorCode: 'BRAIN_FAILED',
              sanitizedErrorClass: classify(err),
            });
            ui.notice('brain-failed', `تعذّر توليد الرد: ${err instanceof Error ? err.message : 'خطأ'}`, 'error');
            throw err;
          }
        },
        activeSessionId: () => activeSession,
        // D5: a stalled provider costs one window, not the session, and the
        // shell is told so the silence is not read as a bug.
        onSttTimeout: (ms) => {
          record({
            subsystem: 'STT',
            status: 'DEGRADED',
            latencyMs: Math.round(ms),
            errorCode: 'STT_TIMEOUT',
            sanitizedErrorClass: 'TimeoutError',
            remediationAttempted: 'None',
          });
          ui.notice('stt-timeout', `تجاوز تحويل الصوت المهلة (${Math.round(ms / 1000)} ثانية) — تم تجاهل النافذة ومتابعة الاستماع.`, 'warn');
        },
        onUtterance: (utterance) => {
          void (async () => {
            // D2: sanitise here as well as in the transport. The transport is
            // the last gate, but skipping a symbol-only reply entirely is
            // cheaper and keeps the speech phase honest.
            const text = stripSpeechText(utterance.reply);
            if (!isSpeakable(text)) {
              setVoicePhase('idle');
              return;
            }
            setVoicePhase('speaking', text);
            // Snapshot the persona for the whole utterance: a persona switch
            // mid-reply would otherwise split one sentence across two voices.
            const voiceId = VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default'];
            const gen = speechGate.capture();
            const sentences = splitSentences(text);
            const t0 = Date.now();
            try {
              for (const sentence of sentences) {
                if (!speechGate.isCurrent(gen)) return;
                const mp3 = await fish.synthesize(sentence, voiceId);
                if (!speechGate.isCurrent(gen)) return;
                ui.broadcastAudio(mp3);
              }
              record({ subsystem: 'TTS', status: 'OK', latencyMs: Date.now() - t0 });
            } catch (err) {
              record({
                subsystem: 'TTS',
                status: 'ERROR',
                latencyMs: Date.now() - t0,
                errorCode: 'TTS_FAILED',
                sanitizedErrorClass: classify(err),
              });
              ui.notice('tts-failed', `تعذّر توليد الصوت: ${err instanceof Error ? err.message : 'خطأ'}`, 'error');
            } finally {
              setVoicePhase('idle');
            }
          })();
        },
      });
    } catch {
      return null;
    }
  };

  const rebuildVoice = (): void => {
    audio = buildVoicePipeline();
    if (audio === null) {
      ui.onAudio = null;
      // The keyless state is the single most common reason a user reports
      // "voice does not work". It must be visible in the diagnostics bus, not
      // only as a UI notice that a user may never have seen.
      record({
        subsystem: 'KEYRING',
        status: 'DEGRADED',
        latencyMs: 0,
        errorCode: 'KEYS_MISSING',
        sanitizedErrorClass: 'AuthError',
        remediationAttempted: 'None',
      });
      ui.notice('voice-disabled-no-keys', 'الصوت معطّل — لم تُهيّأ المفاتيح بعد. أدخل المفاتيح لتفعيل الحلقة الصوتية.', 'warn');
      return;
    }
    const pipeline = audio;
    ui.onAudio = (pcm) => {
      // D13: set the phase here, at the single entry point for uplink audio,
      // and only when it actually changes. The helper already dedupes, so a
      // steady mic costs zero WS frames.
      setVoicePhase('listening');
      void pipeline.pushChunk(pcm).catch(() => undefined);
    };
  };
  rebuildVoice();

  const inventory = new SessionInventory(client, {
    ...(options.inventoryIntervalMs !== undefined ? { intervalMs: options.inventoryIntervalMs } : {}),
    onEvent: () => {
      ui.publishInventory(
        inventory.snapshot().map((s) => ({ sessionId: s.sessionId, state: s.state })),
      );
    },
  });

  const boundPort = await ui.start(options.ipcPort);

  // Discover agents for the active project so the shell's selector is real.
  const directory = options.directory ?? process.cwd();
  const agents = await client.listAgents(directory).catch(() => []);
  ui.publishAgents(agents.map((a) => ({ id: a.id, name: a.name })));

  const publishSessions = async (): Promise<number> => {
    const listed = await client.listSessions();
    ui.publishInventory(listed.map((s) => ({ sessionId: s.sessionId, state: s.state })));
    return listed.length;
  };

  await publishSessions();
  inventory.start();

  return {
    ipcPort: boundPort,
    servePort: options.servePort,
    token: options.ipcToken,
    publishSessions,
    activePersona: () => activePersona,
    stop: async () => {
      inventory.dispose();
      // Flush the diagnostics buffer before the socket goes away, or the last
      // few rows — usually the ones explaining WHY the user is shutting down —
      // are lost.
      await telemetry.close().catch(() => undefined);
      await ui.close();
    },
  };
}

/**
 * Resolve the vault database path. Precedence: an explicit db path, then the
 * canonical vault ROOT (VOXAURA_VAULT_DIR — the same root the Obsidian memory
 * graph uses), then `<cwd>/vault`. One root for keys and memory, so the graph
 * and the keyring never drift apart.
 */
export function vaultPathFromEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const explicit = env['VOXAURA_VAULT_PATH'];
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const root = env['VOXAURA_VAULT_DIR'];
  if (typeof root === 'string' && root.length > 0) return join(root, 'keyring.dat');
  return join(cwd, 'vault', 'keyring.dat');
}

/**
 * Resolve the IPC token (H4). Precedence: explicit env → per-install token file
 * (0600, written by `ensureIpcToken`) → empty (fail-closed, never a default).
 */
export function ipcTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['VOICE_RUNTIME_IPC_TOKEN'] ?? '';
}

/** Default location of the per-install IPC token (0600, never committed). */
export function ipcTokenPath(home: string = homedir()): string {
  return join(home, '.opencode-voice-runtime', 'ipc.token');
}

/**
 * Return the per-install IPC token, generating it on first use (H4). The value
 * is random per machine, written 0600, and never baked into the bundle or logs.
 */
export function ensureIpcToken(path: string = ipcTokenPath()): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACLs already scope the user profile; best-effort on POSIX.
  }
  return token;
}