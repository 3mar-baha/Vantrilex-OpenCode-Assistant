import { probeHealth } from '../launcher/index.js';

// Loss-of-serve detection and recovery state, built AROUND the existing
// `probeHealth`. This module deliberately does not implement a second probe: a
// second one would be a third opinion about the same question, and this repo has
// already paid for that mistake once (see `launcher/launcher.ts:6-20`, where a
// `SupervisedLauncher`/`siblings.ts` pair documented each other as backstops
// while neither ran). `probeHealth` is imported, injected-for-tests, and
// wrapped — never reimplemented.
//
// WHAT THIS IS NOT: this does not change daemon boot. `daemon.ts:264-269`
// still probes once and still throws `SERVE_UNREACHABLE` when serve is dead, so
// a daemon that starts against a dead serve still refuses to start. That
// fail-closed boot check is a deliberate safety property and is NOT this
// module's to relax. This module only governs what happens AFTER a daemon has
// proven serve healthy, and it is not wired into the daemon at all yet (see
// docs/SERVE-RESILIENCE.md for the integration points).
//
// WHY IT IS NEEDED. A one-shot boot probe means the health of the only process
// this app is a front-end for is known exactly once, at startup. When
// `opencode serve` dies later, every command still reaches ServeClient and
// fails one request at a time as a `SERVE_UNREACHABLE` thrown from
// `runtime/client.ts:494`, and the user gets per-command failures with no
// statement of the actual condition. The owner's decision: an amber
// "reconnecting to OpenCode" state, and the command path refuses until the port
// is back — without the app crashing.

/**
 * Steady-state poll cadence while serve is healthy.
 *
 * WHY 5s. Two things bound the choice from below and above. Below: the amber
 * bar is worthless if it appears after the user has already seen three failed
 * commands, so detection has to be fast — at this cadence plus
 * `SERVE_HEALTH_FAILURE_THRESHOLD`, a genuinely dead port is declared lost
 * within ~10s. Above: each tick is one loopback HTTP GET to
 * `/api/session` with a 2s abort (`launcher/launcher.ts:28`), so 5s is 0.2
 * requests/second forever. The WS-4097 shell ping runs on the same 5s cadence
 * (`ipc/protocol.ts:11`), so the two periodic signals are deliberately
 * co-cadenced — one number to reason about rather than two.
 */
export const SERVE_HEALTH_INTERVAL_MS = 5_000;

/**
 * Timeout passed to `probeHealth` per attempt. This is deliberately the SAME
 * number as the probe's own default (`launcher/launcher.ts:22`) rather than a
 * second value that could drift from it.
 */
export const SERVE_HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * Grace added to `SERVE_HEALTH_PROBE_TIMEOUT_MS` to form the monitor's own
 * watchdog.
 *
 * WHY a watchdog at all, when the probe already aborts. `probeHealth` is
 * cooperative: it clears its AbortController timer in a `finally`. The monitor's
 * bounded-ness should be a property of the monitor rather than an inherited
 * promise about a collaborator — a probe that ignored its timeout argument
 * would otherwise hang the tick forever and the outage would supervise itself.
 * The grace exists so the watchdog cannot beat the cooperative abort and turn
 * every timing-out probe into a watchdog expiry; the watchdog is only there for
 * a probe that does not come back at all.
 */
export const SERVE_HEALTH_WATCHDOG_GRACE_MS = 500;

/**
 * Consecutive failed probes required before serve is declared lost.
 *
 * WHY 2, not 1. One failed probe cannot be distinguished from one slow probe.
 * `probeHealth` returns a bare boolean and throws the reason away
 * (`launcher/launcher.ts:32-34`), so a 2s timeout, a 500, a 401 and a closed
 * port are the same `false`. Declaring loss on the first one converts a routine
 * hiccup — the serve process is busy answering an inference turn on a
 * single-supervisor box — into an amber bar plus a blocked command path, which
 * is strictly worse than the outage it was built to report. Two consecutive
 * failures span two poll cycles (~10s at the healthy cadence), which costs
 * nothing to wait for and removes every single-probe false positive.
 *
 * WHY 2 and not 3. The supervisor kills a daemon that never opens 4097, so a
 * serve loss that takes the daemon with it is a total app outage, not a
 * degraded one. Detection latency is therefore a real cost: 2 failures put the
 * bar up in ~10s, which is below the time it takes a user to try a second
 * command. 3 would buy one more false-positive guard at ~15s and is defensible;
 * 2 is the judgement call, stated as one.
 *
 * COUNTING IS STRICTLY CONSECUTIVE, and that is a decision with a stated cost.
 * A success resets the counter, so a serve that alternates healthy/unhealthy
 * every single probe (f,s,f,s,…) NEVER declares loss. That is deliberate: the
 * alternative is a ratio window, which is precisely the flapping this threshold
 * exists to prevent. The residual is that a genuinely intermittent serve reads
 * healthy forever. Pinned by a test so it is a choice, not an oversight.
 */
