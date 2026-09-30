import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { MicGlyph, MicOffGlyph, BotGlyph, BotOffGlyph } from './ControlGlyphs.js';
// The module's own source, inlined by Vite's `?raw` transform. `import.meta.url`
// is not a `file:` URL under the `happy-dom` environment this suite runs in, so
// `readFileSync(new URL(…, import.meta.url))` throws "The URL must be of scheme
// file" — measured, not assumed.
import GLYPHS_SOURCE from './ControlGlyphs.tsx?raw';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
}

/**
 * Glyph → the `data-testid` it MUST render.
 *
 * PAIRS, not a bare list, and the pairing is the fix for a real vacuity: the
 * previous version iterated `[MicGlyph, MicOffGlyph, BotGlyph, BotOffGlyph]`
 * and asserted `aria-hidden` on whatever `<svg>` the mount produced. Nothing in
 * that loop said WHICH glyph it was inspecting, so deleting an entry left the
 * loop with one fewer iteration and the identical result — "all glyphs are
 * decorative" was enforced by the honesty of the literal, not by the test.
 *
 * Two halves, and both are needed. The per-iteration assertion pins the TARGET
 * (this component really does carry this id, so the loop cannot silently inspect
 * a different element). The completeness case at the bottom pins the TABLE
 * against the module's own source, so removing a pair goes red rather than
 * quietly shrinking the coverage.
 *
 * `break-the-guard`: delete `[BotOffGlyph, 'glyph-bot-off']` — the decorative
 * test above stays GREEN (one fewer iteration) and the completeness case goes
 * red, which is the proof that the guard is the second one and not the first.
 */
const GLYPHS: ReadonlyArray<readonly [(typeof MicGlyph), string]> = [
  [MicGlyph, 'glyph-mic'],
  [MicOffGlyph, 'glyph-mic-off'],
  [BotGlyph, 'glyph-bot'],
  [BotOffGlyph, 'glyph-bot-off'],
];

describe('ControlGlyphs (custom vector icons)', () => {
  test('mic glyphs are distinct and the off variant carries a slash', () => {
    mount(<MicGlyph />);
    const on = document.body.querySelector('[data-testid="glyph-mic"]');
    expect(on).not.toBeNull();
    expect(on!.querySelectorAll('path').length).toBeGreaterThanOrEqual(3);
    document.body.innerHTML = '';
    mount(<MicOffGlyph />);
    const off = document.body.querySelector('[data-testid="glyph-mic-off"]');
    expect(off).not.toBeNull();
    // The diagonal slash is the last path, drawn thicker than the body.
    const paths = [...off!.querySelectorAll('path')];
    expect(paths.some((p) => (p.getAttribute('stroke-width') ?? '') === '1.9')).toBe(true);
  });

  test('bot glyphs are distinct and the off variant carries a slash', () => {
    mount(<BotGlyph />);
    const on = document.body.querySelector('[data-testid="glyph-bot"]');
    expect(on).not.toBeNull();
    document.body.innerHTML = '';
    mount(<BotOffGlyph />);
    const off = document.body.querySelector('[data-testid="glyph-bot-off"]');
    expect(off).not.toBeNull();
    const paths = [...off!.querySelectorAll('path')];
    expect(paths.some((p) => (p.getAttribute('stroke-width') ?? '') === '1.9')).toBe(true);
  });

  test('all glyphs are decorative (aria-hidden, currentColor)', () => {
    // Iterate the PAIRS, not pre-built elements: the list is data, so each
    // <G /> is a single child of its own root and there is no array to key.
    for (const [G, testId] of GLYPHS) {
      document.body.innerHTML = '';
      mount(<G />);
      // THE TARGET IS NAMED, so an iteration cannot pass while inspecting some
      // other element — or while inspecting nothing at all.
      const svg = document.body.querySelector(`[data-testid="${testId}"]`);
      expect(svg, `${testId} was not rendered, so this iteration checked nothing`).not.toBeNull();
      expect(document.body.querySelector('svg'), `${testId} is not the only element mounted`).toBe(svg);
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
      // `focusable` is the half of "decorative" that is easy to drop in a
      // desktop webview, where an `aria-hidden` svg can still take focus.
      expect(svg?.getAttribute('focusable')).toBe('false');
    }
  });

  test('COMPLETENESS: the table above names every glyph the module exports', () => {
    // Read from the SOURCE rather than restating the list. A test that asserts
    // `GLYPHS.length === 4` is pinning a copy; this pins the module, so a fifth
    // glyph — or a renamed testid — fails here and has to be added to the table.
    const exported = [...GLYPHS_SOURCE.matchAll(/export function (\w+)\(/g)].map((m) => m[1] ?? '');
    const authored = [...GLYPHS_SOURCE.matchAll(/data-testid="(glyph-[^"]+)"/g)].map((m) => m[1] ?? '');
    expect(exported, 'an exported function per paired glyph').toHaveLength(GLYPHS.length);
    expect(authored.slice().sort(), 'the module\'s own testids').toEqual(GLYPHS.map(([, id]) => id).sort());
    // …and the ids are distinct, so a copy-paste in the table cannot make two
    // iterations inspect the same element and pass as two.
    expect(new Set(GLYPHS.map(([, id]) => id)).size).toBe(GLYPHS.length);
  });
});