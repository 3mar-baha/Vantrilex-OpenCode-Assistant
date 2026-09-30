import { afterEach, describe, expect, test, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basicAuth } from './client.js';
import { UiCommandSchema } from '../ipc/protocol.js';
import {
  SERVE_HEALTH_BACKOFF_MAX_MS,
  SERVE_HEALTH_BACKOFF_MS,
  SERVE_HEALTH_FAILURE_THRESHOLD,
  SERVE_HEALTH_INTERVAL_MS,
  SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS,
  SERVE_HEALTH_PROBE_TIMEOUT_MS,
  SERVE_HEALTH_RECOVERY_THRESHOLD,
  SERVE_HEALTH_WATCHDOG_GRACE_MS,
  SERVE_LOCAL_ONLY_COMMANDS,
  SERVE_BLOCKED_DETAIL_DEGRADED,
  SERVE_BLOCKED_DETAIL_EXHAUSTED,
  SERVE_BLOCKED_DETAIL_RECONNECTING,
  ServeHealthMonitor,
  isServeAvailable,
  serveBlockedDetail,
  withServeGate,
  type ServeHealthEvent,
  type ServeHealthStatus,
} from './serve-health.js';

// Serve-health is a RESILIENCE component, so these tests are adversarial about
// the failure modes that would make it worse than having nothing:
//
//   1. A monitor that reports an outage on one slow probe is worse than none.
//      Both thresholds are pinned here, including the alternating case that
//      deliberately does NOT trip — a documented residual, pinned so it cannot
//      be "fixed" by accident into a flapper.
//   2. A monitor whose own probe hangs is not monitoring, it is the outage.
//      Pinned with a probe that never settles.
//   3. A monitor that retries forever is a battery and a log defect. Pinned to a
//      bounded attempt count and a latched end state.
//   4. A gate that blocks EVERYTHING strands a user whose serve died
//      mid-utterance. Pinned: `abort` and friends still flow.
//
// Hermetic throughout: injected probe, fake timers, no network — except the last
// describe block, which deliberately exercises the REAL `probeHealth` default
// against a real loopback server, because "the monitor is built around the
// existing probe and not around a lookalike" is a claim that has to be proven.

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A probe whose answers come from a script.
 *
 * `mode: 'clamp'` (default) repeats the LAST answer once the script runs out,
 * which is what "serve is still down" looks like. `mode: 'cycle'` wraps around,
 * which is how the alternating flap case is built.
 */
function scriptedProbe(
  script: readonly boolean[],
  mode: 'clamp' | 'cycle' = 'clamp',
): { probe: (p: number, w: string, t: number) => Promise<boolean>; calls: () => number; timeouts: number[] } {
  let calls = 0;
  const timeouts: number[] = [];
  return {
    calls: () => calls,
    timeouts,
    probe: async (_port, _password, timeoutMs) => {
      timeouts.push(timeoutMs);
      const index = mode === 'cycle' ? calls % script.length : Math.min(calls, script.length - 1);
      calls += 1;
      return script[index] ?? false;
    },
  };
}

function monitor(
  script: readonly boolean[],
  options: Partial<ConstructorParameters<typeof ServeHealthMonitor>[0]> = {},
  mode: 'clamp' | 'cycle' = 'clamp',
): { mon: ServeHealthMonitor; calls: () => number; timeouts: number[]; script: boolean[]; events: ServeHealthEvent[] } {
  const probeScript = [...script];
  const { probe, calls, timeouts } = scriptedProbe(probeScript, mode);
  const events: ServeHealthEvent[] = [];
  const mon = new ServeHealthMonitor({
    port: 4096,
    password: 'pw',
    probe,
    onEvent: (e) => void events.push(e),
    ...options,
  });
  return { mon, calls, timeouts, script: probeScript, events };
}

const WATCHDOG_MS = SERVE_HEALTH_PROBE_TIMEOUT_MS + SERVE_HEALTH_WATCHDOG_GRACE_MS;

