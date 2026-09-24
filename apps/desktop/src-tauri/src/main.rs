#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Voxaura shell entry — window, tray, and global hotkeys only (ADR-010).
// Process supervision of `opencode serve` belongs exclusively to the Node
// daemon (src/launcher/); this host never spawns or reaps it. The daemon's
// IPC bearer arrives via the VOICE_RUNTIME_IPC_TOKEN environment variable
// set by the launcher when it spawns this sidecar.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Voxaura");
}
