import { describe, expect, test } from 'vitest';
import { buildTaskNotice } from './notices.js';
import type { TaskFailure, TaskRecord, TaskState } from './types.js';

// The notice plan is PURE, so the whole "visual always, spoken only in a
// silence window" rule is testable without a daemon, a speech gate or a socket.
function record(over: Partial<TaskRecord> = {}): TaskRecord {
  return Object.freeze({
    id: 't1' as TaskRecord['id'],
    seq: 1,
    kind: 'test-suite',
    label: 'اختبارات الواجهة',
    payload: null,
    timeoutMs: 900_000,
    state: 'queued' as TaskState,
    enqueuedAt: 0,
    startedAt: null,
    settledAt: null,
    failure: null,
    restoredFrom: null,
    ...over,
  });
}

const failure = (code: TaskFailure['code'], message = 'why'): TaskFailure => ({ code, message });
const LOUD = { speechAvailable: true };
const SILENT = { speechAvailable: false };

describe('classification', () => {
  test('a completed task is ok', () => {
    const n = buildTaskNotice(record({ state: 'done', settledAt: 1 }), SILENT);
    expect(n.code).toBe('task-done');
    expect(n.severity).toBe('ok');
    expect(n.detailAr).toContain('اختبارات الواجهة');
  });

  test('a timeout is an error and says so, distinct from a plain failure', () => {
    const n = buildTaskNotice(record({ state: 'failed', failure: failure('timeout') }), SILENT);
    expect(n.code).toBe('task-timeout');
    expect(n.severity).toBe('error');
    expect(n.detailAr).toContain('انتهى وقت');
  });

  test('an interrupted task is a WARNING, not an error and not a success', () => {
    // The distinction the user cares about: the work is unfinished and nobody
    // knows why, which is not the same as "it broke".
    const n = buildTaskNotice(record({ state: 'failed', failure: failure('interrupted') }), SILENT);
    expect(n.code).toBe('task-interrupted');
    expect(n.severity).toBe('warn');
    expect(n.detailAr).toContain('ما بنقدر نأكد');
  });

  test('a thrown failure is an error and carries the reason', () => {
    const n = buildTaskNotice(record({ state: 'failed', failure: failure('threw', 'exit 1') }), SILENT);
    expect(n.code).toBe('task-failed');
    expect(n.severity).toBe('error');
    expect(n.detailAr).toContain('exit 1');
  });

  test('a cancelled task is a warning', () => {
    const n = buildTaskNotice(record({ state: 'cancelled', settledAt: 2 }), SILENT);
    expect(n.code).toBe('task-cancelled');
    expect(n.severity).toBe('warn');
  });

  test('a failed task with no reason still classifies, rather than throwing', () => {
    const n = buildTaskNotice(record({ state: 'failed', failure: null }), SILENT);
    expect(n.code).toBe('task-failed');
    expect(n.severity).toBe('error');
  });
});

describe('the silence window', () => {
  test('a visual notice is unconditional — even in a loud room, even cancelled', () => {
    for (const state of ['done', 'failed', 'cancelled'] as TaskState[]) {
      for (const ctx of [LOUD, SILENT]) {
        expect(buildTaskNotice(record({ state, failure: failure('threw') }), ctx).visual).toBe(true);
      }
    }
  });

  test('a finished task speaks only when the window is open', () => {
    expect(buildTaskNotice(record({ state: 'done', settledAt: 1 }), LOUD).speak).toBe(true);
    expect(buildTaskNotice(record({ state: 'done', settledAt: 1 }), SILENT).speak).toBe(false);
  });

  test('a CANCELLED task is not spoken even in a silent window', () => {
    // The one deliberate departure from "spoken on completion": the user
    // cancelled it seconds ago and already knows. Pinned so the judgement is a
    // decision on the record rather than an accident someone can undo by
    // accident.
    const n = buildTaskNotice(record({ state: 'cancelled', settledAt: 1 }), LOUD);
    expect(n.speak).toBe(false);
    expect(n.visual).toBe(true);
  });

  test('a failure IS spoken when the window is open — the user asked for this work', () => {
    expect(buildTaskNotice(record({ state: 'failed', failure: failure('timeout') }), LOUD).speak).toBe(true);
  });

  test('the notice does not vary with the window except on `speak`', () => {
    const t = record({ state: 'failed', failure: failure('threw', 'boom') });
    const loud = buildTaskNotice(t, LOUD);
    const silent = buildTaskNotice(t, SILENT);
    expect({ ...loud, speak: 0 }).toEqual({ ...silent, speak: 0 });
  });
});