export const SERVE_HEALTH_FAILURE_THRESHOLD = 2;

/**
 * Consecutive successful probes required before serve is declared recovered.
 *
 * WHY 2, not 1. Recovery is the direction that flaps. A serve restart brings
 * the listener back before its session store is warm, and `probeHealth` cannot
 * tell "answered" from "answered usefully" — it is `res.ok` and nothing more.
 * One success there is a coin flip, and each coin flip is an amber bar the user
 * sees appear and vanish.
 *
 * WHY equal to the failure threshold rather than larger. The two thresholds
 * trade against different harms. A false LOSS blocks a live user, and the
 * self-correction is a blocked command they retry. A false RECOVERY lets a
 * command through to a serve that is still coming up, and the self-correction
 * is a `SERVE_UNREACHABLE` from `runtime/client.ts:494` — the pre-existing
 * behaviour, which is the graceful direction. So recovery must be at least as
 * strict as loss, but pushing it higher only widens the window in which a
 * recovered serve stays blocked. Equal at 2 is the balance point.
 *
 * This is a judgement, not a measurement. No live serve-restart trace has been
 * gathered; the justification is the asymmetric cost above.
 */
export const SERVE_HEALTH_RECOVERY_THRESHOLD = 2;

/** First reconnect delay. Doubles per attempt, capped by the constant below. */
export const SERVE_HEALTH_BACKOFF_MS = 1_000;

/** Ceiling on the reconnect delay, so the last attempts are not minutes apart. */
export const SERVE_HEALTH_BACKOFF_MAX_MS = 30_000;

/**
 * Hard cap on reconnect attempts, after which the monitor LATCHES OFF.
 *
 * WHY bounded, and why the bound ends in a latch rather than a floor interval.
 * An unbounded retry loop against a port that never comes back is a battery
 * drain and a log defect: at the 1s/2s/4s/8s/16s/30s schedule these six
 * attempts span ~61s, and after that the monitor stops probing entirely. That
 * is the honest end state — the serve is not coming back on its own, and
 * continuing to ask costs battery while producing no new information. The
 * monitor stops; it does not decay into a slow poll that looks like recovery.
 *
 * `resume()` re-arms. Whoever owns the retry affordance (a user action, a
 * supervisor notification) calls it.
 */
export const SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS = 6;

/**
 * The three states. Nothing else is representable, which is the point: the
 * module cannot report a condition the protocol has no frame for.
 *
 * - `healthy`     — the last probe succeeded; commands flow.
 * - `degraded`    — loss DECLARED (failure threshold reached) and no reconnect
 *                   attempt has failed yet. A serve that answers again from here
 *                   still needs the full recovery threshold, and stays
 *                   `degraded` in the meantime: recovery is not free just
 *                   because it was quick.
 * - `reconnecting`— a reconnect attempt is in flight or has failed; the
 *                   backoff schedule owns the cadence. Also where the monitor
 *                   ends up permanently once attempts are exhausted, which
 *                   `status().exhausted` distinguishes from a live retry.
 *
 * Entry to the degraded path is ONLY ever a loss of a previously healthy serve.
 * There is no other edge in: a monitor that starts `degraded` would mean the
 * daemon booted against a dead serve, which `daemon.ts:264` already refuses.
 */
export type ServeHealthState = 'healthy' | 'degraded' | 'reconnecting';

/** The signature of `probeHealth`, which is what this monitor wraps. */
export type ServeProbe = (port: number, password: string, timeoutMs: number) => Promise<boolean>;

