#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Voxaura shell entry — window + the outer-most process supervisor.
//
// Two-tier ownership, made explicit:
//   * The NODE DAEMON remains the authority for `opencode serve` (it owns the
//     launcher, port policy and sibling sweeper — see src/launcher/). The shell
//     only *nudges* a missing serve into existence so a cold double-click works.
//   * The shell spawns the daemon when it is absent, and owns the lifetime of
//     every child IT created: on exit they are killed, so no orphans survive.
//
// Networking, process control and the Job Object remain std-only; the two
// deliberate crate dependencies are `getrandom` (the OS CSPRNG, used for every
// secret in this file — see `secure_random_bytes`) and `windows-sys` (the Job
// Object and the DACL work in `restrict_to_owner`). Command resolution is
// env-overridable so a packaged build can point at sidecars without recompiling.
//
// IPC identity (H4): the WS-4097 bearer is NOT baked into the bundle. This
// process writes a random per-install token to
// `~/.opencode-voice-runtime/ipc.token` and the webview asks for it at runtime
// through the `ipc_token` command below. The file is NOT created with Unix
// `0600` — see `restrict_to_owner` for what it actually gets, which is a
// protected, owner-only DACL, because on Windows `0o600` is a silent no-op.
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const OPENCODE_PORT: u16 = 4096;
const DAEMON_PORT: u16 = 4097;

/// Windows Job Object with KILL_ON_JOB_CLOSE. Handles are not RAII-wrapped:
/// the job must outlive every child for the kernel to enforce the kill, and it
/// is intentionally never closed (process teardown closes it, which is exactly
/// the trigger we want).
#[cfg(windows)]
struct KillOnCloseJob(HANDLE);

#[cfg(windows)]
unsafe impl Send for KillOnCloseJob {}
#[cfg(windows)]
unsafe impl Sync for KillOnCloseJob {}

#[cfg(windows)]
impl KillOnCloseJob {
    fn create() -> Option<Self> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let _ = CloseHandle(job);
                return None;
            }
            Some(KillOnCloseJob(job))
        }
    }

    /// Returns whether the kernel actually took ownership. Callers MUST act on
    /// `false`; see `adoption_action`.
    fn adopt(&self, child: &Child) -> bool {
        unsafe {
            let handle = child.as_raw_handle() as HANDLE;
            AssignProcessToJobObject(self.0, handle) != 0
        }
    }
}

/// What to do with a child whose Job-Object adoption returned `ok`.
///
/// D10: adoption used to be `let _ = AssignProcessToJobObject(..)` — the BOOL
/// was discarded, so a child the kernel refused was still counted as
/// supervised and still survived our death. There is no safe "ignore" here.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum AdoptionAction {
    /// The kernel will kill it when this process dies.
    Keep,
    /// Not in the job: it would outlive us, so kill it now.
    Kill,
}

/// What actually happened when we tried to put a child in the job.
///
/// C7: this used to be a bare `bool`, computed as
/// `self.job().is_none_or(|job| job.adopt(&child))`. `is_none_or` returns
/// `true` when the receiver is `None` — and `None` is precisely what
/// `Supervisor::job()` yields when `CreateJobObjectW` FAILED. So on a machine
/// that could not create the job at all, every child reported `adopted = true`,
/// was pushed into `children`, and left `unadopted` at 0. The graceful reap
/// became the only net, and the child outlived us holding 4096 — the exact
/// outcome the note above `adoption_action` says has no safe "ignore".
///
/// A three-variant enum makes the swallowed case unrepresentable: mapping "we
/// have no job" onto "the kernel took it" now has to be written on purpose,
/// with the pid in hand, in a place a test can reach.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Adoption {
    /// In the job: the kernel kills it when this process dies.
    Adopted,
    /// The job exists and the kernel refused this child.
    Refused { pid: u32 },
    /// C7: the job object itself could not be created, so there was nothing to
    /// adopt into. Reported separately from `Refused` because the two have
    /// different causes and different fixes — this one makes every future
    /// child untrackable too, not just this one.
    NoJob { pid: u32 },
}

impl Adoption {
    fn from_bool(ok: bool, pid: u32) -> Self {
        if ok {
            Adoption::Adopted
        } else {
            Adoption::Refused { pid }
        }
    }
}

fn adoption_action(outcome: Adoption) -> AdoptionAction {
    match outcome {
        Adoption::Adopted => AdoptionAction::Keep,
        // Both failures leave the child outside the job, so both must die now.
        Adoption::Refused { .. } | Adoption::NoJob { .. } => AdoptionAction::Kill,
    }
}

/// Where a child's logs went, or why they went nowhere.
///
/// D12: `fs::File::create` was matched with `Err(_) => cmd.stderr(Stdio::null())`.
/// On Windows a sharing violation on a handle held by a previous daemon makes
/// that create fail, and the child's stderr then vanished with no trace at all —
/// which is exactly what the 2026-09-27 forensics saw (a zero-byte
/// `daemon-stderr.log` untouched across ~18 h of recorded spawns).
#[derive(Debug, PartialEq, Eq)]
enum LogPlan {
    /// The canonical `<stem>.log` is openable.
    Primary(PathBuf),
    /// The canonical name was taken; a unique file is open instead.
    Fallback(PathBuf),
    /// Nothing could be opened. The message names the underlying errors.
    Unavailable(String),
}

/// A short unique suffix for the fallback file. No clock dependency: the pid
/// plus a monotonic counter is enough to disambiguate concurrent launches.
fn unique_suffix() -> String {
    use std::sync::atomic::AtomicU32;
    static SEQ: AtomicU32 = AtomicU32::new(0);
    format!("{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst))
}

/// Open `<stem>.log` in append mode, falling back to a unique file.
///
/// Append, never truncate: a restart that fails for a different reason must not
/// erase the evidence of the previous failure.
fn plan_child_logs(dir: &Path, stem: &str) -> LogPlan {
    let primary = dir.join(format!("{stem}.log"));
    match open_append(&primary) {
        Ok(_) => LogPlan::Primary(primary),
        Err(first) => {
            let fallback = dir.join(format!("{stem}-{}.log", unique_suffix()));
            match open_append(&fallback) {
                Ok(_) => {
                    log_line(&format!(
                        "log: {primary:?} unavailable ({first}); using {fallback:?}"
                    ));
                    LogPlan::Fallback(fallback)
                }
                Err(second) => LogPlan::Unavailable(format!(
                    "could not open child logs for {stem}: {primary:?} failed ({first}); fallback {fallback:?} failed ({second})"
                )),
            }
        }
    }
}

fn open_append(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().append(true).create(true).open(path)
}

/// Both streams are captured, to two distinct files, so `console.log` from the
/// daemon is as diagnosable as its `console.error`. stdout used to be
/// unconditionally `Stdio::null()`.
fn open_child_stdout(dir: &Path, stem: &str) -> Option<fs::File> {
    open_append(&dir.join(format!("{stem}-stdout.log"))).ok()
}

fn open_child_stderr(dir: &Path, stem: &str) -> Option<fs::File> {
    match plan_child_logs(dir, stem) {
        LogPlan::Primary(p) | LogPlan::Fallback(p) => open_append(&p).ok(),
        LogPlan::Unavailable(msg) => {
            log_line(&format!("log: {msg}"));
            None
        }
    }
}

/// Who a running `opencode serve` process belongs to.
///
/// D11: `resolve_opencode_bin()` deliberately reuses the CLI the OpenCode
/// *desktop app* installs, and that app runs its own `serve --service` on a
/// random port. Live on 2026-09-27: PID 19516 `opencode-cli.exe serve --service`
/// on :49374 while nothing held 4096. Two supervisors, one user.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum ServeOwnership {
    /// A process we did not spawn, while our own port is cold.
    Foreign,
    /// One of ours, or not a serve.
    NotForeign,
}

/// Decide whether a foreign serve exists.
///
/// PID-based, not command-line based. `wmic` is absent on current Windows
/// images (measured: not found) and the `Get-CimInstance` equivalent costs
/// ~500 ms and is quoting-fragile across shells. `tasklist` was measured at
/// 134 ms and returns exactly what this predicate needs. What we lose is the
/// foreign command line in the log; what we keep is a detection that actually
/// runs on the machine users have.
fn foreign_serve_present(ours: &[u32], candidates: &[u32]) -> ServeOwnership {
    let foreign = candidates.iter().any(|pid| !ours.contains(pid));
    if foreign {
        ServeOwnership::Foreign
    } else {
        ServeOwnership::NotForeign
    }
}

/// Running `opencode-cli.exe` PIDs, via `tasklist`. Best effort by design: this
/// is a diagnostic, and a failure here must never stop bring-up. Returns an
/// empty list when the query cannot be answered.
#[cfg(windows)]
fn opencode_pids() -> Vec<u32> {
    let Ok(out) = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq opencode-cli.exe", "/FO", "CSV", "/NH"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        // CSV: "opencode-cli.exe","19516","Console","1","422,116 K"
        .filter_map(|line| line.split("\",\"").nth(1))
        .filter_map(|pid| pid.trim().parse::<u32>().ok())
        .collect()
}

#[cfg(not(windows))]
fn opencode_pids() -> Vec<u32> {
    Vec::new()
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum BringUpAction {
    /// 4096 already answers: adopt it, never spawn a second serve.
    Adopt,
    /// Cold, and we are the only candidate.
    Spawn,
    /// Cold, but a foreign serve exists. Spawn ours AND say so.
    SpawnAndWarn,
}

fn bring_up_action(port_already_open: bool, foreign_serve_present: bool) -> BringUpAction {
    if port_already_open {
        BringUpAction::Adopt
    } else if foreign_serve_present {
        BringUpAction::SpawnAndWarn
    } else {
        BringUpAction::Spawn
    }
}

/// Outcome of spawn-then-wait-for-port.
#[derive(Debug)]
enum BindOutcome {
    /// The port opened inside the budget; the child is handed back for supervision.
    Bound(Child),
    /// The child never opened the port and has been KILLED (L12).
    TimedOut { pid: u32 },
    /// The command could not be started at all.
    SpawnFailed(String),
}

/// Spawn `cmd` and wait for `port` to answer.
///
/// L12: the old code spawned, waited, and on timeout returned `Err` while the
/// child kept running for the rest of the session — a process holding a half-open
/// port with nothing to reap it. The child is now killed before returning.
fn spawn_and_wait_for_port(cmd: &mut Command, port: u16, budget: Duration) -> BindOutcome {
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return BindOutcome::SpawnFailed(format!("could not spawn process: {e}")),
    };
    let pid = child.id();
    if !wait_for_port(port, budget) {
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
        return BindOutcome::TimedOut { pid };
    }
    BindOutcome::Bound(child)
}

/// Bring-up result as the shell sees it.
///
/// L11: `ensure_all_services` returned `Vec<String>`, so "someone else is
/// already bringing the app up" and "it worked" and "it failed" were the same
/// type. The frontend could not tell them apart and never retried, which is
/// indistinguishable from a hang.
#[derive(Debug, Clone, Serialize)]
struct BringUpStatus {
    /// `ready` | `in-flight` | `failed`
    state: &'static str,
    detail: String,
    /// Whether the caller should simply try again. True only for `in-flight`.
    retriable: bool,
    steps: Vec<String>,
}

impl BringUpStatus {
    fn ready(steps: Vec<String>) -> Self {
        Self { state: "ready", detail: steps.join("; "), retriable: false, steps }
    }

    fn in_flight() -> Self {
        Self {
            state: "in-flight",
            detail: "bring-up already in flight".to_string(),
            retriable: true,
            steps: Vec::new(),
        }
    }

    fn failed(detail: &str) -> Self {
        Self {
            state: "failed",
            detail: detail.to_string(),
            retriable: false,
            steps: Vec::new(),
        }
    }
}

/// Single-flight guard: setup and the frontend both request bring-up; without
/// this they race and spawn duplicate children (the loser exits, and the race
/// can leave neither holding the port).
static BRINGUP_INFLIGHT: AtomicBool = AtomicBool::new(false);

/// Children spawned by THIS process. Killed on exit; never touched if they were
/// already running before we started (we did not create them). On Windows the
/// job object is the hard guarantee; this list is the graceful path.
#[derive(Default)]
struct Supervisor {
    children: Mutex<Vec<Child>>,
    /// Children the kernel refused to adopt. They are killed immediately, but
    /// the count is retained because a non-zero value is the signature of a
    /// broken Job Object and belongs in the log.
    unadopted: Mutex<usize>,
    /// C7: children we could not track because `CreateJobObjectW` itself
    /// failed. Kept apart from `unadopted` because it is a different fault with
    /// a different blast radius — this one affects every child, now and later,
    /// so a zero `unadopted` no longer means "supervision is working".
    no_job: Mutex<usize>,
    #[cfg(windows)]
    job: std::sync::OnceLock<Option<KillOnCloseJob>>,
}

impl Supervisor {
    #[cfg(windows)]
    fn job(&self) -> Option<&KillOnCloseJob> {
        self.job.get_or_init(KillOnCloseJob::create).as_ref()
    }

    /// Take ownership of a child. Returns whether it is now kernel-supervised.
    ///
    /// D10: on Windows a child the job refused is KILLED, not tracked. A child
    /// we cannot reap on exit is an orphan the moment we are gone, and an
    /// orphan holding 4096 blocks the next cold launch.
    fn own(&self, child: Child) -> bool {
        #[cfg(windows)]
        {
            let outcome = self.adoption_of(&child);
            self.own_with_adoption(child, outcome)
        }
        #[cfg(not(windows))]
        {
            self.own_with_adoption(child, Adoption::Adopted)
        }
    }

    /// C7: the decision, including the case where there IS no job.
    ///
    /// Split out of `own` so the `None` arm is reachable from a test. A real
    /// `CreateJobObjectW` cannot be made to fail portably, so
    /// `with_unavailable_job` injects a supervisor whose job slot already holds
    /// `None` — which is byte-for-byte the state of the machine this defect was
    /// written for.
    #[cfg(windows)]
    fn adoption_of(&self, child: &Child) -> Adoption {
        match self.job() {
            Some(job) => Adoption::from_bool(job.adopt(child), child.id()),
            // No job exists. `is_none_or` used to read this as success; the
            // child would then have been recorded as supervised and would have
            // outlived us.
            None => Adoption::NoJob { pid: child.id() },
        }
    }

    /// Split out so the failure branch is testable without provoking a real
    /// `AssignProcessToJobObject` error, which cannot be forced portably.
    fn own_with_adoption(&self, mut child: Child, outcome: Adoption) -> bool {
        if adoption_action(outcome) == AdoptionAction::Kill {
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            match outcome {
                // C7: surfaced, not folded into `unadopted`. The two log lines
                // differ because the operator action differs — one is a retry
                // of a single child, the other is "this machine cannot create
                // Job Objects at all".
                Adoption::NoJob { .. } => {
                    if let Ok(mut n) = self.no_job.lock() {
                        *n += 1;
                    }
                    log_line(&format!(
                        "supervisor: JOB-CREATE-FAILED pid={pid} — no job object exists, so the child \
                         cannot be supervised; it was killed immediately and no future child will be \
                         tracked either"
                    ));
                }
                _ => {
                    if let Ok(mut n) = self.unadopted.lock() {
                        *n += 1;
                    }
                    log_line(&format!(
                        "supervisor: job-adopt-failed pid={pid} — killed immediately (it would have outlived us)"
                    ));
                }
            }
            return false;
        }
        if let Ok(mut kids) = self.children.lock() {
            kids.push(child);
        }
        true
    }

    /// Test-only: a supervisor on a machine where `CreateJobObjectW` failed.
    #[cfg(all(test, windows))]
    fn with_unavailable_job() -> Self {
        let sup = Self::default();
        // `OnceLock::set` is stable and the cell is never written again, so this
        // is a faithful stand-in for a failed creation rather than an
        // uninitialised cell.
        let _ = sup.job.set(None);
        sup
    }

    /// Test-only: production reports the unadopted count, not the child count.
    #[cfg(test)]
    fn child_count(&self) -> usize {
        self.children.lock().map(|k| k.len()).unwrap_or(0)
    }

    /// PIDs of children we own, so foreign-process detection can exclude them.
    fn pids(&self) -> Vec<u32> {
        self.children.lock().map(|k| k.iter().map(|c| c.id()).collect()).unwrap_or_default()
    }

    fn unadopted(&self) -> usize {
        self.unadopted.lock().map(|n| *n).unwrap_or(0)
    }

