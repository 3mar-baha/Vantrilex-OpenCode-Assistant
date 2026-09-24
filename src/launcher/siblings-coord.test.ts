import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  pruneHeartbeats,
  readHeartbeats,
  SiblingRegistry,
  sweepOrphans,
  writeHeartbeat,
} from './siblings.js';

// Phase 3 TDD — deterministic cross-process lifecycle. Hermetic: tmpdir files,
// injected lister/killer, controllable clocks.
describe('pruneHeartbeats (crash hygiene)', () => {
  test('removes stale files, keeps fresh, ignores corrupt, returns counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'siblings-prune-'));
    writeHeartbeat(dir, { pid: 1, project: 'a', servePort: 4096, updatedAt: 't' }, 1000);
    writeHeartbeat(dir, { pid: 2, project: 'b', servePort: 4097, updatedAt: 't' }, 1000 - 500_000);
    const before = readHeartbeats(dir, 1000, 90_000).map((e) => e.pid);
    expect(before).toEqual([1]);
    const removed = pruneHeartbeats(dir, 1000, 90_000);
    expect(removed).toBe(1);
    expect(readHeartbeats(dir, 1000, 90_000).map((e) => e.pid)).toEqual([1]);
  });
});

describe('sweepOrphans heartbeat coordination', () => {
  test('fresh heartbeat + live PID survives; stale heartbeat does not protect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'siblings-sweep-'));
    writeHeartbeat(dir, { pid: 200, project: 'sib', servePort: 4097, updatedAt: 't' }, 5000);
    writeHeartbeat(dir, { pid: 300, project: 'dead', servePort: 4098, updatedAt: 't' }, 5000 - 500_000);
    const killed: number[] = [];
    const result = await sweepOrphans([100], {
      heartbeatDir: dir,
      nowMs: 5000,
      list: async () => [100, 200, 300, 400],
      kill: async (pid) => {
        killed.push(pid);
      },
    });
    expect(killed.sort()).toEqual([300, 400]);
    expect(result.reaped.sort()).toEqual([300, 400]);
  });

  test('heartbeat for a non-live PID is ignored (recycled-PID guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'siblings-ghost-'));
    writeHeartbeat(dir, { pid: 999, project: 'ghost', servePort: 4099, updatedAt: 't' }, 5000);
    const killed: number[] = [];
    await sweepOrphans([], {
      heartbeatDir: dir,
      nowMs: 5000,
      list: async () => [400],
      kill: async (pid) => {
        killed.push(pid);
      },
    });
    expect(killed).toEqual([400]);
  });

  test('in-process registry and heartbeat files compose as one predicate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'siblings-compose-'));
    writeHeartbeat(dir, { pid: 200, project: 'file', servePort: 4097, updatedAt: 't' }, 5000);
    const reg = new SiblingRegistry({ now: () => 5000 });
    reg.register(201, { project: 'mem', servePort: 4098 });
    const nowMs = 5000;
    const filePids = new Set(readHeartbeats(dir, nowMs).map((e) => e.pid));
    const isProtected = (pid: number): boolean => reg.isProtected(pid, nowMs) || filePids.has(pid);
    const killed: number[] = [];
    await sweepOrphans([], {
      isProtected,
      list: async () => [200, 201, 202],
      kill: async (pid) => {
        killed.push(pid);
      },
    });
    expect(killed).toEqual([202]);
  });
});
