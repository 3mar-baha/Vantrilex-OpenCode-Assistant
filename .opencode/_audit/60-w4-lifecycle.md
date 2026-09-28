# W4 — lifecycle (C2 / C4 / C7)

Worker W4, Wave 2. Cargo lock held and released; nothing committed.
Write set touched: `apps/desktop/src-tauri/src/main.rs`, `src/daemon.ts`,
`src/orchestrator/audio-pipeline.ts`, `src/daemon.test.ts`,
`src/daemon-barge-in.test.ts` (new), `src/orchestrator/audio-pipeline-abort.test.ts` (new),
this report. `src/orchestrator/command-router.ts` needed **no** change — see C4.

## Gate ledger (all measured on this machine, 2026-09-28)

| Gate | Baseline | After | Exit |
|---|---|---|---|
| `npx tsc --noEmit` | clean | clean | 0 |
| `npm run typecheck:tests` | 0 | **0** | 0 |
| `npm run lint` (eslint) | clean | clean | 0 |
| `npx oxlint` | 8 warnings / 0 errors | **8 warnings / 0 errors** | 0 |
| `npx vitest run` | 573 / 46 files | **655 / 53 files** | 0 |
| `cargo test` | 36 | **48** | 0 |

My own delta: **+22 tests** (9 in `audio-pipeline-abort.test.ts`, 7 in
`daemon-barge-in.test.ts`, 6 in `daemon.test.ts`) and **+12 cargo tests**.
The 53-file / 655-test figure includes other workers' in-flight files
(`src/runtime/laya/**`, `src/policy/laya-sidecar-safety.test.ts`,
`src/telemetry/writer-redaction.test.ts`); the 7 extra files are not mine.
`npm run test:e2e` was **not** run — the orchestrator owns the E2E port lock.

---

## C2 — a second launch silently adopts an existing holder

### The defect, as measured

`port_open()` was a bare `TcpStream::connect_timeout` (`main.rs`, pre-edit
`port_open` at :773-776), and `ensure_daemon` branched on it alone (pre-edit
:1029-1031):

```rust
if port_open(DAEMON_PORT) {
    return Ok(format!("daemon already on {DAEMON_PORT}"));
}
```

So any process with the socket — a leftover dev server, another install, a
squatter — produced `Ok(...)`, and `ensure_all_services` turned that into
`BringUpStatus::ready` (`main.rs:1114`). `EADDRINUSE` was unreachable from this
path: a daemon we *did* spawn and fail to bind is reported by
`spawn_and_wait_for_port` (:1075), never by the probe.

### The fix

A TCP connect cannot carry identity, so the holder now does. Three pieces:

1. **The shell mints a per-install owner key** — `ensure_owner_key()`
   (`main.rs`, in the C2 block after `ensure_serve_password`), same shape as
   `ensure_serve_password`/`ensure_ipc_token`: env `VOXAURA_OWNER_KEY` → file
   `~/.opencode-voice-runtime/owner.key` → fresh CSPRNG via `generate_secret()`.
   It is **never logged** — only the fact that one exists.
2. **The daemon publishes it** — `daemon.ts` writes `daemon.owner`
   (`{v, pid, ipcPort, contractVersion, ownerKey}`) *after* `ui.start()`
   resolves, and removes it on `stop()`. Without `VOXAURA_OWNER_KEY` it
   publishes nothing, so a hand-started `cli.js serve` cannot claim a port it
   cannot prove.
3. **The shell decides** — `holder_from_probe()` is a pure function of
   (port open, marker bytes, expected key, liveness closure) returning
   `DaemonHolder::{Cold, Ours{pid}, Foreign{reason}}`. `ensure_daemon` adopts
   `Ours`, **refuses** `Foreign` with an `Err` naming 4097 and the reason, and
   spawns on `Cold`.

Deliberate design points, with the reason:

- **The key is not hashed.** It authorises nothing but "I am the daemon this
  shell launched"; the real WS-4097 bearer is separate and untouched. Hashing
  would need SHA-256 in *two* languages, and `Cargo.toml` has no hash crate —
  hand-rolling one in the file the S2 audit just reviewed is a worse trade than
  a second copy of a non-credential.
- **The marker file is pre-created by the shell** with the same protected
  owner-only DACL as `owner.key` (`write_protected_secret`), and the daemon
  overwrites it **in place**. A temp-file + rename would `REPLACE` the file and
  reset its security descriptor, discarding that DACL. `daemon.ts` says so at
  the write.
- **A 1.5 s settle window.** The holder publishes *after* binding, so a launch
  landing in that window sees a live port and no file. `classify_daemon_holder`
  polls for `Ours` up to `OWNER_SETTLE`, but returns `Cold` immediately when
  nothing is listening — a first launch never pays the wait.
