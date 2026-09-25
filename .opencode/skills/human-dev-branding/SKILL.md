# Human Developer Repository Branding Skill

Automatically transforms repository branding and architecture diagrams into an
authentic, hand-crafted human-engineer aesthetic (Excalidraw/Rough.js
whiteboard sketches, terminal-first layouts, clean developer benchmarks),
eradicating AI-generated neon slop.

## Core Anti-AI Rules

- Never use glowing neon cyan/emerald gradients, radial blur filters, or
  glassmorphism cards.
- Architecture diagrams must use sketchy, organic, hand-drawn strokes
  (Rough.js / Excalidraw whiteboard look, roughness ~1.2, hand-drawn or
  monospace typography).
- Palette is whiteboard markers only: Slate Black `#0f172a`, Blueprint Blue
  `#2563eb`, Marker Amber `#d97706`, Chalk Green `#16a766`, on clean whiteboard
  canvas `#ffffff` (or GitHub Dark `#0d1117`).
- Diagrams stay focused, legible, and structurally meaningful to senior
  engineers. No marketing gradients, no glow, no glass.

## Whiteboard Asset Pipeline

1. Generator lives at `scripts/generate-whiteboard-assets.mjs` (repo root).
   It uses `roughjs` when its Node SVG emitter is available, otherwise falls
   back to deterministic seeded-jitter sketch math producing the same
   roughness-1.2 look. Output is pure SVG: no scripts, no filters, no
   gradients — Camo-safe and sub-35KB per file.
2. Regenerate with: `node scripts/generate-whiteboard-assets.mjs`
3. Re-run the repo's SVG audit + headless render check after regeneration;
   commit only when edges are clean and XML validates.

## Tone

Concise, engineering-driven, devoid of marketing buzzwords. Labels name
components and contracts (ports, frames, status codes), never slogans.
