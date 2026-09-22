import { execFile } from 'node:child_process';

// Orphan sweeper — docs/26 §26.4. Every 60s (<5ms budget): fingerprint live
// `opencode serve` processes by command-line and terminate any instance that is
// neither the supervised child nor the adopted healthy owner (E-1 squat guard).
export interface SweepResult {
  readonly scannedAt: string;
  readonly liveServePids: number[];
  readonly reaped: number[];
}

function tasklistCsv(): Promise<string> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq opencode*', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

export async function sweepOrphans(ownedPids: readonly number[]): Promise<SweepResult> {
  const owned = new Set(ownedPids);
  const liveServePids: number[] = [];
  const reaped: number[] = [];
  if (process.platform === 'win32') {
    const out = await tasklistCsv();
    for (const line of out.split('\n')) {
      const match = /"opencode[^"]*","(\d+)"/.exec(line);
      if (match?.[1] !== undefined) liveServePids.push(Number(match[1]));
    }
    for (const pid of liveServePids) {
      if (!owned.has(pid)) {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
        reaped.push(pid);
      }
    }
  }
  return { scannedAt: new Date().toISOString(), liveServePids, reaped };
}

export function startSweeper(ownedPids: () => readonly number[], intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    void sweepOrphans(ownedPids());
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