- **A refusal is an `Err`, not a warning.** Refusing to spawn over a squatter is
  also strictly better than spawning: that child could only fail to bind, and
  `spawn_and_wait_for_port` would burn 20 s before killing it.
- `process_alive()` moved from the test module to module scope: a stale marker
  naming a dead pid is the case `holder_from_probe` exists to refuse, so it is
  production code now.

**Measured finding that changed the code:** `tasklist /FI "PID eq 0" /NH /FO CSV`
prints `"System Idle Process","0",…` on this machine, so `process_alive(0)` is
`true` on Windows. A marker naming pid 0 would therefore sail through a liveness
check. `holder_from_probe` rejects pid 0 *before* asking, and
`c2_pid_zero_is_refused_even_though_the_os_calls_it_alive` pins both halves.

### Break-the-guard (non-vacuous)

Break: `holder_from_probe` returns `Ours { pid: 1 }` when the marker is absent —
i.e. exactly the pre-C2 lie.

```
running 9 tests
test phase2_tests::c2_our_own_live_daemon_is_told_apart_from_a_bare_tcp_holder ... FAILED
test phase2_tests::c2_a_real_listener_with_no_marker_classifies_as_foreign ... FAILED
test phase2_tests::c2_the_ensure_daemon_status_words_are_distinguishable ... FAILED
    a holder that never received this install's identity must not be adopted
    a bare TCP holder must never be adopted, got Ours { pid: 1 }
    expected a foreign holder
test result: FAILED. 6 passed; 3 failed
EXITCODE=101
```

Restored → 48/48 green, exit 0. The strongest of the three is
`c2_a_real_listener_with_no_marker_classifies_as_foreign`: it binds a **real**
`TcpListener` on an ephemeral port, confirms `port_open(port)` is true, and
requires `Foreign`. Nothing about the defect is mocked.

Node-side mirror: `parseDaemonOwnerMarker` is tested against the same shapes as
`holder_from_probe` (other install, pid 0, negative pid, wrong version, missing
fields, non-object, unparseable), plus a real daemon boot that publishes a marker
naming the **actually bound** port and clears it on `stop()`.

---

## C4 — `abort` does not abandon an in-flight `think()`

### The defect, as measured

`src/daemon.ts` wired `onAbort: () => speechGate.abort()` (pre-edit :261). The
`SpeechGate` is a **TTS** gate: `capture()`/`isCurrent()` are checked only
inside `onUtterance`'s per-sentence synthesize loop. `AudioPipeline.generation`
— the only thing that can abandon a turn — was bumped by `reset()` alone, and
`reset()` was called from exactly one place: `switchSession`. So an `abort`
during planning left the turn running; the planner finished; the pipeline
dropped the answer at its post-`think` generation check
(`audio-pipeline.ts:149`). The user paid for a free-tier planning call whose
result was never spoken.

### The fix

- `AudioPipeline.cancel()` (new, `audio-pipeline.ts`): `ingest.reset()` +
   `recent = []` + `generation += 1`.
- `reset()` now **delegates** to it. One operation, two names: `reset` is the
  session-switch call site, `cancel` is the barge-in one.
- `abortTurn(gate, pipeline)` — new exported function in `daemon.ts` — trips
  both generations: `gate.abort(); pipeline()?.cancel();`.
- `onAbort: () => abortTurn(speechGate, () => audio)`. The pipeline is a
  **getter** because `rebuildVoice` can swap it mid-command.
- `turnGeneration` getter added, so the mechanism is observable.

`command-router.ts` needed **no change**: `case 'abort': deps.onAbort?.()` is
correct once `onAbort` does the right thing. I am reporting that rather than
touching the file to leave a mark.

**One design error I made and my own test caught:** I first wrote `cancel()` to
preserve the repeat memory, reasoning that barge-in is not a session switch. The
new test `a cancel forgets the retracted turn so re-speaking it works` failed,
and it was right: `remember()` runs *before* `think`, so a cancelled turn's
transcript is still in the dedupe window — the user's retry after a barge-in
would be dropped as a duplicate, i.e. silence for asking again. `audio-pipeline-reset.test.ts:204-219`
had already documented this intent for `reset()`. `cancel()` now clears it.

### Break-the-guard (non-vacuous) — two breaks, because one was not enough

**Break 1 — `abortTurn` reduced to its pre-C4 body** (`gate.abort(); void pipeline;`):

