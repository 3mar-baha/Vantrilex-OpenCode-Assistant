# SERVE-RESILIENCE

What `src/runtime/serve-health.ts` is, what it deliberately does not do, and
exactly where the wave that owns `src/daemon.ts` wires it in.

Status: **built, tested, not wired.** The module and its test are in the tree.
Nothing imports it yet, on purpose — see [Why it is not wired](#why-it-is-not-wired).

---

## The problem, stated from the tree

`startDaemon` probes serve exactly once:

```ts
// src/daemon.ts:209-215
if (!(await probeHealth(options.servePort, options.servePassword))) {
  throw new OrchestratorError('SERVE_UNREACHABLE', true, `no healthy opencode serve on 127.0.0.1:${options.servePort}`);
}
```

That is the only health knowledge the daemon ever forms. There is no health
loop, no reconnect and no backoff anywhere in `src/`. When `opencode serve` dies
later, the daemon stays up and every command reaches `ServeClient` and fails
one request at a time as a `SERVE_UNREACHABLE` thrown from
`src/runtime/client.ts:438` — per-command failures, with nothing anywhere
saying what the actual condition is.

The owner's decision this implements:

> If `opencode serve` drops, show an amber "reconnecting to OpenCode" bar and
> **block sending commands until the port is back — without the app crashing.**

## What boot behaviour is NOT changed

**A daemon that starts against a dead serve still refuses to start.**
`src/daemon.ts:209-215` is untouched and must stay that way. That check is
fail-closed and deliberate.

This module cannot relax it, by construction:

- it exports no function that performs the boot check;
- `ServeHealthMonitor` has no "assume healthy" constructor — it starts
  `healthy` only because the *caller* is required to have already run the boot
  probe, and that precondition is stated in the class's `start()` doc comment;
- it is not imported by `daemon.ts`, so no code path exists by which starting
  a monitor makes a dead serve survivable.

If a future integration wave finds itself wanting "start anyway", that is a
change to `daemon.ts:209`, and it should be argued as its own item.

---

## The monitor

### Constants

| Constant | Value | Why |
|---|---|---|
| `SERVE_HEALTH_INTERVAL_MS` | `5_000` | Healthy poll cadence. Below: the amber bar is worthless if it arrives after the user has already seen three failed commands. Above: each tick is one loopback `GET /api/session` with a 2 s abort (`src/launcher/launcher.ts:28`), so 5 s is 0.2 req/s forever. Chosen to match the WS-4097 shell ping cadence (`src/ipc/protocol.ts:11`) — one number to reason about. |
| `SERVE_HEALTH_PROBE_TIMEOUT_MS` | `2_000` | Passed to `probeHealth`. Deliberately the probe's own default (`src/launcher/launcher.ts:22`) so a second value cannot drift from it. |
| `SERVE_HEALTH_WATCHDOG_GRACE_MS` | `500` | Added to the above to form the monitor's own race. It must be > 0 so the watchdog cannot beat the probe's cooperative abort; without it, every timing-out probe would be reported as a watchdog expiry. |
| `SERVE_HEALTH_FAILURE_THRESHOLD` | `2` | See below. |
| `SERVE_HEALTH_RECOVERY_THRESHOLD` | `2` | See below. |
| `SERVE_HEALTH_BACKOFF_MS` | `1_000` | First reconnect delay. |
| `SERVE_HEALTH_BACKOFF_MAX_MS` | `30_000` | Ceiling on the delay, so the last attempts are not minutes apart. |
| `SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS` | `6` | At 1/2/4/8/16/30 s these span ~61 s, after which the monitor latches off. |

### The two thresholds, and the flap each prevents

`SERVE_HEALTH_FAILURE_THRESHOLD = 2` — consecutive failures before loss is
declared.

`probeHealth` returns a bare boolean and discards the reason
(`src/launcher/launcher.ts:32-34`), so a 2 s timeout, a 500, a 401 and a closed
port are the *same* `false`. Declaring loss on the first one converts a routine
hiccup — the serve process busy answering an inference turn on a
single-supervisor box — into an amber bar plus a blocked command path, which is
worse than the outage it was built to report. Two consecutive failures span two
poll cycles (~10 s) and remove every single-probe false positive.

Two and not three: the supervisor kills a daemon that never binds 4097, so a
serve loss that takes the daemon with it is a *total* app outage rather than a
degraded one, and detection latency is a real cost. Three is defensible; two is
the judgement call, stated as one.

`SERVE_HEALTH_RECOVERY_THRESHOLD = 2` — consecutive successes before recovery
is declared.

Recovery is the direction that flaps. A serve restart brings the listener back
before its session store is warm, and `probeHealth` cannot tell "answered" from
"answered usefully". One success there is a coin flip, and every coin flip is a
bar the user sees appear and vanish.

Equal to the failure threshold rather than larger, because the two thresholds
trade against different harms. A false LOSS blocks a live user; the
self-correction is a refused command they retry. A false RECOVERY lets a command
through to a serve that is still coming up; the self-correction is the
pre-existing `SERVE_UNREACHABLE`. So recovery must be at least as strict as
loss, but pushing it higher only widens the window in which a recovered serve
stays blocked.

**This is a judgement, not a measurement.** No live serve-restart trace was
gathered. The justification is the asymmetric cost above, and the constants are
pinned by test so a change is deliberate rather than accidental.

**The documented residual, pinned by test.** Counting is strictly consecutive, so
a success resets the counter and a serve that alternates healthy/unhealthy every
probe *never* declares loss. That is the deliberate trade: the alternative is a
ratio window, which is exactly the flapping the threshold exists to prevent. The
cost is that a genuinely intermittent serve reads healthy forever. Pinned by
`ALTERNATING failure/success never declares loss` so it is a decision, not an
oversight that a well-meaning edit silently reverses.

### The state machine

```
healthy ──(2 consecutive failures)──▶ degraded ──(a reconnect attempt fails)──▶ reconnecting
                                                                                     │
healthy ◀──(2 consecutive successes)────────────────────────────────────────────────┘
```

- **Entry to the degraded path is only ever a loss of a previously healthy
  serve.** There is no other edge in.
- `degraded` → `reconnecting` happens on the first failed reconnect attempt, and
  that failure is the one that spends attempt #1.
- The state stays `reconnecting` after the attempt budget is exhausted, because
  that is the accurate description. `status().exhausted` is what distinguishes
  "still trying" from "gave up", and the two get different `ack.detail` codes.

### What "bounded" means here, concretely

- **Bounded interval.** A self-rescheduling `setTimeout`, not `setInterval`:
  backoff needs a variable delay. The reschedule happens in a `finally`, so a
  slow or throwing probe still leaves a live loop, and the cadence can never
  compound — worst case `delay + probeTimeout` per cycle. Unref'd, so it never
  holds the process open (same reason as `src/orchestrator/inventory.ts:87`).
- **Bounded attempt count.** `SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS`, then the
  monitor **latches off**: no timer, `nextProbeInMs: null`, and `start()` refuses
  to re-arm an exhausted monitor. It does not decay into a slow poll that looks
  like recovery. `resume()` is the re-arm, and it is a no-op unless exhausted.
- **Bounded probe.** `probeHealth` aborts at its own timeout, but the monitor
  races it against its own watchdog anyway, so bounded-ness is a property of the
  monitor and not an inherited promise about a collaborator. A probe that hangs
  is recorded as `probe-timeout` and counted as a failure — it never stops the
  loop, because the condition this module exists for must not be the condition
  that disables it.
- **Bounded concurrency.** A re-entrancy guard means at most one probe is ever in
  flight; a concurrent `checkNow()` returns `'skipped'` rather than queueing.
- **Bounded logging.** Events fire on *transition* only. A healthy serve emits
  nothing, ever — pinned by `emits on TRANSITION only`.

### The event surface

```ts
type ServeHealthEvent =
  | { type: 'state'; from: ServeHealthState; to: ServeHealthState; status: ServeHealthStatus }
  | { type: 'exhausted'; status: ServeHealthStatus }
  | { type: 'resumed';  status: ServeHealthStatus };
```

A subscriber that throws cannot take the loop with it — the loop's job is to
detect the outage, and the event is only a report of it.

`ServeHealthStatus` carries `state`, `servePort`, `consecutiveFailures`,
`consecutiveSuccesses`, `attempts`, `exhausted`, `inStateMs`, `nextProbeInMs`
and `lastFault`. It deliberately does **not** carry the serve password: that
object crosses the WS boundary in the integration wave, and the credential must
not be one hop from a frame.

---

## Integration points for the wave that owns `src/daemon.ts`

Five edits, all in `src/daemon.ts`. Nothing else is required; `protocol.ts` and
`ui-server.ts` need no change.

### 1. Construct and start the monitor

`src/daemon.ts:209-215` is where the boot probe lives, so this is where the
monitor's precondition is satisfied. Immediately after the `SERVE_UNREACHABLE`
throw block — i.e. after serve is *proven* healthy:

```ts
const serveHealth = new ServeHealthMonitor({
  port: options.servePort,
  password: options.servePassword,
  onEvent: (event) => { /* see step 2 */ },
});
```

Start it where `inventory.start()` is called — `src/daemon.ts:1385`, after
`publishSessions()` and after `ui.start()` has returned, so the amber bar has a
socket to travel over. Add `serveHealth.start();` beside that line, and
`serveHealth.stop();` at the top of the `stop()` closure at
`src/daemon.ts:1396-1397`, next to `inventory.dispose()`.

### 2. Turn transitions into the amber notice

`ui.notice` is `src/ipc/ui-server.ts:341`; the `notice` frame's `code` is an
open `z.string().min(1)` (`src/ipc/protocol.ts:635`), so a new code needs no
protocol change.

```ts
onEvent: (event) => {
  if (event.type === 'state' && event.to === 'healthy') {
    ui.notice('serve-restored', 'عاد الاتصال بـ OpenCode', 'info');
    return;
  }
  if (event.type === 'state') {
    ui.notice(SERVE_NOTICE_RECONNECTING, 'جارٍ إعادة الاتصال بـ OpenCode…', 'warn');
    return;
  }
  if (event.type === 'exhausted') {
    ui.notice('serve-reconnect-exhausted', 'تعذّر إعادة الاتصال بـ OpenCode.', 'warn');
  }
}
```

`level: 'warn'` is the amber. The owner asked for exactly three visible states
and this produces them: reconnecting, gave-up, and restored.

### 3. The blocking gate

The named place is the `ui.onCommand` assignment — **`src/daemon.ts:660`**:

```ts
// today
ui.onCommand = createCommandHandler({ ... });

// after — one added call, two existing arguments
ui.onCommand = withServeGate(
  () => serveHealth.status(),
  createCommandHandler({ ... }),
  (status) => ({ ok: false, detail: serveBlockedDetail(status) }),
);
```

`withServeGate` is generic over the command and the outcome type, so
`createCommandHandler`'s `(cmd: UiCommand) => Promise<CommandOutcome>` and
`{ ok: false, detail: string }` both fit without a cast, and
`UiServer.onCommand` (`src/ipc/ui-server.ts:127`) accepts the result unchanged.

**The gate is default-deny with an allowlist**, and that is the part worth
reading before wiring it. `SERVE_LOCAL_ONLY_COMMANDS` is the set of commands
that provably cannot reach serve, and the gate passes those through untouched:

| Allowed while serve is down | Why (from the router's own body) |
|---|---|
| `abort`, `stopSpeech`, `playbackStarted` | call only `deps.onAbort` / `onStopSpeech` / `onPlaybackStarted` — `src/orchestrator/command-router.ts:547`, `src/orchestrator/command-router.ts:552`, `src/orchestrator/command-router.ts:558` |
| `mute`, `deafen`, `arm` | `return { ok: true }` with no dependency call — `src/orchestrator/command-router.ts:584-587` |
| `switchSession` | mutates daemon-local state — `src/orchestrator/command-router.ts:464` |
| `setPersona` | `deps.setPersona`, wired to `ui.setPersona` / `ui.notice` — `src/orchestrator/command-router.ts:542`, `src/daemon.ts:710-711` |
| `saveApiKeys` | `writeKeyPools` reaches only the encrypted vault (`src/voice/key-store.ts:1`) — no network |

The reason the allowlist exists: `abort` and `stopSpeech` are what a user
reaches for when the assistant will not stop talking. Blocking them because
serve died would make the gate *cause* the outage it exists to describe.
`saveApiKeys` is the same argument for a user who needs to fix their keys while
serve is down.

Everything else is blocked, including `confirm` — which re-enters `execute()`
on a parked command (`src/orchestrator/command-router.ts:686`) and would
otherwise run a destructive action against a dead port. A blocked `confirm` lets
the parked command expire naturally on `CONFIRMATION_TTL_MS`, which is the
correct outcome.

Because a test pins the allowlist as exactly the complement of the seven
serve-reaching kinds, **re-derived from the live `UiCommandSchema`**, a command
kind added later is blocked by default until someone proves it local.

### 4. The retry affordance

`resume()` re-arms the budget but does **not** open the command path — resuming
is not recovering, and a `resume()` that flipped the state to `healthy` would
let commands through with no evidence the port is back. Pinned by
`resume() re-arms the budget but does NOT declare healthy`.

There is no retry command in `UiCommandSchema` today, so this step is a product
decision, not an implementation: either add one (an additive change, per the
repo's frame rules) or have the daemon `resume()` on the next supervisor
notification. `checkNow()` also works and is safe to call from a UI affordance —
a manual probe is always honoured, including after the latch, and it can only
recover, never re-spend the budget.

### 5. Expose it on `DaemonHandle`

`DaemonHandle` is `src/daemon.ts:88-102` and the returned object is
`src/daemon.ts:1387-1415`. Add a getter mirroring the `ttsCredit` pattern at
`src/daemon.ts:1391-1393`:

```ts
get serveHealth(): ServeHealthMonitor { return serveHealth; },
```

`cli.ts` prints the handle at `src/cli.ts:215`, so this also makes the state
visible to `doctor` without a new code path.

---

## Why it is not wired

Because `src/daemon.ts` was outside this item's write-set, and because the
integration above is five edits that should be reviewed as one wave rather than
half-landed.

The honest consequence: **`src/runtime/serve-health.ts` is currently reached by
its test and by nothing else.** `npm run test:blindspots` counts it as
test-reachable but not live, and `npm run docs:verify` therefore expects one
more test-reachable module and one more total module than the documented
figures. Measured, by moving the two files aside and re-running the checker:

| Check | Without these files | With them | Mine? |
|---|---|---|---|
| test-reachable modules | 69 | 70 | +1 |
| test total modules | 72 | 73 | +1 |
| dead modules | 9 | 9 | no change |
| live modules | 59 | 59 | no change |
| live source lines | 15264 | 15264 | no change |

The other five `docs:verify` failures present in the tree are **not** mine and
were not caused by this item — they are other agents' concurrent edits
(desktop test counts, `src/tasks/*` dead modules, and 35 dangling `file.ts:NNN`
anchors in `protocol.ts` / `ui-server.ts` / `command-router.ts` citations that
those files' own in-flight rewrites invalidated). The wave that owns
`AGENTS.md` needs to add the two +1s above, and should re-derive the rest.

---

## Verification

```
npx tsc --noEmit                                  # no errors in serve-health.ts
npx tsc -p tsconfig.tests.json --noEmit           # no errors in serve-health.test.ts
npx eslint src/runtime/serve-health.ts src/runtime/serve-health.test.ts --max-warnings 0
npx vitest run src/runtime/serve-health.test.ts   # 31 passed
```

### The guards were broken, not just the tests run

Directive 2 of `Vantrilex-Precision-Workflow` — a guard is real once you have
seen it fail. Each injection below printed a confirmation line *before* the run,
because a break that measured nothing is a pass.

| Injection | Result |
|---|---|
| declare loss on the first failure (`failures < 1`) | 6 failed |
| declare recovery on the first success | 4 failed |
| bypass the allowlist in the gate | 1 failed |
| remove the exhausted guard from `start()` | 1 failed |
| remove the re-entrancy guard from `tick()` | 1 failed |
| remove the watchdog race (bare `await`) | 12 failed |

### Tests that pin a decision rather than a behaviour

- the alternating probe case that deliberately does **not** declare loss;
- the exact values of both thresholds, and of every cadence constant;
- that the allowlist is exactly the complement of the seven serve-reaching
  kinds, parsed from the live `UiCommandSchema` rather than from a comment;
- that the real `probeHealth` is what an un-injected monitor uses, driven against
  a real loopback server — the only way to show it is the same function and not
  a lookalike that happens to agree;
- that a late probe rejection does not crash the process;
- that `status()` cannot contain the serve password.
