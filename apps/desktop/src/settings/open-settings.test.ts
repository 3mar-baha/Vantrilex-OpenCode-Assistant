import { afterEach, describe, expect, test, vi } from 'vitest';
import { isKeysView, isSettingsView, openKeysWindow, openSettingsWindow, SETTINGS_LABEL, KEYS_LABEL } from './open-settings.js';

// FIX 1 — the doubled query parameter.
//
// `spawn()` read `index.html?${query}${suffix}` with `suffix = '&' + query`, so
// EVERY launcher call produced `?view=keys&view=keys` (in `HEAD` since 7d3bc68,
// 2026-09-25, in both the Tauri `WebviewWindow` and the web `window.open`
// path).
//
// It survived because every consumer reads the query with a SUBSTRING test, and
// `'?view=keys&view=keys'.includes('view=keys')` is true. That is exactly why
// these assertions COUNT OCCURRENCES instead of using `toContain`: a
// substring check is the precise check that let a duplicated parameter ship.
// The E2E suite asserts `url()).toContain('view=keys')` and is, by the same
// reasoning, not able to catch this class — so the unit test has to carry it.

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The `window.open` URL the web/E2E path actually used. */
function openedUrl(): string {
  const open = window.open as unknown as { mock: { calls: unknown[][] } };
  const call = open.mock.calls[0];
  expect(call, 'window.open was called').toBeDefined();
  return String(call?.[0] ?? '');
}

const open = vi.fn();
Object.defineProperty(window, 'open', { value: open, writable: true, configurable: true });

afterEach(() => {
  open.mockReset();
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('window URL construction', () => {
  test('the keys window URL carries `view=keys` EXACTLY ONCE', async () => {
    await openKeysWindow();
    const url = openedUrl();
    expect(url).toBe('index.html?view=keys');
    expect(occurrences(url, 'view=keys')).toBe(1);
    expect(url.endsWith('&view=keys')).toBe(false);
  });

  test('the settings window URL carries `view=settings` EXACTLY ONCE', async () => {
    await openSettingsWindow();
    const url = openedUrl();
    expect(url).toBe('index.html?view=settings');
    expect(occurrences(url, 'view=settings')).toBe(1);
  });

  test('the persona variant carries each of its two parameters exactly once', async () => {
    await openSettingsWindow('kareem');
    const url = openedUrl();
    expect(url).toBe('index.html?view=settings&persona=kareem');
    expect(occurrences(url, 'view=settings')).toBe(1);
    expect(occurrences(url, 'persona=kareem')).toBe(1);
    // The doubled form this replaces, spelled out so the regression is legible.
    expect(url).not.toBe('index.html?view=settings&persona=kareem&view=settings&persona=kareem');
  });

  test('each window gets its own target name, so the OS keeps them independent', async () => {
    await openKeysWindow();
    expect(open.mock.calls[0]?.[1]).toBe(`voxaura-${KEYS_LABEL}`);
    open.mockReset();
    await openSettingsWindow();
    expect(open.mock.calls[0]?.[1]).toBe(`voxaura-${SETTINGS_LABEL}`);
  });

  test('no launcher produces a trailing `?`', async () => {
    // `spawn()` defaults `query` to `''`, and `windowUrl` then returns a bare
    // `index.html`. Neither current launcher takes that arm, so what is
    // asserted here is the reachable half of the contract: no URL this module
    // can emit ends in a dangling separator.
    for (const call of [openKeysWindow, () => openSettingsWindow()]) {
      await call();
      expect(openedUrl()).not.toMatch(/\?$/);
      open.mockReset();
    }
  });
});

describe('the view predicates stay lenient by design', () => {
  // They are `includes()` on purpose and are NOT changed by this fix — a caller
  // may pass a search string assembled elsewhere. What matters is that they
  // still accept the corrected URL, and still accept the legacy doubled form so
  // an already-open window from a previous build does not blank out.
  test('isKeysView accepts the corrected and the legacy doubled URL', () => {
    expect(isKeysView('?view=keys')).toBe(true);
    expect(isKeysView('?view=keys&view=keys')).toBe(true);
  });

  test('isSettingsView accepts the corrected and the persona form', () => {
    expect(isSettingsView('?view=settings')).toBe(true);
    expect(isSettingsView('?view=settings&persona=nour')).toBe(true);
  });

  test('each predicate rejects the other surface', () => {
    expect(isKeysView('?view=settings')).toBe(false);
    expect(isSettingsView('?view=keys')).toBe(false);
  });
});