export interface ServeHealthStatus {
  readonly state: ServeHealthState;
  readonly servePort: number;
  /** Consecutive failed probes right now. Reset to 0 by any success. */
  readonly consecutiveFailures: number;
  /** Consecutive successful probes right now. Reset to 0 by any failure. */
  readonly consecutiveSuccesses: number;
  /** Reconnect attempts made since loss was declared. Reset on recovery. */
  readonly attempts: number;
  /**
   * True once `SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS` attempts have all failed.
   * The monitor has stopped probing; `resume()` re-arms it. While exhausted the
   * state is still `reconnecting`, because that is the accurate description.
   */
  readonly exhausted: boolean;
  /** Milliseconds spent in the current state. */
  readonly inStateMs: number;
  /** Milliseconds until the next probe, or null when the monitor has latched. */
  readonly nextProbeInMs: number | null;
  /**
   * Secret-free reason the most recent probe failed. `probeHealth` returns a
   * bare boolean and discards the cause (`launcher/launcher.ts:33-34`), so this
   * carries only what the monitor itself observed — a timeout or a rejected
   * probe, never a URL, a header or a credential.
   */
  readonly lastFault: 'probe-failed' | 'probe-timeout' | 'probe-threw' | null;
}

export type ServeHealthEvent =
  | {
      readonly type: 'state';
      readonly from: ServeHealthState;
      readonly to: ServeHealthState;
      readonly status: ServeHealthStatus;
    }
  | { readonly type: 'exhausted'; readonly status: ServeHealthStatus }
  | { readonly type: 'resumed'; readonly status: ServeHealthStatus };

/**
 * Machine codes for `ack.detail` and the `notice` frame. Distinct per condition
 * so a shell can word them differently and so telemetry can tell "we are trying"
 * from "we gave up" — the same reason `tts-credit.ts:106-108` gives two codes for
 * one condition.
 */
export const SERVE_BLOCKED_DETAIL_DEGRADED = 'serve-degraded';
export const SERVE_BLOCKED_DETAIL_RECONNECTING = 'serve-reconnecting';
export const SERVE_BLOCKED_DETAIL_EXHAUSTED = 'serve-reconnect-exhausted';

/** The `notice` frame code for the amber bar. Matches the `ack.detail` codes. */
export const SERVE_NOTICE_RECONNECTING = 'serve-reconnecting';

/**
 * Commands that provably cannot reach serve, and are therefore NOT blocked by
 * the gate.
 *
 * This is an ALLOWLIST on purpose: an unknown or future command kind is blocked
 * until someone proves it local. Default-deny is the direction where a mistake
 * costs one refused command; default-allow costs a command sent into a dead
 * port.
 *
 * Every member is justified by the router's own body, not by assumption, and
 * every line number below was re-derived BY LOCATING THE SYMBOL (2026-09-30)
 * rather than by adding a delta to the old ones. The previous revision cited
 * the pre-tier-model file, in which these bodies sat ~350 lines earlier, and
 * an anchor that has drifted that far is indistinguishable from one that was
 * never checked. The MEMBERSHIP is unchanged and was verified member by
 * member: it is default-deny, and `serve-health.test.ts` re-derives it as the
 * exact complement of the serve-reaching kinds from the live `UiCommandSchema`.
 *   - `abort`            → `command-router.ts:641` calls `deps.onAbort?.()` only.
 *   - `stopSpeech`       → `command-router.ts:646` calls `deps.onStopSpeech?.()` only.
 *   - `playbackStarted`  → `command-router.ts:652` calls `deps.onPlaybackStarted?.()` only.
 *   - `mute`/`deafen`/`arm` → `command-router.ts:677-680` return `{ ok: true }`
 *                          with no dependency call whatsoever.
 *   - `switchSession`    → `command-router.ts:549-552` mutates daemon-local state.
 *   - `setPersona`       → `command-router.ts:635-638` calls `deps.setPersona?.()`,
 *                          which the daemon wires to `ui.setPersona`/`ui.notice`
 *                          (`daemon.ts:936-937`) — both local frames.
 *   - `saveApiKeys`      → `command-router.ts:627-633` calls `deps.saveKeys`, wired
 *                          to `writeKeyPools` (`daemon.ts:55`), which reaches only
 *                          the encrypted vault (`voice/key-store.ts:1`). No
 *                          network. Blocking it would strand the settings window
 *                          of a user whose serve died, which is the opposite of
 *                          what the gate is for.
 *
 * NOT in the list, and why each matters:
 *   - `setSessionAgent` (`command-router.ts:558`), `setSessionModel` (`:565`),
 *     `toggleSessionSkill` (`:572`), `execSessionShell` (`:585`) and
 *     `sessionContext` (`:660`) all `await deps.client.*` — these ARE the
 *     blocked set.
 *   - `createSession` (`command-router.ts:673`) calls `deps.client.createSession`.
 *   - `confirm` (`command-router.ts:779-788`) calls `execute(parked.cmd)` at
 *     `:787`, which re-enters the blocked cases. It must be blocked, and the
 *     parked command then expires naturally via `CONFIRMATION_TTL_MS`
 *     (`command-router.ts:397`) rather than being executed against a dead port.
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

/** True when the command path is open. The only thing the gate asks. */
export function isServeAvailable(status: ServeHealthStatus): boolean {
  return status.state === 'healthy';
}

