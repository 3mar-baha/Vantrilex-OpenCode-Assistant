import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SiblingRegistry, readHeartbeats, sweepOrphans, writeHeartbeat } from './siblings.js';

// Phase 1 TDD — sibling-serve protection. Hermetic: tmpdir heartbeat files,
// injected process lister/killer. No real taskkill ever runs in tests.
describe('SiblingRegistry (in-process)', () => {
  test('register/heartbeat/list/unregister lifecycle', () => {
    const reg = new SiblingRegistry({ now: () => 1000 });
    reg.register(1234, { project: 'proj-a', servePort: 4096 });
    expect(reg.isProtected(1234, 1000)).toBe(true);
    expect(reg.isProtected(9999, 1000)).toBe(false);
    reg.heartbeat(1234, 2000);
    // Stale after 90s without heartbeat.
    expect(reg.isProtected(1234, 2000 + 89_999)).toBe(true);
    expect(reg.isProtected(1234, 2000 + 90_001)).toBe(false);
    reg.unregister(1234);
    expect(reg.isProtected(1234, 2000)).toBe(false);
  });

  test('list() exposes live entries with project labels', () => {
    const reg = new SiblingRegistry({ now: () => 0 });
    reg.register(1, { project: 'a', servePort: 4096 });
    reg.register(2, { project: 'b', servePort: 4097 });
    expect(reg.list().map((e) => e.project).sort()).toEqual(['a', 'b']);
  });
});

describe('heartbeat files (cross-process)', () => {
  test('write + read round-trip; corrupt and stale files ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'siblings-'));
    writeHeartbeat(dir, { pid: 111, project: 'a', servePort: 4096, updatedAt: 't' }, 1000);
    writeHeartbeat(dir, { pid: 222, project: 'b', servePort: 4097, updatedAt: 't' }, 1000 - 200_000);
    writeFileSync(join(dir, '9999.json'), '{not json');
    const live = readHeartbeats(dir, 1000, 90_000);
    expect(live.map((e) => e.pid).sort()).toEqual([111]);
  });
});

describe('sweepOrphans with sibling protection', () => {
  test('protected PIDs are never killed; orphans still reaped', async () => {
    const killed: number[] = [];
    const result = await sweepOrphans([100], {
      isProtected: (pid) => pid === 200,
      list: async () => [100, 200, 300],
      kill: async (pid) => {
        killed.push(pid);
      },
    });
    expect(killed).toEqual([300]);
    expect(result.reaped).toEqual([300]);
    expect(result.liveServePids).toEqual([100, 200, 300]);
  });

  test('killer failure does not abort the sweep', async () => {
    const killed: number[] = [];
    const result = await sweepOrphans([], {
      list: async () => [400, 401],
      kill: async (pid) => {
        killed.push(pid);
        if (pid === 400) throw new Error('access denied');
      },
    });
    expect(killed).toEqual([400, 401]);
    expect(result.reaped).toEqual([401]);
  });
});
