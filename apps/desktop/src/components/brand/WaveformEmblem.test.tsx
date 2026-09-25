import { describe, expect, test } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { afterEach } from 'vitest';
import { WaveformEmblem } from './WaveformEmblem.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('WaveformEmblem (pure-blue 5-bar mark)', () => {
  test('renders five blueprint bars and nothing else', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<WaveformEmblem />);
    });
    const svg = document.body.querySelector('[data-testid="waveform-emblem"]');
    expect(svg).not.toBeNull();
    const bars = svg!.querySelectorAll('rect');
    expect(bars).toHaveLength(5);
    expect(svg!.querySelector('g')?.getAttribute('fill')).toBe('#2563eb');
    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
