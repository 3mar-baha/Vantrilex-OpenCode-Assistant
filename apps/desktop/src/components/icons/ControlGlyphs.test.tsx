import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { MicGlyph, MicOffGlyph, BotGlyph, BotOffGlyph } from './ControlGlyphs.js';

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
    for (const glyph of [<MicGlyph />, <MicOffGlyph />, <BotGlyph />, <BotOffGlyph />]) {
      document.body.innerHTML = '';
      mount(glyph);
      const svg = document.body.querySelector('svg');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
    }
  });
});