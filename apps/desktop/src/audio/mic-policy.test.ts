import { describe, expect, test } from 'vitest';
import { micFailureNotice, micPolicy } from './vad.js';

// L19 — the microphone stayed hot whenever the window lost focus or was
// minimised. For a voice-first HUD that is a standing privacy and battery cost
// the user never asked for. These pin the rule and, just as importantly, pin
// what it must NOT do: never override the user's own mute choice.

describe('mic hardware policy (L19)', () => {
  test('a hidden window always releases the microphone', () => {
    // Regardless of mute state: if the user cannot see the window, it should
    // not be listening.
    expect(micPolicy('hidden', false)).toBe('release');
    expect(micPolicy('hidden', true)).toBe('release');
  });

  test('a visible window re-acquires the mic only if the user had it live', () => {
    expect(micPolicy('visible', false)).toBe('start');
  });

  test("minimise/restore does not override a deliberate mute", () => {
    // Muted, then hidden, then shown again: the mic must stay off. If restore
    // forced a start here, the mute button would be a lie.
    expect(micPolicy('hidden', true)).toBe('release');
    expect(micPolicy('visible', true)).toBe('none');
  });

  test('the mute toggle is the only thing that turns the mic off', () => {
    // The window being visible must not be what keeps it off.
    expect(micPolicy('visible', false)).toBe('start');
  });

  test('a full minimise/restore round trip returns to the original state', () => {
    const live: Array<'release' | 'start' | 'none'> = [micPolicy('visible', false)];
    live.push(micPolicy('hidden', false));
    live.push(micPolicy('visible', false));
    expect(live).toEqual(['start', 'release', 'start']);
  });
});

// SEC-7 — a packaged build whose microphone permission is refused must be
// DISTINGUISHABLE from one with no microphone at all, or "voice is dead" is
// undiagnosable from a user's report. `NotAllowedError` is the specific case
// that matters: wry leaves the WebView2 mic permission at DEFAULT and Tauri
// exposes no passthrough to change it.
describe('microphone failure notices (SEC-7)', () => {
  const named = (name: string): Error => Object.assign(new Error('x'), { name });

  test('a refused permission is reported as a permission problem', () => {
    const notice = micFailureNotice(named('NotAllowedError'));
    expect(notice).toContain('إذن');
    expect(notice).not.toBe(micFailureNotice(named('NotFoundError')));
  });

  test('a missing device is not reported as a permission problem', () => {
    const notice = micFailureNotice(named('NotFoundError'));
    expect(notice).toContain('لا يوجد ميكروفون');
    expect(notice).not.toBe(micFailureNotice(named('NotAllowedError')));
  });

  test('a busy device is reported distinctly', () => {
    const notices = new Set([
      micFailureNotice(named('NotAllowedError')),
      micFailureNotice(named('NotFoundError')),
      micFailureNotice(named('NotReadableError')),
    ]);
    // Three causes, three different instructions. Collapsing them was the bug.
    expect(notices.size).toBe(3);
  });

  test('an unrecognised failure still says something useful and never throws', () => {
    expect(micFailureNotice(named('SomethingElse'))).toBe('تعذّر الوصول إلى الميكروفون');
    expect(micFailureNotice(undefined)).toBe('تعذّر الوصول إلى الميكروفون');
    expect(micFailureNotice('a string')).toBe('تعذّر الوصول إلى الميكروفون');
  });
});