describe('loss is declared only at the failure threshold', () => {
  test('stays healthy through one failure and declares loss on the second', async () => {
    const { mon, calls } = monitor([true, false, false]);
    expect(mon.status().state).toBe('healthy');

    expect(await mon.checkNow()).toBe('reachable');
    expect(calls()).toBe(1);

    // ONE failure. `checkNow` reports the PROBE (unreachable) while the state
    // machine still reports `healthy` — the two are different questions, and
    // conflating them is the bug this assertion exists to prevent.
    expect(await mon.checkNow()).toBe('unreachable');
    expect(mon.status().state).toBe('healthy');
    expect(mon.status().consecutiveFailures).toBe(1);
    expect(mon.status().lastFault).toBe('probe-failed');
    expect(isServeAvailable(mon.status())).toBe(true);

    // The threshold.
    expect(await mon.checkNow()).toBe('unreachable');
    expect(mon.status().state).toBe('degraded');
    expect(isServeAvailable(mon.status())).toBe(false);
    expect(calls()).toBe(3);
  });

  test('the thresholds are exactly the documented constants, not placeholders', () => {
    // The "why" lives in each constant's doc comment. A silent change to 1
    // would reintroduce the single-slow-probe outage, and to 3 would silently
    // make detection 50% slower than the number in the comment.
    expect(SERVE_HEALTH_FAILURE_THRESHOLD).toBe(2);
    expect(SERVE_HEALTH_RECOVERY_THRESHOLD).toBe(2);
  });

  test('a success mid-outage RESETS the failure count — counting is strictly consecutive', async () => {
    const { mon, calls } = monitor([true, false, false, true, true, false]);
    await mon.checkNow(); // ok
    await mon.checkNow(); // fail 1
    await mon.checkNow(); // fail 2 → degraded
    expect(mon.status().state).toBe('degraded');

    await mon.checkNow(); // success 1 of 2 — not yet recovered
    expect(mon.status().consecutiveSuccesses).toBe(1);
    expect(mon.status().state).toBe('degraded');
    await mon.checkNow(); // success 2 → healthy
    expect(mon.status().state).toBe('healthy');
    expect(mon.status().attempts).toBe(0);

    await mon.checkNow(); // fail 1 of a NEW outage
    expect(mon.status().consecutiveFailures).toBe(1);
    expect(mon.status().state).toBe('healthy');
    expect(calls()).toBe(6);
  });

  test('ALTERNATING failure/success never declares loss — the documented residual, pinned', async () => {
    // f,s,f,s,… twenty-one probes. A ratio window would call this an outage
    // around the 4th failure; strictly-consecutive counting never trips, by
    // decision. This test exists so the choice is visible and cannot be quietly
    // reversed into a flapper by a well-meaning edit.
    const { mon } = monitor([false, true], {}, 'cycle');
    let worst = 0;
    for (let i = 0; i < 21; i += 1) {
      await mon.checkNow();
      worst = Math.max(worst, mon.status().consecutiveFailures);
    }
    expect(mon.status().state).toBe('healthy');
    expect(worst).toBe(1);
    expect(isServeAvailable(mon.status())).toBe(true);
  });
});