    /// C7: how many children this supervisor could not track because the job
    /// object does not exist. Zero is the only healthy value.
    fn no_job(&self) -> usize {
        self.no_job.lock().map(|n| *n).unwrap_or(0)
    }

    fn reap(&self) {
        let Ok(mut kids) = self.children.lock() else { return };
        for child in kids.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        kids.clear();
    }
}

fn runtime_dir() -> Option<PathBuf> {
    // VOICE_RUNTIME_DIR overrides the whole directory. This exists because the
    // credential tests need a scratch path: without it, `ensure_machine_key` and
    // its siblings resolve under the operator's real USERPROFILE, where a test
    // run would rewrite the live install's key and make the vault undecryptable.
    if let Some(explicit) = std::env::var_os("VOICE_RUNTIME_DIR") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let mut path = PathBuf::from(home);
    path.push(".opencode-voice-runtime");
    Some(path)
}

/// Append one line to the supervisor log, in the runtime directory. Diagnostics
/// only — never credentials, never transcript content. This file carries no
/// credential, so it deliberately does NOT get the owner-only DACL that
/// `restrict_to_owner` applies to `ipc.token` and `serve.pass`.
///
/// The production body is compiled out under `cargo test`. The unit tests
/// deliberately drive the failure paths, including Job-Object creation failure,
/// and without this gate each run appended fabricated `JOB-CREATE-FAILED` lines
/// to the operator's real diagnostic file. That is the worst form of test
/// pollution: a green suite silently corrupting the one artefact you would read
/// to debug a genuine boot failure. Measured on this machine — a single
/// `cargo test` run appended 546 bytes here, and the log is append-only, so the
/// damage accumulated across runs.
///
/// Split by `cfg` rather than an early `return`, so the test build neither
/// compiles dead I/O paths nor warns about unreachable code.
#[cfg(not(test))]
fn log_line(message: &str) {
    let Some(dir) = runtime_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("supervisor.log");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut existing) = fs::read_to_string(&path) {
        existing.push_str(&format!("[{stamp}] {message}\n"));
        let _ = fs::write(&path, existing);
    } else {
        let _ = fs::write(&path, format!("[{stamp}] {message}\n"));
    }
}

/// No-op under test. See the production variant above for why this gate exists.
///
/// Takes and drops the message so call sites need no `cfg` of their own:
/// sprinkling `#[cfg(not(test))]` across two dozen call sites would be far more
/// error-prone than making the sink inert in exactly one place.
#[cfg(test)]
fn log_line(_message: &str) {}

fn token_path() -> Option<PathBuf> {
    Some(runtime_dir()?.join("ipc.token"))
}

/// Bytes of entropy behind every secret in this file. 32 bytes -> 64 hex chars.
const SECRET_BYTES: usize = 32;

/// Fill `N` bytes from the operating system's cryptographic RNG.
///
/// Dossier S2. The generator this replaced was an xorshift64* whose entire
/// state was `SystemTime::now().as_nanos() as u64 ^ process::id() as u64`.
/// Both halves of that seed are observable rather than secret: the wall clock
/// is readable by anything running on the machine, and a Windows PID is a
/// bounded enumerable integer (1..=65535). Worse, the old loop emitted all 32
/// bytes from just *four* xorshift steps, so the 256-bit-looking secret was
/// fully determined by a ~64-bit seed, of which only the handful of nanosecond
/// values spanning the process's own startup window are plausible. The token
/// therefore carried roughly 2^30 effective bits, not 2^256, and an attacker who
/// had merely observed when the app launched could regenerate it offline.
///
/// `getrandom` reaches the kernel CSPRNG (RtlGenRandom/BCryptGenRandom on
/// Windows). It fails rather than degrading, which is why this returns
/// `Result`: a weak secret must never be produced as a fallback.
fn secure_random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| format!("csprng: {e}"))?;
    Ok(buf)
}

/// A `SECRET_BYTES` CSPRNG secret, lower-case hex.
fn generate_secret() -> Result<String, String> {
    let bytes = secure_random_bytes::<SECRET_BYTES>()?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Write a secret to `path` and lock the file down to its owner, fail-closed.
///
/// Returns the secret so the caller does not have to re-read a file it just
/// wrote. The order matters: the bytes hit the disk *before* the DACL is set,
/// because the DACL call needs to own the file. If the DACL cannot be
/// applied, the file is removed again and the error propagates. Continuing
/// would mean knowingly leaving a live credential at whatever access level the
/// parent directory happened to grant, which is exactly the defect this
/// function exists to close.
///
/// Failing closed is safe for startup here: `setup()` and `ensure_all_services`
/// both log the error and keep going, and `ipc_token` then fails closed, so the
/// shell renders its disconnected state instead of inventing a credential.
fn write_protected_secret(path: &Path, secret: &str, label: &str) -> Result<(), String> {
    if let Err(e) = fs::write(path, secret) {
        return Err(format!("{label}: {e}"));
    }
    lock_or_delete(path, label)
}

/// Apply the owner-only DACL to a file that already exists, fail-closed.
///
/// This is the ADOPT half of `write_protected_secret`, and it exists because
/// "we only protect what we create" was the defect this closes. A secret
/// written by an older install — or by the Node daemon, whose `{ mode: 0o600 }`
/// is a silent no-op on Windows — carries whatever ACL its parent directory
/// granted. Every `ensure_*` function then adopted it through a
/// `read_to_string` fast path that returned the value WITHOUT re-locking, so
/// the weak descriptor was accepted as permanent on every later launch. The
/// creation path looked correct the whole time, which is why the gap read as
/// "protected" in review: `machine.key` was the only one of the five with an
/// adopt branch, and it is the only one that was ever correct.
///
/// Fail-closed and delete, for the same reason `write_protected_secret` does:
/// leaving the file would mean the next launch adopts it again and the ACL is
/// never retried. Deleting a credential is recoverable (a fresh one is
/// generated); leaving a world-readable one is not.
///
/// Windows notes, because this is not a one-liner and two of these are the
/// reason it works:
///
///   1. `SetNamedSecurityInfoW` needs `WRITE_DAC`, and the file's owner holds it
///      on an INHERITED descriptor via `(F)`, so re-locking an inherited file
///      succeeds. Measured on all five live secrets, which were all inherited
///      before this change and all protected after it.
///   2. The owner is granted `READ_CONTROL` and `WRITE_DAC` IMPLICITLY on
///      Windows, whatever the DACL says. That is why the fail-closed branch
///      below is hard to reach and hard to test — see
///      `a_lock_that_cannot_be_applied_is_reported_not_swallowed` for the two
///      stagings that were tried and discarded.
///
/// Ordering is what keeps the daemon out of the way, and it was measured rather
/// than reasoned about: `ensure_owner_marker` runs inside `ensure_daemon`,
/// BEFORE the daemon is spawned, and the daemon then rewrites the marker in
/// place. An in-place write does not touch the security descriptor, so the lock
/// survives the rewrite — verified on a live install by `icacls` after the
/// daemon had republished the file. No open handle is ever contended.
fn lock_or_delete(path: &Path, label: &str) -> Result<(), String> {
    if let Err(e) = restrict_to_owner(path) {
        let _ = fs::remove_file(path);
        return Err(format!("{label}: {e}"));
    }
    Ok(())
}

/// Restrict `path` to its owner — the real Windows equivalent of Unix `0600`.
///
/// `std::fs::set_permissions(path, 0o600)` is NOT the answer here. On Windows
/// that function is `SetFileAttributes` and toggles nothing but the
/// FILE_ATTRIBUTE_READONLY bit; it compiles, returns `Ok(())`, and changes no
/// access control whatsoever. It is a silent no-op that reads like a working
/// permission check, which is the same failure shape as the comments that
/// used to claim `(0600)` while calling no ACL code at all. Windows carries
/// "only me" in a discretionary access control list, not in a mode bit.
///
/// Three properties make the result an actual `0600` rather than decoration:
///
///   1. `SetEntriesInAclW` is given a NULL `oldacl`, so the new DACL is built
///      only from the trustees we name instead of being merged into whatever
///      the parent directory contributed.
///   2. `PROTECTED_DACL_SECURITY_INFORMATION` sets `SE_DACL_PROTECTED`, which
///      blocks inheritance from the parent. This is the part Unix gives for
///      free with `0600` and that the naive Windows equivalent silently lacks:
///      without it the guarantee is only as strong as `%USERPROFILE%`'s ACL,
///      which this process does not control and cannot assume.
///   3. The mask is `GENERIC_ALL`, which the kernel maps to concrete file
///      rights for the object, so this is a full-control grant — the Windows
///      analogue of `rw` for the owner, which is what `0600` means.
///
/// Trustees are the calling user's own SID plus the well-known LocalSystem SID.
/// LocalSystem is included so that system-level maintenance (backup agents,
/// servicing) is not locked out of the file; it does not weaken the boundary
/// this call exists to draw, which is "no other interactive user".
#[cfg(windows)]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree, GENERIC_ALL};
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, SE_FILE_OBJECT, SET_ACCESS,
        TRUSTEE_W, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_IS_WELL_KNOWN_GROUP,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, DACL_SECURITY_INFORMATION, GetFileSecurityW, WinLocalSystemSid,
        NO_INHERITANCE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    };

    let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide_path.push(0);

    // SECURITY_DESCRIPTOR_RELATIVE (0x8000) is the control bit
    // SetNamedSecurityInfoW needs alongside PROTECTED_DACL_SECURITY_INFORMATION;
    // it is passed implicitly as part of that SECURITY_INFORMATION mask, and
    // SetNamedSecurityInfoW builds the descriptor itself, so there is no
    // SECURITY_DESCRIPTOR_RELATIVE buffer for us to construct or free here.

    unsafe {
        // (a) The SID we are locking the file down TO is the file's own owner,
        // read back from its security descriptor. We just created the file, so
        // its owner is the identity that created it — which is the whole point
        // of a function named "restrict to owner".
        //
        // The obvious alternative is to ask the process token for its user SID
        // (OpenProcessToken + GetTokenInformation(TokenUser)). That is *not*
        // used here: on this machine `GetTokenInformation(TokenUser)` returns
        // ERROR_NOT_ENOUGH_MEMORY (998) even with the size query succeeding and
        // a 1 KiB buffer, so it is not a usable dependency. The file's owner SID
        // is one API call, needs no token access rights, and cannot drift from
        // the file's actual owner the way a token lookup could.
        let mut sd_len = 0u32;
        let _ = GetFileSecurityW(
            wide_path.as_ptr(),
            OWNER_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut sd_len,
        );
        if sd_len == 0 {
            return Err(format!("acl: owner size query failed ({})", GetLastError()));
        }
        // Kept alive until after SetEntriesInAclW, because the trustee array
        // below points into it.
        let mut descriptor = vec![0u8; sd_len as usize];
        let mut actual = 0u32;
        // NOTE: `lpnlengthneeded` is documented as [out, optional], but passing
        // NULL for it does NOT work on this OS: both GetFileSecurityW and
        // GetTokenInformation fail with ERROR_NOT_ENOUGH_MEMORY (998) even
        // when the size query succeeded and the buffer is comfortably large
        // enough. A real out-pointer is passed for that reason.
        if GetFileSecurityW(
            wide_path.as_ptr(),
            OWNER_SECURITY_INFORMATION,
            descriptor.as_mut_ptr() as *mut core::ffi::c_void,
            sd_len,
            &mut actual,
        ) == 0
        {
            return Err(format!("acl: owner read failed ({})", GetLastError()));
        }
        // SELF_RELATIVE security descriptor: [0]=Revision [1]=SBZ1 [2..4]=Control,
        // then OwnerOffset at [4..8] as a u32.
        let owner_offset = u32::from_le_bytes([
            descriptor[4],
            descriptor[5],
            descriptor[6],
            descriptor[7],
        ]) as usize;
        if owner_offset == 0 || owner_offset >= descriptor.len() {
            return Err("acl: security descriptor has no owner SID".to_string());
        }
        let owner_sid = descriptor.as_mut_ptr().add(owner_offset) as *mut core::ffi::c_void;

        // (b) the well-known LocalSystem SID. SECURITY_MAX_SID_SIZE.
        let mut system_sid = [0u8; 68];
        let mut system_len = system_sid.len() as u32;
        if CreateWellKnownSid(
            WinLocalSystemSid,
            std::ptr::null_mut(),
            system_sid.as_mut_ptr() as *mut core::ffi::c_void,
            &mut system_len,
        ) == 0
        {
            return Err(format!("acl: CreateWellKnownSid failed ({})", GetLastError()));
        }

        // (c) one GRANT+SET access-allowed ACE per trustee.
        //
        // The Win32 `TRUSTEE_W.ptstrName` member is a union that is genuinely
        // a PSID when `TrusteeForm == TRUSTEE_IS_SID` (and a PWSTR when it is
        // TRUSTEE_IS_NAME). windows-sys flattens that union to PWSTR, so each
        // SID pointer is reinterpreted here; the kernel reinterprets it back to
        // a SID because of the TRUSTEE_IS_SID form we set. `SetEntriesInAclW`
        // consumes the EXPLICIT_ACCESS_W array synchronously, so neither the
        // owner descriptor nor the SYSTEM buffer has to outlive this call.
        let trustees = [
            EXPLICIT_ACCESS_W {
                grfAccessPermissions: GENERIC_ALL,
                grfAccessMode: SET_ACCESS,
                grfInheritance: NO_INHERITANCE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_USER,
                    ptstrName: owner_sid as *mut u16,
                },
            },
            EXPLICIT_ACCESS_W {
                grfAccessPermissions: GENERIC_ALL,
                grfAccessMode: SET_ACCESS,
                grfInheritance: NO_INHERITANCE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                    ptstrName: system_sid.as_mut_ptr() as *mut u16,
                },
            },
        ];

        let mut acl: *mut windows_sys::Win32::Security::ACL = std::ptr::null_mut();
        let code = SetEntriesInAclW(
            trustees.len() as u32,
            trustees.as_ptr(),
            std::ptr::null(),
            &mut acl,
        );
        if code != 0 {
            return Err(format!("acl: SetEntriesInAclW failed ({code})"));
        }

        // (d) apply it, with inheritance blocked.
        let code = SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null(),
        );
        LocalFree(acl as _);
        if code != 0 {
            return Err(format!("acl: SetNamedSecurityInfoW failed ({code})"));
        }
    }
    Ok(())
}

/// Unix equivalent, so the same guarantee holds if this ever builds off-Windows.
#[cfg(not(windows))]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("acl: chmod 0600 failed ({e})"))
}

/// Generate or load the per-install IPC token. Written before any child
/// spawns so the UI can read it immediately via the `ipc_token` command.
///
/// When this process generates the file, it is created with a protected
/// owner-only DACL (see `restrict_to_owner`) — not Unix `0600`, which is a
/// no-op on Windows. A pre-existing file is read as-is and not rewritten.
/// Adopt `machine.key`: the 32-byte root secret every vault cipher is derived
/// from. Returned as lowercase hex so the daemon can take it from an env var
/// rather than reading the file itself.
///
/// WHY THIS LIVES HERE AND NOT IN NODE. The daemon used to create this file
/// with `{ mode: 0o600 }`, which on Windows is `SetFileAttributes`: it toggles
/// READONLY, returns Ok, and changes no ACL. The obvious repair from Node was
/// `icacls /inheritance:r /grant:r <user>:(F)`, and it was implemented, tested
/// and REMOVED: it returns "Successfully processed 1 files" and then produces a
/// file the named account cannot read, because `icacls` grants a NAME and cannot
/// name the owner SID. A fix that locks the owner out of the key file would
/// strand every saved provider key, which is strictly worse than the inherited
/// ACL it claimed to remove. This works because `restrict_to_owner` calls
/// `SetNamedSecurityInfoW` with a NULL `oldacl`, preserving the owner SID by
/// construction - a primitive Node cannot reach without a native addon.
///
/// ADOPTION, NOT JUST CREATION. A pre-existing file is re-locked, because a file
/// written by an older install is exactly the one whose protection was a no-op.
/// That is the only way the gap actually closes for existing users, and the
/// test exercises the adopt path in isolation for the same reason: locking the
/// creation path would otherwise mask a broken adopt branch.
///
/// Fail-closed: a wrong-length file is removed and reported, and a DACL failure
/// deletes the file, because a weakly-permissioned key would be adopted on every
/// later launch and the problem would never surface again.
fn ensure_machine_key() -> Result<String, String> {
    const MACHINE_KEY_BYTES: usize = 32;
    let dir = runtime_dir().ok_or_else(|| "no home directory".to_string())?;
    let path = dir.join("machine.key");
    fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;

    if let Ok(existing) = fs::read(&path) {
        if existing.len() == MACHINE_KEY_BYTES {
            // Adopted, so re-lock it. Same helper as every other secret: this
            // branch was already correct, and keeping it on the shared path is
            // what stops it from drifting back into a private copy.
            lock_or_delete(&path, "machine.key")?;
            return Ok(to_hex(&existing));
        }
        // Wrong length: it cannot be a key this install generated, and adopting
        // it would make every vault undecryptable in a way that reads as
        // corruption rather than as a bad file.
        let _ = fs::remove_file(&path);
        return Err(format!(
            "machine.key: {} bytes, expected {MACHINE_KEY_BYTES} - removed; a new key will be generated, and any existing vault is now unreadable",
            existing.len()
        ));
    }

    let key = secure_random_bytes::<MACHINE_KEY_BYTES>()?;
    fs::write(&path, &key).map_err(|e| format!("machine.key: {e}"))?;
    lock_or_delete(&path, "machine.key")?;
    Ok(to_hex(&key))
}

