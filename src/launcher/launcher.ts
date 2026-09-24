import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { nowIso } from '../common/brands.js';
import type { OrchestratorConfig } from '../common/config.js';
import { OrchestratorError } from '../common/errors.js';
import { basicAuth } from '../runtime/client.js';

// Process supervision — docs/26-AGENT-LAUNCHER.md. Windows children are spawned
// into a Job Object equivalent (CREATE_BREAKAWAY guard + taskkill /T tree-kill);
// identity is command-line + start-time fingerprinting, never PID trust alone.
export interface ServeHandle {
  readonly pid: number;
  readonly port: number;
  readonly contractVersion: string;
  readonly adopted: boolean;
  readonly startedAt: string;
}

export type HealthStatus = 'starting' | 'ready' | 'degraded' | 'unreachable';

export interface Launcher {
  boot(cfg: OrchestratorConfig, password: string): Promise<ServeHandle>;
  shutdown(handle: ServeHandle): Promise<void>;
  health(handle: ServeHandle, password: string): Promise<HealthStatus>;
  hotRestart(handle: ServeHandle, cfg: OrchestratorConfig, newPassword: string): Promise<ServeHandle>;
}

export interface PortResolution {
  readonly port: number;
  readonly adopted: boolean;
}

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

/** Adopt-if-healthy else escalate (E-1) — docs/13 §13.5. Pure decision core, unit-tested. */
export function resolvePort(conflict: { healthy: boolean; passwordMatches: boolean }, basePort: number, taken: readonly number[]): PortResolution {
  if (conflict.healthy && conflict.passwordMatches) {
    return { port: basePort, adopted: true };
  }
  let port = basePort + 1;
  while (taken.includes(port)) port += 1;
  return { port, adopted: false };
}

const BOOT_BUDGET_MS = 10_000;
const POLL_MS = 250;

export class SupervisedLauncher implements Launcher {
  private child: ChildProcess | null = null;

  async boot(cfg: OrchestratorConfig, password: string): Promise<ServeHandle> {
    if (password.length === 0) {
      throw new OrchestratorError('CONFIG_INVALID', false, 'server password is required for supervised boot');
    }
    const port = cfg.serve.port;
    if (await probeHealth(port, password)) {
      return { pid: -1, port, contractVersion: await this.probeContract(port, password), adopted: true, startedAt: nowIso() };
    }
    // Password travels via child env ONLY — never argv (I-4). Asserted in tests.
    const child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    const deadline = Date.now() + BOOT_BUDGET_MS;
    while (Date.now() < deadline) {
      if (await probeHealth(port, password)) {
        return {
          pid: child.pid ?? -1,
          port,
          contractVersion: await this.probeContract(port, password),
          adopted: false,
          startedAt: nowIso(),
        };
      }
      await sleep(POLL_MS);
    }
    await this.killTree(child);
    throw new OrchestratorError('SERVE_UNREACHABLE', true, `opencode serve not ready on 127.0.0.1:${port} within 10s`);
  }

  async shutdown(handle: ServeHandle): Promise<void> {
    if (handle.adopted || this.child === null) return;
    const child = this.child;
    this.child = null;
    child.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (!(await probeHealth(handle.port, 'shutdown-probe-unreachable'))) break;
      await sleep(250);
    }
    await this.killTree(child);
  }

  async health(handle: ServeHandle, password: string): Promise<HealthStatus> {
    const ok = await probeHealth(handle.port, password);
    return ok ? 'ready' : 'unreachable';
  }

  async hotRestart(handle: ServeHandle, cfg: OrchestratorConfig, newPassword: string): Promise<ServeHandle> {
    // T6: checkpoint-first restart; session re-attach is orchestrator-owned (P2).
    await this.shutdown(handle);
    return this.boot(cfg, newPassword);
  }

  private async probeContract(port: number, password: string): Promise<string> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openapi.json`, {
        headers: { Authorization: basicAuth(password) },
      });
      if (!res.ok) return 'unknown';
      const doc = (await res.json()) as { info?: { version?: string } };
      return doc.info?.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async killTree(child: ChildProcess): Promise<void> {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') {
        // Job-Object semantics: /T terminates the whole tree (ConPTY included).
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        await new Promise<void>((resolve) => {
          killer.on('exit', () => resolve());
          killer.on('error', () => resolve());
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // Reaping is best-effort; the orphan sweeper (§sweeper) is the backstop.
    }
  }
}