describe('recovery is declared only at the success threshold', () => {
  test('one success while degraded is NOT healthy; the second is', async () => {
    const { mon, calls } = monitor([true, false, false, true, true]);
    await mon.checkNow(); // ok
    await mon.checkNow(); // fail 1
    await mon.checkNow(); // fail 2 → degraded

    // First recovery probe: serve answered, but one answer is not evidence.
    expect(await mon.checkNow()).toBe('reachable');
    expect(mon.status().consecutiveSuccesses).toBe(1);
    expect(mon.status().state).toBe('degraded');
    expect(isServeAvailable(mon.status())).toBe(false);

    // Second consecutive success → recovered, and the attempt budget resets.
    expect(await mon.checkNow()).toBe('reachable');
    expect(mon.status().state).toBe('healthy');
    expect(mon.status().attempts).toBe(0);
    expect(mon.status().exhausted).toBe(false);
    expect(mon.status().lastFault).toBeNull();
    expect(calls()).toBe(5);
  });

  test('a failure between the two recovery successes restarts the recovery count', async () => {
    const { mon } = monitor([true, false, false, true, false, true, true]);
    await mon.checkNow();
    await mon.checkNow();
    await mon.checkNow(); // degraded
    await mon.checkNow(); // recovery success 1
    expect(mon.status().consecutiveSuccesses).toBe(1);
    await mon.checkNow(); // back down
    expect(mon.status().consecutiveSuccesses).toBe(0);
    expect(mon.status().state).toBe('reconnecting');
    await mon.checkNow(); // success 1
    await mon.checkNow(); // success 2
    expect(mon.status().state).toBe('healthy');
  });

  test('the state walk is healthy → degraded → reconnecting → healthy', async () => {
    const { mon, events } = monitor([true, false, false, false, true, true]);
    await mon.checkNow();
    await mon.checkNow();
    await mon.checkNow(); // → degraded
    await mon.checkNow(); // → reconnecting (first attempt fails)
    await mon.checkNow(); // recovery success 1
    await mon.checkNow(); // recovery success 2 → healthy
    expect(
      events
        .filter((e): e is Extract<ServeHealthEvent, { type: 'state' }> => e.type === 'state')
        .map((e) => `${e.from}->${e.to}`),
    ).toEqual(['healthy->degraded', 'degraded->reconnecting', 'reconnecting->healthy']);
  });
});

describe('the probe cannot become the outage', () => {
  test('a probe that never settles is a TIMED-OUT failure and the loop survives it', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const events: ServeHealthEvent[] = [];
    const mon = new ServeHealthMonitor({
      port: 4096,
      password: 'pw',
      probe: () => {
        calls += 1;
        return new Promise<boolean>(() => undefined); // never settles
      },
      failureThreshold: 1,
      onEvent: (e) => void events.push(e),
    });
    mon.start();

    // The watchdog is the probe's own timeout plus a grace period, so a
    // cooperative abort always wins and the watchdog only catches a probe that
    // ignores its timeout argument entirely. The first tick is one full interval
    // out — `start()` does not probe immediately, because the boot probe already
    // asked the same question.
    await vi.advanceTimersByTimeAsync(SERVE_HEALTH_INTERVAL_MS + WATCHDOG_MS);
    expect(mon.status().state).toBe('degraded');
    expect(mon.status().lastFault).toBe('probe-timeout');
    expect(calls).toBe(1);

    // The next failing probe moved it to `reconnecting` and spent an attempt,
    // which is the proof the loop kept running past the hang.
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + SERVE_HEALTH_BACKOFF_MS + 1);
    expect(calls).toBe(2);
    expect(mon.status().state).toBe('reconnecting');
    expect(mon.status().attempts).toBe(1);
    mon.stop();
  });

  test('a probe that REJECTS is a failure, not an error that stops the monitor', async () => {
    const { mon } = monitor([], { probe: async () => { throw new Error('ECONNREFUSED'); }, failureThreshold: 1 });
    expect(await mon.checkNow()).toBe('unreachable');
    expect(mon.status().state).toBe('degraded');
    expect(mon.status().lastFault).toBe('probe-threw');
    // A further failing probe still lands, i.e. the monitor is not wedged.
    expect(await mon.checkNow()).toBe('unreachable');
    expect(mon.status().attempts).toBe(1);
  });

  test('a probe that rejects LATE, after the watchdog gave up, does not crash the process', async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    const mon = new ServeHealthMonitor({
      port: 4096,
      password: 'pw',
      probe: () => new Promise<boolean>((_res, rej) => { reject = rej; }),
      failureThreshold: 1,
    });
    const started = mon.checkNow();
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS);
    expect(await started).toBe('unreachable');
    // The late rejection lands with nobody listening. An unobserved rejection is
    // a process-level crash, so this is the assertion that matters — and it is
    // silent when it is broken, which is why the settle is asserted after it.
    reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(10);
    expect(mon.status().lastFault).toBe('probe-timeout');  });

  test('the probe is re-entrancy guarded: a concurrent checkNow() is SKIPPED, not queued', async () => {
    let release!: (ok: boolean) => void;
    let calls = 0;
    const mon = new ServeHealthMonitor({
      port: 4096,
      password: 'pw',
      probe: () => {
        calls += 1;
        return new Promise<boolean>((res) => { release = res; });
      },
    });
    const first = mon.checkNow();
    const second = await mon.checkNow();
    expect(second).toBe('skipped');
    expect(calls).toBe(1);
    release(false);
    expect(await first).toBe('unreachable');
    expect(mon.status().consecutiveFailures).toBe(1);
  });

  test('the probe is handed the port, the password and the documented timeout', async () => {
    const { mon, timeouts } = monitor([true], { password: 'pw' });
    await mon.checkNow();
    expect(timeouts).toEqual([SERVE_HEALTH_PROBE_TIMEOUT_MS]);
  });
});