/** The `ack.detail` code a blocked command should carry. */
export function serveBlockedDetail(status: ServeHealthStatus): string {
  if (status.exhausted) return SERVE_BLOCKED_DETAIL_EXHAUSTED;
  return status.state === 'degraded' ? SERVE_BLOCKED_DETAIL_DEGRADED : SERVE_BLOCKED_DETAIL_RECONNECTING;
}

/**
 * Wrap a command handler so it refuses while serve is not healthy.
 *
 * The refusal is supplied by the caller rather than hardcoded here because this
 * module does not own the outcome type — `CommandOutcome`
 * (`orchestrator/command-router.ts:45`) is the router's, and returning it from
 * the runtime layer would invert the dependency.
 *
 * The handler is passed through UNCHANGED for allowlisted commands, so a user
 * whose serve died can still stop the audio, switch session, and save keys. That
 * asymmetry is the whole reason the allowlist exists: blocking `abort` would
 * strand a mid-utterance user behind a dead port with no way to make it stop.
 */
export function withServeGate<C extends { readonly kind: string }, R>(
  readStatus: () => ServeHealthStatus,
  handler: (cmd: C) => R | Promise<R>,
  refusal: (status: ServeHealthStatus) => R,
): (cmd: C) => R | Promise<R> {
  return (cmd: C) => {
    const status = readStatus();
    if (SERVE_LOCAL_ONLY_COMMANDS.has(cmd.kind)) return handler(cmd);
    if (isServeAvailable(status)) return handler(cmd);
    return refusal(status);
  };
}

export interface ServeHealthMonitorOptions {
  readonly port: number;
  readonly password: string;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly failureThreshold?: number;
  readonly recoveryThreshold?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  readonly backoffMaxMs?: number;
  /** Injected probe. Defaults to the real `probeHealth`, so production cannot diverge. */
  readonly probe?: ServeProbe;
  /** Clock seam, for asserting `inStateMs` without sleeping. */
  readonly now?: () => number;
  readonly onEvent?: (event: ServeHealthEvent) => void;
}

/**
 * What a manual probe found, as opposed to what the state machine concluded
 * about it.
 *
 * The distinction is load-bearing and the two were originally the same value,
 * which made a test read `healthy` after a probe had just failed: the state
 * machine correctly refuses to declare loss on one failure, and the return
 * value was reporting the state rather than the probe. A caller asking "did the
 * port answer?" must not be told "yes" because the monitor is still in a
 * hysteresis window. `unreachable` here is compatible with
 * `status().state === 'healthy'` and means so deliberately.
 */
export type CheckResult = 'reachable' | 'unreachable' | 'skipped';

export class ServeHealthMonitor {
  private readonly port: number;
  /**
   * Held for probing only. It is deliberately NOT exposed on `status()`: that
   * object crosses the WS boundary in the integration wave, and the serve
   * password must not be one hop from a frame.
   */
  private readonly password: string;
  private readonly probe: ServeProbe;
  private readonly now: () => number;
  private readonly onEvent: ((event: ServeHealthEvent) => void) | undefined;
  private readonly intervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly failureThreshold: number;
  private readonly recoveryThreshold: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly backoffMaxMs: number;

  private state: ServeHealthState = 'healthy';
  private failures = 0;
  private successes = 0;
  private attempts = 0;
  private exhausted = false;
  private fault: ServeHealthStatus['lastFault'] = null;
  private enteredAt: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private running = false;
  private nextProbeAt: number | null = null;

