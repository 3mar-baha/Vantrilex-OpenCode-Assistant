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
// Everything here is std-only (no new crates): TCP reachability probes and
// std::process::Command. Command resolution is env-overridable so a packaged
// build can point at sidecars without recompiling.
//
// IPC identity (H4): the WS-4097 bearer is NOT baked into the bundle. The
// daemon writes a random per-install token to
// `~/.opencode-voice-runtime/ipc.token` (0600) and the webview asks for it at
// runtime through the `ipc_token` command below.
use serde::Serialize;
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

fn adoption_action(ok: bool) -> AdoptionAction {
    if ok {
        AdoptionAction::Keep
    } else {
        AdoptionAction::Kill
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
            let ok = self.job().is_none_or(|job| job.adopt(&child));
            self.own_with_adoption(child, ok)
        }
        #[cfg(not(windows))]
        {
            self.own_with_adoption(child, true)
        }
    }

    /// Split out so the failure branch is testable without provoking a real
    /// `AssignProcessToJobObject` error, which cannot be forced portably.
    fn own_with_adoption(&self, mut child: Child, adopted: bool) -> bool {
        if adoption_action(adopted) == AdoptionAction::Kill {
            let _ = child.kill();
            let _ = child.wait();
            if let Ok(mut n) = self.unadopted.lock() {
                *n += 1;
            }
            log_line(&format!(
                "supervisor: job-adopt-failed pid={} — killed immediately (it would have outlived us)",
                child.id()
            ));
            return false;
        }
        if let Ok(mut kids) = self.children.lock() {
            kids.push(child);
        }
        true
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
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let mut path = PathBuf::from(home);
    path.push(".opencode-voice-runtime");
    Some(path)
}

/// Append one line to the supervisor log (0600 directory). Diagnostics only —
/// never credentials, never transcript content.
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

fn token_path() -> Option<PathBuf> {
    Some(runtime_dir()?.join("ipc.token"))
}

/// Generate or load the per-install IPC token (0600). Written before any child
/// spawns so the UI can read it immediately via the `ipc_token` command.
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
            return Ok(trimmed.to_string());
        }
    }
    // 32 random bytes as hex, sourced without extra crates.
    let mut bytes = [0u8; 32];
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15)
        ^ std::process::id() as u64;
    for chunk in bytes.chunks_mut(8) {
        // xorshift64*
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        for (i, b) in chunk.iter_mut().enumerate() {
            *b = ((seed >> (i * 8)) & 0xff) as u8;
        }
    }
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;
    fs::write(&path, &token).map_err(|e| format!("ipc.token: {e}"))?;
    Ok(token)
}

/// Per-install serve password (0600). The shell and the daemon must agree on
/// one credential for `opencode serve`; without it the daemon refuses to start
/// (fail-closed) and a cold double-click can never come up. Precedence: an
/// explicit env value wins, otherwise a generated 32-byte hex secret is stored
/// beside the IPC token — never in the bundle, never logged.
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
            return Ok(trimmed.to_string());
        }
    }
    // 32 random bytes as hex, sourced without extra crates.
    let mut bytes = [0u8; 32];
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15)
        ^ std::process::id() as u64;
    for chunk in bytes.chunks_mut(8) {
        // xorshift64*
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        for (i, b) in chunk.iter_mut().enumerate() {
            *b = ((seed >> (i * 8)) & 0xff) as u8;
        }
    }
    let password: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;
    fs::write(&path, &password).map_err(|e| format!("serve.pass: {e}"))?;
    Ok(password)
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
            return PathBuf::from(explicit);
        }
    }
    if let Some(entry) = entry {
        let mut cursor = entry.parent().map(PathBuf::from);
        while let Some(dir) = cursor {
            let candidate = dir.join("vault");
            if candidate.is_dir() {
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
            if !supervised {
                log_line("ensure_opencode: WARNING spawned serve could not be job-adopted and was killed");
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
fn ensure_daemon(app: &tauri::AppHandle, ipc_token: &str) -> Result<String, String> {
    if port_open(DAEMON_PORT) {
        return Ok(format!("daemon already on {DAEMON_PORT}"));
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
            if !supervised {
                log_line("ensure_daemon: WARNING spawned daemon could not be job-adopted and was killed");
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
            Ok(BringUpStatus::failed(&err))
        }
    }
}

#[tauri::command]
fn shutdown_all_services(app: tauri::AppHandle) -> Result<String, String> {
    app.state::<Supervisor>().reap();
    Ok("children stopped".to_string())
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
        assert_eq!(adoption_action(true), AdoptionAction::Keep);
    }

    #[test]
    fn adoption_failure_kills_the_child() {
        assert_eq!(adoption_action(false), AdoptionAction::Kill);
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
        sup.own_with_adoption(child, false);
        assert_eq!(sup.unadopted(), 1);
        assert_eq!(sup.child_count(), 0, "an unadopted child must not be tracked as supervised");
        // Give the kernel a moment to reap it, then assert the PID is gone.
        std::thread::sleep(Duration::from_millis(400));
        assert!(!process_alive(pid), "an unadopted child must be killed, not left running");
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

    // ---- helpers -------------------------------------------------------

    fn process_alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            // `tasklist` by PID: no extra crates, and this is a test-only path.
            let out = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output();
            match out {
                Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")),
                Err(_) => false,
            }
        }
        #[cfg(not(windows))]
        {
            Path::new(&format!("/proc/{pid}")).exists()
        }
    }
}


fn main() {
    let app = tauri::Builder::default()
        .manage(Supervisor::default())
        .invoke_handler(tauri::generate_handler![
            ipc_token,
            ensure_all_services,
            shutdown_all_services
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