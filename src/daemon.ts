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
import { FileAudioOut, FishHttpTransport, TtsEngine } from './voice/tts.js';
import { openRouterChat } from './voice/brain.js';
import { createCommandHandler } from './orchestrator/command-router.js';
import { probeHealth } from './launcher/index.js';
import { FileVault } from './voice/vault.js';
import { Keyring, type AcquiredKey } from './voice/keyring.js';
import { GroqWhisperClient, transcribeStream } from './voice/stt.js';
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

  ui.onCommand = createCommandHandler({
    client,
    switchSession: (id) => {
      activeSession = id;
      audio?.reset();
    },
    activeSessionId: () => activeSession,
    setPersona: (persona) => {
      activePersona = persona;
    },
    saveKeys: {
      saveKeys: async (keys) => {
        writeKeyPools(vault, {
          groq: [keys.groq],
          fish: [keys.fish],
          openrouter: [keys.openrouter],
        });
        return { ok: true };
      },
    },
  });

  // Voice capture pipeline (P4+P5): binary PCM → Whisper transcript →
  // 3-agent chain (Dots3 intake with fast TTS reply → Nemotron plan →
  // Inkling handoff dispatched to the active session). Built only when the
  // vault holds keys; a keyless daemon keeps the control plane up and drops
  // audio.
  const keyMaterial = (key: AcquiredKey): string => Buffer.from(key.material).toString('utf8');
  let audio: AudioPipeline | null = null;
  try {
    const ring = Keyring.load(vault);
    const cfg = loadConfig();
    const fish = new FishHttpTransport(ring);
    const tts = new TtsEngine(cfg.cache, fish, new FileAudioOut());
    const chat: ChatFn = async (model, system, user) => {
      const key = ring.acquire('openrouter');
      try {
        return await openRouterChat(keyMaterial(key), model, system, user);
      } finally {
        ring.release(key, true);
      }
    };
    const coordinator = new Coordinator({
      chat,
      speak: async (replyAr) => {
        // Fast verbal response: synthesize, never let TTS failure break dispatch.
        await tts.speak(replyAr, activePersona === 'nour' ? 'female-toggle' : 'male-default').catch(() => undefined);
      },
      dispatch: async (text) => {
        const session = activeSession as SessionId;
        return client.promptSession(session, text, { origin: 'voice', actor: 'capture' });
      },
      activeSessionId: () => activeSession,
    });
    audio = new AudioPipeline({
      transcribe: async (pcm) => {
        const key = ring.acquire('groq');
        try {
          return (await transcribeStream(pcm, new GroqWhisperClient(keyMaterial(key)))).text;
        } finally {
          ring.release(key, true);
        }
      },
      think: async (transcript) => {
        const mission = await coordinator.run(transcript);
        const reply = mission.replyAr ?? '';
        return mission.receipt === null ? { reply } : { reply, receipt: mission.receipt };
      },
      activeSessionId: () => activeSession,
      onUtterance: (utterance) => {
        // P4b downlink: synthesize the spoken reply and stream it to shells.
        // Fire-and-forget by design — synthesis failure must never break the
        // control plane or the already-recorded dispatch receipt.
        void (async () => {
          if (utterance.reply.trim().length === 0) return;
          try {
            const mp3 = await fish.synthesize(
              utterance.reply,
              VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default'],
            );
            ui.broadcastAudio(mp3);
          } catch {
            // Swallowed deliberately (see above).
          }
        })();
      },
    });
  } catch {
    audio = null;
  }
  if (audio !== null) {
    const pipeline = audio;
    ui.onAudio = (pcm) => {
      void pipeline.pushChunk(pcm).catch(() => undefined);
    };
  }

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