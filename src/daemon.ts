import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OrchestratorError } from './common/errors.js';
import { redactSecrets, redactString } from './common/logger.js';
import { loadConfig } from './common/config.js';
import type { SessionId } from './common/brands.js';
import { VOICE_IDS } from './common/brands.js';
import { UiServer } from './ipc/index.js';
import { ServeClient } from './runtime/index.js';
import {
  ServeHealthMonitor,
  SERVE_NOTICE_RECONNECTING,
  serveBlockedDetail,
  withServeGate,
  type ServeProbe,
} from './runtime/serve-health.js';
import { createShellTaskBridge, type ShellTaskBridge } from './daemon/shell-tasks.js';
import { SessionInventory } from './orchestrator/inventory.js';
import { AudioPipeline } from './orchestrator/audio-pipeline.js';
import { Coordinator, INTAKE_MODEL, type ChatFn, type IntakeAck } from './orchestrator/coordinator.js';
import { TaskQueue, type TaskResult } from './orchestrator/task-queue.js';
import { DeliveryBuffer, type DeliveryItem } from './orchestrator/delivery.js';
import { createFishTransport, type FishWsTransport } from './voice/fish-ws.js';
import type { FishHttpTransport } from './voice/tts.js';
import { isSpeakable, SpeechGate, splitSentences, stripSpeechText } from './voice/tts.js';
import { FishCreditError } from './voice/tts.js';
import { TtsCreditMonitor } from './voice/tts-credit.js';
import { openRouterChat } from './voice/brain.js';
import { narrate, NARRATOR_MODEL, type NarratorChat } from './orchestrator/narrator.js';
// Imported from the persona module directly, NOT the knowledge barrel: the
// barrel re-exports the retriever and the 43-chunk corpus, and the daemon should
// not pull a search index into its import graph to obtain one style string.
import { PERSONA_DIRECTIVES } from './knowledge/personas.js';
import { OpenCodeBridge } from './runtime/opencode-bridge.js';
import { createCommandHandler } from './orchestrator/command-router.js';
import { describeSlashCommands, parseSlashCommand, slashCommandError } from './orchestrator/slash.js';
import { mentionSummary, resolveMentions } from './orchestrator/mentions.js';
import { isActionableInstruction, optimizePrompt } from './orchestrator/prompt-optimizer.js';
import { probeHealth } from './launcher/index.js';
import { FileVault } from './voice/vault.js';
import { Keyring, keyAdvanced, withKey, type AcquiredKey } from './voice/keyring.js';
import { GroqWhisperClient, SttTimeoutError, transcribeStream } from './voice/stt.js';
import { AudioIngest, isLoudWindow } from './voice/ingest.js';
// NOT imported statically. `runtime/vad.js` pulls in `onnxruntime-node`, a
// native module the sidecar does not bundle, so a static import made a missing
// package a hard module-load failure: the daemon died with ERR_MODULE_NOT_FOUND
// and never bound 4097. Found by cold-launching the real installer, not by the
// gates. The dynamic import below degrades to the RMS energy gate instead, which
// is the fail-closed behaviour the design always intended. The gate itself lives
// in `runtime/vad-gate.ts` (M3-B.4) and is transport-blind: it imports neither
// this file nor the ONNX module.
import { makeVadGate, type VadModule } from './runtime/vad-gate.js';
import { writeKeyPools } from './voice/key-store.js';
import { TelemetryWriter } from './telemetry/index.js';
import { classifyError } from './telemetry/index.js';
import type { TelemetryInput } from './telemetry/index.js';

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
  /**
   * Where the runtime state lives (token, logs, telemetry, the `daemon.owner`
   * marker). Defaults to `~/.opencode-voice-runtime` and is overridden only by
   * tests, which would otherwise write into the real install's directory.
   */
  readonly runtimeDir?: string;
  /**
   * Overrides the narrator's chat surface. Every other network client here is
   * injected; this was the one hardcoded external call, which made the most
   * important integration — that the active persona actually reaches the system
   * prompt — untestable. With this seam a test can assert the system string
   * differs per persona instead of trusting the source.
   */
  readonly narratorChat?: NarratorChat;
  /**
   * Clock seam for the TTS credit monitor. The monitor's whole job is measuring
   * how long voice has been broken, so a test has to control time; every other
   * network client here is injected and this is the equivalent seam for the one
   * piece of time-dependent state the daemon owns.
   */
  readonly ttsCreditNow?: () => number;
  /**
   * Clock seam for the serve health monitor, mirroring `ttsCreditNow` and for the
   * same reason: the monitor's job is measuring how long an outage has lasted
   * (`inStateMs`), so a test has to control time to assert it. Production uses
   * `Date.now()`.
   */
  readonly serveHealthNow?: () => number;
  /**
   * Probe seam for the serve health monitor.
   *
   * `ServeHealthMonitor` defaults to the REAL `probeHealth`, and that default is
   * load-bearing — a test must be able to prove production uses the same probe,
   * which it can only do if the seam exists at all. An injected probe is how a
   * test drives the state machine (and therefore the command gate) without
   * killing a serve process, which is otherwise the only honest way to reach
   * `degraded`.
   */
  readonly serveHealthProbe?: ServeProbe;
  /**
   * Overrides the courtesy TTS line for a finished shell task.
   *
   * Present for the same reason as `narratorChat`: every other network client in
   * this file is injected, and an un-injected one makes the audible half of the
   * task-completion rule untestable without Fish. `undefined` speaks nothing at
   * all, which is what every other test in the suite wants.
   */
  readonly shellSpeak?: (textAr: string) => void;
}

export interface DaemonHandle {
  readonly ipcPort: number;
  readonly servePort: number;
  readonly token: string;
  /**
   * The live TTS credit monitor — a VIEW of the daemon-scoped binding, not a
   * snapshot, so it reports the same object the rebuilt pipeline closes over.
   */
  readonly ttsCredit: TtsCreditMonitor;
  /**
   * The live serve health monitor. A VIEW, for the same reason `ttsCredit` is
   * one, and it mirrors that getter exactly: `cli.ts` reads `daemon.ttsCredit`
   * after `startDaemon` resolves, so `daemon.serveHealth.status()` becomes an
   * operator-visible line with no new code path.
   *
   * What is deliberately NOT exposed: `ServeHealthMonitor` holds the serve
   * password in a private field, so handing the object to a caller who prints it
   * is safe, but `status()` is the shape that would cross the WS boundary — and
   * it deliberately carries no credential (`runtime/serve-health.ts:337`).
   */
  readonly serveHealth: ServeHealthMonitor;
  /**
   * The live shell-task queue — a VIEW, again for the same reason. It exists so a
   * caller can `close()` it and so `doctor` can read `stats()` without reaching
   * into the daemon's closure.
   */
  readonly shellTasks: ShellTaskBridge;
  /** Publish a session snapshot to every connected shell. */
  publishSessions(): Promise<number>;
  /** The persona the daemon currently speaks with (real server-side state). */
  activePersona(): 'kareem' | 'nour';
  stop(): Promise<void>;
}

/** Contract version of the `daemon.owner` marker. Bumped on an incompatible change. */
export const DAEMON_OWNER_VERSION = 1;
/** The marker the Tauri shell reads to tell "our daemon" from "a stranger on 4097". */
export const DAEMON_OWNER_FILE = 'daemon.owner';
/** The install identity the shell hands the daemon in its environment. */
export const DAEMON_OWNER_KEY_ENV = 'VOXAURA_OWNER_KEY';

export interface DaemonOwnerMarker {
  readonly v: number;
  readonly pid: number;
  readonly ipcPort: number;
  readonly contractVersion: string;
  /**
   * The install identity verbatim. NOT a credential: it authorises nothing but
   * the statement "I am the daemon this shell launched", and the shell holds the
   * real WS-4097 bearer separately. It is stored plainly because a one-way
   * transform would need a hash in two languages, and a hash nobody gains
   * anything from on a loopback liveness question.
   */
  readonly ownerKey: string;
}

export function daemonOwnerMarker(fields: {
  readonly pid: number;
  readonly ipcPort: number;
  readonly contractVersion: string;
  readonly ownerKey: string;
}): DaemonOwnerMarker {
  return {
    v: DAEMON_OWNER_VERSION,
    pid: fields.pid,
    ipcPort: fields.ipcPort,
    contractVersion: fields.contractVersion,
    ownerKey: fields.ownerKey,
  };
}

/**
 * Validate a marker against the identity WE hold. Returns `null` for anything
 * that is not provably our own live daemon — and never throws, because a
 * truncated or hostile file on the port path must degrade to "not ours", not to
 * a crash on launch.
 *
 * This is the Node mirror of `holder_from_probe` in
 * `apps/desktop/src-tauri/src/main.rs`; the two must agree on every shape or a
 * launch will refuse its own daemon. The tests in `daemon.test.ts` and
 * `phase2_tests` assert the same shapes on both sides.
 */