  constructor(options: ServeHealthMonitorOptions) {
    this.port = options.port;
    this.password = options.password;
    this.probe = options.probe ?? ((port, password, timeoutMs) => probeHealth(port, password, timeoutMs));
    this.now = options.now ?? (() => Date.now());
    this.onEvent = options.onEvent;
    this.intervalMs = options.intervalMs ?? SERVE_HEALTH_INTERVAL_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? SERVE_HEALTH_PROBE_TIMEOUT_MS;
    this.failureThreshold = options.failureThreshold ?? SERVE_HEALTH_FAILURE_THRESHOLD;
    this.recoveryThreshold = options.recoveryThreshold ?? SERVE_HEALTH_RECOVERY_THRESHOLD;
    this.maxAttempts = options.maxAttempts ?? SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? SERVE_HEALTH_BACKOFF_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? SERVE_HEALTH_BACKOFF_MAX_MS;
    this.enteredAt = this.now();
  }

  /**
   * Begin polling. Idempotent.
   *
   * Starts in `healthy` unconditionally, and that is only sound because of the
   * PRECONDITION, not because it was measured: the caller must have already run
   * the boot probe (`daemon.ts:264`) and must not have started this monitor
   * without it. Constructing a monitor is NOT a substitute for that check, and
   * the module deliberately provides no way to relax boot.
   *
   * Does NOT probe immediately. The boot probe just ran against the same port
   * with the same credentials milliseconds earlier, so an immediate probe would
   * be a second opinion on a question that was just answered. The first tick is
   * one full interval out.
   *
   * Refuses to arm while exhausted. An exhausted monitor has concluded that
   * probing further is not worth the battery, and a `start()` that quietly
   * re-armed it would make that conclusion revocable by accident.
   */
  start(): void {
    if (this.running || this.exhausted) return;
    this.running = true;
    this.schedule(this.intervalMs);
  }

  /**
   * Stop polling and clear any pending tick. Idempotent.
   *
   * `stop()` is unconditional — unlike `start()`, it always clears, because
   * stopping a monitor that has latched off must still be safe to call.
   */
  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /**
   * Re-arm after exhaustion. Resets the attempt budget and, if the monitor was
   * running, schedules the next tick; the state stays `reconnecting`, so
   * commands remain blocked until a probe actually succeeds. That asymmetry is
   * deliberate — resuming is not recovering, and a `resume()` that flipped the
   * state to `healthy` would open the command path with no evidence the port is
   * back. A `resume()` on a monitor that is not exhausted is a no-op, so a
   * double-click on a retry affordance cannot spend two budgets.
   */
  resume(): void {
    if (!this.exhausted) return;
    this.exhausted = false;
    this.attempts = 0;
    this.emit({ type: 'resumed', status: this.status() });
    if (this.running) this.schedule(this.backoffDelay(0));
  }

  /**
   * Force one probe cycle now. Returns `skipped` rather than queueing if a probe
   * is already in flight — the re-entrancy guard is what keeps a slow serve from
   * building a backlog of overlapping probes, and it is the reason this method
   * can never reject and never leaves the caller waiting on a second probe.
   *
   * A manual probe is an operator action and is always honoured, including after
   * exhaustion: a serve that came back while the monitor had latched off is
   * discovered by exactly this call. It can only RECOVER, never re-spend the
   * attempt budget — otherwise a well-meaning retry loop could drive the counter
   * past its own bound, and `status().attempts` would stop being the number the
   * bound is stated in.
   */
  async checkNow(): Promise<CheckResult> {
    const reached = await this.tick();
    if (reached === null) return 'skipped';
    return reached ? 'reachable' : 'unreachable';
  }

  status(): ServeHealthStatus {
    return {
      state: this.state,
      servePort: this.port,
      consecutiveFailures: this.failures,
      consecutiveSuccesses: this.successes,
      attempts: this.attempts,
      exhausted: this.exhausted,
      inStateMs: Math.max(0, this.now() - this.enteredAt),
      nextProbeInMs: this.nextProbeAt === null ? null : Math.max(0, this.nextProbeAt - this.now()),
      lastFault: this.fault,
    };
  }

