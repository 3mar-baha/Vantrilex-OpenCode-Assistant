// Voxaura crest — inline geometric SVG, resolution-independent by construction.
// No raster assets; renders identically at 24/48/96 px.
export interface CrestProps {
  readonly size?: 24 | 48 | 96;
}

export function Crest({ size = 48 }: CrestProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Voxaura crest"
      data-testid="voxaura-crest"
      data-size={size}
    >
      <rect x="1" y="1" width="46" height="46" rx="10" fill="#141413" stroke="#383530" strokeWidth="2" />
      <circle cx="24" cy="24" r="9" fill="none" stroke="#e7e5e4" strokeWidth="2.5" />
      <circle cx="24" cy="24" r="3.5" fill="#10b981" />
      <path d="M24 8 v6 M24 34 v6 M8 24 h6 M34 24 h6" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
