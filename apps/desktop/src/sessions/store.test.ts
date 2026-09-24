import { describe, expect, test } from 'vitest';
import { initialSessionsState, sessionsReducer } from './store.js';

describe('sessionsReducer', () => {
  test('replace swaps the list, preserving activeId', () => {
    const s1 = sessionsReducer(initialSessionsState, {
      kind: 'replace',
      sessions: [{ id: 'a', state: 'running' }],
    });
    expect(s1.sessions).toEqual([{ id: 'a', state: 'running' }]);
    expect(s1.activeId).toBeNull();
    const s2 = sessionsReducer({ ...s1, activeId: 'a' }, {
      kind: 'replace',
      sessions: [{ id: 'b', state: 'idle' }],
    });
    expect(s2.sessions).toEqual([{ id: 'b', state: 'idle' }]);
    expect(s2.activeId).toBe('a');
  });

  test('select records the id without fabricating list entries', () => {
    const s = sessionsReducer(initialSessionsState, { kind: 'select', id: 'ses_x' });
    expect(s.activeId).toBe('ses_x');
    expect(s.sessions).toEqual([]);
  });
});
