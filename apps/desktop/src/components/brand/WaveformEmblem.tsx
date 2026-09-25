// WaveformEmblem — the pure-blue 5-bar waveform mark from assets/icon.svg,
// inlined so the dark header needs no asset-pipeline round-trip. Short,
// medium, tall center, medium, short — blueprint #2563eb, transparent field.
const BARS: ReadonlyArray<{ x: number; y: number; h: number }> = [
  { x: 0, y: 26, h: 60 },
  { x: 34, y: 11, h: 90 },
  { x: 68, y: -14, h: 140 },
  { x: 102, y: 16, h: 80 },
  { x: 136, y: 31, h: 50 },
];

export function WaveformEmblem(): JSX.Element {
  return (
    <svg data-testid="waveform-emblem" viewBox="-8 -22 176 156" width="32" height="28" role="img" aria-label="Voxaura">
      <g fill="#2563eb">
        {BARS.map((b) => (
          <rect key={b.x} x={b.x} y={b.y} width={24} height={b.h} rx={12} />
        ))}
      </g>
    </svg>
  );
}