```
× a reply already being planned when abort lands is never narrated   22ms
× a cancelled turn is not deduped away when the user says it again     3ms
    AssertionError: onUtterance is the narration entry point:
      expected [ { transcript: 'شوف السير', …(2) } ] to deeply equal []
Tests  2 failed | 6 passed
```

**Break 2 — the `startDaemon` wiring, `() => audio` → `() => null`:**

```
× startDaemon hands abortTurn the LIVE pipeline, not a stub   6ms
    AssertionError: the abort handler must reach the turn pipeline:
      onAbort: () => abortTurn(speechGate, () => null),
      : expected '…' to match /abortTurn\(speechGate,\s*\(\)\s*=>\s*…/
Tests  1 failed | 7 passed
```

Why break 2 exists: my first guard wired the *test's own* rig to `abortTurn` and
therefore **did not fail** when I broke the daemon's call site — a vacuous guard
for the wiring, which is exactly what the rule is for. The rig cannot reach
`audio`: it is private to `startDaemon`, and observing it needs a booted daemon
with a real voice pipeline (real vault keys, real provider calls). So that one
link is pinned **structurally** and the test says so in its own name and comment.
It is weaker than a runtime test and I am not claiming otherwise.

The behavioural guard is otherwise end-to-end: real `createCommandHandler`, real
`abortTurn`, real `SpeechGate`, real `AudioPipeline`, and the narration chain
wired exactly as `daemon.ts:594-632` wires it. "Never narrated" is asserted at
`onUtterance`, at the faked synthesizer, and at the broadcast — with a control
test proving the same turn *is* narrated when no abort lands, so the guard cannot
pass on a pipeline that narrates nothing.

---

## C7 — `Supervisor::own` swallowed job-creation failure

### The defect, as measured

Pre-edit `main.rs:361-371`:

```rust
let ok = self.job().is_none_or(|job| job.adopt(&child));
self.own_with_adoption(child, ok)
```

`self.job()` returns `None` when `KillOnCloseJob::create` failed
(`CreateJobObjectW` null, or `SetInformationJobObject` returning 0 —
`main.rs:61-81`). `Option::is_none_or` returns **true** for `None`. So on a
machine that cannot create the job at all: every child reported `adopted = true`,
was pushed into `children`, `unadopted` stayed `0`, and only the graceful reap
was left as a net. That directly contradicts the note at :89-93 — "There is no
safe 'ignore' here."

**Which was wrong: the code, not the comment.** The comment described the
correct contract and the implementation violated it. I fixed the code and left
the comment, now accurate.

### The fix

- New `enum Adoption { Adopted, Refused{pid}, NoJob{pid} }`. A three-variant enum
  makes the swallowed case unrepresentable: mapping "we have no job" onto "the
  kernel took it" must now be written on purpose, with the pid, somewhere a test
  can reach.
- `Supervisor::adoption_of(&self, child)` — split out of `own` so the `None` arm
  is reachable from a test, and `match self.job() { Some(job) => …, None => NoJob }`.
- New `no_job` counter, separate from `unadopted`: a kernel refusal is one child,
  a creation failure means **every future child** is untrackable too. Distinct
  log lines, and `ensure_all_services` reports the counter on failure.
- **Both `own()` call sites now return `Err` when `!supervised`.** Pre-edit they
  logged a WARNING and returned `Ok("… started on 4096/4097")` for a child that
  had just been killed — the same silent-adoption lie as C2 in a different place,
  so it is fixed rather than left as a second copy of the defect.

### Break-the-guard (non-vacuous)

Break: `adoption_of` restored to the historical line verbatim —
`let ok = self.job().is_none_or(|job| job.adopt(child));`

```
running 3 tests
test phase2_tests::c7_a_missing_job_is_never_reported_as_an_adoption ... ok
test phase2_tests::c7_a_healthy_job_is_still_adopted_and_counts_no_failure ... ok
test phase2_tests::c7_a_job_that_cannot_be_created_is_surfaced_and_the_child_is_killed ... FAILED
    panicked at src\main.rs:1553:9:
    a supervisor with no job object must NOT report the child as supervised
test result: FAILED. 2 passed; 1 failed
EXITCODE=101
```

Honest detail: **only 1 of the 3 C7 tests detects this break.**
`c7_a_missing_job_is_never_reported_as_an_adoption` pins the `Adoption`→`Action`
mapping, which the break does not change, and `c7_a_healthy_job_is_still_adopted…`
is the control. The behavioural test is the guard, and it works because
`Supervisor::with_unavailable_job()` (test-only) seeds the `OnceLock` with `None`
— a faithful stand-in for a failed `CreateJobObjectW`, against a **real spawned
child** that must be found dead afterwards.

---

