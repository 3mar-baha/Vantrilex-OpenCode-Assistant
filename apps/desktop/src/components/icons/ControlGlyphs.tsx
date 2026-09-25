// Custom vector control glyphs — drawn here rather than pulled from an icon
// font so the stroke language matches the rest of the shell. All glyphs share
// a 24x24 grid, 1.6px strokes, round caps, and currentColor fill/stroke.
import type { SVGProps } from 'react';

type GlyphProps = SVGProps<SVGSVGElement> & { readonly size?: number };

function frame(size: number, props: GlyphProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...props,
  };
}

/** Active user microphone. */
export function MicGlyph({ size = 22, ...rest }: GlyphProps): JSX.Element {
  return (
    <svg data-testid="glyph-mic" {...frame(size, rest)}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
    </svg>
  );
}

/** User microphone, muted (diagonal slash). */
export function MicOffGlyph({ size = 22, ...rest }: GlyphProps): JSX.Element {
  return (
    <svg data-testid="glyph-mic-off" {...frame(size, rest)}>
      <path d="M9 6.2V6a3 3 0 0 1 6 0v5" />
      <path d="M15 13.4A3 3 0 0 1 9 12" />
      <path d="M5.5 11a6.5 6.5 0 0 0 9.6 5.7" />
      <path d="M18.5 11a6.4 6.4 0 0 1-.6 2.7" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
      <path d="M3.5 3.5 20.5 20.5" strokeWidth={1.9} />
    </svg>
  );
}

/** Assistant speech active (robot head with sound arcs). */
export function BotGlyph({ size = 22, ...rest }: GlyphProps): JSX.Element {
  return (
    <svg data-testid="glyph-bot" {...frame(size, rest)}>
      <rect x="4.5" y="8" width="15" height="10" rx="3.5" />
      <path d="M12 8V4.6" />
      <circle cx="12" cy="3.4" r="1.2" />
      <path d="M9.3 12.5v1.4M14.7 12.5v1.4" />
      <path d="M2.6 11.2v2.4M21.4 11.2v2.4" />
    </svg>
  );
}

/** Assistant speech muted (robot head with diagonal slash). */
export function BotOffGlyph({ size = 22, ...rest }: GlyphProps): JSX.Element {
  return (
    <svg data-testid="glyph-bot-off" {...frame(size, rest)}>
      <path d="M6.4 8.6A3.5 3.5 0 0 1 8 8h6.5" />
      <path d="M19 9.2A3.5 3.5 0 0 1 19.5 11v3.5c0 .5-.1 1-.3 1.4" />
      <path d="M15.6 18H8a3.5 3.5 0 0 1-3.5-3.5V11c0-.6.1-1.1.4-1.6" />
      <path d="M12 8V4.6" />
      <circle cx="12" cy="3.4" r="1.2" />
      <path d="M9.3 12.5v1.4M14.7 12.5v1.4" />
      <path d="M2.6 11.2v2.4M21.4 11.2v2.4" />
      <path d="M3.5 3.5 20.5 20.5" strokeWidth={1.9} />
    </svg>
  );
}