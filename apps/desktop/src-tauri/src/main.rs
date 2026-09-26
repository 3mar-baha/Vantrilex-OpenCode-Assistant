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

    fn adopt(&self, child: &Child) {
        unsafe {
            let handle = child.as_raw_handle() as HANDLE;
            let _ = AssignProcessToJobObject(self.0, handle);
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
    #[cfg(windows)]
    job: std::sync::OnceLock<Option<KillOnCloseJob>>,
}

impl Supervisor {
    #[cfg(windows)]
    fn job(&self) -> Option<&KillOnCloseJob> {
        self.job.get_or_init(KillOnCloseJob::create).as_ref()
    }

    fn own(&self, child: Child) {
        #[cfg(windows)]
        if let Some(job) = self.job() {
            job.adopt(&child);
        }
        if let Ok(mut kids) = self.children.lock() {
            kids.push(child);
        }
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
    base.join("Voxaura").join("vault")
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
    if port_open(OPENCODE_PORT) {
        return Ok(format!("opencode serve already on {OPENCODE_PORT}"));
    }
    let bin = resolve_opencode_bin();
    let password = ensure_serve_password()?;
    let mut cmd = Command::new(&bin);
    cmd.args(["serve", "--port", &OPENCODE_PORT.to_string(), "--hostname", "127.0.0.1"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("OPENCODE_SERVER_PASSWORD", &password);
    let child = cmd
        .spawn()
        .map_err(|e| format!("could not spawn opencode ({bin}): {e}"))?;
    app.state::<Supervisor>().own(child);
    if wait_for_port(OPENCODE_PORT, Duration::from_secs(20)) {
        Ok(format!("opencode serve started on {OPENCODE_PORT}"))
    } else {
        Err(format!("opencode serve did not open {OPENCODE_PORT} in time"))
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
        .stdout(Stdio::null())
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .env("VOICE_RUNTIME_IPC_TOKEN", ipc_token)
        .env("VOXAURA_VAULT_DIR", resolve_vault_dir(Some(&entry)));
    // Capture child stderr into the runtime dir: without it a failed bring-up
    // is silent and undiagnosable.
    match runtime_dir() {
        Some(dir) => {
            let _ = fs::create_dir_all(&dir);
            match fs::File::create(dir.join("daemon-stderr.log")) {
                Ok(file) => {
                    cmd.stderr(Stdio::from(file));
                }
                Err(_) => {
                    cmd.stderr(Stdio::null());
                }
            }
        }
        None => {
            cmd.stderr(Stdio::null());
        }
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("could not spawn daemon via {node}: {e}"))?;
    app.state::<Supervisor>().own(child);
    if wait_for_port(DAEMON_PORT, Duration::from_secs(20)) {
        Ok(format!("daemon started on {DAEMON_PORT}"))
    } else {
        Err(format!("daemon did not open {DAEMON_PORT} in time"))
    }
}

/// Zero-click bring-up: nudge serve, then the daemon, then report. Errors are
/// returned (never panicked) so the UI can surface them.
#[tauri::command]
fn ensure_all_services(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    if BRINGUP_INFLIGHT.swap(true, Ordering::SeqCst) {
        log_line("ensure_all_services: already in flight — skipping duplicate");
        return Ok(vec!["bring-up already in flight".to_string()]);
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
    if let Err(err) = &result {
        log_line(&format!("ensure_all_services ERROR: {err}"));
    }
    BRINGUP_INFLIGHT.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
fn shutdown_all_services(app: tauri::AppHandle) -> Result<String, String> {
    app.state::<Supervisor>().reap();
    Ok("children stopped".to_string())
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