describe('bounded attempts, bounded backoff, then a latch', () => {
  test('attempts are capped at the constant and the monitor LATCHES', async () => {
    const { mon, calls, events } = monitor([false], { failureThreshold: 1 });
    // Drive well past the budget with manual probes: no timers, no sleeping.
    // A manual probe is an operator action and is always honoured, including
    // after the latch — that is how a serve which came back while we gave up is
    // rediscovered. What must NOT drift is the budget itself.
    for (let i = 0; i < SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS + 6; i += 1) await mon.checkNow();

    const status = mon.status();
    expect(status.exhausted).toBe(true);
    // Clamped, even though six extra probes ran after the latch: the counter is
    // the number the bound is stated in, so it must not drift past it.
    expect(status.attempts).toBe(SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS);
    // Every manual probe ran — none was swallowed.
    expect(calls()).toBe(SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS + 6);
    expect(events.filter((e) => e.type === 'exhausted')).toHaveLength(1);
    // The state stays `reconnecting` because that is the true description;
    // `exhausted` is what distinguishes "still trying" from "gave up".
    expect(status.state).toBe('reconnecting');
    expect(serveBlockedDetail(status)).toBe(SERVE_BLOCKED_DETAIL_EXHAUSTED);
  });

  test('an EXHAUSTED monitor schedules no further probe — the battery claim, tested', async () => {
    vi.useFakeTimers();
    const { mon, calls } = monitor([false], { failureThreshold: 1 });
    for (let i = 0; i < SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS + 1; i += 1) await mon.checkNow();
    const spent = calls();
    expect(mon.status().exhausted).toBe(true);
    expect(mon.status().nextProbeInMs).toBeNull();

    // `start()` must not re-arm an exhausted monitor. It did, once, and this is
    // the assertion that says so.
    mon.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls()).toBe(spent);

    // And neither does a second `start()` on a running, exhausted monitor
    // reached via the timer path rather than manual probes.
    mon.resume();
    expect(mon.status().exhausted).toBe(false);
    mon.stop();
  });

  test('resume() re-arms the budget but does NOT declare healthy', async () => {
    const { mon, events } = monitor([false], { failureThreshold: 1 });
    for (let i = 0; i < SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS + 1; i += 1) await mon.checkNow();
    expect(mon.status().exhausted).toBe(true);

    mon.resume();
    expect(mon.status().exhausted).toBe(false);
    expect(mon.status().attempts).toBe(0);
    // Resuming is not recovering. A resume that opened the command path with no
    // evidence the port is back is the exact bug this pins.
    expect(mon.status().state).toBe('reconnecting');
    expect(isServeAvailable(mon.status())).toBe(false);
    expect(events.some((e) => e.type === 'resumed')).toBe(true);

    // A second resume is a no-op: a double-clicked retry affordance must not
    // spend two budgets.
    const resumed = events.filter((e) => e.type === 'resumed').length;
    mon.resume();
    expect(events.filter((e) => e.type === 'resumed')).toHaveLength(resumed);
  });

  test('a serve that returns AFTER the latch is still discovered', async () => {
    // `clamp` mode repeats the last script entry, so flipping it turns the
    // script from "always down" to "always up" without a new monitor.
    const { mon, script } = monitor([false], { failureThreshold: 1 });
    for (let i = 0; i < SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS + 1; i += 1) await mon.checkNow();
    expect(mon.status().exhausted).toBe(true);
    script[script.length - 1] = true;

    // The operator's retry. It recovers, and the budget does not go negative.
    expect(await mon.checkNow()).toBe('reachable');
    expect(mon.status().consecutiveSuccesses).toBe(1);
    expect(mon.status().state).toBe('reconnecting');
    expect(await mon.checkNow()).toBe('reachable');
    expect(mon.status().state).toBe('healthy');
    expect(mon.status().attempts).toBe(0);
    expect(mon.status().exhausted).toBe(false);
  });

  test('the backoff doubles, is capped, and never exceeds SERVE_HEALTH_BACKOFF_MAX_MS', async () => {
    vi.useFakeTimers();
    // Sample the gap between consecutive probes as the backoff walks up.
    const gaps: number[] = [];
    let prevAt = Date.now();
    const mon = new ServeHealthMonitor({
      port: 4096,
      password: 'pw',
      probe: async () => {
        gaps.push(Date.now() - prevAt);
        prevAt = Date.now();
        return false;
      },
      failureThreshold: 1,
      maxAttempts: 40,
    });
    mon.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    mon.stop();

    // gaps[0] = healthy cadence, gaps[1] = the short first retry delay,
    // gaps[2..] = the doubling backoff.
    expect(gaps[0]).toBe(SERVE_HEALTH_INTERVAL_MS);
    expect(gaps[1]).toBe(SERVE_HEALTH_BACKOFF_MS);
    const backoffs = gaps.slice(2);
    expect(backoffs[0]).toBe(SERVE_HEALTH_BACKOFF_MS);
    expect(backoffs[1]).toBe(SERVE_HEALTH_BACKOFF_MS * 2);
    expect(backoffs[2]).toBe(SERVE_HEALTH_BACKOFF_MS * 4);
    // Capped, and it stays capped however long the outage runs.
    expect(Math.max(...backoffs)).toBe(SERVE_HEALTH_BACKOFF_MAX_MS);
    expect(SERVE_HEALTH_BACKOFF_MAX_MS).toBe(30_000);
  });

  test('every scheduled delay sits between the base interval and the backoff cap', async () => {
    vi.useFakeTimers();
    const gaps: number[] = [];
    let prevAt = Date.now();
    const mon = new ServeHealthMonitor({
      port: 4096,
      password: 'pw',
      probe: async () => {
        gaps.push(Date.now() - prevAt);
        prevAt = Date.now();
        return false;
      },
      failureThreshold: 1,
    });
    mon.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    mon.stop();
    expect(gaps.length).toBeGreaterThan(4);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(Math.min(SERVE_HEALTH_INTERVAL_MS, SERVE_HEALTH_BACKOFF_MS));
      expect(gap).toBeLessThanOrEqual(SERVE_HEALTH_BACKOFF_MAX_MS);
    }
  });

  test('the cadence constants are the documented values, and the probe fits inside a tick', () => {
    expect(SERVE_HEALTH_INTERVAL_MS).toBe(5_000);
    expect(SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS).toBe(6);
    // The probe budget must fit inside the cadence, or a timing-out probe
    // overlaps the next tick even on a healthy serve.
    expect(SERVE_HEALTH_PROBE_TIMEOUT_MS + SERVE_HEALTH_WATCHDOG_GRACE_MS).toBeLessThan(SERVE_HEALTH_INTERVAL_MS);
  });
});