  /** `null` when a probe was already in flight, so the caller knows nothing ran. */
  private async tick(): Promise<boolean | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const { healthy, fault } = await this.boundedProbe();
      this.apply(healthy, fault);
      return healthy;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * One probe, hard-bounded. Resolves `false` on EVERY failure mode — a refused
   * probe, a probe that ignores its timeout, a probe that throws. A probe that
   * fails catastrophically is a failed probe, not an error that stops the loop:
   * if it were the latter, the one condition this module exists for would also
   * be the condition that disables it.
   */
  private async boundedProbe(): Promise<{ healthy: boolean; fault: ServeHealthStatus['lastFault'] }> {
    const budget = this.probeTimeoutMs + SERVE_HEALTH_WATCHDOG_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const call = this.probe(this.port, this.password, this.probeTimeoutMs);
      // The loser of the race may reject long after this function returned, and
      // an unobserved rejection is a process-level crash in Node. Swallow it on
      // purpose: its result is already irrelevant.
      void call.catch(() => undefined);
      const outcome = await Promise.race([
        call.then(
          (ok) => ({ kind: 'ok' as const, ok }),
          () => ({ kind: 'threw' as const, ok: false }),
        ),
        new Promise<{ kind: 'timeout', ok: false }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout', ok: false }), budget);
        }),
      ]);
      if (outcome.kind === 'ok') return { healthy: outcome.ok, fault: outcome.ok ? null : 'probe-failed' };
      if (outcome.kind === 'threw') return { healthy: false, fault: 'probe-threw' };
      return { healthy: false, fault: 'probe-timeout' };
    } catch {
      // A synchronous throw from `this.probe` lands here rather than in the
      // raced branches, and must not escape to kill the timer.
      return { healthy: false, fault: 'probe-threw' };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private apply(healthy: boolean, fault: ServeHealthStatus['lastFault']): void {
    if (healthy) {
      this.failures = 0;
      this.successes += 1;
      this.fault = null;
      if (this.state !== 'healthy') {
        if (this.successes >= this.recoveryThreshold) this.transition('healthy');
        return;
      }
      // Healthy and already counted: a new outage starts from a clean budget.
      this.attempts = 0;
      this.exhausted = false;
      return;
    }

    this.successes = 0;
    this.failures += 1;
    this.fault = fault;
    if (this.state === 'healthy') {
      if (this.failures < this.failureThreshold) return;
      // The ONLY entry to the degraded path: a previously healthy serve lost.
      this.transition('degraded');
      return;
    }
    if (this.exhausted) return; // the budget is spent; a failure re-asserts it
    // Degraded or already reconnecting: a failed probe spends an attempt.
    if (this.state === 'degraded') this.transition('reconnecting');
    this.attempts += 1;
    if (this.attempts >= this.maxAttempts) {
      this.exhausted = true;
      this.clearTimer();
      this.emit({ type: 'exhausted', status: this.status() });
    }
  }

  private transition(to: ServeHealthState): void {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    this.enteredAt = this.now();
    if (to === 'healthy') {
      this.attempts = 0;
      this.exhausted = false;
    }
    this.emit({ type: 'state', from, to, status: this.status() });
  }

  /** `attempts` is 1-based; the caller's first attempt gets the base delay. */
  private backoffDelay(attempts: number): number {
    if (attempts <= 0) return this.backoffMs;
    const scaled = this.backoffMs * 2 ** (attempts - 1);
    return Math.min(scaled, this.backoffMaxMs);
  }

  /**
   * Self-rescheduling `setTimeout`, not `setInterval`.
   *
   * Backoff needs a variable delay, which `setInterval` cannot express. The
   * reschedule happens in a `finally`, so a probe that is slow or throws still
   * leaves a live loop, and the cadence can never compound: the worst case is
   * `delay + probeTimeout` per cycle, bounded by the two constants. Unref'd, so
   * it never holds the process open (`orchestrator/inventory.ts:87` does the
   * same, for the same reason).
   */
  private async runCycle(): Promise<void> {
    try {
      await this.tick();
    } finally {
      if (this.running && !this.exhausted) this.schedule(this.nextDelay());
    }
  }

  private nextDelay(): number {
    if (this.state === 'healthy') return this.intervalMs;
    return this.backoffDelay(this.attempts);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.clearTimer();
    this.nextProbeAt = this.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextProbeAt = null;
      void this.runCycle();
    }, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextProbeAt = null;
  }

  private emit(event: ServeHealthEvent): void {
    // A subscriber that throws must not take the monitor's loop with it: the
    // loop's job is to detect an outage, and the event is only a report of it.
    try {
      this.onEvent?.(event);
    } catch {
      /* reported state is already committed */
    }
  }
}
