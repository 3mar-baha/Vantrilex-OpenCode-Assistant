import { randomBytes } from 'node:crypto';
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
import { Coordinator, type ChatFn } from './orchestrator/coordinator.js';
import { FishHttpTransport, isSpeakable, SpeechGate, splitSentences, stripSpeechText } from './voice/tts.js';
import { openRouterChat } from './voice/brain.js';
import { createCommandHandler } from './orchestrator/command-router.js';
import { probeHealth } from './launcher/index.js';
import { FileVault } from './voice/vault.js';
import { Keyring, type AcquiredKey } from './voice/keyring.js';
import { GroqWhisperClient, transcribeStream } from './voice/stt.js';
import { isLoudWindow, bytesToFloat32 } from './voice/ingest.js';
import { SileroVad, VAD_WINDOW_SAMPLES } from './runtime/vad.js';
import { writeKeyPools } from './voice/key-store.js';

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
  const ui = new UiServer({
    token: options.ipcToken,
    contractVersion: options.contractVersion ?? '3.1.0',
  });

  let activeSession: SessionId | undefined;
  let activePersona: 'kareem' | 'nour' = 'kareem';
  const vault = new FileVault(options.vaultPath);
  // Barge-in generation gate: trips on `abort` so stale reply sentences never
  // synthesize or broadcast afterwards. Plain state — safe before key setup.
  const speechGate = new SpeechGate();

  ui.onCommand = createCommandHandler({
    client,
    // Phase 4: the project root serve is scoped to, and the directory a new
    // session is created in. Never taken from the command payload.
    projectDirectory: () => options.directory ?? process.cwd(),
    onContext: (sessionId, usage) => {
      ui.context(sessionId, usage.used, usage.limit, usage.percent, usage.messageCount);
    },
    switchSession: (id) => {
      activeSession = id;
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
  // 3-agent chain (Dots3 intake → Nemotron plan → Inkling handoff). Built from
  // the vault; kept REBUILDABLE so keys saved from the UI activate the voice
  // loop without a restart. A keyless daemon keeps the control plane up, drops
  // audio, and tells the shell to show the first-run call to action.
  const keyMaterial = (key: AcquiredKey): string => Buffer.from(key.material).toString('utf8');
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
  let vadLoad: Promise<SileroVad | null> | null = null;
  const loadVad = (): Promise<SileroVad | null> => {
    if (vadLoad === null) {
      const cfg = loadConfig();
      vadLoad = SileroVad.load(cfg.vad.modelPath, { threshold: cfg.vad.threshold }).catch(() => null);
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
          try {
            const res = await transcribeStream(pcm, new GroqWhisperClient(keyMaterial(key)));
            // D1: surface no_speech_prob so the pipeline can drop a window
            // Whisper itself believes was not speech.
            return res.noSpeechProb === undefined
              ? res.text
              : { text: res.text, noSpeechProb: res.noSpeechProb };
          } catch (err) {
            ui.notice('stt-failed', `تعذّر تحويل الكلام إلى نص: ${err instanceof Error ? err.message : 'خطأ'}`, 'error');
            throw err;
          } finally {
            ring.release(key, true);
          }
        },
        think: async (transcript) => {
          setVoicePhase('thinking', transcript);
          try {
            const mission = await coordinator.run(transcript);
            const reply = mission.replyAr ?? '';
            return mission.receipt === null ? { reply } : { reply, receipt: mission.receipt };
          } catch (err) {
            ui.notice('brain-failed', `تعذّر توليد الرد: ${err instanceof Error ? err.message : 'خطأ'}`, 'error');
            throw err;
          }
        },
        activeSessionId: () => activeSession,
        // D5: a stalled provider costs one window, not the session, and the
        // shell is told so the silence is not read as a bug.
        onSttTimeout: (ms) => {
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
            try {
              for (const sentence of sentences) {
                if (!speechGate.isCurrent(gen)) return;
                const mp3 = await fish.synthesize(sentence, voiceId);
                if (!speechGate.isCurrent(gen)) return;
                ui.broadcastAudio(mp3);
              }
            } catch (err) {
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