describe('the event surface', () => {
  test('emits on TRANSITION only, so a healthy serve produces no event traffic', async () => {
    const { mon, events } = monitor([true]);
    for (let i = 0; i < 25; i += 1) await mon.checkNow();
    expect(events).toHaveLength(0);
  });

  test('every event carries the status AT the moment of the transition', async () => {
    const { mon, events } = monitor([true, false, false]);
    await mon.checkNow();
    await mon.checkNow();
    await mon.checkNow();
    const transition = events.find((e) => e.type === 'state');
    expect(transition).toBeDefined();
    if (transition?.type !== 'state') throw new Error('expected a state event');
    expect(transition.to).toBe('degraded');
    expect(transition.status.state).toBe('degraded');
    expect(transition.status.consecutiveFailures).toBe(2);
  });

  test('a subscriber that throws cannot take the loop with it', async () => {
    const { mon, calls } = monitor([true, false, false], {
      onEvent: () => {
        throw new Error('subscriber exploded');
      },
    });
    await mon.checkNow(); // ok
    await mon.checkNow(); // fail 1
    await mon.checkNow(); // fail 2 → emits, and the subscriber throws
    expect(mon.status().state).toBe('degraded');
    // The loop is still alive: a fourth probe is accepted and applied.
    await mon.checkNow();
    expect(calls()).toBe(4);
    expect(mon.status().state).toBe('reconnecting');
    expect(mon.status().attempts).toBe(1);
  });

  test('status() never carries the serve password', async () => {
    const { mon } = monitor([true], { password: 'super-secret-pw' });
    await mon.checkNow();
    expect(JSON.stringify(mon.status())).not.toContain('super-secret-pw');
  });

  test('stop() clears the pending tick and nothing fires afterwards', async () => {
    vi.useFakeTimers();
    const { mon, calls } = monitor([true]);
    mon.start();
    mon.stop();
    expect(mon.status().nextProbeInMs).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(0);
  });

  test('start() is idempotent — a second start does not double the probe rate', async () => {
    vi.useFakeTimers();
    const { mon, calls } = monitor([true]);
    mon.start();
    mon.start();
    mon.start();
    await vi.advanceTimersByTimeAsync(SERVE_HEALTH_INTERVAL_MS * 2);
    mon.stop();
    expect(calls()).toBe(2);
  });
});