/// Lowercase hex, for handing bytes to a child process through an env var.
fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Re-apply the owner-only DACL to the vault, after Node rewrote it.
///
/// `resolve_vault_dir` locks `keyring.dat` down once at startup, and that is
/// not enough: the Node daemon rewrites the whole file every time the user
/// saves keys, and `Keyring.save` renames a temp file over the original. A
/// rename REPLACES the file, so the new one carries whatever ACL its temp name
/// had - the inherited profile ACL. The startup lock is silently undone by the
/// first save, which is why this exists.
#[tauri::command]
fn restrict_vault_file() -> Result<bool, String> {
    #[cfg(not(windows))]
    return Ok(false);
    #[cfg(windows)]
    {
        let keyring = resolve_vault_dir(None).join("keyring.dat");
        if !keyring.exists() {
            return Ok(false);
        }
        // Fail-closed and delete, like write_protected_secret.
        if let Err(e) = restrict_to_owner(&keyring) {
            let _ = fs::remove_file(&keyring);
            return Err(format!("keyring.dat: {e}"));
        }
        log_line("vault: keyring.dat DACL re-applied after save");
        Ok(true)
    }
}

fn ensure_ipc_token() -> Result<String, String> {
    if let Ok(explicit) = std::env::var("VOICE_RUNTIME_IPC_TOKEN") {
        if !explicit.trim().is_empty() {
            return Ok(explicit);
        }
    }
    let dir = runtime_dir().ok_or_else(|| "no home directory".to_string())?;
    let path = dir.join("ipc.token");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            // Adopted, so re-lock it. See `lock_or_delete`: the file this reads
            // may have been written by an older install, and its ACL is not
            // something this function gets to assume.
            lock_or_delete(&path, "ipc.token")?;
            return Ok(trimmed.to_string());
        }
    }
    let token = generate_secret()?;
    fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;
    write_protected_secret(&path, &token, "ipc.token")?;
    Ok(token)
}

/// Per-install serve password. The shell and the daemon must agree on one
/// credential for `opencode serve`; without it the daemon refuses to start
/// (fail-closed) and a cold double-click can never come up. Precedence: an
/// explicit env value wins, otherwise a generated 32-byte hex secret is stored
/// beside the IPC token — never in the bundle, never logged — under the same
/// protected owner-only DACL as the IPC token (see `restrict_to_owner`).
///
/// Lifetime: see `W3-S2-SERVE-PASS-LIFETIME` in
/// `.opencode/_audit/20-w3-csprng.md` for why this one is NOT rotated per
/// launch even though `ipc.token` is a candidate for it.
fn ensure_serve_password() -> Result<String, String> {
    if let Ok(explicit) = std::env::var("OPENCODE_SERVER_PASSWORD") {
        if !explicit.trim().is_empty() {
            return Ok(explicit);
        }
    }
    let dir = runtime_dir().ok_or_else(|| "no home directory".to_string())?;
    let path = dir.join("serve.pass");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            // Adopted, so re-lock it — same reason as `ensure_ipc_token`.
            lock_or_delete(&path, "serve.pass")?;
            return Ok(trimmed.to_string());
        }
    }
    let password = generate_secret()?;
    fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;
    write_protected_secret(&path, &password, "serve.pass")?;
    Ok(password)
}

// ---------------------------------------------------------------------------
// C2: WHO holds 4097.
//
// `port_open()` is a bare TCP connect, so `ensure_daemon` used to return
// "daemon already on 4097" for ANY process that had the socket — a leftover
// `python -m http.server`, an unrelated dev server, a second user's app, a
// half-dead daemon's socket still in TIME_WAIT with a live holder. The status
// was then `ready`, so the shell asserted a control plane it did not have, and
// EADDRINUSE was unreachable from this path: a daemon we *did* spawn and fail
// to bind is reported by `spawn_and_wait_for_port`, not by the port probe.
//
// A TCP connect cannot tell those apart, so the holder now carries an identity.
// The daemon publishes `<runtime>/daemon.owner` AFTER it has bound, containing
// the owner key this process handed it in its environment. The key is
// per-install and lives in an owner-only-DACL file exactly like `serve.pass`; a
// process that never received it cannot write a marker that verifies, which is
// what turns "something is listening" into "this install's daemon, pid N, is
// listening".
//
// Deliberately NOT used: the IPC token itself. Copying a live credential to a
// second file to answer a liveness question would double the blast radius of
// every leak for no gain, and this key authorises nothing but "I am the daemon
// this shell started".
// ---------------------------------------------------------------------------

/// Bumped only if the marker shape changes incompatibly.
const DAEMON_OWNER_VERSION: u32 = 1;
/// How long a launch waits for a holder that has bound but not yet published.
const OWNER_SETTLE: Duration = Duration::from_millis(1500);

fn owner_file_path() -> Option<PathBuf> {
    Some(runtime_dir()?.join("daemon.owner"))
}

/// Per-install identity handed to the daemon through its environment.
///
/// Precedence mirrors `ensure_serve_password`: explicit env, then the
/// per-install file, then a fresh CSPRNG secret. The value is never logged —
/// only the fact that one exists.
///
/// The key is a NON-CREDENTIAL. It authorises nothing except the statement "I
/// am the daemon this shell launched", and it is not a substitute for the IPC
/// token anywhere. It is nevertheless written into `daemon.owner` verbatim, so
/// that file is created here with the same protected owner-only DACL
/// (`write_protected_secret`) rather than being created fresh by the daemon,
/// which has no way to set one — a file created by Node inherits the parent
/// directory's ACL instead of getting its own.
///
/// Note the marker is then overwritten IN PLACE by the daemon rather than
/// replaced via a temp file + rename, because replacing a file resets its
/// security descriptor and would throw that DACL away.
fn ensure_owner_key() -> Result<String, String> {
    if let Ok(explicit) = std::env::var("VOXAURA_OWNER_KEY") {
        if !explicit.trim().is_empty() {
            return Ok(explicit);
        }
    }
    let dir = runtime_dir().ok_or_else(|| "no home directory".to_string())?;
    let path = dir.join("owner.key");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            // Adopted, so re-lock it — same reason as `ensure_ipc_token`.
            lock_or_delete(&path, "owner.key")?;
            ensure_owner_marker(&dir)?;
            return Ok(trimmed.to_string());
        }
    }
    let key = generate_secret()?;
    fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;
    write_protected_secret(&path, &key, "owner.key")?;
    ensure_owner_marker(&dir)?;
    Ok(key)
}

/// Make sure `daemon.owner` exists AND is protected, on every launch.
///
/// This is a separate function because the marker is the one credential whose
/// ADOPT path was worse than a missing re-lock: the whole block used to sit
/// after the `return Ok(trimmed)` fast path in `ensure_owner_key`, so on any
/// install that already had `owner.key` — that is, every install that had ever
/// run — the marker was never even looked at. Its ACL was whatever it was
/// created with, forever. That is the measured `(I)` on `daemon.owner`, and no
/// amount of hardening the creation path would have touched it.
///
/// Never truncates an existing marker: this runs before the holder probe, and
/// overwriting would erase the identity of the very daemon we are about to
/// adopt. `lock_or_delete` only changes the descriptor, never the bytes.
fn ensure_owner_marker(dir: &Path) -> Result<(), String> {
    let marker = dir.join("daemon.owner");
    if marker.exists() {
        // Adopted: re-lock without touching the contents. The daemon rewrites
        // this file in place after binding, and an in-place write preserves the
        // security descriptor, so locking it here survives that rewrite.
        return lock_or_delete(&marker, "daemon.owner");
    }
    write_protected_secret(&marker, "", "daemon.owner")
}

/// The published holder identity. Only the fields this side acts on are
/// deserialized; `serde` ignores the rest, so a newer daemon that adds a field
/// still verifies.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonOwnerFile {
    v: u32,
    pid: u32,
    owner_key: String,
}

/// Who is holding 4097.
#[derive(Debug, PartialEq, Eq, Clone)]
enum DaemonHolder {
    /// Nothing is listening: spawn.
    Cold,
    /// This install's own daemon, alive, holding the port. Adopting it is
    /// correct and is what a second window of the same app must do.
    Ours { pid: u32 },
    /// Something IS listening and it is not provably this install's daemon.
    Foreign { reason: String },
}

/// C2: the decision, as a pure function of what the probe found.
///
/// `alive` is injected so the "marker names a dead process" case is reachable
/// without waiting for a real one to die — which is exactly the silent-adoption
/// case: our daemon is gone, the port has a new holder, and the file on disk
/// still names the old pid.
fn holder_from_probe(
    port_open: bool,
    raw: Option<&str>,
    owner_key: &str,
    alive: &dyn Fn(u32) -> bool,
) -> DaemonHolder {
    if !port_open {
        return DaemonHolder::Cold;
    }
    let Some(raw) = raw else {
        return DaemonHolder::Foreign {
            reason: "no daemon.owner file, so the holder never received this install's identity"
                .to_string(),
        };
    };
    let parsed: DaemonOwnerFile = match serde_json::from_str(raw) {
        Ok(p) => p,
        Err(e) => {
            return DaemonHolder::Foreign {
                reason: format!("daemon.owner is unreadable ({e})"),
            }
        }
    };
    if parsed.v != DAEMON_OWNER_VERSION {
        return DaemonHolder::Foreign {
            reason: format!(
                "daemon.owner is version {} and this shell speaks version {DAEMON_OWNER_VERSION}",
                parsed.v
            ),
        };
    }
    // The key is checked BEFORE the pid is used for anything, so a file written
    // by anything other than a daemon this shell started cannot influence the
    // decision beyond "not ours".
    if parsed.owner_key != owner_key {
        return DaemonHolder::Foreign {
            reason: "daemon.owner carries a different install identity (another user, or another Voxaura install)"
                .to_string(),
        };
    }
    if parsed.pid == 0 {
        return DaemonHolder::Foreign { reason: "daemon.owner names pid 0".to_string() };
    }
    if !alive(parsed.pid) {
        return DaemonHolder::Foreign {
            reason: format!(
                "daemon.owner names pid {}, which is not running — our daemon is gone and something else took the port",
                parsed.pid
            ),
        };
    }
    DaemonHolder::Ours { pid: parsed.pid }
}

/// Is a process with this pid alive? Test-only before C2; now production, because
/// a marker left behind by a dead daemon is the case `holder_from_probe` exists
/// to refuse. `tasklist` by PID — no extra crate, and the same bet the rest of
/// this file already makes for `opencode_pids`.
fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let Ok(out) = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
        else {
            return false;
        };
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
}