## W5 Laya seam — NOT added. Decision and evidence

I wrote the seam, measured it against W5's in-flight guard, and **removed it**.
The orchestrator should apply it after the guard is fixed; the one-liner is in
"Recommended follow-ups".

`src/policy/laya-sidecar-safety.test.ts` walks the daemon's import graph with a
regex scanner. Two properties of that scanner matter:

- it is **comment-blind** — `/^\s*(?:import|export)\s[^'"]*from\s+['"]…/gm` and
  `/import\(\s*['"]…/g` match prose;
- it has **no visited-once guard** — `if (!seen || isStatic) queue.push(...)`
  re-queues any statically-reachable node once per incoming static edge.

`src/runtime/laya/laya-engine.ts:21` and `:28` name `'./laya-engine.js'` **in
their own doc comments**. So the scanner reads them as self-edges, and the
re-queue rule turns a self-edge into a non-terminating walk. I measured it with
a standalone replica of the walker (in `%LOCALAPPDATA%\Temp\opencode`, not the
repo), capped at 20 000 steps:

```
entry src/daemon.ts cap 20000
steps 20001 runaway true
laya edges:
   dynamic  src\daemon.ts -> src\runtime\laya\loader.ts
   dynamic  src\runtime\laya\loader.ts -> src\runtime\laya\laya-engine.ts
   STATIC   src\runtime\laya\laya-engine.ts -> src\runtime\laya\laya-engine.ts
   dynamic  src\runtime\laya\laya-engine.ts -> src\runtime\laya\laya-engine.ts
top re-processed files:  19998x src\runtime\laya\laya-engine.ts
offenders 2997  ['src\...\laya-engine.ts -> onnxruntime-node (static)', …]
```

`laya-engine.ts` also ends up in `statics`, so the guard reports the **false**
offender `laya-engine -> onnxruntime-node (static)` and fails. My `import()` of
`loader.js` is a *dynamic* edge and is innocent; it is simply what makes the
subtree reachable, at which point the self-edge detonates.

With the seam removed, the same walk terminates:

```
entry src/daemon.ts cap 5000
steps 124 exhausted queue true
nodes 33 statics 32
offenders 0 []
```

The symptom I first saw was a **heap OOM killing a vitest worker** (4 GB,
"Reached heap limit") in the full-suite run — the runaway walk. It disappeared
with the seam, and the suite went to 655/655. So the seam was not merely
failing a test, it was destabilising the gate.

Attribution: **the guard is the defect; my seam was the trigger.** W5's file is
not in my write set, so I could not fix it.

## Recommended follow-ups (not implemented — outside my write set)

1. **W5: give the walker a visited-once rule** — `if (!seen) queue.push(...)`
   plus `statics.add(cand)` when the edge is static. One line, and it makes the
   guard terminate on a dense graph. Optionally strip comments before matching.
2. **Orchestrator: re-add the Laya seam** to `src/daemon.ts` once (1) lands,
   immediately after the `vadGate` block:
   ```ts
   let layaLoad: Promise<{ decide(t: string): Promise<unknown | null>; heads: readonly string[];
     operatingLength: number } | null> | null = null;
   const loadLaya = () => (layaLoad ??= import('./runtime/laya/loader.js')
     .then((m) => m.loadLayaAdvisory({ sink: record }))
     .catch(() => null));
   ```
   I had this wired and passing `tsc`; it is the `loader.js`-only rule their
   `index.ts:1-16` prescribes. It is advisory: `null` (the shipped state — the
   checkpoint tokenizer is a ~40 MB artifact that is not vendored) leaves the
   voice loop untouched.
3. **Residual, deliberate:** a provider call already dispatched inside
   `coordinator.run` (`src/orchestrator/coordinator.ts:305`) cannot be recalled,
   and `coordinator.ts` is not in my write set, so there is no cancellation seam
   to add there. `abort` guarantees the *reply* is never narrated or announced;
   it does not un-send a prompt OpenCode has already received. The pre-`coordinator`
   stages (mentions fetch, `optimizePrompt`) are likewise not short-circuited —
   adding that would need a `turnGeneration` read inside `think`, which is
   untestable without real keys, so I left it rather than ship an unverified guard.
4. **`owner.key` is a new file in the runtime dir.** If W4's C2 design is
   reviewed and rejected, delete `ensure_owner_key`, `holder_from_probe`,
   `classify_daemon_holder`, `DaemonHolder` and the `ensure_daemon` branch, plus
   the `C2` tests — they are self-contained. The `daemon.ts` marker code is
   likewise removable on its own (`publishOwner`/`clearOwner`/`runtimeDir`).
