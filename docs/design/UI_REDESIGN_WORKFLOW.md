# UI Redesign Workflow — Arabic shell, emblem, SiriWave, tabbed settings

## Ingested skills (read-only guidance)

Registry entries are metadata stubs (description + upstream raw URL), so they
served as direction, not code. Applied principles:

- `agents/Desktop App Engineer.md` — Tauri v2 boundary discipline: window,
  tray, hotkey stay native; renderer never touches fs/secrets (our
  `ApiKeysModal` keeps values in uncontrolled inputs, out of React state).
- `agents/Frontend Developer.md` — modern React patterns: controlled tab
  state, cleanup on unmount (rAF guard), typed props.
- `agents/UI Designer.md` — consistent system: single font stack, single
  status-pill vocabulary, badge + emblem reuse (`WaveformEmblem`).
- `skills/taste-skill.md` — variance control: restrained palette (slate +
  blue accents), no slop gradients, density kept low.
- `skills/motion-lexicon.md` — calm product motion: 5-layer harmonic wave,
  tremolo instead of flashes, `prefers-reduced-motion` static fallback.

## What changed

1. **RTL + Arabic shell** (`App.tsx` root `dir="rtl"`, Arabic system font
   stack). All chrome copy Arabic; Latin tokens (`API`, `MCP`, `OpenCode`,
   `Tauri`, `Groq`, `Fish Audio`, `OpenRouter`, `Whisper`, `Nemotron`,
   `Dots3`, `Inkling`, `JSON`, `WS-4097`, session/agent/model ids) verbatim —
   enforced by `SettingsDialog.test.tsx` acronym assertions.
2. **Status pill** replaces `bridge: …` text: `● في وضع الاستعداد` /
   `● جاري الاستماع...` / `● جاري المعالجة...` / `● جاري التحدث...` /
   `● غير متصل`, driven by bridge state + matrix state.
3. **Header emblem**: inlined `WaveformEmblem` (5 blue bars, 32×28) beside the
   `Voxaura` title — no asset-pipeline dependency for the dark header.
4. **SiriWaveVisualizer** (Canvas 2D): idle breathing vs active vocal wave,
   color follows `stateAccent(matrix)`, `data-mode` for E2E. `PixelMatrix`
   module retained with its tests (unused by App).
5. **SettingsDialog**: 680×580 square, 5 sidebar tabs; API-keys tab reuses the
   mandatory intake; models tab shows the static 3-agent roster + live agent
   picker; voice tab reuses persona radios; system tab shows daemon-reported
   facts only (no fabricated pool counts). `SettingsPortal.tsx` deleted; its
   Esc/focus-trap coverage moved to dialog-level tests.
6. **E2E updated**: Arabic status assertions, `siri-wave` + `data-mode`
   lifecycle proofs, rewritten portals spec.

## Verification

- `npm run test:vantrilex` exit 0 (root + desktop).
- `npm run test:e2e` — specs assert Arabic copy, tab swapping, persona
  reporting, fail-closed key gating, and wave lifecycle.
- Terminology invariant is test-enforced, not documentary.