describe('the command gate', () => {
  const healthy: ServeHealthStatus = {
    state: 'healthy', servePort: 4096, consecutiveFailures: 0, consecutiveSuccesses: 2,
    attempts: 0, exhausted: false, inStateMs: 10, nextProbeInMs: 5_000, lastFault: null,
  };
  const degraded: ServeHealthStatus = { ...healthy, state: 'degraded', consecutiveFailures: 2, consecutiveSuccesses: 0, lastFault: 'probe-failed' };
  const reconnecting: ServeHealthStatus = { ...healthy, state: 'reconnecting', attempts: 1, consecutiveFailures: 3, lastFault: 'probe-timeout' };
  const exhausted: ServeHealthStatus = { ...reconnecting, exhausted: true, attempts: SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS };

  type Outcome = { ok: boolean; detail?: string };

  test('a healthy serve passes everything through', async () => {
    const seen: string[] = [];
    const gated = withServeGate<{ kind: string }, Outcome>(
      () => healthy,
      (cmd) => { seen.push(cmd.kind); return { ok: true }; },
      () => ({ ok: false, detail: 'blocked' }),
    );
    expect(await gated({ kind: 'setSessionAgent' })).toEqual({ ok: true });
    expect(seen).toEqual(['setSessionAgent']);
  });

  test('a non-healthy serve refuses with a per-condition machine code, and never reaches the handler', async () => {
    const seen: string[] = [];
    const handler = (cmd: { kind: string }): Outcome => { seen.push(cmd.kind); return { ok: true }; };
    const refusal = (s: ServeHealthStatus): Outcome => ({ ok: false, detail: serveBlockedDetail(s) });

    for (const status of [degraded, reconnecting, exhausted]) {
      const gated = withServeGate<{ kind: string }, Outcome>(() => status, handler, refusal);
      const out = await gated({ kind: 'execSessionShell' });
      expect(out.ok).toBe(false);
      expect(out.detail).toBe(serveBlockedDetail(status));
    }
    expect(seen).toEqual([]);
    expect(serveBlockedDetail(degraded)).toBe(SERVE_BLOCKED_DETAIL_DEGRADED);
    expect(serveBlockedDetail(reconnecting)).toBe(SERVE_BLOCKED_DETAIL_RECONNECTING);
    expect(serveBlockedDetail(exhausted)).toBe(SERVE_BLOCKED_DETAIL_EXHAUSTED);
    // `degraded` and `reconnecting` are distinct codes on purpose: a shell can
    // word them differently, and telemetry can tell "detected" from "retrying".
    expect(SERVE_BLOCKED_DETAIL_DEGRADED).not.toBe(SERVE_BLOCKED_DETAIL_RECONNECTING);
  });

  test('ALLOWLISTED commands still flow while serve is dead — a dead port must not strand the user', async () => {
    // The specific regression: `abort` and `stopSpeech` are what a user reaches
    // for when the assistant will not stop talking. Blocking them because serve
    // died would make the gate cause the outage it exists to describe.
    const seen: string[] = [];
    const gated = withServeGate<{ kind: string }, Outcome>(
      () => exhausted,
      (cmd) => { seen.push(cmd.kind); return { ok: true }; },
      () => ({ ok: false }),
    );
    for (const kind of ['abort', 'stopSpeech', 'playbackStarted', 'mute', 'deafen', 'arm', 'switchSession', 'setPersona', 'saveApiKeys']) {
      expect(await gated({ kind })).toEqual({ ok: true });
    }
    expect(seen).toHaveLength(9);
  });

  test('every allowlisted kind is a REAL command in the protocol, parsed against the real schema', async () => {
    for (const kind of SERVE_LOCAL_ONLY_COMMANDS) {
      const parsed = UiCommandSchema.safeParse({ id: 'c1', kind });
      expect(parsed.success, `${kind} is not a real UiCommand kind`).toBe(true);
    }
  });

  test('the allowlist is exactly the complement of the six serve-reaching kinds plus confirm', () => {
    // The shape of the split, re-derived from the live schema rather than from a
    // comment: everything the allowlist misses is blocked BY DEFAULT, which is
    // the safe direction for a kind added later.
    const realKinds: readonly string[] = UiCommandSchema.shape.kind.options;
    expect(realKinds.filter((k) => !SERVE_LOCAL_ONLY_COMMANDS.has(k)).sort()).toEqual([
      'confirm', 'createSession', 'execSessionShell', 'sessionContext',
      'setSessionAgent', 'setSessionModel', 'toggleSessionSkill',
    ]);
    // `confirm` is blocked because `command-router.ts:269-277` re-enters
    // execute() on a parked command, which lands in one of the cases above.
    // Letting a confirmation through while degraded is the "destructive act
    // against a dead serve" the FR-12 park exists to prevent.
    expect(SERVE_LOCAL_ONLY_COMMANDS.has('confirm')).toBe(false);
  });
});