/// C2: the real probe — reachability, then the published identity.
fn classify_daemon_holder(port: u16, owner_key: &str) -> DaemonHolder {
    let deadline = Instant::now() + OWNER_SETTLE;
    loop {
        // Cold is the common case on a first launch and must not pay the settle.
        if !port_open(port) {
            return DaemonHolder::Cold;
        }
        let raw = owner_file_path().and_then(|p| fs::read_to_string(p).ok());
        let holder = holder_from_probe(true, raw.as_deref(), owner_key, &process_alive);
        if matches!(holder, DaemonHolder::Ours { .. }) {
            return holder;
        }
        // A holder publishes its identity AFTER binding, so a launch landing in
        // that window sees a live port and no file. Poll instead of crying
        // wolf; after the budget, whatever we see is the answer.
        if Instant::now() >= deadline {
            return holder;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Return the daemon's IPC token. Fails closed when the token file is absent —
/// the shell then renders its disconnected state instead of inventing a
/// credential.
#[tauri::command]
fn ipc_token() -> Result<String, String> {
    let path = token_path().ok_or_else(|| "no home directory".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|_| "ipc token not provisioned".to_string())?;
    let token = raw.trim().to_string();
    if token.is_empty() {
        return Err("ipc token is empty".to_string());
    }
    Ok(token)
}

/// TCP reachability — sufficient to answer "is something serving this port?".
/// We deliberately do not authenticate here: the daemon and serve both require
/// credentials, and the shell must not carry any.
fn port_open(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&addr.into(), Duration::from_millis(400)).is_ok()
}

fn wait_for_port(port: u16, budget: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < budget {
        if port_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    port_open(port)
}

/// Resolve the canonical OpenCode CLI: explicit env, else the desktop-bundled
/// 2.0.12 CLI, else bare `opencode` from PATH.
fn resolve_opencode_bin() -> String {
    if let Ok(explicit) = std::env::var("VOXAURA_OPENCODE_BIN") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let cli_root = PathBuf::from(appdata).join("ai.opencode.desktop").join("cli");
        let Ok(entries) = fs::read_dir(&cli_root) else {
            return "opencode".to_string();
        };
        let mut versions: Vec<(Vec<u32>, PathBuf)> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .map(|p| {
                let key = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
                    .split('.')
                    .map(|part| part.parse::<u32>().unwrap_or(0))
                    .collect::<Vec<u32>>();
                (key, p)
            })
            .collect();
        // Numeric compare: 2.0.12 must beat 2.0.6 (lexicographic would not).
        versions.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, dir) in versions.into_iter().rev() {
            let exe = dir.join("opencode-cli.exe");
            if exe.exists() {
                log_line(&format!("opencode binary: {}", exe.display()));
                return exe.to_string_lossy().to_string();
            }
        }
    }
    log_line("opencode binary: falling back to PATH name `opencode`");
    "opencode".to_string()
}

/// Resolve the daemon entrypoint. Precedence:
///   1. explicit VOXAURA_DAEMON_PATH
///   2. the BUNDLED sidecar next to the installed binary (`resources/sidecar/`)
///      — this is the self-contained path for a real install
///   3. `dist/cli.js` from the current directory or up the exe's ancestors
///      (the developer path: a double-clicked binary runs with cwd =
///      target/release, so climbing out is what finds the repo layout)
fn resolve_daemon_entry(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("VOXAURA_DAEMON_PATH") {
        let p = PathBuf::from(explicit);
        if p.exists() {
            return Some(p);
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("sidecar").join("dist").join("cli.js");
        if bundled.exists() {
            return Some(bundled);
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.parent().map(PathBuf::from);
        while let Some(dir) = cursor {
            roots.push(dir.clone());
            cursor = dir.parent().map(PathBuf::from);
        }
    }
    for root in roots {
        let candidate = root.join("dist").join("cli.js");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Windows extended-length paths (`\\?\O:\…`) are rejected by Node's module
/// resolver (`lstat 'O:'` → EISDIR). Strip the prefix before handing a path to
/// the child runtime.
fn plain_path(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
}

/// Canonical vault ROOT for this launch (the same root the Obsidian memory
/// graph uses — one place for keys and notes):
///   1. an explicit VOXAURA_VAULT_DIR
///   2. the `vault/` directory found among the daemon entrypoint's ancestors
///      (the developer/repo layout)
///   3. `%LOCALAPPDATA%\Voxaura\vault` (a real install has no repo to sit in)
fn resolve_vault_dir(entry: Option<&Path>) -> PathBuf {
    if let Ok(explicit) = std::env::var("VOXAURA_VAULT_DIR") {
        if !explicit.trim().is_empty() {
            let dir = PathBuf::from(explicit);
            log_line(&format!("resolve: vault={} (explicit)", dir.display()));
            return dir;
        }
    }
    if let Some(entry) = entry {
        let mut cursor = entry.parent().map(PathBuf::from);
        while let Some(dir) = cursor {
            let candidate = dir.join("vault");
            if candidate.is_dir() {
                log_line(&format!("resolve: vault={} (ancestor)", candidate.display()));
                return candidate;
            }
            cursor = dir.parent().map(PathBuf::from);
        }
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| runtime_dir())
        .unwrap_or_else(|| PathBuf::from("."));
    let root = base.join("Voxaura").join("vault");
    // Ensure the install vault directory exists so key intake has a home, and
    // on first run seed it from a repo vault if one is found among the daemon
    // entrypoint's ancestors (developer upgrade path). Never overwrites.
    let _ = fs::create_dir_all(&root);
    let keyring = root.join("keyring.dat");
    if !keyring.exists() {
        if let Some(entry) = entry {
            let mut cursor = entry.parent().map(PathBuf::from);
            while let Some(dir) = cursor {
                let src = dir.join("vault").join("keyring.dat");
                if src.exists() {
                    if fs::copy(&src, &keyring).is_ok() {
                        log_line(&format!("vault seeded from {}", src.display()));
                    }
                    break;
                }
                cursor = dir.parent().map(PathBuf::from);
            }
        }
    }
    // A security audit found the credential set split: `ipc.token`, `serve.pass`,
    // `owner.key` and `daemon.owner` all get the owner-only protected DACL, and
    // this file - which holds the encrypted provider keys - did not. It is
    // created by `fs::copy` and by `Keyring.save` in `vault.ts`, both of which
    // rely on a Unix `0600` mode that Windows does not translate into an ACL, so
    // the protection was inherited from the profile rather than designed. The
    // vault's own key material is the thing most worth protecting, and the
    // inconsistency was the defect: the rigour existed, it just was not applied
    // here.
    //
    // Applied unconditionally, not only on the seed path, because a vault
    // created by an older install is exactly the case that needs it. `log_line`
    // rather than `?` because failing to lock down a file is not a reason to
    // refuse to launch: the keys are already encrypted, the exposure window is
    // the inherited ACE, and bricking the app would be the worse outcome. It is
    // logged loudly because it must not be invisible.
    if keyring.exists() {
        if let Err(e) = restrict_to_owner(&keyring) {
            log_line(&format!("WARN keyring.dat ACL not restricted: {}", e));
        }
    }
    // The resolved vault is the one path a voice-dead install cannot be
    // diagnosed without. `Keyring.load` throws on an empty or partially
    // undecryptable vault, `rebuildVoice` turns that into a KEYS_MISSING
    // telemetry row, and from the logs alone that row is indistinguishable
    // from "the user never saved keys" — which is the wrong instruction,
    // because re-entering keys changes nothing if the path is wrong.
    log_line(&format!("resolve: vault={} (install default)", root.display()));
    root
}

/// Prefer the bundled Node runtime; fall back to PATH for development.
fn resolve_node_bin(resource_dir: Option<&Path>) -> String {
    if let Ok(explicit) = std::env::var("VOXAURA_NODE_BIN") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("sidecar").join("node.exe");
        if bundled.exists() {
            return plain_path(&bundled);
        }
    }
    "node".to_string()
}

/// Spawn `opencode serve` when 4096 is cold. Returns a human-readable status.
fn ensure_opencode(app: &tauri::AppHandle) -> Result<String, String> {
    // D11: the decision is made explicitly and logged. Adopting is always
    // preferred; a foreign serve is never silently ignored, because two
    // supervisors for one user is a real (and previously invisible) condition.
    let ours: Vec<u32> = {
        let sup = app.state::<Supervisor>();
        sup.pids()
    };
    let candidates = opencode_pids();
    let action = bring_up_action(
        port_open(OPENCODE_PORT),
        foreign_serve_present(&ours, &candidates) == ServeOwnership::Foreign,
    );
    match action {
        BringUpAction::Adopt => {
            return Ok(format!("opencode serve already on {OPENCODE_PORT}"));
        }
        BringUpAction::SpawnAndWarn => {
            log_line(&format!(
                "ensure_opencode: opencode-cli.exe pids {candidates:?} include {} process(es) we did not spawn, and {OPENCODE_PORT} is cold; \
                 this is a second supervisor (the OpenCode desktop app runs its own serve) — spawning ours anyway and recording it",
                candidates.iter().filter(|p| !ours.contains(p)).count()
            ));
        }
        BringUpAction::Spawn => {}
    }
    let bin = resolve_opencode_bin();
    let password = ensure_serve_password()?;
    let mut cmd = Command::new(&bin);
    cmd.args(["serve", "--port", &OPENCODE_PORT.to_string(), "--hostname", "127.0.0.1"])
        .stdin(Stdio::null());
    // D12: both streams captured, so a serve that dies during bring-up is
    // diagnosable instead of vanishing into Stdio::null().
    if let Some(dir) = runtime_dir() {
        let _ = fs::create_dir_all(&dir);
        if let Some(out) = open_child_stdout(&dir, "opencode") {
            cmd.stdout(Stdio::from(out));
        }
        if let Some(err) = open_child_stderr(&dir, "opencode") {
            cmd.stderr(Stdio::from(err));
        }
    }
    cmd.env("OPENCODE_SERVER_PASSWORD", &password);
    // L12: on a bind timeout the child is killed, not abandoned.
    match spawn_and_wait_for_port(&mut cmd, OPENCODE_PORT, Duration::from_secs(20)) {
        BindOutcome::Bound(child) => {
            let supervised = app.state::<Supervisor>().own(child);
            // C7: the child we just spawned was killed because the kernel would
            // not take it, so there is no serve. The old code logged a WARNING
            // and returned Ok("started"), which is the same silent-adoption lie
            // as C2 in a different place: a green step for a process that is
            // already dead.
            if !supervised {
                let msg = format!(
                    "opencode serve could not be job-supervised and was killed; it is NOT running on {OPENCODE_PORT}"
                );
                log_line(&format!("ensure_opencode: WARNING {msg}"));
                return Err(msg);
            }
            Ok(format!("opencode serve started on {OPENCODE_PORT}"))
        }
        BindOutcome::TimedOut { pid } => {
            let hint = if candidates.iter().any(|p| !ours.contains(p)) {
                format!(
                    " (opencode-cli.exe pids {candidates:?} include a process we did not spawn; a second supervisor may hold the OpenCode profile lock)"
                )
            } else {
                String::new()
            };
            Err(format!(
                "opencode serve (pid {pid}) did not open {OPENCODE_PORT} in time; it was killed{hint}"
            ))
        }
        BindOutcome::SpawnFailed(msg) => Err(format!("could not spawn opencode ({bin}): {msg}")),
    }
}

/// Spawn the Node daemon when 4097 is cold. Requires a resolvable entrypoint.
///
/// C2: the "already there" branch used to be `port_open(DAEMON_PORT)`, which
/// adopts ANY holder and reports success. It now asks who the holder is, and an
/// unidentifiable holder is a FAILURE, not an adoption: claiming `ready` on a
/// port held by something that cannot answer the WS-4097 contract leaves the
/// user staring at a disconnected HUD with a green light, and spawning a second
/// daemon there is worse — it can only fail to bind.
fn ensure_daemon(app: &tauri::AppHandle, ipc_token: &str) -> Result<String, String> {
    // Adopted next to the owner key because the whole point is that this file
    // gets a real DACL rather than a Unix mode Windows ignores. Env var, not a
    // path: the daemon must never re-implement the ACL, and a path would invite
    // it to open the file directly.
    let machine_key = ensure_machine_key()?;
    // Resolved before the port probe because the probe needs it to recognise
    // our own daemon, and a key that cannot be created must not be a silent
    // downgrade to "adopt anything".
    let owner_key = ensure_owner_key()?;
    match classify_daemon_holder(DAEMON_PORT, &owner_key) {
        DaemonHolder::Cold => {}
        DaemonHolder::Ours { pid } => {
            log_line(&format!(
                "ensure_daemon: adopted this install's own daemon (pid {pid}) on {DAEMON_PORT}"
            ));
            return Ok(format!("adopted our daemon (pid {pid}) already on {DAEMON_PORT}"));
        }
        DaemonHolder::Foreign { reason } => {
            let msg = format!(
                "something is listening on {DAEMON_PORT} and it is not this install's daemon \
                 ({reason}); refusing to adopt it and refusing to spawn a second daemon over it — \
                 close whatever holds the port (another Voxaura window, a leftover dev server) and retry"
            );
            log_line(&format!("ensure_daemon: REFUSING to adopt {DAEMON_PORT}: {reason}"));
            return Err(msg);
        }
    }
    let resource_dir = app.path().resource_dir().ok();
    log_line(&format!(
        "resolve: resource_dir={:?}",
        resource_dir.as_ref().map(|p| p.display().to_string())
    ));
    let Some(entry) = resolve_daemon_entry(resource_dir.as_deref()) else {
        return Err("daemon entrypoint not found (bundled sidecar missing and VOXAURA_DAEMON_PATH unset)".to_string());
    };
    let node = resolve_node_bin(resource_dir.as_deref());
    log_line(&format!("resolve: node={node} entry={}", plain_path(&entry)));
    let password = ensure_serve_password()?;
    let mut cmd = Command::new(&node);
    cmd.arg(plain_path(&entry))
        .arg("serve")
        .stdin(Stdio::null())
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .env("VOICE_RUNTIME_IPC_TOKEN", ipc_token)
        // C2: the identity the daemon republishes so a LATER launch can tell
        // this daemon apart from anything else holding 4097. Never logged.
        .env("VOXAURA_OWNER_KEY", &owner_key)
    // Hex rather than raw bytes: 32 raw bytes in an env var is awkward to log
    // safely, and hex stays readable in a support diff.
    .env("VOXAURA_MACHINE_KEY", &machine_key)
        .env("VOXAURA_VAULT_DIR", resolve_vault_dir(Some(&entry)));
    // D12: capture BOTH streams. The failure mode this replaces was a silently
    // swallowed File::create error degrading to Stdio::null(), which left a
    // zero-byte daemon-stderr.log across many real spawns.
    if let Some(dir) = runtime_dir() {
        let _ = fs::create_dir_all(&dir);
        match open_child_stdout(&dir, "daemon") {
            Some(out) => {
                cmd.stdout(Stdio::from(out));
            }
            None => {
                log_line("daemon: stdout capture unavailable — continuing without it");
            }
        }
        match open_child_stderr(&dir, "daemon") {
            Some(err) => {
                cmd.stderr(Stdio::from(err));
            }
            None => {
                log_line("daemon: stderr capture unavailable — bring-up failures will be silent");
            }
        }
    } else {
        log_line("daemon: no runtime dir — child logs disabled");
    }
    // L12: a daemon that never opens 4097 is killed rather than left running.
    match spawn_and_wait_for_port(&mut cmd, DAEMON_PORT, Duration::from_secs(20)) {
        BindOutcome::Bound(child) => {
            let supervised = app.state::<Supervisor>().own(child);
            // C7: see `ensure_opencode`. A killed child is not a started daemon,
            // and `ready` must never describe a control plane that is not there.
            if !supervised {
                let msg = format!(
                    "daemon could not be job-supervised and was killed; it is NOT running on {DAEMON_PORT}"
                );
                log_line(&format!("ensure_daemon: WARNING {msg}"));
                return Err(msg);
            }
            Ok(format!("daemon started on {DAEMON_PORT}"))
        }
        BindOutcome::TimedOut { pid } => Err(format!(
            "daemon (pid {pid}) did not open {DAEMON_PORT} in time; it was killed (see daemon.log in the runtime dir)"
        )),
        BindOutcome::SpawnFailed(msg) => Err(format!("could not spawn daemon via {node}: {msg}")),
    }
}

/// Zero-click bring-up: nudge serve, then the daemon, then report. Errors are
/// returned (never panicked) so the UI can surface them.
///
/// L11: returns a typed status. "in-flight" is now distinguishable from
/// "failed" and marked retriable, so the shell can retry once instead of
/// waiting forever on an app that is still starting.
#[tauri::command]
fn ensure_all_services(app: tauri::AppHandle) -> Result<BringUpStatus, String> {
    if BRINGUP_INFLIGHT.swap(true, Ordering::SeqCst) {
        log_line("ensure_all_services: already in flight — skipping duplicate");
        return Ok(BringUpStatus::in_flight());
    }
    let result = (|| -> Result<Vec<String>, String> {
        log_line("ensure_all_services: begin");
        let ipc_token = ensure_ipc_token()?;
        log_line("ipc token: ready");
        let opencode = ensure_opencode(&app)?;
        log_line(&format!("opencode: {opencode}"));
        let daemon = ensure_daemon(&app, &ipc_token)?;
        log_line(&format!("daemon: {daemon}"));
        Ok(vec![opencode, daemon])
    })();
    BRINGUP_INFLIGHT.store(false, Ordering::SeqCst);
    match result {
        Ok(steps) => Ok(BringUpStatus::ready(steps)),
        Err(err) => {
            log_line(&format!("ensure_all_services ERROR: {err}"));
            let sup = app.state::<Supervisor>();
            if sup.unadopted() > 0 {
                log_line(&format!(
                    "ensure_all_services: {} child(ren) could not be job-adopted",
                    sup.unadopted()
                ));
            }
            // C7: `unadopted == 0` used to be read as "supervision is fine". It
            // is not: a machine that could not create the Job Object at all never
            // increments it, because there is nothing to refuse a child from.
            if sup.no_job() > 0 {
                log_line(&format!(
                    "ensure_all_services: CreateJobObjectW failed — {} child(ren) were unsupervisable and every future child will be too",
                    sup.no_job()
                ));
            }
            Ok(BringUpStatus::failed(&err))
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 2 TDD — process supervision and log capture.
//
// The defects these cover were all invisible from the outside: a discarded
// BOOL, a silently swallowed io::Error, and a status string that could not
// distinguish "someone else is already doing this" from "it failed".
// ---------------------------------------------------------------------------
#[cfg(test)]
mod phase2_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "voxaura-phase2-{tag}-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    // ---- D10: Job Object adoption must not be fire-and-forget -------------

    #[test]
    fn adoption_success_keeps_the_child() {
        // The historical code was `let _ = AssignProcessToJobObject(..)`, so a
        // child that failed to join the job was still tracked and still
        // believed to be supervised.
        assert_eq!(adoption_action(Adoption::from_bool(true, 1)), AdoptionAction::Keep);
    }

    #[test]
    fn adoption_failure_kills_the_child() {
        assert_eq!(adoption_action(Adoption::from_bool(false, 1)), AdoptionAction::Kill);
    }

    /// C7: the swallowed case. A `None` job is a FAILURE to adopt, and this is
    /// the assertion the old `is_none_or` code contradicts: `None` used to be
    /// read as "adopted".
    #[test]
    fn c7_a_missing_job_is_never_reported_as_an_adoption() {
        assert_eq!(
            adoption_action(Adoption::NoJob { pid: 4242 }),
            AdoptionAction::Kill,
            "a job object that could not be created cannot adopt anything; reporting Keep here is \
             exactly the C7 defect"
        );
        assert_ne!(Adoption::NoJob { pid: 1 }, Adoption::Adopted);
        assert_ne!(Adoption::Refused { pid: 1 }, Adoption::NoJob { pid: 1 });
    }

    /// C7, behavioural and against a REAL child. `with_unavailable_job` puts the
    /// supervisor in the state of a machine where `CreateJobObjectW` failed, so
    /// `own()` walks the real `None` arm. Reinstating `is_none_or` makes this
    /// fail on the very first assertion (`supervised` was `true`) and again on
    /// the child count, which is the orphan the defect produced.
    #[cfg(windows)]
    #[test]
    fn c7_a_job_that_cannot_be_created_is_surfaced_and_the_child_is_killed() {
        let sup = Supervisor::with_unavailable_job();
        let child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn probe child");
        let pid = child.id();
        let supervised = sup.own(child);
        assert!(
            !supervised,
            "a supervisor with no job object must NOT report the child as supervised"
        );
        assert_eq!(
            sup.no_job(),
            1,
            "the creation failure must be surfaced in its own counter, not folded into `unadopted`"
        );
        assert_eq!(
            sup.unadopted(),
            0,
            "`unadopted` counts kernel refusals; a creation failure is a different fault and \
             leaving this at 0 is what made the failure invisible"
        );
        assert_eq!(
            sup.child_count(),
            0,
            "an unsupervisable child must not be recorded as supervised"
        );
        std::thread::sleep(Duration::from_millis(400));
        assert!(!process_alive(pid), "an unsupervisable child must be killed, not left running");
    }

    /// C7, control: a machine that CAN create the job still adopts normally, so
    /// the guard above is not a blanket "always refuse".
    #[cfg(windows)]
    #[test]
    fn c7_a_healthy_job_is_still_adopted_and_counts_no_failure() {
        let sup = Supervisor::default();
        let child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn probe child");
        assert!(sup.own(child), "a working Job Object must still adopt a live child");
        assert_eq!(sup.no_job(), 0);
        assert_eq!(sup.unadopted(), 0);
        assert_eq!(sup.child_count(), 1);
        sup.reap();
    }

    #[test]
    fn supervisor_own_reports_adoption_and_tracks_the_child() {
        let sup = Supervisor::default();
        let child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn probe child");
        let ok = sup.own(child);
        #[cfg(windows)]
        {
            // A real Job Object on a real child must succeed; if this fails the
            // orphan-hardening in D10 is not actually working.
            assert!(ok, "a live child must be adopted by the job");
            assert_eq!(sup.unadopted(), 0);
        }
        #[cfg(not(windows))]
        {
            let _ = ok;
        }
        assert_eq!(sup.child_count(), 1);
        sup.reap();
        assert_eq!(sup.child_count(), 0);
    }

    #[test]
    fn unadopted_children_are_killed_immediately_not_merely_counted() {
        // A child the kernel will not reap on our death is an orphan the moment
        // we exit. Counting it is not enough; it must be killed.
        let sup = Supervisor::default();
        let child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn probe child");
        let pid = child.id();
        // Simulate the failure branch without needing a real assignment error.
        sup.own_with_adoption(child, Adoption::Refused { pid });
        assert_eq!(sup.unadopted(), 1);
        assert_eq!(
            sup.no_job(),
            0,
            "a kernel refusal is not a job-creation failure; the two must not share a counter"
        );
        assert_eq!(sup.child_count(), 0, "an unadopted child must not be tracked as supervised");
        // Give the kernel a moment to reap it, then assert the PID is gone.
        std::thread::sleep(Duration::from_millis(400));
        assert!(!process_alive(pid), "an unadopted child must be killed, not left running");
    }

    // ---- C2: "something is on 4097" is not "our daemon is on 4097" --------

    /// A marker as the daemon publishes it. `owner` is the install key.
    fn owner_json(pid: u32, owner: &str) -> String {
        format!(
            r#"{{"v":{DAEMON_OWNER_VERSION},"pid":{pid},"ipcPort":4097,"contractVersion":"3.1.0","ownerKey":"{owner}"}}"#
        )
    }

    const KEY: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

    #[test]
    fn c2_a_cold_port_is_cold() {
        assert_eq!(
            holder_from_probe(false, None, KEY, &|_| true),
            DaemonHolder::Cold
        );
        // A marker left over from a dead daemon must not make a COLD port look
        // occupied — that would spawn nothing and report a healthy daemon.
        assert_eq!(
            holder_from_probe(false, Some(&owner_json(4242, KEY)), KEY, &|_| true),
            DaemonHolder::Cold
        );
    }

    /// The two cases the defect merged, in one test so the distinction cannot
    /// be narrowed away later.
    #[test]
    fn c2_our_own_live_daemon_is_told_apart_from_a_bare_tcp_holder() {
        let ours = holder_from_probe(true, Some(&owner_json(4242, KEY)), KEY, &|p| p == 4242);
        assert_eq!(ours, DaemonHolder::Ours { pid: 4242 }, "a marker that matches this install and names a live pid IS our daemon");

        // The exact live defect: the port answers, nothing published an identity.
        // `port_open` alone said "daemon already on 4097" and the status was
        // `ready`.
        let squatter = holder_from_probe(true, None, KEY, &|_| true);
        assert!(
            matches!(squatter, DaemonHolder::Foreign { .. }),
            "a holder that never received this install's identity must not be adopted"
        );
    }

    #[test]
    fn c2_a_marker_from_another_install_is_refused() {
        // Another user's Voxaura, or a second install on this machine. It IS a
        // daemon, but not OURS, and adopting it means the webview would present
        // a token this install cannot use.
        let holder = holder_from_probe(true, Some(&owner_json(4242, "some-other-key")), KEY, &|p| {
            p == 4242
        });
        match holder {
            DaemonHolder::Foreign { reason } => {
                assert!(reason.contains("identity"), "the reason must say why: {reason}");
            }
            other => panic!("expected Foreign, got {other:?}"),
        }
    }

    #[test]
    fn c2_a_stale_marker_naming_a_dead_pid_is_refused() {
        // Our daemon is gone; something else has the port; the file on disk still
        // names the old pid. This is silent adoption wearing a live marker.
        let holder = holder_from_probe(true, Some(&owner_json(4242, KEY)), KEY, &|_| false);
        match holder {
            DaemonHolder::Foreign { reason } => {
                assert!(reason.contains("not running"), "the reason must say why: {reason}");
            }
            other => panic!("expected Foreign, got {other:?}"),
        }
    }

    #[test]
    fn c2_a_malformed_or_wrong_version_marker_is_refused_not_parsed_loosely() {
        for raw in [
            "",
            "not json at all",
            r#"{"v":1,"pid":4242}"#,                       // no ownerKey
            r#"{"pid":4242,"ownerKey":"k"}"#,               // no version
            r#"{"v":99,"pid":4242,"ownerKey":"k"}"#,        // future version
            r#"{"v":1,"pid":0,"ownerKey":"k"}"#,            // impossible pid
        ] {
            let holder = holder_from_probe(true, Some(raw), KEY, &|_| true);
            assert!(
                matches!(holder, DaemonHolder::Foreign { .. }),
                "marker {raw:?} must be refused, got {holder:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn c2_a_real_listener_with_no_marker_classifies_as_foreign() {
        // The end-to-end form: a REAL process holds a REAL port and the decision
        // is made through the production probe. Nothing is mocked, so this is
        // the case the defect described rather than a description of it.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind squatter port");
        let port = listener.local_addr().unwrap().port();
        // A bare accept-loop stands in for "any process with the socket": it
        // speaks no protocol, but it makes `port_open` true, which is the whole
        // of what the old probe knew. The loop (not a single accept) is load
        // bearing — one accept and the listener is dropped, which closes the
        // port and turns the case back into `Cold`.
        std::thread::spawn(move || {
            while listener.accept().is_ok() {}
        });

        let open = port_open(port);
        assert!(open, "the probe must see the real holder");
        let holder = holder_from_probe(open, None, KEY, &process_alive);
        match holder {
            DaemonHolder::Foreign { reason } => {
                assert!(reason.contains("identity"), "unexpected reason: {reason}");
            }
            other => panic!("a bare TCP holder must never be adopted, got {other:?}"),
        }
    }

    #[test]
    fn c2_the_ensure_daemon_status_words_are_distinguishable() {
        // A refusal has to reach the UI as a failure. `Ok("daemon already on
        // 4097")` for a stranger is the lie; the refusal must therefore be an
        // `Err` string that names the port and the reason.
        let holder = holder_from_probe(true, None, KEY, &|_| true);
        let DaemonHolder::Foreign { reason } = holder else {
            panic!("expected a foreign holder");
        };
        let msg = format!(
            "something is listening on {DAEMON_PORT} and it is not this install's daemon ({reason}); refusing to adopt it"
        );
        assert!(msg.contains("4097"), "the message must name the port: {msg}");
        assert!(!msg.contains("ready"), "a refusal must not read as a success: {msg}");
    }

    /// The liveness leg, against the real kernel — and the one place where the
    /// naive implementation is wrong.
    ///
    /// Measured on this machine: `tasklist /FI "PID eq 0" /NH /FO CSV` prints
    /// `"System Idle Process","0","Services","0","8 K"`, so `process_alive(0)`
    /// is TRUE on Windows even though pid 0 is not a process anything can be.
    /// A marker naming pid 0 would therefore sail through a liveness check,
    /// which is why `holder_from_probe` rejects it before asking. Deleting that
    /// guard makes this test fail.
    #[cfg(windows)]
    #[test]
    fn c2_pid_zero_is_refused_even_though_the_os_calls_it_alive() {
        assert!(
            process_alive(0),
            "tasklist really does report System Idle Process as pid 0 — if this ever stops \
             holding, the pid-0 guard is merely belt-and-braces, not load-bearing"
        );
        let holder = holder_from_probe(true, Some(&owner_json(0, KEY)), KEY, &process_alive);
        match holder {
            DaemonHolder::Foreign { reason } => {
                assert!(reason.contains("pid 0"), "the reason must name the pid: {reason}");
            }
            other => panic!("a marker naming pid 0 must be refused, got {other:?}"),
        }
    }

    /// The liveness leg against a real death, not a fake pid: a child we spawn
    /// and reap must read as gone, or the stale-marker refusal is theatre.
    #[cfg(windows)]
    #[test]
    fn c2_a_reaped_child_reads_as_not_running() {
        let mut child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn probe child");
        let pid = child.id();
        assert!(process_alive(pid), "a running child must read as alive");
        let _ = child.kill();
        let _ = child.wait();
        std::thread::sleep(Duration::from_millis(400));
        assert!(!process_alive(pid), "a reaped child must read as gone");
    }

    // ---- D12: child stdout AND stderr must land somewhere diagnosable ----

    #[test]
    fn child_logs_use_the_canonical_file_when_it_can_be_opened() {
        let dir = temp_dir("logs-primary");
        match plan_child_logs(&dir, "daemon") {
            LogPlan::Primary(path) => {
                assert_eq!(path, dir.join("daemon.log"));
                assert!(path.exists());
            }
            other => panic!("expected Primary, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn child_logs_fall_back_to_a_unique_file_instead_of_going_silent() {
        // The live defect: `fs::File::create` failed (a handle held by a prior
        // daemon) and the code silently degraded to `Stdio::null()`, so the
        // daemon's stderr vanished with no trace. A directory squatting on the
        // canonical name reproduces that failure deterministically.
        let dir = temp_dir("logs-fallback");
        let _ = fs::create_dir_all(dir.join("daemon.log"));
        match plan_child_logs(&dir, "daemon") {
            LogPlan::Fallback(path) => {
                assert_ne!(path, dir.join("daemon.log"));
                assert!(path.exists(), "the fallback file must actually be created");
                assert!(path.to_string_lossy().contains("daemon-"));
            }
            other => panic!("expected Fallback, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn child_logs_report_both_errors_when_no_file_can_be_created() {
        let dir = temp_dir("logs-unavailable").join("does-not-exist");
        match plan_child_logs(&dir, "daemon") {
            LogPlan::Unavailable(msg) => {
                assert!(msg.contains("daemon"), "the message must name what failed: {msg}");
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn child_logs_are_append_only_so_a_restart_cannot_erase_the_cause() {
        // `File::create` truncates. A restart that failed for a different reason
        // would destroy the evidence of the previous failure.
        let dir = temp_dir("logs-append");
        let path = dir.join("daemon.log");
        fs::write(&path, b"first run evidence").unwrap();
        assert!(matches!(plan_child_logs(&dir, "daemon"), LogPlan::Primary(_)));
        assert_eq!(fs::read(&path).unwrap(), b"first run evidence");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn both_streams_are_captured_never_nulled() {
        let dir = temp_dir("logs-both");
        let out = open_child_stdout(&dir, "daemon");
        let err = open_child_stderr(&dir, "daemon");
        assert!(out.is_some(), "stdout must be captured, not nulled");
        assert!(err.is_some(), "stderr must be captured, not nulled");
        // Two distinct files, so the two streams do not interleave into one.
        // `File` has no PartialEq, so compare the paths we opened.
        assert_ne!(
            dir.join("daemon-stdout.log"),
            dir.join("daemon.log"),
            "stdout and stderr must not share a file"
        );
        assert!(dir.join("daemon-stdout.log").exists());
        assert!(dir.join("daemon.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn child_output_actually_lands_in_the_captured_files() {
        // The D12 proof. Asserting only that the files were created would not
        // show that the handle is wired to the child at all — which is the
        // whole question, since the original bug produced a zero-byte file that
        // nobody could tell apart from "the child was quiet".
        let dir = temp_dir("logs-bytes");
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "echo STDOUT_MARKER & echo STDERR_MARKER 1>&2"])
            .stdin(Stdio::null())
            .stdout(Stdio::from(open_child_stdout(&dir, "probe").expect("stdout file")))
            .stderr(Stdio::from(open_child_stderr(&dir, "probe").expect("stderr file")));
        let mut child = cmd.spawn().expect("spawn");
        let _ = child.wait();
        let out = fs::read_to_string(dir.join("probe-stdout.log")).unwrap_or_default();
        let err = fs::read_to_string(dir.join("probe.log")).unwrap_or_default();
        assert!(out.contains("STDOUT_MARKER"), "stdout was not captured; got {out:?}");
        assert!(err.contains("STDERR_MARKER"), "stderr was not captured; got {err:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_second_child_appends_rather_than_erasing_the_first_failure() {
        // Append-mode is the reason a restart cannot destroy the evidence of
        // the previous one.
        let dir = temp_dir("logs-append-real");
        for marker in ["FIRST", "SECOND"] {
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", &format!("echo {marker}")])
                .stdin(Stdio::null())
                .stdout(Stdio::from(open_child_stdout(&dir, "app").expect("stdout file")))
                .stderr(Stdio::from(open_child_stderr(&dir, "app").expect("stderr file")));
            let mut child = cmd.spawn().expect("spawn");
            let _ = child.wait();
        }
        let combined = format!(
            "{}{}",
            fs::read_to_string(dir.join("app-stdout.log")).unwrap_or_default(),
            fs::read_to_string(dir.join("app.log")).unwrap_or_default()
        );
        assert!(combined.contains("FIRST"), "the first run's evidence was erased");
        assert!(combined.contains("SECOND"), "the second run was not captured");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- D11: one supervisor, and make a duplicate visible ---------------

    #[test]
    fn a_process_we_did_not_spawn_is_a_foreign_supervisor() {
        // The live condition: PID 19516 was `opencode-cli.exe serve --service`
        // on :49374 while nothing held 4096. Our own list is empty at bring-up
        // time, so any candidate is foreign.
        assert_eq!(foreign_serve_present(&[], &[19516]), ServeOwnership::Foreign);
    }

    #[test]
    fn only_our_own_children_are_not_foreign() {
        // After we spawn, our PID must stop counting as foreign, or every
        // subsequent bring-up would warn about itself.
        assert_eq!(foreign_serve_present(&[4242], &[4242]), ServeOwnership::NotForeign);
        assert_eq!(foreign_serve_present(&[4242], &[4242, 19516]), ServeOwnership::Foreign);
    }

    #[test]
    fn no_candidates_means_no_foreign_serve() {
        assert_eq!(foreign_serve_present(&[], &[]), ServeOwnership::NotForeign);
    }

    #[cfg(windows)]
    #[test]
    fn opencode_pids_parses_tasklist_csv_and_ignores_the_no_match_banner() {
        // tasklist with no match prints a prose banner, not CSV. Parsing that as
        // a PID would report a phantom foreign supervisor on every clean boot.
        let sample = "\"opencode-cli.exe\",\"19516\",\"Console\",\"1\",\"422,116 K\"\r\n";
        let pids: Vec<u32> = sample
            .lines()
            .filter_map(|line| line.split("\",\"").nth(1))
            .filter_map(|pid| pid.trim().parse::<u32>().ok())
            .collect();
        assert_eq!(pids, vec![19516]);

        let banner = "INFO: No tasks are running which match the specified criteria.\r\n";
        let none: Vec<u32> = banner
            .lines()
            .filter_map(|line| line.split("\",\"").nth(1))
            .filter_map(|pid| pid.trim().parse::<u32>().ok())
            .collect();
        assert!(none.is_empty(), "the no-match banner must not parse as a pid");
    }

    #[cfg(windows)]
    #[test]
    fn opencode_pids_runs_against_this_machine_without_erroring() {
        // Best-effort by contract: whatever this machine reports, it must not
        // panic and must return a well-formed list.
        let pids = opencode_pids();
        assert!(pids.iter().all(|p| *p > 0));
    }

    #[test]
    fn adoption_is_preferred_over_a_second_spawn() {
        // When 4096 already answers, we adopt it. Spawning a second serve would
        // be the duplicate-supervisor bug.
        assert_eq!(bring_up_action(true, false), BringUpAction::Adopt);
        // Even with a foreign process present, an open port means adopt.
        assert_eq!(bring_up_action(true, true), BringUpAction::Adopt);
    }

    #[test]
    fn a_cold_port_with_a_foreign_serve_is_spawned_but_flagged() {
        // Refusing to spawn would break the app for anyone with the OpenCode
        // desktop app running, which is a worse failure than the duplication.
        // The duplicate must instead be visible in the log and the status.
        assert_eq!(bring_up_action(false, true), BringUpAction::SpawnAndWarn);
    }

    #[test]
    fn a_cold_port_with_no_foreign_serve_just_spawns() {
        assert_eq!(bring_up_action(false, false), BringUpAction::Spawn);
    }

    // ---- L11: the frontend must be able to tell "busy" from "failed" ------

    #[test]
    fn in_flight_is_reported_as_retriable_not_as_success_or_failure() {
        // The old contract returned Ok(vec!["bring-up already in flight"]), which
        // the UI could not distinguish from real progress, and never retried.
        let s = BringUpStatus::in_flight();
        assert_eq!(s.state, "in-flight");
        assert!(s.retriable, "in-flight must be retriable or the app silently never starts");
        assert!(s.detail.contains("in flight"));
    }

    #[test]
    fn a_real_failure_is_not_retriable_and_carries_the_reason() {
        let s = BringUpStatus::failed("daemon did not open 4097 in time");
        assert_eq!(s.state, "failed");
        assert!(!s.retriable);
        assert!(s.detail.contains("4097"));
    }

    #[test]
    fn success_reports_each_step() {
        let s = BringUpStatus::ready(vec!["opencode serve started on 4096".to_string()]);
        assert_eq!(s.state, "ready");
        assert!(!s.retriable);
        assert_eq!(s.steps.len(), 1);
    }

    #[test]
    fn status_serialises_with_the_fields_the_shell_reads() {
        let json = serde_json::to_string(&BringUpStatus::in_flight()).unwrap();
        assert!(json.contains("\"state\":\"in-flight\""));
        assert!(json.contains("\"retriable\":true"));
    }

    // ---- L12: a child that never binds must be killed, not leaked ---------

    #[cfg(windows)]
    #[test]
    fn a_child_that_never_binds_is_killed_and_reported_as_timed_out() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "ping -n 60 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let outcome = spawn_and_wait_for_port(&mut cmd, 1, Duration::from_millis(900));
        let BindOutcome::TimedOut { pid } = outcome else {
            panic!("expected TimedOut");
        };
        std::thread::sleep(Duration::from_millis(400));
        assert!(
            !process_alive(pid),
            "a serve that never opened its port must be killed, not left running"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_child_that_does_bind_is_returned_for_supervision() {
        // Hold the port ourselves so the probe succeeds immediately.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind probe port");
        let port = listener.local_addr().unwrap().port();
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let outcome = spawn_and_wait_for_port(&mut cmd, port, Duration::from_millis(900));
        assert!(matches!(outcome, BindOutcome::Bound(_)), "expected Bound, got {outcome:?}");
        if let BindOutcome::Bound(mut child) = outcome {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[test]
    fn a_command_that_cannot_spawn_is_reported_not_panicked() {
        let mut cmd = Command::new("definitely-not-a-real-binary-9f3a");
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        match spawn_and_wait_for_port(&mut cmd, 1, Duration::from_millis(200)) {
            BindOutcome::SpawnFailed(msg) => assert!(msg.contains("could not spawn")),
            other => panic!("expected SpawnFailed, got {other:?}"),
        }
    }

    /// The resolved vault must be logged on EVERY path, not just the last.
    ///
    /// A voice-dead installed build reports `KEYS_MISSING` in telemetry and
    /// nothing else: the daemon cannot say which file it tried, so the row is
    /// indistinguishable from "the user never saved keys" — the wrong
    /// instruction, because re-entering keys changes nothing if the path is
    /// wrong. This was found the hard way: the first launch after an install
    /// emitted `KEYS_MISSING` with a vault that plainly held three keys, and
    /// the logs could not say why.
    ///
    /// The log was originally on the final `return` only, so the explicit-env
    /// and ancestor branches returned before reaching it. This asserts all
    /// three branches report, which is the property that matters.
    #[test]
    fn every_vault_resolution_branch_is_logged() {
        // Scoped to the function body on purpose. A file-wide count also matches
        // the string literals in this test, which made the first version of it
        // fail on itself - a reminder that a "count the occurrences" assertion
        // needs a scope that excludes the assertion.
        let src = include_str!("main.rs");
        let body = src
            .split("fn resolve_vault_dir")
            .nth(1)
            .and_then(|rest| rest.split("fn resolve_node_bin").next())
            .expect("resolve_vault_dir body");

        // One log line per branch: explicit, ancestor, install default.
        let logged = body.matches("resolve: vault=").count();
        assert_eq!(
            logged, 3,
            "resolve_vault_dir has 3 return paths (explicit, ancestor, install \
             default) and each must log its result; found {logged}"
        );

        let returns: Vec<&str> = body
            .lines()
            .filter(|l| l.trim_start().starts_with("return "))
            .collect();
        // Two explicit `return`s; the third path (install default) is the
        // function's tail expression, so it is asserted by the log count above
        // and by the final-statement check below rather than here.
        assert_eq!(returns.len(), 2, "expected 2 explicit returns, found {}", returns.len());
        for l in returns {
            let preceding = body.split(l).next().unwrap_or_default();
            assert!(
                preceding.contains("resolve: vault="),
                "a return path has no log line next to it: {}",
                l.trim()
            );
        }

        // The install-default branch is the tail expression, so it is covered by
        // the log count above. Asserting its exact position was tried and
        // removed: it couples the test to the wording of a format string, so a
        // harmless reword fails it while a real unlogged return still would not
        // be the thing that broke.
    }

    // ---- helpers -------------------------------------------------------
    //
    // `process_alive` used to live here. It is production code now (C2): a
    // `daemon.owner` left behind by a dead daemon is exactly the case the
    // holder classification must refuse, so it sits at module scope beside the
    // probe that uses it and is shared by the tests.
}

// ---------------------------------------------------------------------------
// Dossier S2: the supervisor's secret generation.
//
// Two defects are covered here, and neither was ever executed by any runner
// before this module existed, which is exactly why both shipped:
//
//   * `ipc.token` and `serve.pass` were filled by an xorshift64* whose state
//     was `nanos_since_epoch ^ pid`. Both inputs are observable, and all 32
//     bytes came out of four PRNG steps, so a 256-bit-looking secret was really
//     a ~2^30-bit one that anyone who knew roughly when the app launched could
//     regenerate offline.
//   * the `fs::write` calls set no access control at all, while the doc
//     comments above them claimed `(0600)`. On Windows `0o600` could not have
//     worked either way: `fs::set_permissions` is `SetFileAttributes` there
//     and only toggles FILE_ATTRIBUTE_READONLY.
//
// The guard is deliberately layered, because no single technique is sufficient:
// a statistical test cannot tell a CSPRNG from a well-seeded PRNG on one
// sample, and a source scan is defeated by renaming. So there is an exact
// reproduction of the historical generator (behavioural), a static scan that
// rejects the algorithm's fingerprints (structural), and a format/uniqueness
// sanity check (property).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod s2_secret_tests {
    use super::*;

    fn secret_file(tag: &str, name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "voxaura-s2-{tag}-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = fs::create_dir_all(&dir);
        dir.join(name)
    }

    /// The historical generator, transcribed exactly from the pre-S2 code
    /// (`main.rs:460-476` and `:501-517` as they stood before this change).
    ///
    /// Its output is byte-for-byte what the old production code produced for a
    /// given seed, which is what makes it usable both as a reproduction and as
    /// a positive control for the attack in
    /// `generated_secrets_are_not_reproducible_from_the_old_seed`.
    fn historical_xorshift_hex(seed_in: u64) -> String {
        let mut bytes = [0u8; 32];
        let mut seed = seed_in;
        for chunk in bytes.chunks_mut(8) {
            xorshift64_step(&mut seed);
            for (i, b) in chunk.iter_mut().enumerate() {
                *b = ((seed >> (i * 8)) & 0xff) as u8;
            }
        }
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// POSITIVE CONTROL for the primary guard: prove the attack actually breaks
    /// the real historical generator.
    ///
    /// A guard that has never been observed to catch the thing it guards is not
    /// a guard. This builds a secret exactly as the old code would have, from a
    /// seed of the same shape (`nanos ^ pid`), and asserts the recovery in
    /// `recover_seed_if_xorshift` gets the seed back and that the `nanos ^ pid`
    /// consistency check accepts it. If this ever passes silently on a `None`
    /// recovery, the primary guard downstream is vacuous.
    #[test]
    fn the_attack_does_break_the_historical_generator() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        for pid in [1u64, 4, 1234, 4242, 65_535] {
            let seed = nanos ^ pid;
            let secret = historical_xorshift_hex(seed);
            assert_eq!(secret.len(), 64, "historical generator must still emit 64 hex chars");
            let recovered = recover_seed_if_xorshift(&secret)
                .expect("a secret from the historical generator must be recoverable");
            assert_eq!(
                recovered, seed,
                "recovered the wrong seed for pid {pid}: the attack is broken"
            );
            // And the exact predicate the primary guard uses must accept it.
            let back = (recovered ^ pid) as u128;
            assert!(
                back == nanos as u128,
                "the nanos^pid consistency check must accept a genuine hit"
            );
        }
        // Deliberately NOT asserted: that a real CSPRNG secret fails recovery.
        // A random 64-bit word round-trips through the inverse for any output
        // with probability 2^-64, so a strict `is_none()` would be a flaky
        // assertion in the 1-in-1.8e19 direction. The primary guard tolerates
        // this because it also requires the recovered seed to be consistent
        // with the observed clock window and an enumerable pid, which a random
        // 64-bit value satisfies with probability ~2^-32 per sample.
    }

    /// One forward xorshift64* step, exactly as the historical code performed
    /// it. Split out so the inverse below can be self-tested against it.
    fn xorshift64_step(seed: &mut u64) {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
    }

    /// The inverse of one `xorshift64_step`.
    ///
    /// The transform is linear over GF(2) and therefore invertible. Each
    /// `x ^= x << k` is undone by iterating `x = y ^ (x << k)` until every bit
    /// has been reached (ceil(64/k) rounds), and — critically — the three
    /// stages must be undone in REVERSE order: 17, then 7, then 13. Doing them
    /// in forward order is the obvious mistake and yields a wrong inverse; the
    /// self-test in the guard below is what caught it.
    fn xorshift64_unstep(y: u64) -> u64 {
        let mut a = y;
        for _ in 0..4 {
            a = y ^ (a << 17); // 17 * 4 >= 64
        }
        let mut b = a;
        for _ in 0..10 {
            b = a ^ (b >> 7); // 7 * 10 >= 64
        }
        let mut c = b;
        for _ in 0..5 {
            c = b ^ (c << 13); // 13 * 5 >= 64
        }
        c
    }

    /// Recover the 64-bit xorshift state that produced `secret`, if it could
    /// have been produced by the historical generator.
    ///
    /// The old code emitted, for each 8-byte chunk, the bytes of a single
    /// advanced state word, least-significant byte first. So the FIRST 8 bytes
    /// of the output are exactly `state_after_step_1`, and undoing one step
    /// yields the seed itself. No brute force over the 2^64 seed space is
    /// needed — the output leaks its own seed. That is the whole point of the
    /// finding: the "32 random bytes" carried only 64 bits of state.
    fn recover_seed_if_xorshift(secret: &str) -> Option<u64> {
        if secret.len() < 16 {
            return None;
        }
        let mut first = [0u8; 8];
        for (i, b) in first.iter_mut().enumerate() {
            *b = u8::from_str_radix(&secret[i * 2..i * 2 + 2], 16).ok()?;
        }
        let state1 = u64::from_le_bytes(first);
        let seed0 = xorshift64_unstep(state1);
        // Only accept a recovery that actually round-trips: this both filters
        // accidental CSPRNG output and proves the inverse is correct here.
        let mut check = seed0;
        xorshift64_step(&mut check);
        if check == state1 {
            Some(seed0)
        } else {
            None
        }
    }

    /// THE PRIMARY GUARD. Fails if the xorshift64* is reinstated.
    ///
    /// This is an attack, not a guess. For each live secret it recovers the
    /// candidate 64-bit seed, then checks whether that seed could have been
    /// `nanos_since_epoch ^ pid` for ANY pid in 1..=65535 during the window in
    /// which the secret was actually generated (bracketed by real clock reads
    /// taken immediately around the generation). If the weak generator is
    /// present, the recovered seed matches for the true pid and this fails.
    ///
    /// There are no hardcoded timestamps. An earlier version of this test swept
    /// a guessed `base` constant and was verified to PASS against a reinstated
    /// xorshift — a vacuous guard. This version derives the clock window from
    /// the clock at run time, so it cannot drift.
    #[test]
    fn generated_secrets_are_not_reproducible_from_the_old_seed() {
        // Self-test the inverse before relying on it.
        for probe in [
            0u64,
            1,
            0x9E37_79B9_7F4A_7C15,
            0xdead_beef_cafe_babe,
            u64::MAX,
        ] {
            let mut s = probe;
            xorshift64_step(&mut s);
            assert_eq!(
                xorshift64_unstep(s),
                probe,
                "the seed-recovery inverse is wrong, so this guard would be vacuous"
            );
        }

        let nanos_now = || -> u128 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        };

        const SAMPLES: usize = 16;
        let mut hits: Vec<(usize, u64, u64)> = Vec::new();
        for sample in 0..SAMPLES {
            let before = nanos_now();
            let secret = generate_secret().expect("csprng");
            let after = nanos_now();
            let Some(seed) = recover_seed_if_xorshift(&secret) else {
                continue; // not xorshift-shaped: exactly what a CSPRNG gives
            };
            // Was this seed = nanos ^ pid for some plausible pid, with the
            // clock reading landing in the window we actually observed?
            for pid in 1..=65_535u64 {
                let nanos = (seed ^ pid) as u128;
                if nanos >= before && nanos <= after {
                    hits.push((sample, seed, pid));
                    break;
                }
            }
        }

        assert!(
            hits.is_empty(),
            "a generated secret is reproducible from the historical xorshift64* seed \
             (nanos ^ pid): {hits:?}. The weak generator is back."
        );
    }

    /// Structural guard: the algorithm's fingerprints must not reappear.
    ///
    /// The needles are assembled from fragments so this module's own source
    /// does not contain them — otherwise the scan would match the guard itself,
    /// which is the self-matching failure documented at `main.rs:1285`.
    #[test]
    fn the_weak_generator_has_not_been_reinstated() {
        let src = include_str!("main.rs");
        // Scope to production code only.
        //
        // This must split at the first *test module*, NOT at the first
        // `#[cfg(test)]`: the latter is `Supervisor::child_count` at line 395,
        // which sits ABOVE the secret machinery, so splitting there would scope
        // the guard to a region that does not contain the code being guarded and
        // every assertion would pass vacuously. `mod phase2_tests` is the first
        // module, and everything before it is production.
        let body = src
            .split("mod phase2_tests")
            .next()
            .expect("production code precedes the first test module");
        // The guarded functions must actually be inside that region, or every
        // assertion below would pass vacuously.
        assert!(
            body.contains("fn generate_secret"),
            "guard scope regression: the secret generator is not in the scanned region"
        );
        let code = code_only(body);

        // The algorithm's CODE fingerprints. These cannot appear in prose, so
        // unlike the bare word "xorshift" they do not fire on the comments that
        // document what was replaced. Any faithful reinstatement contains them.
        for (needle, what) in [
            ("^= seed", "the xorshift state update"),
            ("<< 13", "the xorshift shift constant"),
            ("chunks_mut(8)", "the 4-step chunked emission loop"),
        ] {
            assert!(
                !code.contains(needle),
                "{what} is back in production code ({needle}); the S2 fix was reverted"
            );
        }
        // The self-acknowledging comment the old generator carried.
        assert!(
            !body.contains("sourced without extra crates"),
            "the pre-S2 generator comment is back"
        );
        // "as_nanos" is the clock half of the old seed and appears in no other
        // production code in this file.
        assert!(
            !code.contains(&["as_nan", "os"].concat()),
            "a nanosecond clock is read to seed a secret again; the S2 fix was reverted"
        );

        // Positive controls: the fix must actually be wired in, or every
        // assertion above would pass vacuously on an empty implementation.
        assert!(body.contains("getrandom::fill"), "generate_secret must call the CSPRNG");
        assert!(
            body.contains("restrict_to_owner"),
            "secrets must be locked down with restrict_to_owner"
        );
        assert!(
            body.contains("SetNamedSecurityInfoW") && body.contains("PROTECTED_DACL_SECURITY_INFORMATION"),
            "the owner-only DACL is not actually applied"
        );
    }

    /// Strip comment lines so the source guards below inspect CODE rather than
    /// prose. The comments in this file deliberately *describe* the historical
    /// defect (naming the old algorithm, naming `0600`), and a naive
    /// `src.contains("xorshift")` therefore fires on the explanation of the fix
    /// rather than on the fix itself — the self-matching failure mode already
    /// documented at `main.rs:1285`.
    fn code_only(src: &str) -> String {
        src.lines()
            .filter(|l| {
                let t = l.trim_start();
                !(t.starts_with("//") || t.starts_with("/*") || t.starts_with('*'))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Drop backtick-quoted spans, so a comment that *names* a value to say what
    /// it is NOT (`0o600` is a no-op) does not trip a guard banning the value's
    /// use. The original false claims were unquoted.
    fn without_backticked(src: &str) -> String {
        let mut out = String::with_capacity(src.len());
        let mut in_tick = false;
        for c in src.chars() {
            match c {
                '`' => in_tick = !in_tick,
                _ if !in_tick => out.push(c),
                _ => {}
            }
        }
        out
    }

    /// Format and property checks on the generator itself.
    #[test]
    fn generated_secrets_are_well_formed_and_unpredictable() {
        const N: usize = 256;
        let mut seen = std::collections::HashSet::new();
        let mut per_position = [0usize; 64];
        // 16 buckets, one per hex DIGIT. This was `[0usize; 256]` (a byte
        // histogram) while only 0..=15 are ever written, so the "every bucket
        // is used" assertion died on the first always-zero bucket at index 16 —
        // reported as "hex digit 10" because the message formats with `{nibble:x}`.
        let mut digit_histogram = [0usize; 16];

        for _ in 0..N {
            let s = generate_secret().expect("csprng");
            assert_eq!(s.len(), SECRET_BYTES * 2, "secret must be {} hex chars", SECRET_BYTES * 2);
            assert!(
                s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "secret must be lower-case hex: {s}"
            );
            assert!(seen.insert(s.clone()), "duplicate secret generated: {s}");
            for (i, c) in s.chars().enumerate() {
                per_position[i] += 1;
                // Bucket by the hex digit's VALUE (0..=15), not by the high
                // nibble of its ASCII code — the latter only ever yields 3..=7
                // for '0'..'f' and would fail on a perfectly good generator.
                let v = c.to_digit(16).expect("hex digit") as usize;
                digit_histogram[v] += 1;
            }
        }
        assert_eq!(seen.len(), N, "all {N} secrets must be distinct");

        // No nibble position may be constant across samples: a zeroed or
        // repeated output would show up as a position that never varies.
        for (i, distinct) in per_position.iter().enumerate() {
            assert!(*distinct > 1, "hex position {i} is constant across {N} secrets");
        }
        // Every one of the 16 hex digits should appear, and none should dominate
        // so heavily that the others look starved: a broken or short fill shows
        // up here. The upper bound is a loose sanity net, not a statistical test
        // — the real strength assertion is the seed-reproduction sweep above.
        for (digit, count) in digit_histogram.iter().enumerate() {
            assert!(*count > 0, "hex digit {digit:x} never appeared in {N} secrets");
            assert!(
                *count < N * 64,
                "hex digit {digit:x} took {count} of {} samples — the output is not random",
                N * 64
            );
        }
    }

    /// The vault must get the same owner-only protected DACL as every other
    /// credential. A security audit found the split: `ipc.token`, `serve.pass`,
    /// `owner.key` and `daemon.owner` were all restricted, and `keyring.dat` —
    /// which holds the encrypted provider keys — was not, because it is created
    /// by `fs::copy` and by `Keyring.save`, and both rely on a Unix `0600` mode
    /// that Windows does not translate into an ACL.
    ///
    /// This is a source-shape assertion, and honestly labelled as one: it cannot
    /// prove the DACL is applied at runtime, only that the call site exists and is
    /// inside the vault-resolution path. A behavioural version would need a real
    /// installed vault, which is what `release:verify` covers. What this does
    /// catch is the specific regression - someone removing the call while the
    /// rest of the credential set stays locked down, which is exactly the state
    /// the audit found and which reads as correct because the neighbours are fine.
    #[test]
    fn the_vault_gets_the_same_protected_dacl_as_every_other_credential() {
        let body = include_str!("main.rs");
        // Take the FIRST occurrence, which is the definition. `resolve_vault_dir`
        // appears 7 times in this file (definition, call site, and the existing
        // `every_vault_resolution_branch_is_logged` assertion), so an
        // `index()`-based slice that picked the wrong one tested the wrong text.
        //
        // Two earlier versions of this assertion failed for reasons that had
        // nothing to do with the property under test: the first looked for a
        // function name that does not exist, and the second sliced from the
        // definition and then stopped at the next `\nfn `, which lands on a
        // nested helper. Both reported "the guard is missing" while the guard was
        // present — the same shape as the doc anchors in AGENTS.md that pointed at
        // a comment while the gate stayed green.
        let vault_fn = body
            .split("fn resolve_vault_dir")
            .nth(1)
            .expect("resolve_vault_dir definition exists")
            .split("\nfn ")
            .next()
            .expect("slice is non-empty");
        assert!(
            vault_fn.contains("restrict_to_owner(&keyring)"),
            "keyring.dat must be given the owner-only protected DACL, not left on the \
             profile's inherited ACL. If this is intentionally removed, delete the claim \
             in AGENTS.md about the vault being protected rather than leaving the \
             document lying."
        );
        // And the lockdown must not be conflated with the Unix mode that Windows
        // ignores: `fs::set_permissions` is a silent no-op for ACLs there.
        assert!(
            !vault_fn.contains("set_permissions"),
            "do not reintroduce fs::set_permissions as the vault's protection; it is a \
             silent no-op on Windows (SetFileAttributes, READONLY only)."
        );
    }

    /// Serialises the tests that mutate `VOICE_RUNTIME_DIR`.
    ///
    /// `std::env::set_var` is process-wide and the harness runs these in parallel
    /// threads, so two tests touching the same variable interleave. The symptom
    /// is not an obvious race: one test wipes the directory the other just wrote
    /// and the failure lands as an unrelated-looking assertion. Both machine-key
    /// tests passed under `--test-threads=1` and failed in a normal run, which is
    /// the signature of exactly this. The fix is the lock, not a serial-run flag.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Is `path`'s DACL marked PROTECTED (SE_DACL_PROTECTED), i.e. unable to
    /// inherit from the parent? Read through `GetFileSecurityW`, the same read
    /// `restrict_to_owner` performs, so the test observes the real descriptor
    /// rather than trusting the writer's return value.
    #[cfg(windows)]
    fn dacl_is_protected(path: &Path) -> bool {
        use windows_sys::Win32::Security::{
            GetFileSecurityW, PSECURITY_DESCRIPTOR, SECURITY_DESCRIPTOR,
        };
        // `requestedinformation` is a plain u32 in windows-sys 0.59, and
        // PSECURITY_DESCRIPTOR is *mut c_void, so both are used in their real
        // form rather than as imported constants that do not exist here.
        const SE_FILE_OBJECT: u32 = 1;
        const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
        let wide: Vec<u16> = path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut storage = vec![0u8; 1024];
        let mut needed: u32 = 0;
        let ok = unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                SE_FILE_OBJECT | DACL_SECURITY_INFORMATION,
                storage.as_mut_ptr() as PSECURITY_DESCRIPTOR,
                1024,
                &mut needed,
            )
        } != 0;
        if !ok {
            return false;
        }
        unsafe {
            let sd = storage.as_mut_ptr() as *mut SECURITY_DESCRIPTOR;
            (*sd).Control & 0x1000 != 0
        }
    }

    #[cfg(not(windows))]
    fn dacl_is_protected(_path: &Path) -> bool {
        true
    }

    /// Put `path` back on an INHERITABLE DACL: the state a file written by an
    /// older install is in, and the precondition adoption has to repair. Shells
    /// out to `icacls /reset`, which means exactly "inherit from the parent
    /// again" and is the documented inverse of what `restrict_to_owner` does.
    ///
    /// This is a test fixture restoring the PRE-FIX state, which is the only way
    /// to prove the fix repairs it.
    #[cfg(windows)]
    fn icacls_reset(path: &Path) {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .args(["/reset"])
            .output();
        assert!(
            status.is_ok_and(|o| o.status.success()),
            "icacls /reset failed; the adoption precondition cannot be staged"
        );
    }

    #[cfg(not(windows))]
    fn icacls_reset(_path: &Path) {}

    /// `machine.key` is ADOPTED, not recreated, stays readable by its owner, and
    /// has its DACL re-applied even when the file already existed.
    #[test]
    fn the_machine_key_is_adopted_not_recreated() {
        let _guard = env_lock();
        let dir = std::env::temp_dir().join("voxaura-mkey-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("machine.key");

        let restore = std::env::var("VOICE_RUNTIME_DIR").ok();
        std::env::set_var("VOICE_RUNTIME_DIR", &dir);

        let first = ensure_machine_key().expect("first key");
        let second = ensure_machine_key().expect("adopted key");
        assert_eq!(first, second, "the key must be stable across calls");
        assert_eq!(first.len(), 64, "32 bytes rendered as lowercase hex");
        assert!(
            first.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "the key must be lowercase hex: {first}"
        );
        assert_eq!(fs::read(&path).expect("reread").len(), 32);
        assert!(dacl_is_protected(&path), "a freshly created key must be locked down");

        // THE ADOPTION PATH, ISOLATED. Everything above passes even if
        // `restrict_to_owner` is deleted from the ADOPT branch, because the first
        // call CREATED the file and the creation branch still locks it down. That
        // is the real shape of the gap - a file written by an older install - so
        // it is exercised on its own: strip the DACL, then adopt and require the
        // helper to restore it. Break-testing reported this guard as MISSED while
        // the test was genuinely green until the two paths were separated.
        icacls_reset(&path);
        assert!(
            !dacl_is_protected(&path),
            "precondition failed: the DACL was expected to be inheritable before adoption"
        );
        assert_eq!(ensure_machine_key().expect("adopt after reset"), first);
        assert!(
            dacl_is_protected(&path),
            "adopting an existing key must RE-APPLY the owner-only DACL, not assume it"
        );

        // Readability after the lockdown. This is the assertion that killed the
        // icacls approach, which reported success and produced a file its own
        // named grantee could not open.
        assert_eq!(
            fs::read(&path).expect("owner must still read its own key").len(),
            32,
            "the DACL locked the owner out - that is the failure that removed icacls"
        );

        let _ = fs::remove_dir_all(&dir);
        match restore {
            Some(v) => std::env::set_var("VOICE_RUNTIME_DIR", v),
            None => std::env::remove_var("VOICE_RUNTIME_DIR"),
        }
    }

    /// THE GAP THIS CLOSES. `ensure_ipc_token`, `ensure_serve_password` and
    /// `ensure_owner_key` all read an existing file and returned the value
    /// WITHOUT re-applying the DACL, so a file written by an older install —
    /// or by the Node daemon, whose `{ mode: 0o600 }` is a silent no-op on
    /// Windows — kept the parent directory's inherited ACL forever. Measured on
    /// this machine before the fix: `ipc.token`, `serve.pass` and `daemon.owner`
    /// all carried `BUILTIN\Administrators:(I)(F)`, i.e. the WS-4097 bearer
    /// token was readable by any local administrator.
    ///
    /// The audit recorded **0** tests for the adopt path, which is why three of
    /// the five secrets stayed exposed while `machine.key` — the only one that
    /// already had an adopt branch, and the only one that was correct — had
    /// three.
    ///
    /// Each secret is staged the way an older install leaves it (created, then
    /// `icacls /reset` to put it back on the inherited profile ACL), adopted,
    /// and required to come back protected. `machine.key` is included in the
    /// sweep so a future edit cannot quietly regress the one that was already
    /// right: the cost of it being right once is that removing it looks like an
    /// unrelated cleanup.
    #[test]
    fn every_adopted_secret_is_relocked_not_assumed() {
        let _guard = env_lock();
        let dir = std::env::temp_dir().join(format!(
            "voxaura-adopt-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");

        // These three short-circuit every `ensure_*` before it touches a file,
        // so a value inherited from the developer's own shell would make this
        // test assert nothing. Cleared explicitly rather than assumed absent.
        let shadowed = [
            "VOICE_RUNTIME_IPC_TOKEN",
            "OPENCODE_SERVER_PASSWORD",
            "VOXAURA_OWNER_KEY",
        ];
        let restore_env: Vec<(String, String)> = shadowed
            .iter()
            .filter_map(|k| std::env::var(k).ok().map(|v| ((*k).to_string(), v)))
            .collect();
        for k in shadowed {
            std::env::remove_var(k);
        }

        let restore = std::env::var("VOICE_RUNTIME_DIR").ok();
        std::env::set_var("VOICE_RUNTIME_DIR", &dir);

        // Created, not adopted, so each file starts life genuinely locked down.
        let token = ensure_ipc_token().expect("provision ipc.token");
        let password = ensure_serve_password().expect("provision serve.pass");
        let owner = ensure_owner_key().expect("provision owner.key");
        let key = ensure_machine_key().expect("provision machine.key");

        let secrets: [(&str, PathBuf, &str); 5] = [
            ("ipc.token", dir.join("ipc.token"), token.as_str()),
            ("serve.pass", dir.join("serve.pass"), password.as_str()),
            ("owner.key", dir.join("owner.key"), owner.as_str()),
            ("machine.key", dir.join("machine.key"), key.as_str()),
            ("daemon.owner", dir.join("daemon.owner"), ""),
        ];
        for (label, path, _) in &secrets {
            assert!(path.exists(), "{label} was not provisioned");
            assert!(
                dacl_is_protected(path),
                "{label} must be locked down when this install CREATED it"
            );
        }

        // Put every one back on the inherited profile ACL — the state a file
        // written by an older install is in, and the precondition adoption has
        // to repair. Without this the test would pass on the creation path
        // alone, which is the exact way the original gap stayed invisible.
        for (label, path, _) in &secrets {
            icacls_reset(path);
            assert!(
                !dacl_is_protected(path),
                "precondition failed for {label}: the DACL was expected to be inheritable \
                 before adoption, so this test would prove nothing"
            );
        }

        // Re-adopt. Same values, since these are adopted and not regenerated —
        // if any of them came back different the function silently rotated a
        // credential instead of locking the existing one down.
        assert_eq!(
            ensure_ipc_token().expect("adopt ipc.token"),
            token,
            "adopting must not rotate the token"
        );
        assert_eq!(
            ensure_serve_password().expect("adopt serve.pass"),
            password,
            "adopting must not rotate the serve password"
        );
        assert_eq!(
            ensure_owner_key().expect("adopt owner.key"),
            owner,
            "adopting must not rotate the owner key"
        );
        assert_eq!(
            ensure_machine_key().expect("adopt machine.key"),
            key,
            "adopting must not rotate the machine key"
        );

        for (label, path, _) in &secrets {
            assert!(
                dacl_is_protected(path),
                "{label} was adopted onto an INHERITED DACL and stayed inherited. Adoption \
                 must RE-APPLY the owner-only protected DACL, exactly as machine.key already \
                 did — the other three secrets were the gap."
            );
            // Readability, which is the assertion that killed the icacls
            // approach: it reported success and produced a file its own named
            // grantee could not open.
            assert!(
                fs::metadata(path).is_ok(),
                "{label} became unreadable to its owner after the re-lock"
            );
        }

        // `daemon.owner` is adopted too, and re-locking it must NOT have
        // truncated it: `ensure_owner_key` runs BEFORE the holder probe, so
        // clobbering the marker would erase the identity of the daemon about to
        // be adopted and force a pointless respawn.
        let marker = dir.join("daemon.owner");
        let before = fs::read(&marker).expect("marker readable");
        ensure_owner_key().expect("re-adopt owner key");
        assert_eq!(
            fs::read(&marker).expect("marker still readable"),
            before,
            "re-locking the marker must not rewrite its bytes"
        );

        let _ = fs::remove_dir_all(&dir);
        match restore {
            Some(v) => std::env::set_var("VOICE_RUNTIME_DIR", v),
            None => std::env::remove_var("VOICE_RUNTIME_DIR"),
        }
        for (k, v) in restore_env {
            std::env::set_var(k, v);
        }
    }

    /// `lock_or_delete` is the fail-closed step shared by the create path and every
    /// adopt path. Its error branch must surface an `Err` and must not leave a
    /// readable file behind.
    ///
    /// SCOPE, STATED HONESTLY. What this asserts is the error wiring: a lock
    /// that cannot be applied is reported, not swallowed into an `Ok`. It does
    /// NOT assert the delete-on-failure cleanup, because on Windows that branch
    /// cannot be staged from a test — the OWNER of a file holds implicit
    /// `READ_CONTROL` and `WRITE_DAC` no matter what the DACL says, so
    /// `SetNamedSecurityInfoW` on an owner-accessible path effectively cannot
    /// fail. (Two stagings were tried and discarded: a path whose parent is a
    /// FILE, which fails at `create_dir_all` before the DACL call is ever made;
    /// and a DACL with `WRITE_DAC` removed from the owner's ACE, which the
    /// implicit grant overrides. Both "passed" while proving nothing.) The
    /// delete itself remains covered only by inspection of `lock_or_delete`.
    #[test]
    fn a_lock_that_cannot_be_applied_is_reported_not_swallowed() {
        let path = secret_file("lock-err", "gone.token");
        // Created then removed, so the ACL step has a real target that is gone.
        fs::write(&path, "x").expect("seed");
        fs::remove_file(&path).expect("remove");
        let err = lock_or_delete(&path, "gone.token")
            .expect_err("a lock that cannot be applied must not report success");
        assert!(
            err.contains("gone.token"),
            "the error must name the file that could not be locked, got: {err}"
        );
        assert!(!path.exists(), "nothing to leave behind");
    }

    /// A wrong-length key must be refused and removed, never adopted: it cannot
    /// be a key this install generated, and adopting it would make every vault
    /// undecryptable in a way that reads as corruption.
    #[test]
    fn a_wrong_length_machine_key_is_refused_and_removed() {
        let _guard = env_lock();
        let dir = std::env::temp_dir().join("voxaura-mkey-bad");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("machine.key");
        fs::write(&path, b"too short").expect("seed");

        let restore = std::env::var("VOICE_RUNTIME_DIR").ok();
        std::env::set_var("VOICE_RUNTIME_DIR", &dir);
        let err = ensure_machine_key().expect_err("must refuse");
        assert!(
            err.contains("expected 32"),
            "the error must name the real problem, not fail generically: {err}"
        );
        assert!(!path.exists(), "a wrong-length key must not be left on disk");

        let _ = fs::remove_dir_all(&dir);
        match restore {
            Some(v) => std::env::set_var("VOICE_RUNTIME_DIR", v),
            None => std::env::remove_var("VOICE_RUNTIME_DIR"),
        }
    }

    /// The machine key must come from the CSPRNG. This is the same defect class
    /// as the original `ipc.token`, which shipped with an xorshift seeded by
    /// `nanos ^ pid` - and it now guards the ROOT of every vault cipher rather
    /// than one credential among several.
    #[test]
    fn the_machine_key_is_csprng_not_a_seeded_prng() {
        let body = include_str!("main.rs");
        let start = body.find("fn ensure_machine_key").expect("fn exists");
        let section = &body[start..];
        let end = section.find("\nfn ").map(|i| i + 1).unwrap_or(section.len());
        let f = &section[..end];
        assert!(
            f.contains("secure_random_bytes"),
            "machine.key must come from the CSPRNG, not a seeded PRNG"
        );
        assert!(
            !f.contains("nanos") && !f.contains("SystemTime"),
            "machine.key must not be seeded from the clock: a vault root derived that way is guessable"
        );
    }

    /// The write path must produce a file, and must be a real file with content.
    #[test]
    fn write_protected_secret_creates_a_readable_file() {
        let path = secret_file("write", "ipc.token");
        let secret = generate_secret().expect("csprng");
        write_protected_secret(&path, &secret, "ipc.token").expect("write");
        assert_eq!(fs::read_to_string(&path).expect("reread").trim(), secret);
        let _ = fs::remove_file(&path);
    }

    /// Fail-closed: if the ACL cannot be applied, the secret must not be left
    /// on disk. A file that survives with a weaker ACL is worse than no file,
    /// because the `read_to_string` fast path in `ensure_ipc_token` would adopt
    /// it as permanent and never retry the lockdown.
    #[test]
    fn a_failed_acl_removes_the_secret_instead_of_leaving_it_world_readable() {
        // A directory is not a valid *file* target for a DACL write the way this
        // function performs it on a non-NTFS/odd path; the reliable way to make
        // the ACL step fail deterministically is a path whose parent is a file.
        let blocker = secret_file("acl-fail", "blocker");
        fs::write(&blocker, "not a directory").expect("seed blocker");
        let nested = blocker.join("ipc.token");
        let secret = "deadbeef".repeat(8);
        let err = write_protected_secret(&nested, &secret, "ipc.token")
            .expect_err("must fail closed, not leave the secret");
        assert!(
            err.contains("ipc.token"),
            "error must name the file, got: {err}"
        );
        assert!(
            !nested.exists(),
            "the secret survived a failed ACL write at {}",
            nested.display()
        );
        let _ = fs::remove_file(&blocker);
    }

    /// The Windows equivalent of `0600`, verified against the real kernel state
    /// of a real file — not against a mock and not against our own source text.
    #[cfg(windows)]
    #[test]
    fn the_secret_file_gets_a_protected_owner_only_dacl() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::{
            EqualSid, GetFileSecurityW, SE_DACL_PRESENT, SE_DACL_PROTECTED,
        };

        let path = secret_file("dacl", "serve.pass");
        let secret = generate_secret().expect("csprng");
        write_protected_secret(&path, &secret, "serve.pass").expect("write");

        // Read the security descriptor back from the filesystem. BOTH the DACL
        // and the owner are requested: the owner is what the ACEs are checked
        // against, and asking for one does not populate the other's offset.
        let info = DACL_SECURITY_INFORMATION_FLAG | OWNER_SECURITY_INFORMATION_FLAG;
        let mut needed = 0u32;
        let mut actual = 0u32;
        unsafe {
            GetFileSecurityW(
                wide(&path).as_ptr(),
                info,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        assert!(needed > 0, "GetFileSecurityW could not size the descriptor");
        let mut sd = vec![0u8; needed as usize];
        let ok = unsafe {
            GetFileSecurityW(
                wide(&path).as_ptr(),
                info,
                sd.as_mut_ptr() as *mut core::ffi::c_void,
                needed,
                &mut actual,
            )
        };
        assert_ne!(ok, 0, "GetFileSecurityW failed: {}", last_error());

        // SELF_RELATIVE SD fixed header:
        //   [0]=Revision [1]=SBZ1 [2..4]=Control  (all u16-aligned, then u32s)
        //   [4..8]=OwnerOffset  [8..12]=GroupOffset  [12..16]=SaclOffset
        //   [16..20]=DaclOffset
        // Reading the DACL from [4..8] would silently pick up the OWNER offset.
        let le32 = |o: usize| u32::from_le_bytes([sd[o], sd[o + 1], sd[o + 2], sd[o + 3]]) as usize;
        let owner_offset = le32(4);
        let dacl_offset = le32(16);
        assert!(owner_offset > 0, "no owner SID in the descriptor");
        let owner_sid = unsafe { sd.as_ptr().add(owner_offset) as *mut core::ffi::c_void };
        let control = u16::from_le_bytes([sd[2], sd[3]]);
        assert_ne!(
            control & SE_DACL_PRESENT,
            0,
            "SE_DACL_PRESENT is not set — there is no DACL to protect"
        );
        assert_ne!(
            control & SE_DACL_PROTECTED,
            0,
            "SE_DACL_PROTECTED is not set: the file's DACL still INHERITS from the parent \
             directory, so the guarantee is only as strong as %USERPROFILE%'s ACL. This is \
             the specific thing that Unix 0600 gives for free and that a naive Windows \
             port omits."
        );

        assert!(
            dacl_offset > 0 && dacl_offset + 8 <= sd.len(),
            "DACL offset out of range"
        );
        let dacl = &sd[dacl_offset..];
        let ace_count = u16::from_le_bytes([dacl[4], dacl[5]]) as usize;
        // Exactly two ACEs: the file's owner and LocalSystem. A third, or an
        // inherited ACE, means the lockdown is not what the comment claims.
        assert_eq!(
            ace_count,
            2,
            "expected exactly 2 ACEs (owner + LocalSystem), found {ace_count}: the DACL is \
             not owner-only"
        );

        // Walk the ACEs: each must be ACCESS_ALLOWED (0), carry full control, and
        // name either the file's owner or LocalSystem.
        let mut cursor = 8usize;
        let system_sid = well_known_system_sid();
        let mut saw_owner = false;
        let mut saw_system = false;
        for i in 0..ace_count {
            let ace = &dacl[cursor..];
            assert!(ace.len() >= 20, "ACE {i} truncated");
            let ace_type = ace[0];
            let ace_size = u16::from_le_bytes([ace[2], ace[3]]) as usize;
            assert_eq!(ace_type, 0, "ACE {i} is type {ace_type}, not ACCESS_ALLOWED_ACE");
            let mask = u32::from_le_bytes([ace[4], ace[5], ace[6], ace[7]]);
            assert_eq!(
                mask & 0x1F01FF,
                0x1F01FF,
                "ACE {i} mask {mask:#x} is not a full file-access grant"
            );
            let sid_ptr = unsafe { (ace.as_ptr().add(8)) as *mut core::ffi::c_void };
            if unsafe { EqualSid(sid_ptr, owner_sid) } != 0 {
                saw_owner = true;
            } else if unsafe { EqualSid(sid_ptr, system_sid) } != 0 {
                saw_system = true;
            } else {
                panic!(
                    "ACE {i} grants access to neither the file owner nor LocalSystem — \
                     a third party can read the secret"
                );
            }
            cursor += ace_size;
        }
        assert!(saw_owner, "the owner's own ACE is missing");
        assert!(saw_system, "the LocalSystem ACE is missing");
        let _ = fs::remove_file(&path);

        // ---- local helpers ----
        fn wide(p: &Path) -> Vec<u16> {
            let mut v: Vec<u16> = p.as_os_str().encode_wide().collect();
            v.push(0);
            v
        }
        fn last_error() -> u32 {
            unsafe { windows_sys::Win32::Foundation::GetLastError() }
        }
    }

    #[cfg(windows)]
    const DACL_SECURITY_INFORMATION_FLAG: u32 = 4; // SE_DACL_SECURITY_INFORMATION
    #[cfg(windows)]
    const OWNER_SECURITY_INFORMATION_FLAG: u32 = 1; // OWNER_SECURITY_INFORMATION

    #[cfg(windows)]
    fn well_known_system_sid() -> *mut core::ffi::c_void {
        use windows_sys::Win32::Security::{CreateWellKnownSid, WinLocalSystemSid};
        let buf = Box::leak(Box::new([0u8; 68]));
        let mut len = buf.len() as u32;
        let ok = unsafe {
            CreateWellKnownSid(
                WinLocalSystemSid,
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                &mut len,
            )
        };
        assert_ne!(
            ok,
            0,
            "CreateWellKnownSid failed: {}",
            unsafe { windows_sys::Win32::Foundation::GetLastError() }
        );
        buf.as_mut_ptr() as *mut core::ffi::c_void
    }

    #[cfg(windows)]
    fn process_user_sid() -> *mut core::ffi::c_void {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token = std::ptr::null_mut();
            assert_ne!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token),
                0,
                "OpenProcessToken failed"
            );
            let mut needed = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
            // The SID lives *inside* this buffer, so the buffer must outlive the
            // returned pointer. It is deliberately leaked: a test process is
            // short-lived, and returning a pointer into a `Vec` that is dropped
            // here is a use-after-free that corrupts the whole test process.
            let buf = Box::leak(vec![0u8; needed as usize].into_boxed_slice());
            // `lpnlengthneeded` must be non-NULL on this OS; see the identical
            // note in `restrict_to_owner`.
            let mut actual = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                needed,
                &mut actual,
            );
            let _ = CloseHandle(token);
            assert_ne!(ok, 0, "GetTokenInformation failed");
            (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid
        }
    }

    /// `restrict_to_owner` grants the DACL to the file's *owner* SID, taken from
    /// the file's own security descriptor, rather than to the process token's
    /// user SID. That is only correct if those two are the same identity — if
    /// they ever diverged, the secret would be locked to somebody else and the
    /// daemon could not read it. This asserts the equivalence directly, via the
    /// token, rather than assuming it.
    #[cfg(windows)]
    #[test]
    fn the_dacl_is_granted_to_the_actual_process_user() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::{EqualSid, GetFileSecurityW};

        let path = secret_file("owner-identity", "ipc.token");
        let secret = generate_secret().expect("csprng");
        write_protected_secret(&path, &secret, "ipc.token").expect("write");

        let mut w: Vec<u16> = path.as_os_str().encode_wide().collect();
        w.push(0);
        let mut needed = 0u32;
        let mut actual = 0u32;
        unsafe {
            GetFileSecurityW(
                w.as_ptr(),
                OWNER_SECURITY_INFORMATION_FLAG,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        assert!(needed > 0, "GetFileSecurityW could not size the descriptor");
        let mut sd = vec![0u8; needed as usize];
        let ok = unsafe {
            GetFileSecurityW(
                w.as_ptr(),
                OWNER_SECURITY_INFORMATION_FLAG,
                sd.as_mut_ptr() as *mut core::ffi::c_void,
                needed,
                &mut actual,
            )
        };
        assert_ne!(ok, 0, "GetFileSecurityW failed");
        let owner_offset = u32::from_le_bytes([sd[4], sd[5], sd[6], sd[7]]) as usize;
        assert!(owner_offset > 0 && owner_offset < sd.len(), "no owner SID in descriptor");
        let owner = unsafe { sd.as_ptr().add(owner_offset) as *mut core::ffi::c_void };

        let me = process_user_sid();
        assert_ne!(
            unsafe { EqualSid(owner, me) },
            0,
            "the file's owner SID is not the current process user; restrict_to_owner would \
             grant the DACL to the wrong identity and the daemon could not read the secret"
        );
        let _ = fs::remove_file(&path);
    }

    /// The `(0600)` comments were the original lie. Assert they cannot come
    /// back, and that the words now describe what the code does.
    #[test]
    fn no_claim_of_unix_0600_survives_in_the_documentation() {
        let src = include_str!("main.rs");
        let body = src.split("mod phase2_tests").next().unwrap();
        // The original lie was a bare, UNQUOTED parenthetical claim on functions
        // that called no ACL code at all: "ipc.token (0600)", "serve password
        // (0600)", "supervisor log (0600 directory)". Backticked spans are
        // stripped first, because the corrected comments legitimately *name*
        // `0600` in order to explain that Windows gets something else instead —
        // banning the bare token would make the correct explanation impossible
        // to write, which is how guards like this end up disabled.
        let prose = without_backticked(body);
        assert!(
            !prose.contains("(0600)"),
            "a production comment still asserts Unix 0600 permissions. On Windows \
             fs::set_permissions is SetFileAttributes and cannot express this, so the claim \
             is false. Describe restrict_to_owner instead."
        );
        assert!(
            !prose.contains("0600 directory"),
            "the runtime directory is still documented as 0600; it is never ACL'd at all."
        );
        // Positive control: the lockdown really is documented, so this guard is
        // not passing merely because the text moved.
        assert!(
            body.contains("restrict_to_owner"),
            "restrict_to_owner must be documented as the real permission mechanism"
        );
    }
}


fn main() {
    let app = tauri::Builder::default()
        .manage(Supervisor::default())
        .invoke_handler(tauri::generate_handler![
            ipc_token,
            ensure_all_services,
            restrict_vault_file
        ])
        .setup(|app| {
            // Write the per-install IPC token SYNCHRONOUSLY, before the webview
            // loads. The frontend asks for it on mount via `ipc_token`; if the
            // file were only written later (by the daemon), the shell could read
            // it too early and render a permanent disconnected state.
            if let Err(err) = ensure_ipc_token() {
                log_line(&format!("ensure_ipc_token ERROR: {err}"));
            }
            // Bring the tiers up off the UI thread; a slow probe must not delay
            // first paint. The frontend also calls ensure_all_services so it can
            // render the outcome.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = ensure_all_services(handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Voxaura");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            app_handle.state::<Supervisor>().reap();
        }
    });
}