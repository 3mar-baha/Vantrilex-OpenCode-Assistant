# 01 — Core Engine Forensic Audit

**Auditor:** Forensic Auditor 1/7
**Date:** 2026-09-28
**Scope audited:** `src/orchestrator/`, `src/runtime/`, `src/cli.ts`, `src/daemon.ts`, `src/ipc/`, `apps/desktop/src-tauri/src/main.rs`
**Method:** every claim below is derived from physical source on disk. Markdown under `docs/`, `dossier/`, `AGENTS.md` and in-code comments are treated as UNTRUSTED and only appear as claims to be falsified. Where a number was measured, the exact command is quoted.

---

## 0. PATH VERIFICATION (the brief's "path that does not exist" note)

**All six scoped paths in the brief exist.** Verified:

| Scoped path | Exists | Contents |
|---|---|---|
| `src/orchestrator/` | yes | 8 production `.ts` + 11 `.test.ts` (measured: `Get-ChildItem -Recurse -File`) |
| `src/runtime/` | yes | 4 production `.ts` (`client.ts`, `opencode-bridge.ts`, `fuzzy-match.ts`, `vad.ts`) + `index.ts` + 4 `.test.ts` |
| `src/cli.ts` | yes | 246 lines |
| `src/daemon.ts` | yes | 755 lines |
| `src/ipc/` | yes | 3 production `.ts` (`protocol.ts`, `ui-server.ts`, `audio.ts`) + `index.ts` + 4 `.test.ts` |
| `apps/desktop/src-tauri/src/main.rs` | yes | 1383 lines, the only `.rs` file in `src-tauri/src/` |

**FINDING 0.1 (doc claims a file that does not exist).** `docs/26-AGENT-LAUNCHER.md:34-42` (normative §26.1) states `src/launcher/` owns the serve child and that *"no other module may spawn `serve` … all control flows through `launcher/`"*, and §26.4:88-92 specifies a 60 s orphan sweeper. Physically, `src/launcher/` contains exactly three files — `index.ts`, `launcher.ts`, `launcher.test.ts` — and `launcher.ts` is 38 lines exporting **only** `probeHealth` (verified: `Get-ChildItem -Path src\launcher -File`). `SupervisedLauncher`, `resolvePort`, `siblings.ts` and `killTree` do not exist. The document *does* carry a supersession banner at `docs/26-AGENT-LAUNCHER.md:3-27` saying exactly this, so the banner is correct and §26.1 is knowingly-false frozen text. `AGENTS.md` is right to call it superseded. **Not a live defect; recorded because the doc body still reads as normative.**

**FINDING 0.2 (in-code comment contradicts the physical tree).** `scripts/lint-baseline.mjs:20-33` asserts:

> *"`oxlint` is declared in devDependencies (pinned exact, no caret) but is **absent from node_modules**, so every run was resolving an AMBIENT GLOBAL binary… `npm install` cannot currently fix this"*

and `:45-62` refuses to run the gate unless `node_modules/.bin/oxlint.cmd` exists. Measured on this machine:

```
PS> Test-Path 'node_modules\.bin\oxlint.cmd'   →  True
PS> Test-Path 'node_modules\oxlint'           →  True
PS> npm run lint:ox
  oxlint: 8 warning(s), 0 error(s); baseline 8
    OK
  EXITCODE=0
```

The comment is stale. `git log --oneline -8` line 5 is `895bc7f build(toolchain): upgrade vitest to 4.1.11, resolve F-02, npm ci green` — F-02 was resolved after the comment was written. The `scripts/lint-baseline.json` file exists and contains `8`. The gate runs on the pinned local binary and passes.

**FINDING 0.3 (dead-file count off by one).** `AGENTS.md` says the quarantine is *"44 files including their tests and fixtures"*. Measured: `Get-ChildItem -Path '.opencode\_archive\dead-code-phase1' -Recurse -File` → **45** files, of which 28 are production `.ts` and 14 are `.test.ts` (28 matches the "the other 28" claim; 45 does not match 44).

---

## 1. PROCESS LIFECYCLE — who spawns whom, in what order

### 1.1 The process tree (cold start, physically derivable)

```
voxaura.exe  (Tauri shell — apps/desktop/src-tauri/src/main.rs:1350)
├── opencode-cli.exe serve --port 4096 --hostname 127.0.0.1     main.rs:752-770
└── node.exe <sidecar>/dist/cli.js serve                          main.rs:807-842
    └── (no further children; the daemon never spawns serve)
```

`src/daemon.ts:44-46` and `main.rs:5-10` both state the ownership rule explicitly:

- `daemon.ts:45-46`: *"It adopts an already-running `opencode serve` (single-supervisor rule: it never fights one)"* — proven by code: `daemon.ts:79-85` calls `probeHealth` and **throws** `SERVE_UNREACHABLE` rather than spawning. `src/launcher/launcher.ts:22-38` (`probeHealth`) contains **no** spawn path at all — only a `fetch` to `/api/session`.
- `main.rs:5-10`: *"The shell only *nudges* a missing serve into existence so a cold double-click works… The shell spawns the daemon when it is absent."*

**Only the Rust shell ever spawns anything.** Neither `src/cli.ts` nor `src/daemon.ts` contains a `spawn`/`exec`/`Command` call. Verified by reading all 246 lines of `cli.ts` and all 755 lines of `daemon.ts`.

### 1.2 The Windows Job Object — exact code, handle creation, membership

**Import** — `main.rs:30-38`:
```rust
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
```
Crate declaration — `apps/desktop/src-tauri/Cargo.toml:18-24`: `windows-sys = { version = "0.61", features = ["Win32_Foundation", "Win32_Security", "Win32_System_JobObjects", "Win32_System_Threading"] }`, under `[target.'cfg(windows)'.dependencies]`. `Win32_System_JobObjects` is present, so the imports resolve.

**Handle type** — `main.rs:43-48`:
```rust
/// Windows Job Object with KILL_ON_JOB_CLOSE. Handles are not RAII-wrapped:
/// the job must outlive every child for the kernel to enforce the kill, and it
/// is intentionally never closed (process teardown closes it, which is exactly
/// the trigger we want).
#[cfg(windows)]
struct KillOnCloseJob(HANDLE);
```
`Send`/`Sync` are `unsafe impl`-ed at `main.rs:50-53` (required because `Supervisor` is Tauri-managed state and must be `Send + Sync`).

**Creation** — `main.rs:56-77`:
```rust
fn create() -> Option<Self> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());   // :59
        if job.is_null() { return None; }                                 // :60-62
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();  // :63
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; // :64
        let ok = SetInformationJobObject(                                  // :65-70
            job, JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 { let _ = CloseHandle(job); return None; }             // :71-74
        Some(KillOnCloseJob(job))
    }
}
```
- `CreateJobObjectW(NULL, NULL)` → unnamed job, no name collision risk.
- **Only** `LimitFlags` is set; `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` is otherwise zeroed (`std::mem::zeroed()`), so no active-process limit, no memory limit, no UI-restriction.
- On `SetInformationJobObject` failure the handle is closed and `None` is returned — no leak.

**Lazy singleton** — `main.rs:342-343` stores it, `main.rs:347-350` creates it:
```rust
#[cfg(windows)]
job: std::sync::OnceLock<Option<KillOnCloseJob>>,
...
fn job(&self) -> Option<&KillOnCloseJob> {
    self.job.get_or_init(KillOnCloseJob::create).as_ref()
}
```
The job is created on **first use**, not at `Supervisor::default()`. `Supervisor::default()` is installed at `main.rs:1352` (`.manage(Supervisor::default())`).