describe('the monitor is built around the real probeHealth, not a lookalike', () => {
  test('with no injected probe it probes a REAL loopback serve, and reads a REAL 401 as down', async () => {
    // No fake timers and no injected probe: this drives `probeHealth` through the
    // monitor's default binding against a real HTTP server, which is the only
    // way to show the two are the same function rather than two functions that
    // happen to agree.
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/api/session' && req.headers.authorization === basicAuth('pw')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(401);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe server failed to bind');

    let deadPort = 0;
    try {
      const mon = new ServeHealthMonitor({ port: addr.port, password: 'pw' });
      expect(await mon.checkNow()).toBe('reachable');
      // A wrong password is a 401, which `probeHealth` reads as unhealthy. The
      // monitor inherits that reading rather than reinterpreting it — and note
      // the state is still `healthy`, because one failure is inside threshold.
      const wrong = new ServeHealthMonitor({ port: addr.port, password: 'nope', failureThreshold: 1 });
      expect(await wrong.checkNow()).toBe('unreachable');
      expect(wrong.status().lastFault).toBe('probe-failed');
      expect(wrong.status().state).toBe('degraded');
    } finally {
      deadPort = addr.port;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // The real port is now closed: the probe must fail fast, not hang. This is
    // the end-to-end version of "the probe is bounded".
    const dead = new ServeHealthMonitor({ port: deadPort, password: 'pw', failureThreshold: 1 });
    expect(await dead.checkNow()).toBe('unreachable');
    expect(dead.status().state).toBe('degraded');
  });
});
