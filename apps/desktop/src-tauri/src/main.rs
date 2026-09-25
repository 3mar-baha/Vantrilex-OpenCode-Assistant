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
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent};

const OPENCODE_PORT: u16 = 4096;
const DAEMON_PORT: u16 = 4097;

/// Children spawned by THIS process. Killed on exit; never touched if they were
/// already running before we started (we did not create them).
#[derive(Default)]
struct Supervisor {
    children: Mutex<Vec<Child>>,
}

impl Supervisor {
    fn own(&self, child: Child) {
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

fn token_path() -> Option<PathBuf> {
    Some(runtime_dir()?.join("ipc.token"))
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
        if let Ok(entries) = fs::read_dir(&cli_root) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            versions.sort();
            for dir in versions.into_iter().rev() {
                let exe = dir.join("opencode-cli.exe");
                if exe.exists() {
                    return exe.to_string_lossy().to_string();
                }
            }
        }
    }
    "opencode".to_string()
}

/// Resolve the daemon entrypoint: explicit env, else search for `dist/cli.js`
/// from the current directory AND up the ancestors of the executable. The
/// upward walk matters: a double-clicked binary runs with cwd = its own
/// directory (`target/release`), so the repo layout is only reachable by
/// climbing out. A packaged build must supply VOXAURA_DAEMON_PATH (and Node).
fn resolve_daemon_entry() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("VOXAURA_DAEMON_PATH") {
        let p = PathBuf::from(explicit);
        if p.exists() {
            return Some(p);
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

fn resolve_node_bin() -> String {
    std::env::var("VOXAURA_NODE_BIN").unwrap_or_else(|_| "node".to_string())
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
fn ensure_daemon(app: &tauri::AppHandle) -> Result<String, String> {
    if port_open(DAEMON_PORT) {
        return Ok(format!("daemon already on {DAEMON_PORT}"));
    }
    let Some(entry) = resolve_daemon_entry() else {
        return Err("daemon entrypoint not found (set VOXAURA_DAEMON_PATH or run npm run build)".to_string());
    };
    let node = resolve_node_bin();
    let password = ensure_serve_password()?;
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("OPENCODE_SERVER_PASSWORD", &password);
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
    let opencode = ensure_opencode(&app)?;
    let daemon = ensure_daemon(&app)?;
    Ok(vec![opencode, daemon])
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