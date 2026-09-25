#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Voxaura shell entry — window, tray, and global hotkeys only (ADR-010).
// Process supervision of `opencode serve` belongs exclusively to the Node
// daemon (src/launcher/); this host never spawns or reaps it.
//
// IPC identity (H4): the WS-4097 bearer is NOT baked into the bundle. The
// daemon writes a random per-install token to
// `~/.opencode-voice-runtime/ipc.token` (0600) and the webview asks for it at
// runtime through the `ipc_token` command below. Localhost-only, still absent
// from the compiled artifact.
use std::fs;
use std::path::PathBuf;

fn token_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))?;
    let mut path = PathBuf::from(home);
    path.push(".opencode-voice-runtime");
    path.push("ipc.token");
    Some(path)
}

/// Return the daemon's IPC token. Fails closed when the vault-side token file
/// is absent — the shell then renders its disconnected state instead of
/// inventing a credential.
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ipc_token])
        .run(tauri::generate_context!())
        .expect("error while running Voxaura");
}