**Assignment** — `main.rs:81-86`:
```rust
fn adopt(&self, child: &Child) -> bool {
    unsafe {
        let handle = child.as_raw_handle() as HANDLE;   // :83
        AssignProcessToJobObject(self.0, handle) != 0   // :84
    }
}
```
It takes the **`Child` itself** (std's `Child::as_raw_handle` on Windows is the process handle) — not a PID-derived handle, so there is no PID-recycling window.

**Membership — exactly two callers**, both in the `BindOutcome::Bound` arms:
- `main.rs:771-777` — the `opencode serve` child, via `app.state::<Supervisor>().own(child)`.
- `main.rs:843-848` — the Node daemon child, via the same.

So **exactly 2 processes are ever assigned to the job** (plus the shell itself, implicitly, because a process is always in a job on Windows unless breakaway is requested — this shell does not request `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, so the shell is the job's root).

**Failure is not swallowed** — `main.rs:89-108` + `357-388`:
```rust
fn adoption_action(ok: bool) -> AdoptionAction { if ok { Keep } else { Kill } }   // :102-108
...
fn own(&self, child: Child) -> bool {
    #[cfg(windows)]
    { let ok = self.job().is_none_or(|job| job.adopt(&child)); self.own_with_adoption(child, ok) }  // :360-361
    #[cfg(not(windows))]
    { self.own_with_adoption(child, true) }                                     // :365
}
fn own_with_adoption(&self, mut child: Child, adopted: bool) -> bool {
    if adoption_action(adopted) == AdoptionAction::Kill {                        // :372
        let _ = child.kill(); let _ = child.wait();                               // :373-374
        if let Ok(mut n) = self.unadopted.lock() { *n += 1; }                     // :375-377
        log_line(&format!("supervisor: job-adopt-failed pid={} — killed immediately …", child.id()));  // :378-381
        return false;
    }
    if let Ok(mut kids) = self.children.lock() { kids.push(child); }               // :384-386
    true
}
```
Both `BindOutcome::Bound` arms log a warning when `own()` returns `false` (`main.rs:773-775`, `main.rs:845-847`), and `ensure_all_services` re-reports the cumulative count on failure (`main.rs:884-890`).

**FINDING 1.1 (real, latent).** `Supervisor::own` at `main.rs:360`:
```rust
let ok = self.job().is_none_or(|job| job.adopt(&child));
```
`Option::is_none_or` treats `None` as **`true`**. If `CreateJobObjectW` or `SetInformationJobObject` ever fails, `self.job()` is `None` and `ok` becomes `true` — the child is counted as supervised and pushed into `self.children` (`main.rs:384-386`) even though **no job exists**. The only protection left is the graceful `reap()` path (`main.rs:405-412`), which is bypassed by `Stop-Process -Force` / Task Manager — exactly the case the job object exists to cover. The failure is also **invisible in the log**: `unadopted` is only incremented in the `Kill` branch, so a `None` job leaves `unadopted() == 0` and `main.rs:884-890` reports nothing. This is a real regression path against the D10 hardening the code documents. A job-creation failure is unlikely but the code's own doc comment (`main.rs:89-93`: *"There is no safe 'ignore' here"*) is violated by the `is_none_or` default.

### 1.3 Shutdown

- `main.rs:1378-1382`: `app.run(|app_handle, event| { if let RunEvent::ExitRequested{..} | RunEvent::Exit = event { app_handle.state::<Supervisor>().reap(); } })` — graceful path, kills + `wait()`s every tracked child (`main.rs:405-412`).
- `main.rs:896-900`: `#[tauri::command] fn shutdown_all_services(app)` calls `reap()` and returns `"children stopped"`.
- The Job Object handle is **never closed by Rust** (by design, `main.rs:43-46`), so the kernel closes it at process teardown and `KILL_ON_JOB_CLOSE` fires — this is what covers `Stop-Process -Force`.

---

## 2. COLD START SEQUENCE, STEP BY STEP

Every step below is emitted in this exact order by the code. No step is inferred.

| # | Where | Action |
|---|---|---|
| 1 | `main.rs:1351-1352` | `tauri::Builder::default().manage(Supervisor::default())` — supervisor state installed, no children yet. |
| 2 | `main.rs:1353-1357` | `invoke_handler` registers exactly three commands: `ipc_token`, `ensure_all_services`, `shutdown_all_services`. |
| 3 | `main.rs:1358-1365` | `.setup(...)` runs **synchronously on the Tauri main thread, before the webview loads**. First statement: `if let Err(err) = ensure_ipc_token() { log_line(…) }`. |
| 4 | `main.rs:446-480` | `ensure_ipc_token()`: env `VOICE_RUNTIME_IPC_TOKEN` wins if non-blank (`:447-451`); else read `%USERPROFILE%\.opencode-voice-runtime\ipc.token` if non-blank (`:454-459`); else generate 32 bytes → 64 hex chars (`:461-476`), `fs::create_dir_all(&dir)` (`:477`), `fs::write(&path,&token)` (`:478`). |
| 5 | `main.rs:1369-1372` | `let handle = app.handle().clone(); std::thread::spawn(move \|\| { let _ = ensure_all_services(handle); });` — bring-up runs **off the UI thread** so a slow probe does not delay first paint. |
| 6 | `main.rs:863-868` | `ensure_all_services` takes the single-flight guard: `if BRINGUP_INFLIGHT.swap(true, Ordering::SeqCst) { … return Ok(BringUpStatus::in_flight()) }`. `static BRINGUP_INFLIGHT: AtomicBool` declared at `main.rs:330`. |
| 7 | `main.rs:871-872` | `let ipc_token = ensure_ipc_token()?;` (idempotent; returns the same token), then `log_line("ipc token: ready")`. |
| 8 | `main.rs:873-874` | `ensure_opencode(&app)?` — §3 below. |
| 9 | `main.rs:875-876` | `ensure_daemon(&app, &ipc_token)?` — §3 below. |
| 10 | `main.rs:879-893` | `BRINGUP_INFLIGHT.store(false, SeqCst)`, then the typed status: `BringUpStatus::ready(steps)` / `::failed(&err)` (`main.rs:303-325`). Failures are **returned, never panicked**. |
| 11 | webview | `apps/desktop/src/App.tsx:87` calls `ensureServices()` → `invoke('ensure_all_services')` (`apps/desktop/src/settings/services.ts:44`). Non-Tauri → `null` no-op (`services.ts:35`). |
| 12 | webview | `App.tsx:90` calls `resolveIpcTokenWithRetry()` → `invoke('ipc_token')` (`apps/desktop/src/settings/ipc-token.ts:22`). Bounded poll: 20 attempts × 500 ms = ~10 s (`ipc-token.ts:49-50`). |
| 13 | `main.rs:526-535` | `#[tauri::command] fn ipc_token()` reads the file, trims, errors `"ipc token not provisioned"` if absent or empty — **fails closed, never invents a credential**. |
| 14 | webview | `App.tsx:95-168` constructs `VoxauraBridge` and calls `b.connect()`. |
| 15 | `apps/desktop/src/bridge/ws.ts:273-277` | `new WebSocket(url, [UI_SUBPROTOCOL, this.opts.token])` — the bearer rides as the **second subprotocol token**; URL is `ws://127.0.0.1:4097/v1/ui` (`ws.ts:5-6`). |
| 16 | `main.rs:1375-1376` | `.build(tauri::generate_context!())` then `.expect("error while building Voxaura")`. |

### 2.1 `serve.pass` provisioning — the credential both children must share

`main.rs:482-521`, `ensure_serve_password()`:
- Env `OPENCODE_SERVER_PASSWORD` wins if non-blank (`:488-492`).
- Else read `%USERPROFILE%\.opencode-voice-runtime\serve.pass` if non-blank (`:495-500`).
- Else generate 32 bytes → 64 hex chars (`:501-517`), `create_dir_all` (`:518`), `fs::write` (`:519`).

The **same function is called twice** — once for each child, and the file guarantees they agree:
- serve: `main.rs:753` `let password = ensure_serve_password()?;` then `main.rs:768` `cmd.env("OPENCODE_SERVER_PASSWORD", &password);`
- daemon: `main.rs:809` `let password = ensure_serve_password()?;` then `main.rs:814` `.env("OPENCODE_SERVER_PASSWORD", &password)`

Runtime dir resolution — `main.rs:415-420`:
```rust
fn runtime_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let mut path = PathBuf::from(home);
    path.push(".opencode-voice-runtime");
    Some(path)
}
```

**FINDING 2.1 (security, real).** The IPC token and the serve password are generated by a **xorshift64\* PRNG seeded from the wall clock and the PID**, not a CSPRNG. `main.rs:460-476` (and the byte-identical block for the password at `main.rs:501-517`):
```rust
// 32 random bytes as hex, sourced without extra crates.
let mut bytes = [0u8; 32];
let mut seed = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos() as u64)
    .unwrap_or(0x9E3779B97F4A7C15)
    ^ std::process::id() as u64;
for chunk in bytes.chunks_mut(8) {
    // xorshift64*
    seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
    for (i, b) in chunk.iter_mut().enumerate() { *b = ((seed >> (i * 8)) & 0xff) as u8; }
}
```
The comment "32 **random** bytes" overstates this. The seed is `nanos_since_epoch ^ pid` — a monotonically-clock-shaped, low-entropy value — and xorshift64\* is a non-cryptographic generator with a 64-bit state. Effective entropy is bounded by the seed's search space, not 256 bits. This is the credential that guards the entire WS-4097 control plane, including `saveApiKeys` (which writes the vault) and `execSessionShell`. Contrast `src/daemon.ts:741-755`, where the *dev* path uses `randomBytes(32)` (`node:crypto`) — so the **packaged build uses the weaker generator** and the dev path does not.

**FINDING 2.2 (doc claim overstates the file mode).** `AGENTS.md` and `docs/10-CHECKPOINT.md:252` both describe the token as "0600". `main.rs:478` and `main.rs:519` use plain `fs::write` with **no permission argument** — no 0600 is ever requested on the Windows path. `src/daemon.ts:748-753` *does* pass `{ mode: 0o600 }` and additionally `chmodSync(path, 0o600)`, but that code is only reached when the file does not already exist, and in the installed flow `main.rs` always writes it first, so the daemon's chmod is a no-op. Protection on Windows comes from the user-profile ACL, not from an explicit mode. The "0600" in the docs is a POSIX-shaped claim the code does not make.

**FINDING 2.3 (double bring-up race, real, cosmetic outcome).** `ensure_all_services` is invoked twice: once on the background thread (`main.rs:1370-1372`) and once from the webview (`App.tsx:87` → `services.ts:44`). `BRINGUP_INFLIGHT` guarantees only one *executes*; the loser gets `state: "in-flight"`, `retriable: true` (`main.rs:308-315`) and the frontend retries **3 times with 400 ms sleeps** (`services.ts:23-24`, loop at `services.ts:43-61`). That is 4 invocations over **~1.2 s total**. But the bind budgets are **20 s for serve** (`main.rs:770`) and **20 s for the daemon** (`main.rs:842`). On any cold start where bring-up takes longer than ~1.2 s — i.e. essentially every cold start — `ensureServices()` exhausts its retries and returns `{ ok: false, detail: "bring-up already in flight (gave up after 4 attempts)" }`, and `App.tsx:88` renders `تعذّر بدء الخدمات: …` in the HUD **even though bring-up subsequently succeeds**. The background thread's result is discarded (`main.rs:1371` is `let _ = …`). Severity: cosmetic/UX false alarm, but it is a permanent false negative on the cold path.

**FINDING 2.4 (order dependency, latent TDZ).** In `src/daemon.ts`, `publishSessions` is a `const` declared at `:684-688` but is *referenced* earlier inside the `think` closure at `:461` (`await publishSessions();`). This is safe at runtime because `:461` is only reached after `startDaemon` has finished executing past `:684`, but the declaration order is inverted and nothing enforces it. If `:677` (`await ui.start`) were ever moved below the pipeline construction, the reference would become a TDZ `ReferenceError` on the first spoken `/new`. No test covers the `/new` + `publishSessions` path through the real daemon (`src/orchestrator/slash-wiring.test.ts` exercises the pure functions only).

---

## 3. PORTS 4096 AND 4097 — every bind, the address, and EADDRINUSE

### 3.1 Every `bind`/`listen` in the audited surface (exhaustive)

There are exactly **two** socket-binding sites in scope, and only one of them is in production code.

| Site | Call | Address | Production? |
|---|---|---|---|
| `src/ipc/ui-server.ts:143-151` | `createServer(...)` + `this.server!.listen(port, '127.0.0.1', …)` | **hard-coded `127.0.0.1`** | yes — this is 4097 |
| `apps/desktop/src-tauri/src/main.rs:540-543` | `TcpStream::connect_timeout(&addr.into(), 400 ms)` | `SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)` | yes — a *connect* probe, not a bind |
| `main.rs:755` | `--hostname 127.0.0.1` (an argv to the child) | n/a | yes — instructs `opencode serve` |

There is **no** `0.0.0.0`, no `::`, no hostname-only `listen()` anywhere in `src/`, and no `EADDRINUSE` string literal anywhere in the audited production code (verified: ripgrep over `src/**/*.ts` for `0\.0\.0\.0|::|EADDRINUSE|bind\(|listen\(` returns only the `127.0.0.1` hits plus test-file `listen(0,'127.0.0.1',…)` calls).

**Port 4097 bind — `src/ipc/ui-server.ts:140-157`, verbatim:**
```ts
/** Start on 127.0.0.1. `port: 0` binds an ephemeral port (tests). Resolves the bound port. */
async start(port: number): Promise<number> {
  if (this.server !== null) throw new Error('UiServer already started');          // :142
  this.server = createServer((_req, res) => { res.writeHead(404); res.end(); });   // :143-146
  this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));     // :147
  await new Promise<void>((resolve, reject) => {
    this.server!.once('error', reject);                                            // :149
    this.server!.listen(port, '127.0.0.1', () => resolve());                       // :150
  });
  const addr = this.server.address();                                              // :152
  const bound = typeof addr === 'object' && addr !== null ? addr.port : port;      // :153
  this.pingTimer = setInterval(() => this.pingAll(), this.pingIntervalMs);          // :154
  this.pingTimer.unref();                                                           // :155
  return bound;
}
```
`'127.0.0.1'` is a **literal string argument** to `listen` — loopback-only, proven from source, not assumed. `main.rs:755` passes `--hostname 127.0.0.1` to `opencode serve` the same way. Both listeners are IPv4-loopback-only; nothing is reachable from the LAN.

**Port 4097 provenance:** `protocol.ts:6` `export const UI_WS_PORT = 4096 + 1;` (= 4097) and `protocol.ts:10` `export const SERVE_PORT = 4096;`. `SERVE_PORT` is the literal in the `hello` schema (`protocol.ts:308`). The **actual** bind port is `cli.ts:149`:
```ts
const ipcPort = Number.parseInt(process.env['VOICE_IPC_PORT'] ?? '4097', 10);
```
`VOICE_IPC_PORT` is **never set by `main.rs`** (the only envs it sets are `OPENCODE_SERVER_PASSWORD` at `main.rs:768`/`814`, `VOICE_RUNTIME_IPC_TOKEN` at `main.rs:815`, and `VOXAURA_VAULT_DIR` at `main.rs:816`). So in a packaged run the daemon binds 4097 by default — but a leaked `VOICE_IPC_PORT` in the user's environment would silently desynchronise it from `main.rs:41 DAEMON_PORT: u16 = 4097` and produce the 20 s timeout + kill path. `UI_WS_PORT` is exported and re-exported (`src/ipc/index.ts:12`) but is consumed only by `src/ipc/protocol.test.ts:26`.

### 3.2 What actually happens on EADDRINUSE

**Proved empirically**, not inferred. Script run against the compiled `dist/ipc/ui-server.js` (a plain `http.Server` squatting on 4097, then a real `UiServer`):

```
RESULT: start() REJECTED code=EADDRINUSE syscall=listen msg=listen EADDRINUSE: address already in use 127.0.0.1:4097
after failure, listening=false
RESULT: retry REJECTED msg=UiServer already started
```

The chain, in order:

1. `ui-server.ts:149` registers `once('error', reject)`, so the `EADDRINUSE` `Error` rejects the promise at `ui-server.ts:148`.
2. `startDaemon` has no try/catch around `const boundPort = await ui.start(options.ipcPort);` (`daemon.ts:677`), so the rejection propagates out of `startDaemon`.
3. `cli.ts:172-175` catches it: `console.log(\`miss daemon: ${err.message}\`); return 1;` → **exit code 1**, one line on stdout, e.g. `miss daemon: listen EADDRINUSE: address already in use 127.0.0.1:4097`.

**FINDING 3.1 (poisoned instance, real but latent).** `ui-server.ts:142` sets `this.server` *before* `listen()` and never resets it on failure. Measured: after a rejected `start()`, `this.server !== null` but `listening === false` (`:123-125`), so a retry throws `'UiServer already started'`. The instance is permanently unusable. In the shipped CLI this is masked because `cli.ts:240` calls `process.exit(await serveDaemon())` immediately, but any future in-process retry path (a supervisor, a test harness, a `--restart` flag) is dead on arrival. Correct fix: clear `this.server = null` in the `error` handler before rejecting.

**FINDING 3.2 (the shell NEVER sees EADDRINUSE — and this contradicts shipped ground truth).** `main.rs:540-543`:
```rust
fn port_open(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&addr.into(), Duration::from_millis(400)).is_ok()
}
```
A bare TCP connect, 400 ms timeout, **no HTTP request, no WebSocket handshake, no bearer, no password**. Consequently:
- `ensure_daemon` at `main.rs:796-798`: `if port_open(DAEMON_PORT) { return Ok(format!("daemon already on {DAEMON_PORT}")); }` — a **successful** return. Any process holding 4097 is adopted silently, and the app reports bring-up `ready`.
- `ensure_opencode` at `main.rs:735-742` likewise reaches `BringUpAction::Adopt` and returns `Ok("opencode serve already on 4096")`.
- Worse, `spawn_and_wait_for_port` at `main.rs:272-285` uses the same `port_open` for the readiness wait. So a child that binds 4097 and *then* dies, or a child that never binds while a squatter holds the port, both read as "Bound" — the readiness check is unsound by construction.

**This directly contradicts shipped Tier-1 ground truth.** `src/knowledge/shared/failures.ts:53-59` (chunk `fail-ports-busy`, source `AGENTS.md#gotchas; apps/desktop/e2e`) states, in both Arabic and English, that the user-facing truth is:

> *"If port 4096 or 4097 is already bound, an installed copy is still running and must be stopped first. **A second launch fails with EADDRINUSE and that is expected**, not a corrupt installation."*

**The second sentence is false.** A second launch does not fail with `EADDRINUSE`; it silently adopts whatever holds the port and reports `ready`. `EADDRINUSE` can only ever surface on the *daemon* side (→ exit 1, one log line), and only if the squatter is not already listening when the daemon binds. The chunk's `source` attribution (`AGENTS.md#gotchas; apps/desktop/e2e`) points at an E2E constraint (ports 4096/4097/4197 must be free for Playwright, `AGENTS.md` §Commands) that has been promoted into end-user product guidance and then contradicted by the code. The BM25 query `"المنفذ 4096"` ranks this chunk second (score 6.298) — so the false statement is actively retrievable.

**FINDING 3.3 (hardcoded `servePort` in `hello`, consistent but blind).** `ui-server.ts:376-386` builds `hello` with `servePort: SERVE_PORT` — the compile-time constant `4096` (`protocol.ts:10`), never `options.servePort`. `UiServerOptions` (`ui-server.ts:44-51`) has no `servePort` field at all, and `startDaemon` never passes one (`daemon.ts:105-108`). The schema demands the literal: `protocol.ts:308 servePort: z.literal(SERVE_PORT)`. The shell mirrors the blindness: `apps/desktop/src/bridge/ws.ts:166` `hello.servePort === 4096` inside `isWellFormedHello`. So if an operator sets `OPENCODE_PORT` to anything other than 4096 (`src/common/config.ts:33`, `.default(4096)`), the daemon connects to that port (`daemon.ts:87`) while the `hello` frame still advertises 4096. Two independent hardcodes agree, so nothing breaks today — but the contract cannot express a non-default port.

**FINDING 3.4 (`OPENCODE_PORT` desync).** `main.rs` never sets `OPENCODE_PORT`, so the daemon uses the default 4096 (`config.ts:33`). If a leaked `OPENCODE_PORT` in the user environment points elsewhere, `main.rs` still spawns serve on 4096 (`main.rs:755` hardcodes the constant) while `daemon.ts:87` dials the env port → `probeHealth` fails → `SERVE_UNREACHABLE` (`daemon.ts:79-85`) → exit 1, and the shell's 20 s wait kills the child. Same class as 3.3: the port is a constant in three places and an env var in one.

### 3.3 EADDRINUSE on the Rust side — handled well, for contrast

`main.rs:272-285`:
```rust
fn spawn_and_wait_for_port(cmd: &mut Command, port: u16, budget: Duration) -> BindOutcome {
    let child = match cmd.spawn() { Ok(c) => c, Err(e) => return BindOutcome::SpawnFailed(...) };
    let pid = child.id();
    if !wait_for_port(port, budget) {
        let mut child = child;
        let _ = child.kill();                 // :280
        let _ = child.wait();                 // :281
        return BindOutcome::TimedOut { pid }; // :282
    }
    BindOutcome::Bound(child)                  // :284
}
```
`wait_for_port` (`main.rs:545-554`) polls every 250 ms until the budget expires, then does one final probe. Both arms are reported with actionable text: `main.rs:786-788` for serve (with a foreign-supervisor hint) and `main.rs:850-852` for the daemon (*"see daemon.log in the runtime dir"*). This is correct, and it is **why** a 4097 clash surfaces as a 20-second stall rather than an error — see Finding 3.2.

---

## 4. IPC / WS FRAME SPECS — `src/ipc/protocol.ts`, exhaustively

### 4.1 Constants (verbatim, with line numbers)

| Constant | Value | Line |
|---|---|---|
| `UI_WS_PORT` | `4096 + 1` = 4097 | `protocol.ts:6` |
| `UI_WS_PATH` | `'/v1/ui'` | `protocol.ts:7` |
| `UI_SUBPROTOCOL` | `'voice-ui.v1'` | `protocol.ts:8` |
| `IPC_TOKEN_ENV` | `'VOICE_RUNTIME_IPC_TOKEN'` | `protocol.ts:9` |
| `SERVE_PORT` | `4096` | `protocol.ts:10` |
| `PING_INTERVAL_MS` | `5000` | `protocol.ts:11` |
| `MISSED_PINGS_LIMIT` | `3` | `protocol.ts:12` |
| `MAX_CONNECTIONS` | `8` | `protocol.ts:19` |
| `RESUME_BUFFER_CAP` | `256` | `protocol.ts:20` |
| **`MAX_MESSAGE_BYTES`** | `1024 * 1024` = **1 048 576** | `protocol.ts:22` |
| `AUDIO_SAMPLE_RATE` | `16000` | `protocol.ts:24` |
| `AUDIO_FRAME_MS` | `100` | `protocol.ts:25` |
| `AUDIO_FRAME_BYTES` | `((16000 * 100) / 1000) * 2` = **3200** | `protocol.ts:26` |
| **`MAX_AUDIO_BYTES`** | `64 * 1024` = **65 536** | `protocol.ts:28` |
| `ACK_KIND` | `'ack'` | `protocol.ts:29` |
| `ERROR_KIND` | `'error'` | `protocol.ts:30` |
| `MAX_AUDIO_CHUNK` (downlink, `audio.ts`) | `32 * 1024` = 32 768 | `audio.ts:7` |
| `AUDIO_DOWNLINK_TYPE` | `0x01` | `audio.ts:6` |
| `MAX_PARKED` (FR-12) | `8` | `command-router.ts:73` |
| `CONFIRMATION_TTL_MS` (FR-12) | `60_000` | `command-router.ts:66` |

`MAX_AUDIO_BYTES` is enforced at `ui-server.ts:442-446`:
```ts
if (frame.opcode === Opcode.Binary) {
  if (frame.payload.byteLength > MAX_AUDIO_BYTES) {
    safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify({ type: ERROR_KIND, detail: 'audio frame too large' })));
    continue;                          // socket survives; frame dropped
  }
```
`MAX_MESSAGE_BYTES` is enforced in `parseHeader` at `protocol.ts:217-219`, throwing `WsProtocolError('frame exceeds message cap — refusing allocation')`, which `FrameReassembler.push` propagates and `ui-server.ts:408-421` converts into a `1009` close frame followed by `socket.destroy()`. **The two limits are different values and they interact**: a single 65 537-byte binary frame is admitted by `parseHeader` (under 1 MiB), passes reassembly, and is then rejected by the `MAX_AUDIO_BYTES` check — which is exactly the documented "error frame, never a dropped socket" behaviour. The 160 000-byte browser window therefore needs ≥3 chunks; the renderer sends ≤32 KiB.

### 4.2 Server → client: TEXT frames — every type, required fields

All seven seq-bearing types share one monotonic counter `this.seq` (`ui-server.ts:106`), incremented in `broadcast` (`:161`), `publishInventory` (`:177`), `publishAgents` (`:189`) and `broadcastFrame` (`:201`).

**(1) `hello`** — `HelloFrameSchema`, `protocol.ts:304-318`. Sent on every successful upgrade at `ui-server.ts:376-387`.
- Required: `type: z.literal('hello')`; `contractVersion: z.string().min(1)`; `nodePid: z.number().int().positive()`; `servePort: z.literal(SERVE_PORT)` (= 4096, hardcoded); `layaReady: z.boolean()` — always literally `true` (`ui-server.ts:381`); `seq: z.number().int().nonnegative()`.
- Optional: `persona: z.enum(['kareem','nour']).optional()` (`protocol.ts:317`, L22).
- Values: `contractVersion` defaults to `'3.1.0'` (`daemon.ts:107`); `nodePid` is `process.pid` (`ui-server.ts:379`).

**(2) `event`** — `UiEventSchema`, `protocol.ts:321-326`.
- Required: `type: z.literal('event')`; `seq: z.number().int().nonnegative()`; `eventId: z.string().min(1)`; `state: z.string().min(1)`.
- Produced by `UiServer.broadcast` (`ui-server.ts:160-170`). Retained in `this.resume` up to `RESUME_BUFFER_CAP` (`:163-164`).
- **Note:** `broadcast` is *never called* anywhere in production. Verified: ripgrep for `\.broadcast\(` across `src/` matches only the definition at `ui-server.ts:160`. `daemon.ts` uses `ui.notice` / `ui.voice` / `ui.context` / `ui.publishInventory` / `ui.publishAgents` only. The `event` frame — and with it the whole `this.resume` Last-Seq replay buffer (`ui-server.ts:390-393`) — is **contract-present but never emitted in production**.

**(3) `inventory`** — `InventoryFrameSchema`, `protocol.ts:403-407`, built by `buildInventoryFrame` (`:411-416`).
- Required: `type: z.literal('inventory')`; `seq: z.number().int().nonnegative()`; `sessions: z.array(InventorySessionSchema)` where each element requires `sessionId: z.string().min(1)` and `state: z.string().min(1)` (`protocol.ts:398-401`). `sessions: []` is the documented unready shape (`protocol.ts:397`).
- Emitted at `daemon.ts:671-673` (on every inventory event) and `daemon.ts:686` (after a `listSessions` sweep).

**(4) `agents`** — `AgentFrameSchema`, `protocol.ts:424-428`, built by `buildAgentFrame` (`:432-434`).
- Required: `type: z.literal('agents')`; `seq: z.number().int().nonnegative()`; `agents: z.array(AgentEntrySchema)` where each element requires `id: z.string().min(1)` and `name: z.string().min(1)` (`protocol.ts:419-422`).
- Emitted exactly once, at `daemon.ts:681-682`. `listAgents` is called with `.catch(() => [])` (`daemon.ts:681`), so a serve failure yields `agents: []` rather than a crash.

**(5) `notice`** — `NoticeFrameSchema`, `protocol.ts:438-446`.
- Required: `type: z.literal('notice')`; `seq: z.number().int().nonnegative()`; `code: z.string().min(1)`; `detail: z.string().min(1)`; `level: z.enum(['info','warn','error'])`.
- Constructor `ui-server.ts:210-212`. **All 11 production `code` values, exhaustively:**

| `code` | level | Emitted at |
|---|---|---|
| `assistant-said` | info | `daemon.ts:213` (the model-written line, also the displayed text) |
| `persona-changed` | info | `daemon.ts:259` |
| `stt-failed` | error | `daemon.ts:422` |
| `slash-invalid` | warn | `daemon.ts:439` and `daemon.ts:471` |
| `slash-help` | info | `daemon.ts:445` |
| `slash-no-session` | warn | `daemon.ts:451` |
| `brain-failed` | error | `daemon.ts:576` |
| `stt-timeout` | warn | `daemon.ts:592` |
| `tts-failed` | error | `daemon.ts:627` |
| `voice-disabled-no-keys` | warn | `daemon.ts:654` |

(10 distinct codes; `slash-invalid` has two call sites. Verified by ripgrep for `ui\.notice\(` across `src/`.)

**(6) `voice`** — `VoiceFrameSchema`, `protocol.ts:453-459`; phase enum `VoicePhaseSchema` at `protocol.ts:450` = `['idle','listening','thinking','speaking']`.
- Required: `type: z.literal('voice')`; `seq: z.number().int().nonnegative()`; `phase: VoicePhaseSchema`.
- Optional: `transcript: z.string().optional()`.
- Constructor `ui-server.ts:214-218`; the daemon wrapper is `setVoicePhase` (`daemon.ts:357-361`) which **dedupes** — `if (phase === voicePhase && transcript === undefined) return;` (`:358`) — so a steady mic costs zero frames.

**(7) `context`** — `ContextFrameSchema`, `protocol.ts:464-475`.
- Required, all six: `type: z.literal('context')`; `seq`; `sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,120}$/)`; `used: z.number().int().nonnegative()`; `limit: z.number().int().positive().nullable()`; `percent: z.number().min(0).max(100).nullable()`; `messageCount: z.number().int().nonnegative()`.
- Constructor `ui-server.ts:227-245`. `limit`/`percent` are nullable **by design** — a gauge that invents its own denominator is explicitly rejected (`ui-server.ts:220-226`).

**(8) `ack`** — `AckFrameSchema`, `protocol.ts:388-393`.
- Required: `type: z.literal(ACK_KIND)` = `'ack'`; `id: z.string().min(1)`; `ok: z.boolean()`. Optional: `detail: z.string()`.
- Built in `dispatchCommand` at `ui-server.ts:478-484`. `id` echoes the command's `id`. **No `seq`.**
- Handler errors are caught at `ui-server.ts:475-477` and become `ok: false, detail: err.message` — never an exception escaping to the socket.

**(9) `error`** — **has no zod schema.** `ERROR_KIND` is a bare string (`protocol.ts:30`). Emitted as an ad-hoc object in three places, always `{type:'error', detail:<string>}` with **no `id` and no `ok`**:
- `ui-server.ts:444` — `detail: 'audio frame too large'`
- `ui-server.ts:458` — `detail: 'invalid JSON'`
- `ui-server.ts:463` — `detail: 'unknown command'` (emitted for any `UiCommandSchema.safeParse` failure, including unknown keys — the schema is `.strict()`)

**FINDING 4.1 (contract asymmetry).** The `error` frame is the only server→client text type with no zod schema and no `id` correlation field, so a client that sent a command and got a parse rejection cannot match the error to its request. The renderer compensates with a generic `onErrorFrame` handler (`ws.ts:132` → `setNotice({code:'transport', …})`) which surfaces no request context. Because `error` carries no `seq` and is not covered by the `Last-Seq` replay buffer, an error emitted during a reconnect window is lost silently. Low severity (all three `error` sites are recoverable by re-issuing), but it is a real gap in a "frozen frame" contract.

### 4.3 Client → server

**TEXT — `UiCommandSchema`, `protocol.ts:343-385`. `.strict()` at `:385`.**
- **There is no `type` discriminator.** The envelope is identified by `id` + `kind`. Verified against the renderer: `apps/desktop/src/bridge/ws.ts:276` sends `JSON.stringify` of a `CommandMsg` whose fields are `id`, `kind` and optional payload (`ws.ts:100-104` shows the tail of the interface); `ws.test.ts:281` asserts `{ kind: 'switchSession', sessionId: 'ses_b' }`. Adding a `type` field would be **rejected** by `.strict()` and answered with `error: 'unknown command'`.
- Required: `id: z.string().min(1).max(128)` refined against `CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/` (`protocol.ts:339, 345`); `kind: z.enum([...])`.
- **`kind` — all 14 values, `protocol.ts:346-362`:** `abort`, `mute`, `deafen`, `arm`, `setPersona`, `switchSession`, `setSessionAgent`, `setSessionModel`, `toggleSessionSkill`, `execSessionShell`, `saveApiKeys`, `confirm`, `sessionContext`, `createSession`.
- Optional payload (all `protocol.ts:363-383`):

| Field | Constraint | Line |
|---|---|---|
| `persona` | `z.enum(['kareem','nour'])` | 363 |
| `minutes` | `z.number().int().positive().max(1440)` | 364 |
| `sessionId` | `z.string().regex(/^ses_[A-Za-z0-9_-]{1,120}$/)` | 365-368 |
| `agent` | `.min(1).max(64).regex(IDENT_RE)` | 369 |
| `model` | `.min(1).max(128).regex(IDENT_RE)` | 370 |
| `skill` | `.min(1).max(128).regex(IDENT_RE)` | 371 |
| `skillAction` | `z.enum(['attach','detach'])` | 372 |
| `command` | `.min(1).max(512)` | 373 |
| `groqKey` | `.min(1).max(512)` + no control chars | 376 |
| `fishKey` | `.min(1).max(512)` + no control chars | 377 |
| `openrouterKey` | `.min(1).max(512)` + no control chars | 378 |
| `confirmId` | `.min(1).max(128)` + no control chars | 379 |
| `approve` | `z.boolean()` | 380 |
| `title` | `.min(1).max(200)` | 382 |
| `contextLimit` | `z.number().int().positive().max(10_000_000)` | 383 |

`IDENT_RE = /^[A-Za-z0-9._:/-]+$/` (`protocol.ts:341`) is the shared charset for `agent`/`model`/`skill`. `sessionId` uses the same `ses_` regex as `ContextFrameSchema` (`protocol.ts:467`).

**BINARY uplink** — raw Int16 mono 16 kHz PCM, **no header, no seq, no type byte** (`ui-server.ts:442-452` passes `Buffer.from(frame.payload)` straight to `onAudio`). Capped at `MAX_AUDIO_BYTES`.

**BINARY downlink** — `[0x01][seq:u16be][mp3…]` (`audio.ts:9-16` encode, `:23-28` decode, `:31-39` split). `splitAudio` chunks at `MAX_AUDIO_CHUNK` = 32 768 and wraps `seq` modulo 65 536 (`audio.ts:35`); `ui-server.ts:254-262` advances `this.audioSeq = (seq + 1) % 65_536`. So the audio sequence space is 16-bit and wraps, independent of the 53-bit `this.seq` text space.

### 4.4 Bearer transport — the subprotocol path

**Server side, `ui-server.ts:287-304`:**
```ts
private bearerOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {          // :289
    const presented = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.token);
    if (presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected)) return true;  // :292
  }
  const proto = req.headers['sec-websocket-protocol'];                          // :297
  const offered = typeof proto === 'string' ? proto.split(',').map((s) => s.trim()) : [];
  const expected = Buffer.from(this.token);
  return offered.some((entry) => {                                              // :300-303
    const candidate = Buffer.from(entry);
    return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
  });
}
```
Both paths use `crypto.timingSafeEqual` (imported at `ui-server.ts:1`) with an explicit length pre-check. The subprotocol fallback exists because "Browser WebSocket clients cannot set the upgrade headers" (`ui-server.ts:294-296`).

**Client side, `apps/desktop/src/bridge/ws.ts:276`:**
```ts
const socket = create(url, [UI_SUBPROTOCOL, this.opts.token]);
```
The header list is literally `['voice-ui.v1', '<token>']`. Pinned by `ws.test.ts:89`: `expect(created[0]!.protocols).toEqual([UI_SUBPROTOCOL, 'tok'])`.

**Upgrade admission, `ui-server.ts:320-340`** — four independent gates, in order:
1. `pathname !== UI_WS_PATH` → **400** + destroy (`:331-335`).
2. `typeof key !== 'string'` (missing `Sec-WebSocket-Key`) → **400**.
3. `version !== '13'` → **400**.
4. `!wants.includes(UI_SUBPROTOCOL)` → **400**. The *echoed* protocol is always the single constant `voice-ui.v1` (`:347`), never the token.
5. `!this.bearerOk(req)` → **401 Unauthorized** + destroy (`:336-340`). Fail-closed, never upgraded.

Then SHA-1 accept (`:84-88`, `wsAccept`), 101 with the fixed header set (`:341-352`), a `Conn` with a fresh `FrameReassembler` (`:353`).

**Fail-closed construction:** `ui-server.ts:113-121` — `if (options.token.length === 0) throw new Error(\`refusing to start: ${IPC_TOKEN_ENV} is empty (fail-closed)\`)`. Reinforced at `daemon.ts:76-78`: `if (options.ipcToken.length === 0) throw new OrchestratorError('CONFIG_INVALID', false, 'IPC token is required (fail-closed)')`.

**Resume:** `lastSeqOf` (`ui-server.ts:306-318`) reads the `last-seq` header first, then falls back to `?lastSeq=N` because browsers cannot set upgrade headers either. Replay at `ui-server.ts:389-401` requires `lastSeq < this.seq`, replays `this.resume` entries with `seq > lastSeq`, then at most one `lastInventory` and one `lastAgents` snapshot. **Note:** `notice`, `voice` and `context` frames are **not** replayed — only `event` frames live in `this.resume`, and `event` frames are never emitted in production (Finding 4.2). So the resume path replays nothing at all in a real run; the HUD relies entirely on the level-triggered `hello` + `inventory` + `agents`.

**Liveness:** `pingTimer` every 5 000 ms (`:154`, `unref()`ed at `:155`); `pingAll` at `:504-522` increments `missedPongs` and destroys at `> 3` (`:511`), i.e. after 4 missed pings ≈ 20 s. **Eviction:** `handleUpgrade` adds the conn then evicts the **oldest** while `size > 8` (`:358-371`) — "the oldest, which is the least likely to be the live shell" (`:356-357`).

**FINDING 4.2 (dead frame type).** `UiServer.broadcast` (`ui-server.ts:160-170`) is the *only* producer of `event` frames and of the `this.resume` buffer it feeds. Ripgrep for `\.broadcast\(` across `src/` finds no production caller — the sole emitter is `ui.notice`/`ui.voice`/`ui.context`/`ui.publishInventory`/`ui.publishAgents`. Consequence: the Last-Seq resume machinery that `AGENTS.md` §Protocol and `docs/09-DECISIONS.md:206` describe as an ADR-010 contract feature is inert in production. The 8 test files in `src/ipc/` do exercise it (`ui-server.test.ts` covers resume and the connection cap), which is exactly the "green suite + unreachable feature" pattern the repo's own `AGENTS.md` warns about.

---

## 5. `src/cli.ts` — every command, its behaviour and exit codes

Dispatch table — `cli.ts:233-246`:
```ts
if (command === 'doctor')            { process.exit(await doctor()); }
else if (command === 'vault' && process.argv[3] === 'bootstrap') { process.exit(await vaultBootstrap()); }
else if (command === 'live')         { process.exit(await liveLoop()); }
else if (command === 'serve')        { process.exit(await serveDaemon()); }
else if (command === 'knowledge')    { process.exit(knowledgeReport()); }
else { console.log('usage: opencode-voice doctor | vault bootstrap | live | serve | knowledge'); process.exit(2); }
```

| # | Command | Arg | Function | Exit codes | Provenance |
|---|---|---|---|---|---|
| 1 | `doctor` | — | `cli.ts:21-39` | **0** iff `alive && verdict.ok`; else **1** | `cli.ts:38` |
| 2 | `vault bootstrap` | `argv[3] === 'bootstrap'` | `cli.ts:60-74` | **0** on write; **1** if the 3 env pools are all empty | `cli.ts:66, 73` |
| 3 | `live` | — | `cli.ts:76-140` | **0** on full round-trip; **1** on any throw | `cli.ts:135, 138` |
| 4 | `serve` | — | `cli.ts:143-176` | **0** on clean SIGINT/SIGTERM shutdown; **1** on missing password, bind failure, or any `startDaemon` throw | `cli.ts:151, 171, 174` |
| 5 | `knowledge` | optional `argv[3]` query | `cli.ts:205-231` | **0** normally and after a query; **1** on parity violation | `cli.ts:210, 230` |
| 6 | *anything else / none* | — | inline | **2** (usage) | `cli.ts:245` |

**`doctor` (`cli.ts:21-39`).** Prints 4 env-presence lines for `OPENCODE_SERVER_PASSWORD`, `GROQ_API_KEYS`, `FISH_AUDIO_KEYS`, `OPENROUTER_API_KEYS` — **presence only, values never printed** (`cli.ts:26` prints `(set, value hidden)`). Then `vaultKeyStatus(readKeyPools(new FileVault('vault/keyring.dat')))` (`cli.ts:32`), because per the L16 note at `cli.ts:28-31` *"env presence is NOT key availability"*. Then a live `probeHealth(cfg.serve.port, password)` (`cli.ts:35`) and a config echo (`cli.ts:37`). Hard-coded relative vault path `const VAULT_PATH = 'vault/keyring.dat'` (`cli.ts:19`) — **relative to cwd**, unlike `daemon.ts:716-722` which honours `VOXAURA_VAULT_PATH` / `VOXAURA_VAULT_DIR`. Measured just now:
```
miss OPENCODE_SERVER_PASSWORD (unset)
miss GROQ_API_KEYS (unset)
miss FISH_AUDIO_KEYS (unset)
miss OPENROUTER_API_KEYS (unset)
ok   vault: 3 keys across 3 pools (counts only, zero material)
miss serve 127.0.0.1:4096 (unreachable)
info voice=male-default briefings=bluf mic=armed
EXIT=1
```

**`vault bootstrap` (`cli.ts:60-74`).** `loadDotEnvLocal()` first (`cli.ts:61`, impl `:41-58` — reads `.env.local`, never overwrites an already-set var, swallows absence). Then `vault.bootstrapFromEnv()`; on `null` prints the `miss` line and returns 1. On success prints per-pool **counts only** (`cli.ts:68-71`) and the follow-up instruction at `:72`.

**`live` (`cli.ts:76-140`).** Four measured stages inside a `Keyring` `try/finally` (`:82`/`:129-131`):
1. Fish TTS of `'أمورك تمام. هذا اختبار الصوت!'` (`:92`) → `tts_ms`, `tts_first_chunk_ms`, `tts_cache_hit`, `tts_sentences`.
2. Groq Whisper STT over 1 s of **generated silence** — `new Uint8Array(16_000 * 2)` (`:99`) — as a *latency* probe (`:98`), wrapped in `withKey(ring,'groq',…)` so a 401/403 advances the pool (`:101-105`).
3. OpenRouter brain round-trip (`:113-118`) → `brain_ms`, `brain_golden_2s`, `brain_intent`, `destructive_gate_armed`.
4. Fish TTS of the reply truncated to 200 chars (`:127`).
Budgets printed at `:133`. This is the only command in the CLI that touches real provider APIs, and per `AGENTS.md` it is **not** in any gate.

**`serve` (`cli.ts:143-176`).** `loadDotEnvLocal()`; **dynamic** `await import('./daemon.js')` at `:145` (so the whole daemon module graph — including the `onnxruntime`-adjacent paths — is only loaded for this command). Then:
- `token = ipcTokenFromEnv() || ensureIpcToken()` (`:148`).
- `ipcPort = parseInt(process.env['VOICE_IPC_PORT'] ?? '4097', 10)` (`:149`).
- **Hard precondition** (`:150-153`): `OPENCODE_SERVER_PASSWORD` empty → print `miss serve: OPENCODE_SERVER_PASSWORD is required`, return **1**.
- `startDaemon({ servePort: cfg.serve.port, servePassword, ipcToken: token, ipcPort, vaultPath: vaultPathFromEnv(), directory: process.cwd() })` (`:155-162`).
- On success prints `ok   daemon: ws=127.0.0.1:<port> serve=<port> (token redacted)` (`:163`), then blocks on a promise resolved by `SIGINT`/`SIGTERM` (`:165-169`), then `await daemon.stop()` and returns **0** (`:170-171`).
- On throw: `console.log(\`miss daemon: ${err.message}\`); return 1;` (`:172-175`).

**FINDING 5.1 (`directory: process.cwd()` in a packaged build).** `cli.ts:161` passes `directory: process.cwd()`. `main.rs` sets **no** cwd and `std::process::Command` inherits the parent's (Rust std default). For a double-clicked Tauri app that cwd is not the project. This value flows to `daemon.ts:221` (`projectDirectory`), `daemon.ts:459` (`createSession` for `/new`), `daemon.ts:681` (`listAgents(directory)` — which the code says is *required* for the 2.0.x contract, `opencode-bridge.ts:80-84`), and `daemon.ts:488` (the `@mention` containment root). In a packaged launch, `createSession` and `@file` resolution are therefore scoped to an arbitrary directory. `main.rs:816` sets `VOXAURA_VAULT_DIR` for keys but nothing equivalent for the project root.

**FINDING 5.2 (`doctor` and `daemon` resolve the vault by different rules).** `cli.ts:19` hard-codes `'vault/keyring.dat'`; `daemon.ts:716-722` (`vaultPathFromEnv`) honours `VOXAURA_VAULT_PATH`, then `VOXAURA_VAULT_DIR`, then `<cwd>/vault/keyring.dat`. So `doctor` run from a directory other than the repo will report a **different vault** than the running daemon — and, per `cli-doctor-keys.test.ts`, may report `miss` on a healthy install. Neither is wrong in isolation; the pair is inconsistent and there is no test that pins them together.

### 5.3 The new `knowledge` command — full specification

`cli.ts:196-231`. It is a **synchronous** function (`knowledgeReport(): number`, `:205`) even though `doctor`/`vault`/`live`/`serve` are `async`; `cli.ts:242` calls it without `await`.

Behaviour, in order:
1. `assertParity()` (`:207`). On throw: `console.error('knowledge: PARITY VIOLATION — …')` and **return 1** (`:209-210`). This is the only command that gates a release.
2. `verifyKnowledge()` → `buildIndex()` (`:212-213`).
3. Prints 7 metrics (`:214-221`).
4. If `process.argv[3]` is present and non-empty, runs `index.search(query, 3)` and prints up to **3** hits, formatted `score.toFixed(3)  id  (source)` (`:223-229`).
5. Returns **0** (`:230`).

**Measured on this machine** (`node dist/cli.js knowledge`):
```
knowledge: shared ground truth (Tier 1)
  shared chunks : 43
  digest        : c12f74d0a29f1c46
  index size    : 43
  nour examples : 8
  kareem examples: 8
  persona leaks : 0
  style asymmetries: 0
EXIT=0
```
and with a query:
```
  query "المنفذ 4096":
    6.801  arch-ports  (AGENTS.md#runtime-topology; src/ipc/ui-server.ts)
    6.298  fail-ports-busy  (AGENTS.md#gotchas; apps/desktop/e2e)
    3.023  lex-runtime  (src/cli.ts; src/daemon.ts; src/voice/tts.ts)
EXIT=0
```
The digest is 16 hex chars, i.e. a truncated 64-bit value (`src/knowledge/build.ts` `sharedDigest`). Note the top two hits are the two chunks this audit falsifies in §3 (Finding 3.2) and in the dead-code section.

**FINDING 5.3 (the knowledge layer is reachable but not in the product path).** `src/knowledge/index.ts:4-7` is explicit and honest:
> *"The knowledge layer is NOT wired into the live narration path yet — that is a separate, reviewed step (`docs/personas/WIRING.md`), and claiming otherwise would be the exact 'documented as shipped while unreachable' defect this project keeps hunting."*

Verified: `ripgrep` for `knowledge/index.js` across `src/` returns exactly one importer — `src/cli.ts:17` — and nothing in `daemon.ts` or `narrator.ts` imports it. The `knowledge` command therefore makes the layer reachable **from a composition root** (`cli.ts`) and nothing more. This is the correct state and it is correctly documented; recorded so the audit does not mistake it for a defect.

**Memory-vault auto-bootstrap, `cli.ts:179-195`.** `OPERATOR_COMMANDS = new Set(['doctor','vault','live'])` (`:185`) — **`serve` and `knowledge` are deliberately excluded**, and the reason is given at `:181-184`: a long-running daemon launched from an arbitrary cwd would litter the filesystem with scaffolded notes. `ensureVault('voxaura', resolveVaultRoot())` (`:191`) is wrapped in a bare `try/catch` that swallows everything (`:192-194`).

**FINDING 5.4 (partial operator-command list).** `knowledge` performs a read-only, side-effect-free report yet is excluded from `OPERATOR_COMMANDS`, so `node dist/cli.js knowledge` does not scaffold the memory vault while `node dist/cli.js doctor` does. That is harmless today but the set's name implies the criterion is "operator command", and `knowledge` is one. Cosmetic.

---

## 6. `src/daemon.ts` — `think()`, the speech gate, and the dynamic VAD import

### 6.1 The `think()` pipeline, step by step

`think` is the `AudioPipelineDeps.think` implementation, `daemon.ts:427-579`. It runs **only** for a window that survived the speech gate, the `no_speech_prob` filter and the repeat-dedupe filter (`audio-pipeline.ts:118-146`).

**Step 0 — phase** — `daemon.ts:428` `setVoicePhase('thinking', transcript)`. Moved here from `transcribe` at `:394-399` because *"the phase moved to 'thinking' on EVERY incoming window, so the HUD flickered listening→thinking 10×/s"* (D13).

**Step 1 — slash interception, before any model.** `daemon.ts:435` `parseSlashCommand(transcript)`. The comment at `:430-434` states the rule: *"A spoken `/command` is handled natively and NEVER reaches a model. Forwarding `/rm -rf /` as prose to a planning agent is how a typo becomes an incident. The HUD is voice-only, so a slash arrives here as a transcript rather than as a WS command — which is exactly why this seam is the daemon and not the command router."*

Sub-branches, all returning `{ reply }` without contacting a model:
- `slashCommandError(transcript) !== null` → `notice('slash-invalid', …, 'warn')` + telemetry `CONFIG_INVALID` + return (`:437-442`).
- `name === 'help'` → `describeSlashCommands().join(' · ')` as both the notice detail and the reply (`:443-447`).
- `name === 'compact'` → no active session ⇒ `slash-no-session` notice + a canned reply (`:448-453`); else `client.compactSession(activeSession)` + reply `'ضغطنا الجلسة، نافذة السياق خفّت'` (`:454-456`).
- `name === 'new'` → `client.createSession(options.directory ?? process.cwd())`, sets `activeSession`, `await publishSessions()` (`:458-461`), and — with an explicit honesty comment at `:463-465` — acknowledges but does **not** persist a trailing title because *"ServeClient exposes no rename endpoint"* (`:466-467`).
- Unreachable fallback: `أمر غير معروف` (`:469-472`).

Only **3** slash names exist — `SLASH_COMMANDS` at `slash.ts:20-24`: `compact` (`takesArgs: false`), `new` (`takesArgs: true`), `help` (`takesArgs: false`). Validation at `slash.ts:61-75`: unknown name → Arabic message that truncates the name to 32 chars and never echoes it in full (`:66-67`); args on a no-args command → rejected (`:69-71`); `args.length > SLASH_MAX_ARGS` (200, `slash.ts:37`) → rejected; `CONTROL_RE = /[\u0000-\u001F\u007F]/` in args → rejected (`slash.ts:29, 73`).

**Step 2 — `@mention` resolution, also before any model.** `daemon.ts:484` only runs when `transcript.includes('@')`. `envCache()` (`:96-104`) is a per-daemon-lifetime memo of `{agents, skills}` from `bridge.getEnvironmentStatus()`, with `.catch(() => ({agents:[], skills:[]}))` (`:101`) so a catalog failure degrades to empty lists, not a crash (comment `:90-94`: *"a turn that waited on two HTTP round-trips before it could transcribe would blow the speech budget"*). `resolveMentions(transcript, { root, agents, skills })` (`:487-491`), then:
- `spoken = mentions.clean` (`:492`) — every mention token is stripped;
- `resolvedMentions = mentionSummary(mentions)` (`:493`);
- if anything resolved, a machine-context suffix `[mentions: files=…,agents=…,skills=…]` is appended (`:494-504`).

`mentions.ts` rules, all physically present: `MENTION_RE = /@([\w.\-[\]/\\]+)/gu` (`:49`); a preceding `[\w@]` means an email, so the token is left alone (`:77-78`); `MENTION_MAX_TOKENS = 60` (`:25, :79`); `MENTION_MAX_FILES = 20` (`:23, :117-120`); agent/skill beats a same-named file (`:89-96`); absolute paths and any token containing `..` are rejected **before any syscall** (`:100-103`); containment proven on `realpathSync(abs)` after `resolvePath` (`:106-116`); the reported path is the *typed* form normalised to POSIX, not the realpath, because a same-tree symlink is legitimate (`:121-126`, `toPosix` at `:137-139`). `mentions.ts:9-17` states the security model and the code implements every clause.

**Step 3 — prompt optimization, conditionally.** `daemon.ts:527` `if (isActionableInstruction(spoken))`, then `optimizePrompt(spoken, …, INTAKE_MODEL, {})` (`:530-541`) with `reasoning: {effort:'none'}` and `timeoutMs: OPTIMIZER_TIMEOUT_MS` (8 000, `daemon.ts:114`, justified at `:111-113`: *"8 s sits under the 10 s intake budget and well over the 901 ms p50"*). On any throw, `task = spoken` — the user's own words (`:546`) — plus a `BRAIN_TIMEOUT` DEGRADED telemetry row (`:547-554`). `isActionableInstruction` (`prompt-optimizer.ts:51-64`) is a pure function: it strips trailing `[.،,!؟?…\s]`, lowercases, and rejects membership in an 18-entry `NON_ACTIONABLE` set (`prompt-optimizer.ts:30-49`): `تمام, طيب, اوك, اوكي, اكيد, نعم, لا, مرحبا, اهلا, السلام عليكم, شكرا, شكرا جزيلا, حسنا, جيد, ماشي, تماما, يسلمو, يلا`.

> **FINDING 6.1 (the "never invent work" gate does not gate dispatch — comment contradicts code).**
> `prompt-optimizer.ts:8-10` states: *"The rule that keeps it honest: it IMPROVES an instruction, it never INVENTS work. `تمام` must not become a task, or the assistant starts acting on acknowledgements. `isActionableInstruction` is the gate."*
> `daemon.ts:522-525` states: *"The gate is `isActionableInstruction`, and it is NOT optional: an acknowledgement ('تمام') must never become a task, or the assistant starts acting on the user's politeness."*
> The actual code, `daemon.ts:526-558`:
> ```ts
> let task = spoken;                                    // :526
> if (isActionableInstruction(spoken)) { task = await optimizePrompt(…); }   // :527-556
> …
> const mission = await coordinator.run(task);           // :558  ← UNCONDITIONAL
> ```
> `coordinator.run` is called on **every** surviving utterance regardless of the gate. What `isActionableInstruction` actually suppresses is one provider call (the optimizer), not the turn. The prevention of invented work is delegated entirely to the model, via the intake system prompt at `coordinator.ts:84-85`: *"If the user said something that needs no action, acknowledge it briefly and set `task_en` to a no-op marker rather than inventing work."*
> No test closes the gap: `prompt-optimizer-wiring.test.ts:18-54` asserts only that `isActionableInstruction` returns `false` for acknowledgements — never that a non-actionable transcript is not dispatched. The describe-block title *"acknowledgements are never turned into tasks"* is aspirational; the delivered property is narrower. Severity: behavioural, not a crash — the user hears an acknowledgement and the assistant acknowledges back, costing two provider calls (intake + plan) instead of zero.

**Step 4 — the coordinator chain.** `daemon.ts:558` `const mission = await coordinator.run(task)`. On success, telemetry `BRAIN`/`OK` (`:559-564`) and `return mission.receipt === null ? { reply } : { reply, receipt }` (`:565-566`). On throw, telemetry `BRAIN`/`ERROR`/`BRAIN_FAILED` (`:568-575`), `notice('brain-failed', …, 'error')` (`:576`), then **re-throw** (`:577`) — which `audio-pipeline.ts:176-185` will propagate unless it is a `SttTimeoutError`.

`Coordinator.run` (`coordinator.ts:191-307`) is: intake (Dots3, `INTAKE_MODEL = 'dots-studio/dots-3-note-preview:free'`, `coordinator.ts:22`) with **one** failover to `COORDINATOR_MODEL = 'thinkingmachines/inkling:free'` (`coordinator.ts:23`) → fire-and-forget `speak` (`:243-250`, `.catch` mandatory per the comment at `:240-242`) → plan under `PLAN_RESPONSE_FORMAT` (`:99-127`, `strict: true`, `json_schema`, `additionalProperties: false`) with **one** bounded retry carrying a `CRITICAL:` prefix (`:269-275`) → FR-12 flagging via `requiresConfirmation` (`:285`) → `dispatch(buildHandoff(...))` (`:305`). The handoff envelope is `[HANDOFF from=Nemotron to=Inkling task=…]` (`coordinator.ts:171`) — `Nemotron` survives only as the mission-handoff role name, not a model slug (`coordinator.ts:20-21`).

**FINDING 6.2 (the `dispatch` option is declared but never injected).** `CoordinatorDeps.dispatch` is a **required** member (`coordinator.ts:150`) and the daemon does supply it (`daemon.ts:385-388`) — but it is *also* a `readonly speak?` and the daemon deliberately omits `speak` (`:380-384`, D4: the old TTS path *"wrote an MP3 to %TEMP% that nothing ever played — so every utterance was synthesised TWICE"*). With `speak` absent, `coordinator.ts:243` `void this.deps.speak?.(intake.reply_ar)?.catch(...)` is a no-op. Consequently `coordinator.run()` is always invoked with `task = the transcript`, and the *spoken* reply comes only from `AudioPipeline.onUtterance` (`daemon.ts:594-632`). Consistent, but the two paths mean the "fast verbal response" that `coordinator.ts:234-243` documents as *"kicked off but NOT awaited"* **is never kicked off at all** in production. The doc comment describes a behaviour the wiring removed.

**FINDING 6.3 (mention-resolution fallback re-admits raw `@` text to the model).** `daemon.ts:474-477` states: *"`@file` / `@agent` / `@skill` are resolved BEFORE the text reaches any model… A rejected token must never survive as prose — that is the whole point of the resolver, and re-introducing the raw text here would hand a traversal attempt straight to the planning agent."* But the catch block at `daemon.ts:505-516` does exactly that:
```ts
} catch (err) {
  // … Fall through with the raw transcript: degradation, not silence.
  spoken = transcript;                    // :508
  record({ … errorCode: 'SESSION_NOT_FOUND', … });   // :509-515
}
```
On a catalog/resolve throw, the un-resolved transcript — `@`-tokens and all — becomes `spoken` and is passed to `optimizePrompt` and then `coordinator.run`. The comment and the code disagree. Severity: low in practice (the tokens are the user's own utterance, and the failure mode requires `resolveMentions` itself to throw rather than to return `rejected`), but the guarantee the comment asserts is not what the code delivers, and the recorded `errorCode: 'SESSION_NOT_FOUND'` is a poor fit for a mention-resolution failure.

### 6.2 The `speechGate` generation counter — two *different* generation counters

This is a genuine trap: the codebase has **two independent generation counters**, and the brief's phrase "the speechGate generation counter" is ambiguous between them. Both are in scope, so both are documented.

**(A) `SpeechGate` — barge-in for TTS. `src/voice/tts.ts:184-203`:**
```rust
/**
 * Barge-in generation gate (directive 4): the daemon captures a generation
 * before speaking a reply sentence-by-sentence; an `abort` command bumps the
 * generation so stale sentences never synthesize or broadcast afterwards.
 */
export class SpeechGate {
  private generation = 0;
  capture(): number { return this.generation; }        // :192-194
  isCurrent(gen: number): boolean { return gen === this.generation; }  // :196-198
  abort(): void { this.generation += 1; }              // :200-202
}
```
Lifecycle in the daemon:
- Constructed once, before key setup — `daemon.ts:119` `const speechGate = new SpeechGate();` with the comment at `:117-118`: *"Barge-in generation gate: trips on `abort` so stale reply sentences never synthesize or broadcast afterwards. Plain state — safe before key setup."*
- Tripped by the `abort` command — `daemon.ts:261` `onAbort: () => speechGate.abort()`, wired into the router at `command-router.ts:248-271` and dispatched at `command-router.ts:201-203` (`case 'abort': deps.onAbort?.(); return { ok: true }`).
- Captured once per utterance — `daemon.ts:608` `const gen = speechGate.capture();`
- Checked **twice per sentence** — `daemon.ts:613` (before `fish.synthesize`) and `daemon.ts:615` (after it resolves, before `ui.broadcastAudio`). Both are `if (!speechGate.isCurrent(gen)) return;` inside the `for (const sentence of sentences)` loop (`:612-617`).
- Persona is snapshotted for the whole utterance — `daemon.ts:606-607` `const voiceId = VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default'];` with the comment *"a persona switch mid-reply would otherwise split one sentence across two voices."*
- `setVoicePhase('idle')` runs in the `finally` (`:628-630`), so a mid-sentence abort still leaves the HUD honest.

**What it does *not* cover:** a sentence already handed to Fish is charged but not broadcast (the second check at `:615` catches it), and any *in-flight* `think`/`transcribe` is untouched. That gap is what counter (B) exists to close.

**(B) `AudioPipeline.generation` — barge-in for the *turn*, not the sentence. `src/orchestrator/audio-pipeline.ts:61-74, 108-162`:**
```ts
/**
 * L6: bumped by every `reset()`. `pushChunk` captures it on entry and
 * re-checks after each await.
 * `reset()` used to clear the ingest buffer and the repeat memory and
 * nothing else, so a `pushChunk` already parked on `transcribe` or `think`
 * carried on and dispatched a turn belonging to the utterance the user just
 * interrupted. …
 */
private generation = 0;                                    // :73
reset(): void { this.ingest.reset(); this.recent = []; this.generation += 1; }   // :108-114
```
`pushChunk` captures at `:117` and re-checks at **five** points: `:119` (per window), `:123` (after `isSpeech`, *before* incrementing `gatedCount`, so an abandoned window does not pollute diagnostics — the comment at `:121-122` says so), `:130` (after `transcribeWindow`), `:149` (after `think`), `:159` (after `dispatch`).
`reset()` is invoked from exactly one production site: `daemon.ts:241-243`:
```ts
switchSession: (id) => {      activeSession = id;
  audio?.reset();
},
```
(the stray leading whitespace on that line is in the file as committed). So (B) is bumped on **session switch only** — **not** on `abort`. The `abort` command trips (A) but leaves (B) untouched. Consequence: an `abort` stops the *speech* of a reply already computed, but a `think` still parked on the intake/plan chain will finish, pass the `:149` check (B unchanged), and its reply is handed to `onUtterance` (`:160`) — where (A) then suppresses playback sentence-by-sentence, but `setVoicePhase('speaking', text)` at `daemon.ts:604` has **already fired**, so the HUD shows "speaking" for a reply that will never be spoken (until the `finally` at `:629` resets it, and only if `onUtterance` was reached at all).

**FINDING 6.4 (abort does not bump the turn-level counter).** Two counters, two triggers, and the mapping is not the one the comments imply. `onAbort` → (A) only. `switchSession` → (B) only. A barge-in (`abort`) therefore never abandons an in-flight `think`; it only suppresses the audio of an utterance that has *already* been fully planned and paid for — which is the more expensive half. The `L6` comment at `audio-pipeline.ts:64-71` describes precisely the stale-reply-after-abort defect and attributes the fix to `reset()`, but no abort path calls `reset()`. The E2E spec `apps/desktop/e2e/abort.spec.ts` (1 test) drives the renderer path, not this seam. Severity: behavioural — wasted quota plus a brief phantom "speaking" HUD state, not incorrect output.

### 6.3 Why the VAD import MUST be dynamic

**The import site — `daemon.ts:332-343`:**
```ts
let vadLoad: Promise<SileroVadLike | null> | null = null;
const loadVad = (): Promise<SileroVadLike | null> => {
  if (vadLoad === null) {
    const cfg = loadConfig();
    // The import itself can fail (missing native package in the sidecar), so
    // it lives inside the promise where `.catch` can actually see it.
    vadLoad = import('./runtime/vad.js')                                                    // :338
      .then((m) => m.SileroVad.load(cfg.vad.modelPath, { threshold: cfg.vad.threshold }) as Promise<SileroVadLike>)
      .catch(() => null);                                                                   // :340
  }
  return vadLoad;
};
```
Memoised in `vadLoad` (`:332`, `:334`) so the ONNX session is created at most once per daemon lifetime. `.catch(() => null)` is inside the promise, so a module-resolution failure is catchable — that is the entire point of the `import()` form, and the comment at `:336-337` says so.

**The consumer — `daemon.ts:345-355`:**
```ts
const vadGate = async (window: Uint8Array): Promise<boolean> => {
  const vad = await loadVad();
  if (vad === null) return isLoudWindow(window);          // :347  ← fail-closed fallback
  const frames = Math.floor(window.byteLength / 2 / VAD_WINDOW_SAMPLES);   // :349
  for (let f = 0; f < frames; f += 1) {
    const frame = bytesToFloat32(window, f * VAD_WINDOW_SAMPLES * 2, VAD_WINDOW_SAMPLES);
    if (await vad.isSpeech(frame)) return true;          // :352
  }
  return false;
};
```
Injected as `speechGate: vadGate` into `AudioPipeline` (`daemon.ts:392`), whose `isSpeech` (`:165-168`) prefers the injected detector over the energy gate and never stacks them.

**Why static would be fatal — the complete chain, every link verified:**

1. `src/runtime/vad.ts:2` — `import * as ort from 'onnxruntime-node';` — a **static, top-level** native import.
2. `package.json:35` — `"onnxruntime-node": "1.30.0"` in **dependencies** (a native addon with prebuilt binaries), not devDependencies.
3. `scripts/provision-sidecar.mjs:44-56` — the sidecar manifest contains **five** packages: `groq-sdk`, `eventsource`, `lru-cache`, `pino`, `zod`. **`onnxruntime-node` is deliberately absent.** `provision-sidecar.mjs:42-43` states the rule: *"only what the `serve` path imports at runtime (not the ML/voice-heavy optional paths)"*.
4. Measured on the built sidecar: `Test-Path apps\desktop\src-tauri\sidecar\node_modules\onnxruntime-node` → **`False`**; `Test-Path apps\desktop\src-tauri\sidecar\dist\runtime\vad.js` → **`True`**. So the compiled `vad.js` **is shipped** and its dependency **is not** — the worst possible combination for a static import.
5. Therefore a static `import … from './runtime/vad.js'` in `daemon.ts` makes the **entire daemon module graph** fail to resolve with `ERR_MODULE_NOT_FOUND` before a single line of `startDaemon` executes, so `ui.start()` at `daemon.ts:677` is never reached and 4097 never opens.
6. `daemon.ts:27-32` states exactly this: *"the daemon died with ERR_MODULE_NOT_FOUND and never bound 4097. Found by cold-launching the real installer, not by the gates. The dynamic import below degrades to the RMS energy gate instead, which is the fail-closed behaviour the design always intended."*
7. **The invariant is enforced by a test, not by convention.** `src/policy/sidecar-safety.test.ts:27-34` asserts `daemon.ts` contains no static import matching `/^\s*import\s[^\n]*from\s+['"][^'"]*runtime\/vad(\.js)?['"]/m` **and** does contain `import\(\s*['"][^'"]*runtime\/vad(\.js)?['"]\s*\)`. `:36-104` then walks the whole import graph from `src/daemon.ts` — resolving both `STATIC_IMPORT` (`:46`) and `DYNAMIC_IMPORT` (`:47`) regexes, tracking each file's reachability *class* (`:52-53`), and failing if any of `NATIVE = {onnxruntime-node, better-sqlite3, node-gyp-build}` (`:45`) is **statically** reachable. Its sanity assertions at `:101-103` prove the walk is real: `anyReach.size > 15`, `anyReach.has('src/runtime/vad.ts') === true`, `staticReach.has('src/runtime/vad.ts') === false`. `:145-148` additionally pins the fallback is not "transcribe everything": `expect(windowRmsDb(silent())).toBe(-100)`.

**Consequence for a packaged build:** `SileroVad.load` (`vad.ts:61-70`) throws `VadModelMissing` if `models/silero-vad.onnx` is absent (`vad.ts:62`). Even with `onnxruntime-node` present (it is in the repo's `node_modules`), the shipped `models/` directory travels with the repo, not the installer. Measured: `models\silero-vad.onnx` exists (2 243 022 bytes) in the repo, but `main.rs` bundles only `sidecar/` (via `tauri.conf.json` resources) — nothing in `main.rs` or `provision-sidecar.mjs` copies `models/`. So **an installed build always takes the `vad === null` RMS-energy path**, and the Silero gate is a dev-only capability. `daemon.ts:26-34` calls this "fail-closed, which is the design intent" (`vad.ts` is *optional*, not required) — correct — but no doc states that a shipped install never runs Silero.

**FINDING 6.5 (mirror-constant drift risk).** `daemon.ts:33-35` deliberately duplicates the VAD window size:
```ts
// VAD_WINDOW_SAMPLES is a plain constant (512), mirrored here to keep the frame
// geometry local and avoid loading the module just to read a number.
const VAD_WINDOW_SAMPLES = 512;
```
The real value is `vad.ts:9` `export const VAD_WINDOW_SAMPLES = 512;`. The mirroring is a deliberate trade (it is why the static import can be avoided) and is currently in sync — but nothing pins it. A change to `vad.ts` alone would silently mis-frame the tensor and `vad.prob` would throw `VADModelError` (`vad.ts:74-76`), which the `.catch(() => null)` at `daemon.ts:340` would swallow into a permanent silent RMS fallback with no telemetry. No test asserts the two constants agree.

---

## 7. THE COMMAND ROUTER (`src/orchestrator/command-router.ts`)

### 7.1 Two disjoint entry paths — this is the key structural fact

A spoken transcript and a renderer click take **completely different routes**. They share only `AudioPipeline`'s windowing.

```
SPOKEN  : PCM → AudioPipeline.pushChunk (audio-pipeline.ts:116) → gates (:120,:137,:141)
          → deps.think(transcript)                       (daemon.ts:427)
          → parseSlashCommand / resolveMentions / isActionableInstruction
          → coordinator.run(task)                        (daemon.ts:558)
          ✗ NEVER touches command-router.ts

RENDERER: WS text frame → UiServer.onData (ui-server.ts:404) → UiCommandSchema.safeParse (:461)
          → dispatchCommand (:466, :471) → this.onCommand (:474) = createCommandHandler(…)
          → command-router.ts
```
`daemon.ts:430-434` states the reason explicitly: *"The HUD is voice-only, so a slash arrives here as a transcript rather than as a WS command — which is exactly why this seam is the daemon and not the command router."* Verified: ripgrep for `createCommandHandler` across `src/` returns two hits — the definition (`command-router.ts:129`) and the daemon's wiring (`daemon.ts:18`, `daemon.ts:217`). No other production caller.

### 7.2 Routed command kinds — all 14, with their guards

`createCommandHandler` (`command-router.ts:129-277`) returns `async (cmd) => CommandOutcome`. Order of operations in the returned handler (`:236-276`):

1. **`confirm` is intercepted first** (`:238-247`) — before the `DESTRUCTIVE_KINDS` check, so confirming can never itself be parked.
2. `DESTRUCTIVE_KINDS.has(cmd.kind)` → park (`:248-271`).
3. Otherwise `execute(cmd)` (`:272`).
4. Any throw → `OrchestratorError` ⇒ `{ok:false, detail: err.code}`; anything else ⇒ `{ok:false, detail:'internal'}` (`:273-276`). **No exception ever escapes to the socket.**

`resolveSession` (`:136-140`): `cmd.sessionId ?? deps.activeSessionId()`, then must match `SESSION_ID_RE = /^ses_[A-Za-z0-9_-]{1,120}$/` (`:82`) — the same regex the zod schema and `ContextFrameSchema` use. Empty or non-matching ⇒ `null`.

The 14 `kind` values and their exact behaviour (`dispatch`, `:151-234`):

| `kind` | Guards | Side effect | Line |
|---|---|---|---|
| `switchSession` | `sessionId` required | `deps.switchSession(id)` | 153-157 |
| `setSessionAgent` | session + `agent` required | `client.setSessionAgent` | 158-164 |
| `setSessionModel` | session + `model` required | `client.setSessionModel(session, parseModelRef(model))` | 165-171 |
| `toggleSessionSkill` | session + `skill` required | `client.toggleSessionSkill(s, skill, skillAction ?? 'attach')` | 172-178 |
| `execSessionShell` | session + `command` required + `shellCommandError` | `client.execSessionShell` — **parked first** | 179-187 |
| `saveApiKeys` | `deps.saveKeys` present + all 3 keys | `saveKeys.saveKeys({groq,fish,openrouter})` | 188-195 |
| `setPersona` | `persona` required | `deps.setPersona?.(p)`; `detail: 'persona-set'` | 196-200 |
| `abort` | none | `deps.onAbort?.()` → `speechGate.abort()` | 201-203 |
| `sessionContext` | session + `client.contextUsage` present | `client.contextUsage(s, cmd.contextLimit)` then `deps.onContext`; Arabic `detail` | 206-219 |
| `createSession` | `client.createSession` present | `client.createSession(projectDirectory())` then `switchSession`; Arabic `detail` | 220-226 |
| `mute` / `deafen` / `arm` | **none** | `return { ok: true }` — **pure no-ops** | 227-230 |
| `confirm` | intercepted at `:238` | executes or cancels the parked command | 238-247 |

**FINDING 7.1 (three of fourteen commands are unconditional no-ops that still cost an OpenRouter narration call).** `command-router.ts:227-230`:
```ts
case 'mute':
case 'deafen':
case 'arm':
  return { ok: true };
```
`mute` is the renderer's barge-in control (`apps/desktop/src/audio/earcons.test.ts:43` builds one for `'arm' | 'abort'`), and the daemon has no `onMute` / `onDeafen` / `onArm` dependency at all — `CommandRouterDeps` (`command-router.ts:39-62`) declares `onAbort`, `onContext`, `onExecuted`, `setPersona`, `saveKeys`, `projectDirectory`, `switchSession`, `activeSessionId`, `client` and nothing else. So pressing Mute acks `ok:true`, the daemon does nothing, and then `onExecuted` (`:147`) fires → `daemon.ts:225-240` `narrateOutcome` → an **OpenRouter/Inkling call** (`daemon.ts:153-179`, `NARRATOR_TIMEOUT_MS` 12 000) to produce a spoken line about silencing a microphone that was never silenced. The HUD then shows `assistant-said` and speaks a confirmation of a no-op. This is the exact class of defect the module's own header bans (`command-router.ts:144-146`: *"The router itself never produces a sentence"*) — the router doesn't, but the narration pipeline does, and it narrates a fiction. Severity: real, user-visible, and it burns free-tier quota on every mute press.

### 7.3 Slash commands in the router — there are none

The router has **no** `kind` for a slash. `DESTRUCTIVE_KINDS` is `new Set(['execSessionShell'])` — a single member (`command-router.ts:65`). The three slash names are handled only in the spoken path (`daemon.ts:443`, `:448`, `:458`). A *separate*, different internal command set exists in `src/runtime/opencode-bridge.ts:76`:
```ts
const INTERNAL_COMMANDS = new Set(['compact', 'undo', 'clear', 'model', 'interrupt', 'revert']);
```
`OpenCodeBridge.runInternalCommand` (`opencode-bridge.ts:189-209`) allows **6** names — a superset of the daemon's 3, adding `undo`, `clear`, `model`, `interrupt`, `revert` — and the file header (`:19`) states the rule: *"NEVER FORWARD a slash blind. Only commands implemented here are run."*

**FINDING 7.2 (two divergent slash vocabularies, and the wider one is unreachable).** The daemon exposes `{compact, new, help}` (`slash.ts:20-24`) and handles them at `daemon.ts:443-472`. The bridge allows `{compact, undo, clear, model, interrupt, revert}` (`opencode-bridge.ts:76`) — but **`runInternalCommand` has no production caller**: ripgrep for `runInternalCommand` across `src/` matches only its definition (`opencode-bridge.ts:189`) and its test. The two sets overlap in exactly one name (`compact`), `new` and `help` exist only in the daemon, and `undo/clear/model/interrupt/revert` exist only in unreachable code. The narrow set is enforced, so there is **no live safety hole** — but the bridge's comment at `:185-188` (*"Run one of the assistant's internal slash commands. Only the implemented set is routable"*) implies an active capability that does not exist.

### 7.4 `@mention` resolution — where it runs and where it does not

Resolution happens **only** in the spoken path, `daemon.ts:484-517`, before any model call. The router's `CommandClient` interface (`command-router.ts:17-25`) has **no** mention parameter — `execSessionShell` takes `(sessionId, command: string)`, `setSessionAgent` takes `(sessionId, agent: string)`. So a renderer-issued command can never carry a mention, and none of the 14 routed kinds is mention-aware. The two paths therefore have genuinely different input-validation surfaces: spoken input goes through `MENTION_RE` + realpath containment + `..`/absolute rejection; renderer input goes through the zod `IDENT_RE` charset and the shell metacharacter deny-list. Neither validates the other's shape.

### 7.5 FR-12 — the park/confirm gate, exactly

`DESTRUCTIVE_KINDS = new Set(['execSessionShell'])` (`:65`); `CONFIRMATION_TTL_MS = 60_000` (`:66`); `MAX_PARKED = 8` (`:73`).

Park path (`:248-271`):
1. **Validate before parking** so a malformed destructive command fails fast rather than occupying a slot (`:249-255`): session resolution, `command` presence, and `shellCommandError(cmd.command)`.
2. `pending.set(cmd.id, { at: now(), cmd })` (`:261`) — keyed by the command's own `id`, so the client must send `confirmId` matching the id of the command it wants to release.
3. Sweep expired entries (`:262-264`).
4. Evict oldest while `size > MAX_PARKED` (`:265-269`), so the in-flight confirmation is never the one dropped.
5. Return `{ ok: true, detail: 'confirmation-required' }` (`:270`).

Confirm path (`:238-247`):
- `confirmId` required (`:240`); unknown id ⇒ `'no pending action'` (`:242`); entry deleted on lookup (`:243`); `now() - parked.at > CONFIRMATION_TTL_MS` ⇒ `'confirmation expired'` (`:244`); `approve === false` ⇒ `{ok:true, detail:'cancelled'}` (`:245`); otherwise `execute(parked.cmd)` (`:246`).

`now` is injectable (`options.now`, `:126`, `:133`) which is what makes the TTL testable without a clock.

**`shellCommandError` — defense-in-depth, `:98-116`:**
```ts
const UNSAFE_SHELL_RE = /[;&|`$<>\n\r*?(){}!~]/;   // :98
const TRAVERSAL_RE = /\.\./;                     // :100
export function shellCommandError(command: string): string | null {
  if (command.trim().length === 0) return 'command required';              // :111
  if (command.length > 512) return 'command too long';                    // :112
  if (TRAVERSAL_RE.test(command)) return 'command rejected (path traversal)';   // :113
  if (UNSAFE_SHELL_RE.test(command)) return 'command rejected (unsafe metacharacters)';  // :114
  return null;
}
```
14 metacharacter classes: `; & | \` $ < > newline CR * ? ( ) { } ! ~`, plus `..` as its own rule. The comment at `:88-96` records that the original list was only `;&|`<><\n\r`, leaving glob, brace, subshell, tilde and history expansion open. The returned message **never echoes the payload** (`:106-108`). Length is bounded twice — 512 in zod (`protocol.ts:373`) and 512 again here.

**FINDING 7.3 (a deny-list, honestly labelled as one).** `command-router.ts:92-96` is candid: *"It is a deny-list and therefore not a sandbox: it raises the cost of an accidental or naive payload, and it is tested both for what it refuses and for what it must not break (`rm -rf build` is the FR-12 spec case)."* Worth recording that `rm -rf build` **passes** the filter (no metacharacter, no `..`) and is therefore parked for confirmation — which is the intended behaviour. The real control is the FR-12 confirm gate plus session scoping, exactly as claimed. No defect; documented so the deny-list is not mistaken for containment.

---

## 8. DISCREPANCIES: CODE vs DOCS

Ordered by severity. Every "code says" citation is a file:line I read; every "docs say" citation is the claim being falsified.

### 8.1 HIGH — `test:vantrilex` **does** include E2E, contrary to `AGENTS.md`

`AGENTS.md` §Gates, verbatim:
> *"`test:vantrilex` is **typecheck → eslint → oxlint → root vitest → desktop vitest**. E2E is **not** part of it."*

and §Commands: `npm run test:vantrilex  # typecheck -> eslint -> oxlint -> vitest(root) -> vitest(desktop)`

**`package.json:24` is the truth:**
```json
"test:vantrilex": "npm run typecheck && npm run lint && npm run lint:ox && npm run test && npm run test:desktop && npm run test:e2e",
```
Six stages, and `npm run test:e2e` **is** the sixth. The gate chain is `typecheck → lint(eslint) → lint:ox(oxlint) → test(vitest root) → test:desktop(vitest desktop) → test:e2e`. `test:e2e` is `npm --prefix apps/desktop run test:e2e` (`package.json:28`), and the desktop script is `npm run build --prefix ../.. && playwright test` — so the gate also **rebuilds root `dist/`** and runs all 14 Playwright specs. `AGENTS.md` is wrong on both the composition and the omission. Anyone trusting the doc will believe a green gate means E2E never ran, and will size their 4096/4097/4197 expectations wrong.

### 8.2 HIGH — all three published test counts are stale

| Quantity | `AGENTS.md` claim | `docs/10-CHECKPOINT.md:604-605` | **Measured** | Command |
|---|---|---|---|---|
| root vitest | 498 passed, 39 files | 498 / 39 | **568 passed, 46 files** | `npx vitest run` → `Test Files 46 passed (46)` / `Tests 568 passed (568)` |
| desktop vitest | 149, 23 files | 149 / 23 | **153 passed, 24 files** | `cd apps/desktop; npx vitest run` → `Test Files 24 passed (24)` / `Tests 153 passed (153)` |
| `cargo test` | 26 | 26 (line 604) | **27 `#[test]`** statically | `Select-String -Path main.rs -Pattern '^\s*#\[test\]'` → 27 |
| E2E | 18 across 14 specs | 18 / 14 | **18 `test(` across 14 `*.spec.ts`** (static count; not executed) | per-file `Select-String '\btest\('` |
| root live modules | 51, 0 dead, 8056 lines | — | **51, 0 dead, 8056 lines — CONFIRMED** | custom reachability walk (below) |
| archive files | 44 | — | **45** | `Get-ChildItem .opencode\_archive\dead-code-phase1 -Recurse -File` |

`docs/10-CHECKPOINT.md:721` already says `cargo test` **27**, so `AGENTS.md` (and line 604 of its own checkpoint) is stale against the repo's own newer ledger. The 568/153 figures are **upward** corrections — the gates got stronger, the documentation did not follow.

Reachability re-derived independently, following `import(...)` dynamic edges as well as static `from` clauses, from `src/daemon.ts` + `src/cli.ts`, resolving every quoted relative specifier to `X.ts` or `X/index.ts`:
```
LIVE production modules : 51
  (with tests) reached  : 51
live source lines       : 8056
DEAD production modules : 0
```
**`AGENTS.md`'s dead-code section is accurate.** Also verified: `src/launcher/` is 3 files, the archive holds 28 production `.ts` + 14 `.test.ts`, and `git log` shows the knowledge layer was *restored* at `076cebc` (so the RAG/guidance work was recovered, not left quarantined — the §0 reachability figure confirms 0 dead either way).

### 8.3 HIGH — Tier-1 shipped ground truth states the opposite of the EADDRINUSE behaviour

Covered in full at Finding 3.2. `src/knowledge/shared/failures.ts:53-59` tells the assistant, in two languages, that *"A second launch fails with EADDRINUSE and that is expected."* `main.rs:540-543` (`port_open` = bare TCP connect) + `main.rs:796-798` prove a second launch **adopts silently and reports `ready`**. `EADDRINUSE` is unreachable from the shell's decision path entirely. Because `knowledgeReport` prints this chunk second for the query `"المنفذ 4096"` (score 6.298, measured) and `docs/13-DEPLOYMENT.md:56` says *"Default `4096` on `127.0.0.1` (never wildcard — boot refuses otherwise, `12` §12.5)"* — note there is **no boot-time wildcard refusal anywhere in the code**; the bind is simply hard-coded to `'127.0.0.1'` at `ui-server.ts:150` and passed as `--hostname 127.0.0.1` at `main.rs:755`, with nothing to refuse — a different mechanism than the doc describes, though the same outcome.

### 8.4 MEDIUM — the "acknowledgement must never become a task" guarantee is not implemented

Covered at Finding 6.1. `prompt-optimizer.ts:8-10` and `daemon.ts:522-525` both claim `isActionableInstruction` prevents an acknowledgement from becoming a task; `daemon.ts:558` calls `coordinator.run(task)` unconditionally. The gate only saves one provider call. The tests (`prompt-optimizer-wiring.test.ts:18-54`) pin the function's return value, not the dispatch. The real prevention is `coordinator.ts:84-85` — i.e. a prompt instruction to a free-tier model, not code.

### 8.5 MEDIUM — "0600" for the IPC token and serve password

Covered at Finding 2.2. `main.rs:478` / `main.rs:519` use `fs::write` with no mode. `daemon.ts:748` passes `{ mode: 0o600 }` but is unreachable in the installed flow because the shell always writes first. `AGENTS.md` §Vault and `docs/10-CHECKPOINT.md:252` both state 0600 as fact.

### 8.6 MEDIUM — a non-CSPRNG guards the whole control plane in the shipped build

Covered at Finding 2.1. `main.rs:460-476` (token) and `main.rs:501-517` (password) are xorshift64\* seeded from `nanos ^ pid`, described in-comment as *"32 random bytes"*. `daemon.ts:746` uses `randomBytes(32)` from `node:crypto` — so the *dev* path is stronger than the *shipped* path. `docs/12-SECURITY.md` and `docs/27-CREDENTIALS.md` were not audited for a CSPRNG claim (out of scope); **UNVERIFIED** whether either asserts one.

### 8.7 MEDIUM — the "3-tier supervisor" and Last-Seq resume are inert

- `docs/10-CHECKPOINT.md:264` claims the supervisor *"probes 4096/4097 and spawns what is missing"*. It probes with a bare TCP connect (Finding 3.2), so "spawns what is missing" is true but "adopts what is present" is **unqualified** — no health, no auth, no identity.
- `docs/00-PROJECT-GUIDE.md:121` *"Job Object teardown | closed — `KILL_ON_JOB_CLOSE`, zero orphans on force-kill"*. The job is real and correct; but Finding 1.1 shows a job-creation failure degrades silently to no-job with `unadopted() == 0`, so "closed" is conditional on `CreateJobObjectW` succeeding, which the code never asserts.
- `docs/09-DECISIONS.md:206, 226` and `AGENTS.md` §Protocol present Last-Seq resume as an ADR-010 contract feature. `ui-server.ts:160` `broadcast` — the sole producer of both `event` frames and the `this.resume` buffer — has **no production caller** (Finding 4.2). Resume replays nothing in a real run.

### 8.8 LOW — stale in-code comments, verified individually

- `scripts/lint-baseline.mjs:20-33` + `:45-62`: claims oxlint is absent from `node_modules` and that `npm install` cannot fix it. **False** — `node_modules\.bin\oxlint.cmd` exists and `npm run lint:ox` exits 0 with 8/8. Superseded by commit `895bc7f`. (Finding 0.2.)
- `daemon.ts:474-477` vs `daemon.ts:508`: "a rejected token must never survive as prose" — the catch path re-admits the raw `@`-bearing transcript. (Finding 6.3.)
- `coordinator.ts:234-243` vs `daemon.ts:380-384`: the "fast verbal response … kicked off but NOT awaited" is never kicked off, because the daemon omits the `speak` hook. (Finding 6.2.)
- `audio-pipeline.ts:64-71` (L6) vs `daemon.ts:261`: the L6 stale-reply fix is attributed to `reset()`, but only `switchSession` calls `reset()`. (Finding 6.4.)
- `docs/26-AGENT-LAUNCHER.md:34-42, 88-92` (normative §26.1, §26.4): describes `SupervisedLauncher`, `resolvePort`, `siblings.ts`, `killTree` and a 60 s orphan sweeper. None exist. The supersession banner at `:3-27` is correct. (Finding 0.1.)
- `src/knowledge/index.ts:4-7`: correctly self-documents that the knowledge layer is **not** in the narration path. Verified — single importer is `cli.ts:17`. **This is an accurate statement, recorded as a non-defect.**

### 8.9 Claims checked and confirmed TRUE (so the audit does not invent problems)

| Claim | Source | Verification |
|---|---|---|
| `servePort` hardcoded 4096, loopback-only | `ui-server.ts:150, 380`; `main.rs:755` | literal `'127.0.0.1'` and `--hostname 127.0.0.1`; no wildcard in the tree |
| `MAX_AUDIO_BYTES` = 64 KiB, error frame not dropped socket | `protocol.ts:28`; `ui-server.ts:442-446` | measured at runtime: oversize → `error` frame, connection preserved |
| Bearer travels as a second subprotocol token | `ui-server.ts:297-303`; `ws.ts:276`; `ws.test.ts:89` | `['voice-ui.v1','<token>']`, `timingSafeEqual` both paths |
| ipc.token written in `setup()` before the webview | `main.rs:1358-1373` | `.setup()` runs before `.build()`/window; also `ipc-token.ts:49-50` polls 20×500 ms as a second line of defence |
| Exactly 2 processes in the Job Object | `main.rs:771-772`, `main.rs:843-844` | the only two `own()` call sites |
| 0 dead production modules, 51 live, 8056 lines | `AGENTS.md` | re-derived independently: **exact match** |
| Dynamic `import('./runtime/vad.js')` is enforced | `sidecar-safety.test.ts:27-104` | passes; also verified physically that `sidecar/node_modules/onnxruntime-node` is absent while `sidecar/dist/runtime/vad.js` is present |
| `docs/26` supersession banner is accurate | `docs/26:3-27` | `src/launcher/` really is 3 files exporting only `probeHealth` |
| `test:vantrilex` typecheck + eslint exit 0 | `AGENTS.md` | `npm run typecheck` → 0; `npm run lint` → 0; `npm run lint:ox` → 0 |
| Version is `0.7.2` in all six places | `AGENTS.md` §Release | `package.json:3`, `apps/desktop/package.json`, `tauri.conf.json`, `Cargo.toml:4`, `provision-sidecar.mjs:47` all `0.7.2` |
| E2E = 18 tests / 14 specs | `AGENTS.md` | static count matches exactly |

---

## 9. EXPLICITLY UNVERIFIED

Per the brief's instruction to say so rather than guess:

1. **`cargo test` execution.** The MSVC toolchain was not loaded and `cargo` was not run. §8.2 reports a **static** `#[test]` count of 27 (9 of which are `#[cfg(windows)]`, so 18 unconditional + 9 Windows-only). Actual pass/fail is **UNVERIFIED**.
2. **`npm run test:e2e` / Playwright execution.** Not run: it rebuilds root `dist/` and requires 4096/4097/4197 free. The 18/14 figure is a static `test(` count per spec file, not an execution result.
3. **Cold-launch behaviour of the packaged build.** Not run (requires an install and a free port set). §2's ordering is derived from source, not from a live launch.
4. **Live provider behaviour** (intake/plan/narration latency, `403` without an agentic UA, `finish=length` without `effort:'none'`). All out of scope here and not measured. The code-side facts are cited; the *live* claims in `AGENTS.md` §Models are **UNVERIFIED by this audit**.
5. **`docs/12-SECURITY.md` and `docs/27-CREDENTIALS.md` CSPRNG assertions** — not read; see Finding 8.6's caveat.
6. **Whether the sidecar's `eventsource` dependency is needed.** `provision-sidecar.mjs:51` ships it, but ripgrep for `from 'eventsource'` across `src/` returns **zero** hits. It is either a transitive requirement of `groq-sdk` or dead weight in the manifest. **UNVERIFIED** which.
7. **`dossier/` claims** (2 files, 1852 lines) beyond the two cross-references already cited. `dossier/PHASE2_AUDIT_REPORT.md` F-02 was cited indirectly via `lint-baseline.mjs:56` and found stale (Finding 0.2); its other findings were not audited.