export function parseDaemonOwnerMarker(raw: string, expectedKey: string): DaemonOwnerMarker | null {
  if (expectedKey.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Partial<Record<'v' | 'pid' | 'ipcPort' | 'contractVersion' | 'ownerKey', unknown>>;
  if (m['v'] !== DAEMON_OWNER_VERSION) return null;
  if (typeof m['pid'] !== 'number' || !Number.isInteger(m['pid']) || m['pid'] <= 0) return null;
  if (typeof m['ipcPort'] !== 'number' || !Number.isInteger(m['ipcPort']) || m['ipcPort'] <= 0) return null;
  if (typeof m['contractVersion'] !== 'string') return null;
  if (m['ownerKey'] !== expectedKey) return null;
  return {
    v: DAEMON_OWNER_VERSION,
    pid: m['pid'],
    ipcPort: m['ipcPort'],
    contractVersion: m['contractVersion'],
    ownerKey: expectedKey,
  };
}

/** The TTS half of barge-in. Structural, so the seam is testable with the real class. */
export interface SpeechGateLike {
  abort(): void;
}

/**
 * Barge-in: what an `abort` command actually does.
 *
 * C4. This used to be `() => speechGate.abort()` — one line that only stopped
 * PLAYBACK. The turn itself was left running: a `think()` already parked in the
 * planner finished, its answer was discarded by the pipeline's post-await
 * generation check, and the user paid for a planning call whose result was never
 * spoken. Cancelling means the request, not the audio.
 *
 * W11. Two halves were still not the whole. `pipeline().cancel()` bumps a
 * GENERATION COUNTER — it unwinds the daemon's own `await`, and nothing else.
 * It cannot reach OpenCode, because the daemon never holds that request.
 *
 * WHY IT NEVER HOLDS IT, in the form that does not depend on which prompt
 * route happens to be live: the conversational egress is `ServeClient
 * .promptSession`, and BOTH of its routes return an ADMISSION, not a
 * completion. `/api/session/{id}/prompt` answers with `SessionInputAdmitted`,
 * and the v1 `POST /session/{id}/prompt_async` answers **204 with no body at
 * all** (measured 2026-10-01 against the live serve: 204, no content-type, zero
 * bytes, for the `{messageID, parts}` body this client sends). So by the time
 * the daemon holds its receipt, OpenCode is already generating the answer, and
 * the only party that can stop it is OpenCode.
 *
 * `promptWithKey` prefers the v2 route and falls through to v1 on a 5xx;
 * `client.ts` records the v2 route as 500-ing on this server generation. That
 * specific 500 was NOT re-measured here — reproducing it needs a REAL session id
 * and a real turn, which is the user's quota and their session, not a probe's.
 * The argument above does not depend on it: an admitted turn is still a running
 * turn. A cancel that never interrupts the session leaves the user's paid-for
 * turn running to completion in a process nobody is watching — which is the
 * defect W11 names, and it was invisible locally because both local halves did
 * fire.
 *
 * So three halves, in a fixed order, and the order is the contract:
 *   * `gate`     — TTS sentence synthesis and broadcast, per sentence;
 *   * `pipeline` — the STT → think → dispatch turn, per await (local only);
 *   * `interrupt`— the OpenCode session itself (`POST /api/session/{id}/interrupt`).
 *
 * `pipeline` is a getter because `rebuildVoice` can replace the pipeline while
 * a command is in flight, and an abort must reach the CURRENT one.
 *
 * `interrupt` is `() => void`, NOT `() => Promise<void>`, and it is never
 * awaited. `abort` is a member of `SERVE_LOCAL_ONLY_COMMANDS`
 * (`runtime/serve-health.ts`) precisely so it still works when serve is DOWN —
 * which is the moment a user reaches for cancel hardest. Awaiting a round trip
 * before the local cancel would let a dead serve delay the one thing that still
 * works, and would make a cancel that cannot reach OpenCode take seconds to
 * admit it. The caller fires and forgets; this function stays synchronous, so
 * the local halves are unconditional and instantaneous.
 *
 * The third parameter is REQUIRED, not optional. An optional `interrupt` would
 * type-check at every existing call site and silently reintroduce exactly the
 * local-only abort this replaced — a signature that reads as wired and behaves
 * as if it were not.
 */
export function abortTurn(
  gate: SpeechGateLike,
  pipeline: () => { cancel(): void } | null,
  interrupt: () => void,
): void {
  gate.abort();
  pipeline()?.cancel();
  interrupt();
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

  // ── SERVE RESILIENCE · POINT 1 ────────────────────────────────────────────
  // The monitor's precondition is the boot probe ABOVE, which is why it is
  // constructed here and not earlier: `ServeHealthMonitor` starts `healthy`
  // unconditionally, and that is only sound because this line has already proven
  // serve. Nothing below relaxes the boot check — a daemon that starts against a
  // dead serve still refuses to start, which is a deliberate fail-closed property
  // and is NOT this integration's to change.
  //
  // Constructed here and started beside `inventory.start()` (after `ui.start()`
  // has returned), because the amber bar needs a socket to travel over and a
  // monitor that started before one existed would have nowhere to report a loss.
  // See `docs/SERVE-RESILIENCE.md`.
  const serveHealth = new ServeHealthMonitor({
    port: options.servePort,
    password: options.servePassword,
    ...(options.serveHealthNow !== undefined ? { now: options.serveHealthNow } : {}),
    ...(options.serveHealthProbe !== undefined ? { probe: options.serveHealthProbe } : {}),
    // ── POINT 2 · the amber bar.
    //
    // Three visible states, and `notice.code` is an open `z.string().min(1)`, so
    // none of them needs a protocol change. `level: 'warn'` IS the amber.
    //
    // Events fire on TRANSITION only (`serve-health.ts:150`), so a healthy serve
    // emits nothing, ever. The `exhausted` event is separate from the state
    // transition because the state STAYS `reconnecting` after the budget is
    // spent — "still trying" and "gave up" are different things to say and the
    // user needs to be told which one they are looking at.
    onEvent: (event) => {
      if (event.type === 'exhausted') {
        ui.notice(
          'serve-reconnect-exhausted',
          `ما قدرنا نرجع على OpenCode بعد ${event.status.attempts} محاولة — تأكّد إن الخدمة شغالة على 127.0.0.1:${options.servePort}`,
          'warn',
        );
        return;
      }
      if (event.type === 'resumed') return;
      if (event.to === 'healthy') {
        ui.notice('serve-restored', 'عاد الاتصال بـ OpenCode.', 'info');
        return;
      }
      ui.notice(SERVE_NOTICE_RECONNECTING, 'جارٍ إعادة الاتصال بـ OpenCode…', 'warn');
    },
  });

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
  const runtimeDir = options.runtimeDir ?? join(homedir(), '.opencode-voice-runtime');
  const contractVersion = options.contractVersion ?? '3.1.0';
  const ui = new UiServer({
    token: options.ipcToken,
    contractVersion,
  });
  /**
   * C2: publish who owns the IPC port, so the shell can tell this daemon from
   * anything else that has bound 4097.
   *
   * The shell used to answer that question with a bare TCP connect, so it
   * adopted ANY holder and reported `ready` — including a leftover dev server
   * that cannot answer the WS-4097 contract at all. The marker is written AFTER
   * `ui.start()` resolves, i.e. only by a daemon that really is listening, and
   * it is removed on `stop()` so a clean exit leaves no stale claim.
   *
   * With no key in the environment (a hand-started `cli.js serve`, a dev script)
   * nothing is published: such a daemon cannot prove it is ours, and a later
   * launch will say so instead of silently adopting it. That is the correct
   * answer, not a degraded one.
   */
  const ownerKey = (process.env[DAEMON_OWNER_KEY_ENV] ?? '').trim();
  const ownerPath = join(runtimeDir, DAEMON_OWNER_FILE);
  const publishOwner = (boundPort: number): void => {
    if (ownerKey.length === 0) return;
    const marker = daemonOwnerMarker({
      pid: process.pid,
      ipcPort: boundPort,
      contractVersion,
      ownerKey,
    });
    try {
      mkdirSync(runtimeDir, { recursive: true });
      // In place, never temp-file + rename: a rename REPLACES the file and
      // resets its security descriptor, which would discard the owner-only DACL
      // the shell applied when it pre-created this path (main.rs,
      // `ensure_owner_key`). A torn read can only make the shell refuse, which
      // is the fail-closed direction.
      //
      // `mode` below only ever applies on CREATION. When the shell has already
      // provisioned this path — which `ensure_owner_marker` now does on every
      // launch, not just the first — the write lands on an existing file and the
      // protected descriptor survives untouched. The guard is for the other case,
      // where this daemon is running without the supervisor and would otherwise
      // CREATE the marker on the parent directory's inherited ACL, putting the
      // owner key in a file every local administrator can read. That is refused
      // rather than written; the catch below already reports it as
      // `daemon-owner-unpublished`, and the next launch then refuses to adopt a
      // holder it cannot authenticate, which is the fail-closed direction.
      if (!CAN_ENFORCE_FILE_MODE && !existsSync(ownerPath)) {
        throw new Error(
          'refusing to create the daemon.owner marker on Windows: a 0600 mode is a ' +
            'no-op there, and the marker carries the owner key. Start Voxaura so its ' +
            'supervisor provisions the path with a protected owner-only DACL.',
        );
      }
      writeFileSync(ownerPath, JSON.stringify(marker), { mode: 0o600 });
    } catch (err) {
      // Not fatal: the daemon is listening and serving. But the next launch will
      // be told 4097 is held by a stranger, so say so rather than leaving the
      // user to work it out from a refused bring-up.
      ui.notice(
        'daemon-owner-unpublished',
        'تعذّر نشر هوية الخدمة على المنفذ — سيُبلّغ التطبيق التالي أن المنفذ مشغول من قبل عملية أخرى.',
        'warn',
      );
      // Redacted at the sink: this is stderr a human pastes into an issue, and
      // a write failure can carry a path or a provider string. Peer review:
      // the non-Error branch used to pass the raw value for "diagnostics" —
      // but a thrown string can carry a key, so unknown types go through
      // `redactSecrets` (fail-closed) rather than through untouched.
      console.error(
        'daemon: could not publish daemon.owner:',
        err instanceof Error ? redactString(err.message) : redactSecrets(err),
      );
    }
  };
  /** Only ever removes OUR claim: a successor that already replaced it wins. */
  const clearOwner = (): void => {
    if (ownerKey.length === 0) return;
    try {
      const raw = readFileSync(ownerPath, 'utf8');
      if (parseDaemonOwnerMarker(raw, ownerKey) === null) return;
      rmSync(ownerPath, { force: true });
    } catch {
      // Already gone, or unreadable. Nothing to clear.
    }
  };

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
  // Credit state for the top-up banner: ONE monitor per daemon, consulted on
  // every TTS fault. It owns the first-fault clock, so repeated faults (and
  // repeated key saves) must not reset the operator's sense of how long voice
  // has been down.
  //
  // It used to be constructed inside `buildVoicePipeline`, which `rebuildVoice`
  // re-runs on every saveApiKeys — so each key save silently restarted the
  // 7-day overdue escalation and the "a week without voice" banner could never
  // arrive for a user who keeps their keys tidy. It is daemon-scoped state like
  // `speechGate`, so it lives beside it; the pipeline closes over the binding.
  const ttsCredit = new TtsCreditMonitor(options.ttsCreditNow ?? (() => Date.now()));

  // M3 B.3 — the watermark the ingest accumulator reports, and a latch for it.
  //
  // Daemon scope beside `speechGate`/`ttsCredit` for the same reason: the state
  // has to outlive `rebuildVoice`, because a pause belongs to the accumulator
  // that raised it. A key save builds a brand-new ingest with an empty buffer,
  // so the 'resume' edge can never arrive from the old one — a shell left
  // discarding audio would keep discarding it for the rest of the session, and
  // the user is holding the keys screen at that moment. `rebuildVoice` therefore
  // releases the latch explicitly instead of relying on the new accumulator to
  // discover a level it never had.
  let uplinkPaused = false;

  // M2 Pattern 1 — the `spawn_thinking` split, daemon half.
  //
  // Daemon scope, beside `speechGate`, for the same reason A.5 moved the credit
  // monitor here: this state must OUTLIVE `rebuildVoice`. A queue constructed
  // inside `buildVoicePipeline` would drop every in-flight task on each key
  // save, and the user saves keys exactly when something is misbehaving.
  //
  // `coordinator` is a late binding rather than a constructor argument because
  // the coordinator itself is built per-pipeline (it closes over `ring` and
  // `client`). Rebuilding the pipeline therefore re-points this queue at the
  // new coordinator without discarding the queue.
  let coordinatorRef: Coordinator | null = null;
  let voiceEpoch = 0;
  const tasks = new TaskQueue({
    plan: async (task, signal) => {
      const coordinator = coordinatorRef;
      if (coordinator === null) {
        // No pipeline, no keys, no planner. A queued task cannot be planned and
        // must not be reported as planned.
        return { ok: false, receipt: null, detail: 'voice-disabled' };
      }
      const ack: IntakeAck = {
        ok: true,
        replyAr: task.replyAr,
        taskEn: task.taskEn,
        receipt: null,
        // Phase B: the gate judges ADDRESS from the user's own words, not from
        // the planner's English restatement. `TaskRecord` has always carried
        // the verbatim transcript; this is the line that hands it across.
        transcript: task.transcript,
        ...(task.intakeModel !== undefined ? { intakeModel: task.intakeModel } : {}),
      };
      const mission = await coordinator.plan(ack, { signal, taskId: task.id });
      // `ErrorCode` is a CLOSED union and the coordinator's `detail` is free
      // text by design (`plan-invalid`, `cancelled`, a flagged-step list). It
      // is a diagnostic detail, not an error taxonomy, so it is NOT widened
      // into the union — the branch maps it and the raw detail rides the task
      // record for anyone who needs the specifics.
      //
      // `ALREADY_RUNNING` for a cancellation is deliberate and load-bearing: a
      // cancelled task lost its slot to a newer turn, which is exactly what
      // that code means. Filing it as a provider fault would make a user
      // barge-in look like a broken model.
      record({
        subsystem: 'BRAIN',
        status: mission.ok && mission.cancelled !== true ? 'OK' : 'DEGRADED',
        latencyMs: Date.now() - task.enqueuedAt,
        ...(mission.ok
          ? {}
          : {
              errorCode:
                mission.cancelled === true ? ('ALREADY_RUNNING' as const) : ('BRAIN_FAILED' as const),
            }),
      });
      // M2 Pattern 3: the `plan-held` notice is no longer fired HERE. It was
      // fired from inside the planner, which is also inside the window where the
      // assistant is speaking the acknowledgement — so the one message that needs
      // a decision was the one guaranteed to be missed. The result is OFFERED to
      // the buffer below, which delivers it on a quiet channel or not at all.
      //
      // The A.15 contract is unchanged: the task is COMPLETED and holds its plan,
      // and the notice names the task id. Approval re-entry is a SEAM, not a
      // path: `delivery.retry(taskId)` exists and is unit-tested, but no shell
      // affordance calls it yet (peer review — claiming otherwise would be
      // A.14-class). Wiring it is M4/C.5-Phase-2 work, never a second plan.
      //
      // Offered HERE rather than from `dispatch`, because `TaskQueue.runOne`
      // deliberately does not call `dispatch` for a held task: a confirmation
      // gate is not a dispatch. Both completion shapes have to be offered, and
      // the two call sites are the only places that can tell them apart.
      if (mission.needsConfirmation === true) {
        offerCompletion(task.id, task.epoch, {
          ok: mission.ok,
          receipt: mission.receipt,
          ...(mission.detail !== undefined ? { detail: mission.detail } : {}),
          needsConfirmation: true,
          flagged: mission.flagged ?? [],
        });
      }
      return {
        ok: mission.ok,
        receipt: mission.receipt,
        ...(mission.detail !== undefined ? { detail: mission.detail } : {}),
        ...(mission.needsConfirmation === true
          ? { needsConfirmation: true, flagged: mission.flagged ?? [] }
          : {}),
      };
    },
    dispatch: (task, result) => {
      // M2 Pattern 3 (see `offerCompletion`): a HOLD is offered to the delivery
      // buffer. A routine dispatch is NOT: its receipt is narrated by the
      // plan's own line, and offering it would count a non-delivery in
      // `stats().delivered` — the exact over-report a peer review caught.
      // Nothing is SPOKEN here either way.
      //
      // M2 Pattern 3: offering is not speaking. The completion is offered and the
      // buffer decides when there is a quiet channel; a hold whose channel is
      // busy waits for the drain instead of colliding with this turn's speech.
      if (result.needsConfirmation !== true) return;
      offerCompletion(task.id, task.epoch, result);
    },
    // Peer review: the kill-switch must be operable, not just readable. An
    // affordance nothing can flip is A.14-class (reads as live, is not).
    enabled: process.env['VOXAURA_TASK_QUEUE'] !== 'off',
  });

  // M2 Pattern 3 — completion ≠ delivery, daemon half.
  //
  // Daemon scope beside `tasks` and `speechGate` for the same reason: this state
  // describes a conversation in progress and must not be rebuilt on a key save.
  // It closes over `tasks` (for `retry`) and over the channel flags below, so it
  // is constructed AFTER the queue and BEFORE the pipeline — the same late-
  // binding dance `coordinatorRef` performs.
  //
  // THE DEFECT THIS CLOSES. `plan-held` was fired from inside the planner, i.e.
  // while the assistant was usually still speaking the acknowledgement. A
  // confirmation prompt that arrives mid-utterance is not read: the user hears
  // two things at once and the one that needs a decision is the one they miss.
  // Now the notice is OFFERED and delivered on a quiet channel, or not at all.
  //
  // Channel flags, kept separate rather than collapsed into one boolean: the
  // `delivery.test.ts` channel table covers all three rows, and a single
  // "busyish" flag here would silently make two of them unreachable.
  let ttsInFlight = 0;
  let playbackSeen = false;
  /** The single offer seam. Both completion shapes go through it. */
  function offerCompletion(taskId: string, epoch: number, result: TaskResult): void {
    delivery.offer({ taskId, epoch, result });
  }
  const delivery = new DeliveryBuffer({
    state: () => ({
      // Peer review: 'thinking' is busy too — intake runs and the ack is
      // spoken inside it, so a hold delivered then talks over the ack.
      // 'listening' is NOT included: the mic streams continuously, so idle
      // listening is indistinguishable from user speech at this layer, and
      // gating on it would stall every delivery forever. That residual gap
      // (user talking over an idle mic) is stated, not closed.
      speechLive: voicePhase === 'speaking' || voicePhase === 'thinking' || ttsInFlight > 0,
      ttsPlaying: ttsInFlight > 0,
      // No shell has reported playback until one does. Deliberately pessimistic:
      // a delivery into a player that does not exist is silence the user reads
      // as being ignored, and an optimistic default would make that silence
      // permanent — a held confirmation with nothing to flush it.
      playbackReady: playbackSeen,
    }),
    deliver: deliverHeld,
    resultFor: (id) => tasks.getResult(id),
    // Peer review: without this, a shell that never sends `playbackStarted`
    // holds a confirmation until TTL silently drops it — permanent silence
    // for old shells. The expiry hook bounds it: worst case a terminal
    // notice at 30 s, never no notice.
    onExpired: (item) => {
      ui.notice(
        'delivery-expired',
        `تأكيد معلق انتهت صلاحيته دون تسليم (المهمة ${item.taskId}) — قل الطلب مرة ثانية لو ما زال مهماً.`,
        'warn',
      );
    },
  });

  /**
   * The one place a held result reaches the user.
   *
   * Only an FR-12 HOLD is delivered, because that is the only completion that
   * needs the user to do something: a dispatched plan's receipt already rides
   * the task record and is narrated by the plan's own line. Delivering receipts
   * here would put a second, redundant notice in front of every turn.
   *
   * Declared as a function (not a const arrow) so `delivery` above can name it
   * before this point — the buffer is constructed at daemon scope and this
   * closes over `ui`.
   */
  function deliverHeld(item: DeliveryItem): void {
    // Only a HOLD needs the user to act; a dispatched plan's receipt is narrated
    // by the plan's own line and repeating it here would double-report.
    if (item.result.needsConfirmation !== true) return;
    const held = item.result.flagged ?? [];
    ui.notice(
      'plan-held',
      `خطوات مدمّرة محفوظة للملفات ${held.join('، ')} — بانتظار التأكيد من الواجهة (المهمة ${item.taskId}).`,
      'warn',
    );
  }

  // A.6 — key material must not outlive the ring that holds it.
  //
  // A `Keyring` caches one Buffer per pool for its whole life, so a ring that
  // is merely "still referenced" is a ring still holding three API keys in the
  // process heap. Two rings exist and each has a different owner: the pipeline
  // ring (rebuilt on every key save) and the per-narration ring. This single
  // reference tracks the PIPELINE ring only; the narration ring is owned by its
  // own call and destroyed in a `finally`. Deliberately NOT a daemon-lifetime
  // registry: registering a per-call ring would grow one entry per narration for
  // the life of the process, which is the very leak this closes.
  //
  // HONEST LIMIT: `destroy()` erases the cached Buffers. `Keyring.keys` is a
  // `Map<KeyPool, string[]>` — JS strings are immutable, so the vault-decrypted
  // key text itself cannot be zeroed from here. This removes Buffer residency
  // and the per-call copies; it does not make the process's memory provably free
  // of key bytes until it exits. Claiming otherwise would be the kind of
  // reassuring-but-false comment this file keeps hunting.
  let liveRing: Keyring | null = null;

  /**
   * The Fish transport of the CURRENT pipeline, late-bound.
   *
   * Exists for one caller: `speakCourtesy` below. Same late-binding discipline as
   * `coordinatorRef` — a key save replaces the transport, and a late-bound reader
   * is how the replacement is picked up without rebuilding whatever holds it. It
   * is cleared in `rebuildVoice` for the same reason `liveRing` is: a transport
   * over a destroyed ring is a handle to zeroed key bytes.
   */
  // The CONCRETE union, not the `FishTransport` port: `synthesizeStream` is
  // OPTIONAL on the port (`voice/tts.ts:277`), so a port-typed binding would make
  // every call below a TS2722 or need a `!` that lies. `createFishTransport`
  // returns this exact union and both members implement the method as required —
  // the same decision its own return-type comment records.
  let speakTransport: FishHttpTransport | FishWsTransport | null = null;

  /**
   * Speak one courtesy line, out loud, now.
   *
   * WHY THIS IS A SYNTHESIS SITE AND NOT A MODEL CALL. `narrateOutcome` above
   * spends an OpenRouter turn to write a sentence, and D4's rule — "no second
   * synthesis site" — exists because a reply was synthesised TWICE (double Fish
   * quota, 1–2 s of dead work). That defect was a duplicate of the SAME sentence.
   * This is a different sentence, written already, and it is synthesised ONCE:
   * `buildTaskNotice` produced the text and nothing else speaks it. So the quota
   * cost is one Fish call for a line the user asked to hear, which is the cost of
   * speaking at all.
   *
   * WHY IT IS NOT THE REPLY PATH. `onUtterance` sets the voice phase, counts
   * `ttsInFlight`, honours the barge generation and drives `delivery.drain()`. All
   * four are correct for a reply and WRONG here: a courtesy line is not a turn, so
   * it must not take the `speaking` phase (the HUD would report the assistant as
   * mid-answer while a command finishes), must not drain held confirmations, and
 * must not be cancelled by a barge aimed at a reply. It checks the gate, streams
   * the audio, and gets out of the way.
   *
   * BEST EFFORT BY CONSTRUCTION: every failure is swallowed. A notice already
   * rendered visually; a Fish fault on top of it is noise, not information. It
   * must never reject into the task queue's subscriber.
   */
  function speakCourtesy(textAr: string): void {
    const fish = speakTransport;
    if (fish === null) return; // keyless daemon: there is no voice to speak with
    const gen = speechGate.capture();
    const voiceId = VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default'];
    void (async () => {
      try {
        for (const sentence of splitSentences(stripSpeechText(textAr))) {
          if (!speechGate.isCurrent(gen)) return;
          for await (const chunk of fish.synthesizeStream(sentence, voiceId, {
            signal: speechGate.signalFor(gen),
          })) {
            if (!speechGate.isCurrent(gen)) return;
            ui.broadcastAudio(chunk);
          }
        }
      } catch {
        /* see above: a courtesy line never reports a failure of its own */
      }
    })();
  }

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
  /**
   * Narration ceiling, raised from 8,000 ms on measured evidence.
   *
   * Measured live against free-tier Inkling (2026-09-27, three runs): 5,010 ms,
   * 5,015 ms, 5,010 ms — first-token-to-whole-line latency for a ~20-word Arabic
   * reply. Two runs landed 5 ms apart, which says this is the model's typical
   * latency rather than a tail. Against the old 8,000 ms ceiling that is roughly
   * 3,000 ms of headroom, but the two measurements differing by 5 ms is a warning
   * sign, not a comfort: free-tier latency is not contractual and the provider
   * documents no SLA for it.
   *
   * 12,000 ms gives ~2.4x the observed p50 instead of ~1.6x. The cost of being
   * wrong is bounded and small — a stuck narration holds the reply for at most 4 s
   * longer before the pipeline drops it and moves on. The cost of a timeout is a
   * silent turn: the user spoke, the work was done, and the answer never arrives.
   * An asymmetric cost like that argues for the larger ceiling.
   *
   * A named constant rather than an inline literal so the value is greppable and
   * so the test has something stable to assert against.
   */
  const NARRATOR_TIMEOUT_MS = 12_000;

  const narratorChat: NarratorChat = async (model, system, user, options) => {
    const ring = Keyring.load(vault);
    // L17: released with the real outcome, so a 401/403 from OpenRouter rotates
    // the pool instead of silently reusing the rejected key.
    //
    // A.6: this ring exists for ONE call, so it is destroyed in a `finally` —
    // not after the await, which a provider error would skip, and not in a
    // `try` that the throw path walks straight past. The narrator swallows
    // every provider failure and returns null, so the error path is the COMMON
    // path: without this line the daemon leaks one keyring per confirmation for
    // its whole life. `await` (not a bare `return`) is what makes the `finally`
    // cover the in-flight call rather than the promise.
    try {
      return await withKey(ring, 'openrouter', (key) =>
        openRouterChat(
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
            timeoutMs: NARRATOR_TIMEOUT_MS,
            // Inkling is a reasoning model: without effort:none it spends the
            // token budget thinking and returns finish=length with content=null
            // (measured live). Same suppression the Dots3 intake uses.
            reasoning: { effort: 'none' },
            ...(options?.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
          },
        ),
      );
    } finally {
      ring.destroy();
    }
  };

  // The seam: production builds the real OpenRouter-backed chat above; a test
  // injects a spy and asserts the persona actually changes the system prompt.
  const activeNarratorChat: NarratorChat = options.narratorChat ?? narratorChat;

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
        activeNarratorChat,
        NARRATOR_MODEL,
        20,
        // The persona seam. `activePersona` already drove the TTS voice id; now
        // it also reaches the system prompt, so Nour and Kareem finally differ
        // in what they SAY and not only in what they sound like.
        { id: activePersona, directive: PERSONA_DIRECTIVES[activePersona] },
      );
      if (line === null) return;
      setVoicePhase('speaking', line);
      // The same generated line is both spoken and displayed: one source, so
      // the screen can never show a template the user did not hear.
      ui.notice('assistant-said', line, 'info');
    })();
  };

  // ── SHELL RESULTS · POINT 4 ───────────────────────────────────────────────
  // Where an approved `execSessionShell` becomes a task, a frame and a notice.
  //
  // THE FR-12 CONFIRM GATE IS ABOVE THIS LINE, in the router, and that ordering
  // is the point. The decorator sits on the `CommandClient` the daemon CONSTRUCTS,
  // so it fires only after `execute()` released the parked command — a rejected
  // or expired confirmation never enqueues anything, so no task and no output
  // frame exist for a command the user did not authorise. Wiring it below the
  // gate would have been the same fact reached the other way round, except that
  // the parked command would announce itself before it was allowed to exist.
  //
  // The `client` handed to the router is a WRAPPER, not `ServeClient`: four of
  // its five verbs are forwarded untouched and `execSessionShell` is the
  // decorated one. That is the whole reason the FR-12 gate is ABOVE this line:
  // the router reaches serve through this object and nowhere else, so a parked
  // command never reaches a queue.
  const shellTasks = createShellTaskBridge({
    run: (sessionId, command) => client.execSessionShell(sessionId, command),
    emitOutput: (input) => {
      ui.output(input);
    },
    emitNotice: (code, detail, level) => {
      ui.notice(code, detail, level);
    },
    // THE AUDIO RULE, and its three halves:
    //   silent while running     — the bridge only emits on `settled`;
    //   a notice on completion   — unconditional, via `buildTaskNotice`;
    //   spoken inside a silence window only — this predicate.
    //
    // The window is the SAME one `DeliveryBuffer` uses for a held FR-12 ask
    // (`delivery.state().speechLive` below), deliberately: two silence windows
    // that disagree is a way to talk over yourself. 'listening' is excluded there
    // for a stated reason — the mic streams continuously — and it is excluded here
    // for the same one.
    speechAvailable: () => voicePhase !== 'speaking' && voicePhase !== 'thinking' && ttsInFlight === 0,
    speak: options.shellSpeak ?? ((text) => speakCourtesy(text)),
  });

  // ── W11 · the half of a cancel that leaves this process ──────────────────
  // `abortTurn` cancels two LOCAL generations and then interrupts the OpenCode
  // session. This is that third half, and it is the only one that costs a round
  // trip, so it is written to be unable to hurt the other two.
  //
  // NOT AWAITED, EVER. See the `interrupt` parameter's note on `abortTurn`:
  // `abort` is allow-listed in `SERVE_LOCAL_ONLY_COMMANDS` so it still fires
  // when serve is dead, which is when it matters most. Awaiting here would put
  // the local cancel behind an HTTP round trip to a port that may not be
  // listening.
  //
  // NO SESSION, NOTHING TO INTERRUPT. `activeSession` is `undefined` until the
  // shell switches or the daemon creates one, and `interruptSession` would
  // throw `SESSION_NOT_FOUND` for a fabricated id. Skipping is the truthful
  // answer, not a silent success: there was no session running.
  const interruptActiveSession = (): void => {
    const session = activeSession;
    if (session === undefined) return;
    void client.interruptSession(session).catch(() => {
      // The user asked to stop work that may still be running inside OpenCode,
      // and it did not stop. Saying so is the whole point — a cancel that fails
      // quietly is the same defect as a cancel that is not wired at all, and it
      // is the one half of this path that cannot be verified locally.
      //
      // The error itself is deliberately NOT interpolated and NOT logged here.
      // `err.message` from the control funnel is a provider string, and
      // redaction is a SINK responsibility (`UiServer.notice`), so echoing it
      // into a second channel would be exactly the leak that sink exists to
      // prevent. `notice.code` is an open `z.string().min(1)`, so a new code is
      // additive and needs no protocol change; the shell renders it through the
      // generic notice pipe.
      //
      // STATED LIMIT — no telemetry row for this failure. `TelemetryInput`'s
      // `subsystem` is a closed union (`STT|BRAIN|TTS|LAYA|LAUNCHER|KEYRING`,
      // `telemetry/writer.ts`) and none of those six is honest for a session
      // interrupt. `BRAIN` would be a lie in the one file whose own comment says
      // reusing a wrong code "would have put a lie in the data", so the row is
      // omitted rather than falsified. Widening the union is the correct fix and
      // is deliberately NOT smuggled in from here.
      ui.notice(
        'interrupt-failed',
        'وقفنا الصوت محلياً، بس ما قدرنا نوقف شغل OpenCode — جرّب مرة ثانية.',
        'warn',
      );
    });
  };

  // ── SERVE RESILIENCE · POINT 3 · the gate ─────────────────────────────────
  // EXACTLY the one-line guard `docs/SERVE-RESILIENCE.md` specifies: a wrapper,
  // two existing arguments, one new. `withServeGate` is generic over the command
  // and the outcome type, so the handler and the refusal both fit without a cast.
  //
  // IT IS DEFAULT-DENY. `SERVE_LOCAL_ONLY_COMMANDS` is an ALLOWLIST of the nine
  // kinds that provably cannot reach serve — including `abort` and `stopSpeech`,
  // which are what a user reaches for when the assistant will not stop talking.
  // Blocking those because serve died would make this gate CAUSE the outage it
  // exists to describe. Everything else, `confirm` included, is refused with
  // `serveBlockedDetail(status)`, and a parked command then expires on its own
  // `CONFIRMATION_TTL_MS` rather than running against a dead port.
  ui.onCommand = withServeGate(
    () => serveHealth.status(),
    createCommandHandler({
    client: {
      // Forwarded UNCHANGED. Spelled out rather than spread, deliberately: `client`
      // is a class instance, so `{ ...client }` would copy no prototype method and
      // every verb below would become `undefined` at runtime — a spread that type-
      // checks and does nothing. One line per verb, checked at compile time.
      setSessionAgent: (sessionId, agent) => client.setSessionAgent(sessionId, agent),
      setSessionModel: (sessionId, model) => client.setSessionModel(sessionId, model),
      toggleSessionSkill: (sessionId, skill, skillAction) =>
        client.toggleSessionSkill(sessionId, skill, skillAction),
      createSession: (directory) => client.createSession(directory),
      contextUsage: (sessionId, limit) => client.contextUsage(sessionId, limit),
      // The decorated one. See the note above on why the gate is above this.
      //
      // THREE PARAMETERS, ALL THREE FORWARDED. This line used to take two and drop
      // the third, which TypeScript accepts without complaint (fewer parameters is
      // assignable) and which therefore compiled green while the `output` frame
      // carried the task queue's UUID instead of the WS command id the shell is
      // waiting on. The router forwards `cmd.id` and this is where it lands; the
      // id is not defaulted, not clamped and not renamed, because a value invented
      // here is indistinguishable from a value that was threaded and lost.
      execSessionShell: (sessionId, command, commandId) => shellTasks.execSessionShell(sessionId, command, commandId),
    },
    // Phase 4: the project root serve is scoped to, and the directory a new
    // session is created in. Never taken from the command payload.
    projectDirectory: () => options.directory ?? process.cwd(),
    onContext: (sessionId, usage) => {
      ui.context(sessionId, usage.used, usage.limit, usage.percent, usage.messageCount);
    },
    onExecuted: (executed, outcome) => {
      // M2-P2: a barge is not an outcome to speak. narrateOutcome would pull
      // session details and spend an Inkling call per interruption, then talk
      // over the still-running turn the user just asked to quiet.
      if (executed.kind === 'stopSpeech') return;
      // M2 Pattern 3: same reasoning, harder. `playbackStarted` fires ONCE per
      // utterance from the renderer's player, so narrating it would add a second
      // spoken line to every reply — the assistant talking about its own audio,
      // and talking over it.
      if (executed.kind === 'playbackStarted') return;
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
      // L22: the HUD and the settings window each kept their own persona state,
      // so a change made in one left the other showing — and speaking — the
      // previous persona. The daemon is the single source: it announces the
      // change and both surfaces follow.
      //
      // The equality guard is the echo-loop defence. A surface that re-sends
      // `setPersona` on receiving `persona-changed` would make the daemon
      // re-announce, and the two would trade updates indefinitely. Returning
      // early on an unchanged persona makes that loop unrepresentable rather
      // than merely unlikely.
      if (activePersona === persona) return;
      activePersona = persona;
      ui.setPersona(persona);
      ui.notice('persona-changed', persona, 'info');
    },
    // The EXPLICIT stop (the HUD button): the whole turn, not just the audio.
    // W11: three halves now — the TTS gate, the local turn generation, and the
    // OpenCode session. The first two are local; only `interruptActiveSession`
    // leaves the process, and it is the only one that could have been missing
    // without any local test noticing.
    onAbort: () => abortTurn(speechGate, () => audio, interruptActiveSession),
    // M2 Pattern 2: a voice burst stops the SPEECH only. Barely more than
    // `speechGate.abort()` on purpose — reaching the pipeline here would throw
    // away a plan the user is already paying for. Structural guard:
    // `daemon-barge-in.test.ts > M2-P2`.
    onStopSpeech: () => speechGate.abort(),
    // M2 Pattern 3: the shell's player began audio. This is the ONLY proof the
    // daemon has that a live shell is taking audio, so it marks the delivery
    // channel playable and drains anything held during the utterance.
    //
    // Ordering matters and is deliberate: `playbackSeen` is set BEFORE the drain
    // so the drain's own `channelFree` check can see the new value. Draining
    // first would find the channel closed and return 0, and the held
    // confirmation would sit until the next unrelated event.
    onPlaybackStarted: () => {
      // The correlation id is deliberately NOT logged. It is a renderer-local
      // counter: it names nothing the daemon can act on, and telemetry that
      // records un-actionable values trains ops to ignore the column.
      playbackSeen = true;
      delivery.drain();
    },
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
    }),
    // The refusal the gate returns instead of calling the handler. Not a throw:
    // the WS layer turns an outcome into an `ack`, so a blocked command reads as
    // a refused command, which is what it is.
    (status) => ({ ok: false, detail: serveBlockedDetail(status) }),
  );

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
  const telemetry = new TelemetryWriter(join(runtimeDir, 'voice-runtime.jsonl'));
  const record = (input: Omit<TelemetryInput, 'sessionId' | 'eventId'>): void => {
    try {
      telemetry.record({ sessionId: activeSession ?? 'none', eventId: randomUUID(), ...input });
    } catch {
      // Deliberately swallowed — see above.
    }
  };
  /**
   * Map a thrown value to the closed error-class union. Never leaks a message.
   *
   * THE BODY LIVES IN `telemetry/error-class.ts` (W27). It used to be this
   * closure, and that was load-bearing in a way nobody intended: a closure over
   * nothing cannot be imported, so no test could call it with a real error, so
   * the classifier's rule was never exercised by a real error — which is exactly
   * how `SttTimeoutError` came to be recorded as `Unknown` for the daemon's
   * entire life while every row it wrote looked plausible.
   *
   * The name `classify` and every `classify(err)` call site are kept, so the
   * wiring guard that pins them (`policy/telemetry-wired.test.ts`) still matches
   * the call it was written against.
   */
  const classify = classifyError;

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
  //
  // M3-B.4: the decision logic (frame loop, deadline, abandoned-promise
  // handling) moved to `runtime/vad-gate.ts`. What stays here is the one thing
  // that is daemon-specific: the lazy dynamic import and its config read.
  let vadLoad: Promise<VadModule | null> | null = null;
  const loadVad = (): Promise<VadModule | null> => {
    if (vadLoad === null) {
      const cfg = loadConfig();
      // The import itself can fail (missing native package in the sidecar), so
      // it lives inside the promise where `.catch` can actually see it.
      vadLoad = import('./runtime/vad.js')
        .then((m) => m.SileroVad.load(cfg.vad.modelPath, { threshold: cfg.vad.threshold }))
        .catch(() => null);
    }
    return vadLoad;
  };

  const vadGate = makeVadGate(loadVad, isLoudWindow);

  const setVoicePhase = (phase: 'idle' | 'listening' | 'thinking' | 'speaking', transcript?: string): void => {
    if (phase === voicePhase && transcript === undefined) return;
    voicePhase = phase;
    ui.voice(phase, transcript);
  };

  const buildVoicePipeline = (): AudioPipeline | null => {
    // Hoisted so the catch can zero a ring that was loaded and then orphaned by
    // a constructor throwing.
    let built: Keyring | null = null;
    try {
      const ring = Keyring.load(vault);
      built = ring;
      // A.6: the daemon is now the owner of this ring, so the daemon destroys it
      // — on the next rebuild and at stop. Closure-scoped single reference, not
      // a collection: there is only ever one pipeline ring.
      liveRing = ring;
      // M2 Pattern 6b rollback: `TTS_TRANSPORT` unset (or anything but the exact
      // string "ws") builds `FishHttpTransport`, which is the measured path. The
      // factory lives in fish-ws.ts because tts.ts cannot import it back
      // without a cycle.
      const fish = createFishTransport(ring);
      // Re-point the courtesy speaker at THIS transport, for the same reason
      // `coordinatorRef` is re-pointed below: a key save replaces the transport,
      // and a speaker still holding the previous one would speak over a destroyed
      // ring's key bytes.
      speakTransport = fish;
        const chat: ChatFn = async (model, system, user, options) => {
          return withKey(ring, 'openrouter', (key) =>
            openRouterChat(keyMaterial(key), model, system, user, fetch, {
              ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
              ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
              ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
              ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
              ...(options?.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
            }),
          );
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
        // Phase B — the ask reaches the user as a notice.
        //
        // NOT synthesised here, and that is deliberate. The single audible path
        // is `onUtterance`, which runs at `think()` time, BEFORE the planner
        // exists; adding a second synthesis site is exactly the double-Fish-
        // quota defect D4 was written to remove, and `speak` is deliberately
        // not passed to the coordinator for that reason. So the ask is RENDERED
        // immediately and ANSWERED BY VOICE on the next turn.
        //
        // The cost, stated: the user hears intake's acknowledgement, then about
        // 2-4 s later sees the question appear. It is not spoken. Speaking it
        // needs a second audible surface and is C-phase work.
        onPermissionRequired: (pending) => {
          ui.notice(
            'permission-required',
            `${pending.askAr} (${pending.taskEn.slice(0, 80)})`,
            'warn',
          );
        },
      });
      // M2 Pattern 1: re-point the daemon-scoped queue at the coordinator that
      // closes over THIS ring. A key save rebuilds the pipeline and therefore the
      // coordinator; without this the queue would keep planning through a
      // destroyed ring's key material. The queue itself is not rebuilt, so
      // in-flight tasks survive the save.
      coordinatorRef = coordinator;
      // The one measured handoff between the STT call and the pipeline's
      // recovery callback (W27). `onSttTimeout` is handed the TIMEOUT BUDGET,
      // which is a constant, so writing it into `latencyMs` reported every stall
      // as exactly 15 000 ms — a fabricated measurement in the one file whose
      // entire job is measurement. This holds the real elapsed time until the
      // callback fires.
      //
      // Declared at PIPELINE scope, not inside `transcribe`, because the writer
      // (`transcribe`'s catch) and the reader (`onSttTimeout`) are siblings in
      // this one options object.
      //
      // ORDER IS DETERMINISTIC, not a race: the timeout arm rethrows,
      // `transcribeWindow` catches it and calls `onSttTimeout` synchronously
      // afterwards, and `pushChunk` awaits windows serially — that serial await
      // is the very wedge D5 fixed — so no second window can overwrite this
      // between the write and the read.
      let sttElapsedMs: number | null = null;
      return new AudioPipeline({
        // M3 B.3: the accumulator reports watermarks, the transport publishes
        // them. The callback is transport-blind — `AudioIngest` neither imports
        // the IPC layer nor knows a frame exists — so the seam is a plain
        // function, and the accumulator is unit-testable with no socket.
        ingest: new AudioIngest({
          onWatermark: (state) => {
            uplinkPaused = state === 'pause';
            ui.flow(state);
          },
        }),
        speechGate: vadGate,
        transcribe: async (pcm) => {
          // D13: the phase moved to 'thinking' on EVERY incoming window, so the
          // HUD flickered listening→thinking 10×/s. It is now set in `think`,
          // which runs only for a window that survived the speech gate.
          // L17: a Groq 401/403 now advances the pool. Previously this reported
          // success on every path, so a revoked key stayed in use and STT simply
          // stopped producing text with nothing to distinguish it from silence.
          const t0 = Date.now();
          return withKey(ring, 'groq', async (key) => {
            try {
              const res = await transcribeStream(pcm, new GroqWhisperClient(keyMaterial(key)));
              record({ subsystem: 'STT', status: 'OK', latencyMs: Date.now() - t0 });
              // D1: surface no_speech_prob so the pipeline can drop a window
              // Whisper itself believes was not speech.
              return res.noSpeechProb === undefined
                ? res.text
                : { text: res.text, noSpeechProb: res.noSpeechProb };
            } catch (err) {
              // A STALL IS NOT A FAILURE, and this is the only branch that knows
              // it (W27). `SttTimeoutError` is thrown by `stt.ts`'s race, and the
              // pipeline's `transcribeWindow` catches exactly that class, counts
              // it, fires `onSttTimeout` and DROPS the window — the loop keeps
              // flowing by design (`audio-pipeline.ts`, the D5 fix). So the
              // pipeline, not this catch, is the authority on a timeout.
              //
              // Before this branch, ONE stalled window produced THREE false
              // reports about itself: this row (`STT_FAILED`/`ERROR`), this
              // notice (`stt-failed`, severity `error`) and then the pipeline's
              // `STT_TIMEOUT`/`DEGRADED` row and `stt-timeout` notice at
              // severity `warn`. Two notices at conflicting severities for one
              // recoverable event, and the harsher one first. The user was told
              // speech-to-text had failed while the app was still listening.
              //
              // The rethrow is load-bearing: it is what lets the pipeline
              // recognise the timeout and recover. Swallowing it here would turn
              // a recoverable stall into a wedge.
              if (err instanceof SttTimeoutError) {
                sttElapsedMs = Date.now() - t0;
                throw err;
              }
              record({
                subsystem: 'STT',
                status: 'ERROR',
                latencyMs: Date.now() - t0,
                errorCode: 'STT_FAILED',
                sanitizedErrorClass: classify(err),
    // L16: a revoked key is not just a failure, it is a failure the keyring
    // recovered from by advancing the pool. Recording that is the difference
    // between "STT is broken" and "the key rotated, the next try may work".
    remediationAttempted: keyAdvanced(err) ? 'KeyAdvanced' : 'None',
              });
              ui.notice('stt-failed', `تعذّر تحويل الكلام إلى نص: ${err instanceof Error ? err.message : 'خطأ'}`, 'error');
              throw err;
            }
          });
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
                task = await withKey(ring, 'openrouter', (key) =>
                  optimizePrompt(
                    spoken,
                    (model, system, user) =>
                      openRouterChat(keyMaterial(key), model, system, user, fetch, {
                        reasoning: { effort: 'none' },
                        timeoutMs: OPTIMIZER_TIMEOUT_MS,
                      }),
                    INTAKE_MODEL,
                    {},
                  ),
                );
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
    remediationAttempted: keyAdvanced(err) ? 'KeyAdvanced' : 'None',
              });
            }
          }
          try {
            // M2 Pattern 1 — the kill-switch. `tasks.enabled === false` restores
            // the pre-split behaviour exactly (`await coordinator.run(task)`),
            // so a regression in the queue can be turned off without a rebuild.
            // The default is ON: the split is the shipped path.
            if (!tasks.enabled) {
              const mission = await coordinator.run(task);
              record({
                subsystem: 'BRAIN',
                status: 'OK',
                latencyMs: Date.now() - t0,
                ...(resolvedMentions.length > 0 ? { remediationAttempted: 'None' as const } : {}),
              });
              const reply = mission.replyAr ?? '';
              return mission.receipt === null ? { reply } : { reply, receipt: mission.receipt };
            }

            // Intake ONLY, then return. This is the whole latency change: the
            // measured intake p50 is 901 ms and the plan p50 is 1950 ms, so
            // speaking the ack here rather than after `run()` removes the plan
            // from the audible path entirely.
            //
            // Peer review: the epoch advances on every ACCEPTED utterance,
            // pre-intake — even one intake then fails to understand. The user
            // spoke, so the previous turn is superseded whether or not the new
            // words parse; otherwise a barge followed by a misheard turn would
            // leave the stale plan dispatching.
            voiceEpoch += 1;
            // M2 Pattern 3: the new utterance supersedes anything still waiting
            // to be delivered. The queue gets its own `cancel` on the same signal;
            // the delivery buffer needs it too, because a held FR-12 confirmation
            // from the PREVIOUS turn is not stale data — it is a prompt for a plan
            // the user has moved past, and answering it would be acting on an
            // instruction they retracted.
            delivery.cancelEpoch(voiceEpoch - 1);
            const ack = await coordinator.intake(task);
            record({
              subsystem: 'BRAIN',
              status: ack.ok ? 'OK' : 'DEGRADED',
              latencyMs: Date.now() - t0,
              ...(resolvedMentions.length > 0 ? { remediationAttempted: 'None' as const } : {}),
              // Peer review (D2): a 6a re-ask silently doubles this row's
              // latency. The flag says which rows are two calls, not one.
              ...(ack.reasked === true ? { remediationAttempted: 'Reasked' as const } : {}),
            });
            if (!ack.ok || ack.replyAr === undefined || ack.taskEn === undefined) {
              ui.notice('intake-failed', 'ما قدرت أفهم الطلب — جرّب مرة ثانية بصيغة أوضح.', 'warn');
              return { reply: '' };
            }

            // A new utterance supersedes the previous turn's work — bumped
            // pre-intake above, so this enqueue only records the epoch.
            tasks.enqueue({
              // The USER's words, not the optimizer's rewrite: `task` is the
              // dispatchable brief and `transcript` is what was actually said.
              transcript,
              taskEn: ack.taskEn,
              replyAr: ack.replyAr,
              epoch: voiceEpoch,
              ...(ack.intakeModel !== undefined ? { intakeModel: ack.intakeModel } : {}),
            });

            // Drain in the background. NOT awaited: awaiting here is exactly
            // the serialization the split exists to remove. `drain()` never
            // rejects (it absorbs planner faults into a failed task), but the
            // catch keeps a future change from becoming an unhandled rejection
            // that takes down the process rather than one turn.
            void tasks.drain().catch(() => undefined);

            // Returning the ack here hands it to the pipeline's own
            // `onUtterance({ transcript, reply, receipt })` — the single
            // audible path, unchanged — so the acknowledgement is synthesised
            // and broadcast while the plan is still being built.
            //
            // `receipt: null` is honest, not a placeholder: nothing has been
            // dispatched yet, and the receipt rides the task record instead.
            // It is also load-bearing for correctness — the pipeline falls back
            // to dispatching the RAW transcript when `receipt === null` AND a
            // `dispatch` dep exists. The daemon's pipeline has no such dep, so
            // nothing is dispatched here; that is asserted in the tests.
            return { reply: ack.replyAr, receipt: null };
          } catch (err) {
            record({
              subsystem: 'BRAIN',
              status: 'ERROR',
              latencyMs: Date.now() - t0,
              errorCode: 'BRAIN_FAILED',
              sanitizedErrorClass: classify(err),
    remediationAttempted: keyAdvanced(err) ? 'KeyAdvanced' : 'None',
            });
            ui.notice('brain-failed', `تعذّر توليد الرد: ${err instanceof Error ? err.message : 'خطأ'}`, 'error');
            throw err;
          }
        },
        activeSessionId: () => activeSession,
        // D5: a stalled provider costs one window, not the session, and the
        // shell is told so the silence is not read as a bug.
        onSttTimeout: (ms) => {
          // THE SINGLE AUTHORITY for a stalled STT window (W27). The pipeline
          // dropped the window and kept listening, so this is a DEGRADED
          // observation at `warn`, not a failure at `error` — and the STT call's
          // own catch no longer claims otherwise. One stall is now one row and
          // one notice, rather than two of each at conflicting severities.
          //
          // `latencyMs` is the MEASURED elapsed time when the STT call left it
          // for us, and the budget only as a floor, so a row never asserts a
          // precision the code does not have. `sanitizedErrorClass` is the
          // literal `'TimeoutError'` rather than `classify(err)` because the
          // callback is handed a duration, not the error; it is written out so
          // that the row's class and `classify`'s answer cannot drift apart.
          const measured = sttElapsedMs ?? Math.round(ms);
          record({
            subsystem: 'STT',
            status: 'DEGRADED',
            latencyMs: measured,
            errorCode: 'STT_TIMEOUT',
            sanitizedErrorClass: 'TimeoutError',
            remediationAttempted: 'None',
          });
          ui.notice('stt-timeout', `تجاوز تحويل الصوت المهلة (${Math.round(ms / 1000)} ثانية) — تم تجاهل النافذة ومتابعة الاستماع.`, 'warn');
          sttElapsedMs = null;
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
            // M2 Pattern 3: the channel is NOT free from here until the audio is
            // out and the phase is idle. Counted, not boolean, because the barge
            // path returns from inside the loop and a naive `= false` in the
            // `finally` could clear the flag while a second utterance is already
            // synthesising.
            ttsInFlight += 1;
            // Snapshot the persona for the whole utterance: a persona switch
            // mid-reply would otherwise split one sentence across two voices.
            const voiceId = VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default'];
            const gen = speechGate.capture();
            const sentences = splitSentences(text);
            const t0 = Date.now();
            try {
              for (const sentence of sentences) {
                if (!speechGate.isCurrent(gen)) return;
                // M2-6c: DRAIN, do not await. `fish.synthesize` concatenated the
                // whole sentence before a single byte reached the shell, so the
                // measured 426-556 ms Fish time-to-first-byte was spent in
                // silence and then re-spent as a stall between sentences. The
                // stream hands each chunk over as Fish emits it.
                //
                // BOUND: `broadcastAudio` still runs every payload through
                // `splitAudio` (ipc/audio.ts), so a downlink frame is at most
                // MAX_AUDIO_CHUNK (32 KiB) + a 3-byte header no matter how large
                // a Fish chunk is. That per-call frame cap is the load-bearing
                // claim (pinned below); MAX_AUDIO_BYTES (64 KiB) is the inbound
                // reassembly cap and the downlink was never subject to it.
                // Pinned by `daemon.test.ts > M2-6c`.
                for await (const chunk of fish.synthesizeStream(sentence, voiceId, {
                  // M2 Pattern 2: the barge must reach Fish too, not just the
                  // broadcast. Without a signal the provider kept synthesising
                  // audio nobody would hear — wasted free-tier credit, paid on
                  // the one interaction where the user already gave up on
                  // hearing the rest. The gate check below still governs the
                  // broadcast; this governs the generation.
                  signal: speechGate.signalFor(gen),
                })) {
                  // Per CHUNK, not per sentence: a barge-in now lands within one
                  // chunk instead of one whole sentence. Returning here closes
                  // the generator, so the transport's `finally` cancels the reader.
                  if (!speechGate.isCurrent(gen)) return;
                  ui.broadcastAudio(chunk);
                }
              }
              record({ subsystem: 'TTS', status: 'OK', latencyMs: Date.now() - t0 });
            } catch (err) {
              // M2 Pattern 2: a barge is a CANCEL, not a failure. The signal
              // fires, the provider read rejects, and the `finally` below drops
              // the phase to idle (which is the `voice` frame the shell reads) —
              // that is the whole ordered outcome: abort → idle → notify.
              //
              // Without this the deliberate cancel was billed as a TTS failure:
              // a `TTS_FAILED` telemetry row and a red `تعذّر توليد الصوت` notice
              // shown to a user who did nothing wrong but talk over the reply.
              //
              // A credit fault is the one exception: a 402/429 means the balance
              // is gone, it is rare, and it is the only branch a user can act on
              // — dropping it to keep a barge quiet would be the wrong trade.
              //
              // Peer review: gate on the error's SHAPE, not only the
              // generation. A genuine 401/403 or timeout arriving after any
              // barge must still bill and notify; only a caller abort
              // (AbortError from our own signal) is the barge working.
              const abortedByBarge =
                typeof err === 'object' &&
                err !== null &&
                (err as { name?: unknown }).name === 'AbortError';
              if (!speechGate.isCurrent(gen) && !(err instanceof FishCreditError) && abortedByBarge) return;
              record({
                subsystem: 'TTS',
                status: 'ERROR',
                latencyMs: Date.now() - t0,
                errorCode: 'TTS_FAILED',
                sanitizedErrorClass: classify(err),
              });
              // The credit interceptor. A 402/429 is not a generic failure: the
              // key is fine and rotating it would change nothing, so the only useful
              // instruction is to top up. The typed error lets this branch say that
              // instead of leaking a prose message the user cannot act on.
              if (err instanceof FishCreditError) {
                const credit = ttsCredit.recordFault(err);
                record({
                  subsystem: 'TTS',
                  status: 'ERROR',
                  latencyMs: Date.now() - t0,
                  // Distinct from TTS_FAILED: this one is a balance problem, and
                  // telemetry that conflates them hides the renewal from ops.
                  errorCode: `TTS_CREDIT_${err.status}`,
                  sanitizedErrorClass: classify(err),
                });
                if (credit.noticeCode !== null && credit.noticeDetailAr !== null) {
                  ui.notice(credit.noticeCode, credit.noticeDetailAr, 'warn');
                }
                return;
              }
              ui.notice('tts-failed', `تعذّر توليد الصوت: ${err instanceof Error ? err.message : 'خطأ'}`, 'error');
            } finally {
              ttsInFlight -= 1;
              setVoicePhase('idle');
              // M2 Pattern 3: the quiet window this whole module waits for. The
              // ORDER is load-bearing: the phase drops to idle and the in-flight
              // count reaches zero BEFORE the drain, or `channelFree` sees a busy
              // channel, returns 0, and the held confirmation waits for an event
              // that may never come.
              //
              // Peer review corrected the old claim here: this drain does NOT
              // flush holds for a shell that never sends `playbackStarted`
              // (`playbackReady` stays false). That case is bounded instead by
              // the TTL expiry hook below — worst case a terminal notice at
              // 30 s, never permanent silence.
              delivery.drain();
            }
          })();
        },
      });
    } catch {
      // A.6: a build that failed after the vault was read still loaded a ring.
      // Leaving it to the GC is the leak, so it is zeroed here and dropped.
      if (built !== null) {
        if (liveRing === built) liveRing = null;
        built.destroy();
      }
      return null;
    }
  };

  const rebuildVoice = (): void => {
    // A.6: the ring being replaced is holding the keys the user is in the middle
    // of replacing. Destroy it BEFORE the new pipeline is built, so the daemon
    // never holds two rings' worth of key bytes — and so a failed rebuild cannot
    // leave the previous ring alive, unreachable and unzeroed.
    const outgoing = liveRing;
    liveRing = null;
    outgoing?.destroy();
    // The transport that ring fed goes with it. Left pointing, a courtesy line
    // fired after a key save would read the DESTROYED ring's cached buffers —
    // exactly the A.6 leak, one hop removed.
    speakTransport = null;
    // M3 B.3: the accumulator is about to be replaced by an empty one, so any
    // pause it held can never be released by it. Say so explicitly, or the shell
    // drops uplink audio until the next restart.
    if (uplinkPaused) {
      uplinkPaused = false;
      ui.flow('resume');
    }
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
  // C2: only now, with the socket actually bound, does this daemon have a claim
  // worth making.
  publishOwner(boundPort);

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
  // The monitor STARTS here and not at construction: this is the first moment the
  // amber bar has a socket to travel over, and a monitor armed before `ui.start()`
  // returned would have detected an outage it could not report. `start()` does not
  // probe immediately either (`serve-health.ts:387`) — the boot probe answered this
  // exact question milliseconds ago, so the first tick is one full interval out.
  serveHealth.start();

  return {
    ipcPort: boundPort,
    servePort: options.servePort,
    token: options.ipcToken,
    get ttsCredit() {
      return ttsCredit;
    },
    // ── SERVE RESILIENCE · POINT 5 ───────────────────────────────────────────
    // A VIEW, mirroring `ttsCredit` exactly, and for the same reason: a snapshot
    // would report an object nothing else is reading.
    get serveHealth() {
      return serveHealth;
    },
    get shellTasks() {
      return shellTasks;
    },
    publishSessions,
    activePersona: () => activePersona,
    stop: async () => {
      // FIRST, beside `inventory.dispose()`: both are the periodic pollers, and a
      // poll that fires during teardown is a probe against a port the supervisor is
      // already tearing down. `stop()` is unconditional, so this is safe even if the
      // monitor latched off after exhausting its attempt budget.
      serveHealth.stop();
      // The shell queue second, and before the socket closes: `close()` rejects
      // every in-flight `execSessionShell` waiter, and a command parked in
      // `confirm` must learn that from an `ack` rather than hanging on a promise
      // whose daemon is gone. Emitting into a closed socket would be the worse
      // failure of the two, so this runs while `ui` is still open.
      shellTasks.close();
      inventory.dispose();
      // Flush the diagnostics buffer before the socket goes away, or the last
      // few rows — usually the ones explaining WHY the user is shutting down —
      // are lost.
      await telemetry.close().catch(() => undefined);
      // A.6: the pipeline ring's cached key bytes go last, after the rows that
      // explain the shutdown are on disk and before the socket closes. Idempotent
      // and nullable, because a keyless daemon never built one and a save may have
      // replaced it. NOT a closed window: a turn still in flight can re-acquire
      // (and re-cache) after this line, since the socket is still open.
      const remaining = liveRing;
      liveRing = null;
      remaining?.destroy();
      // C2: drop the claim before the socket goes away, so the next launch sees a
      // cold port rather than a marker naming a process that is shutting down.
      clearOwner();
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
 * True when this platform can actually make a file owner-only from Node.
 *
 * MEASURED on Windows, not assumed: `writeFileSync(p, x, { mode: 0o600 })`
 * followed by `chmodSync(p, 0o600)` leaves the file at
 *
 *   NT AUTHORITY\SYSTEM:(I)(F)
 *   BUILTIN\Administrators:(I)(F)
 *   <owner>:(I)(F)
 *
 * Both calls compile, return, and change nothing that matters. `mode` is an
 * argument to `open(2)`, and it is consumed only when the file is CREATED;
 * `chmodSync` is `SetFileAttributes`, which toggles `FILE_ATTRIBUTE_READONLY`
 * and no access control at all. So the `0o600` here was never a control — it
 * was decoration that read like one, which is the same failure shape as the
 * `(0600)` comments that used to ship with no ACL code anywhere.
 *
 * Windows carries "only me" in a DACL. Node cannot write one without a native
 * addon, which is why the Rust supervisor owns credential creation on this
 * platform (see `restrict_to_owner` in `main.rs`).
 */
const CAN_ENFORCE_FILE_MODE = process.platform !== 'win32';

/**
 * Return the per-install IPC token, generating it on first use (H4). The value
 * is random per machine, never baked into the bundle or logs, and — on Windows —
 * never written by this process at all (see `CAN_ENFORCE_FILE_MODE`).
 *
 * ADOPT, NEVER RE-CREATE, ON WINDOWS. This function used to create the file
 * with `{ mode: 0o600 }` and a `chmodSync`, which is why it could win a race
 * against the supervisor and leave the WS-4097 bearer token readable by
 * `BUILTIN\Administrators`. It is the ONLY producer of this credential outside
 * the Rust supervisor: `serveDaemon` reaches it solely when
 * `VOICE_RUNTIME_IPC_TOKEN` is absent from the environment, and the supervisor
 * always sets that (main.rs). So the create branch is reachable exactly when the
 * supervisor did NOT run — which is not a moment this process should be inventing
 * a credential in, because it cannot protect the file it is about to write.
 *
 * Failing closed is the correct direction here rather than a loud no-op: a
 * refused create is an operator-visible error naming the real cause, whereas a
 * silently world-readable bearer token is discovered during an audit.
 *
 * An EXISTING file is still adopted, and `writeFileSync` against an existing
 * path does not change its security descriptor, so this never downgrades what
 * the supervisor locked down.
 */
export function ensureIpcToken(path: string = ipcTokenPath()): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const token = randomBytes(32).toString('hex');
  if (!CAN_ENFORCE_FILE_MODE) {
    throw new Error(
      `ipc.token is absent at ${path} and this process cannot create it safely: ` +
        'on Windows a 0600 mode is a no-op (SetFileAttributes), so a token written here ' +
        'would be readable by every local administrator. Provision the token through the ' +
        'Voxaura shell, which applies a protected owner-only DACL, or set ' +
        'VOICE_RUNTIME_IPC_TOKEN.',
    );
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on POSIX only. Reachable exclusively where the mode above is
    // real, so a failure here is the filesystem refusing, not a silent no-op.
  }
  return token;
}
