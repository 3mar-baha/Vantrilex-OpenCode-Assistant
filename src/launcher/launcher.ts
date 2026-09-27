import { basicAuth } from '../runtime/client.js';

// Serve health probing — the ONLY part of the old launcher surface that is
// actually called (by `cli.ts` for `doctor` and by `daemon.ts`).
//
// L13: `SupervisedLauncher`, `resolvePort` and the whole `siblings.ts` orphan
// sweeper were deleted as dead code. They were a complete, plausible-looking
// second supervision layer that nothing ever called, and one of them even
// documented the other as its "backstop" — two mutually-referencing safety
// nets, neither of them running. That is worse than having none: a maintainer
// reading `killTree` would reasonably conclude orphans were handled.
//
// The real supervision is the Rust `KILL_ON_JOB_CLOSE` Job Object in
// `apps/desktop/src-tauri/src/main.rs`, which is exercised by 26 Rust tests and
// was verified by cold-launching the packaged build. Process ownership lives in
// exactly one place now.
//
// `resolvePort` went with them for a second reason: on a password mismatch it
// escalated to `basePort + 1`, i.e. 4097 — which is the WS-4097 UI bridge port.
// Reviving it would have handed the serve process the UI bridge's socket.

export async function probeHealth(port: number, password: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Verified live: serve uses HTTP Basic and /health returns SPA HTML, so an
    // authenticated JSON route is the real health signal.
    const res = await fetch(`http://127.0.0.1:${port}/api/session`, {
      headers: { Authorization: basicAuth(password) },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
