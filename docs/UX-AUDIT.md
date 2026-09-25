# UX Audit — Voxaura companion (self-discovered)

An independent pass over `apps/desktop/src/` asking one question per control:
*does this earn its place in a voice companion?* Findings below are the
friction points found, and the change made for each.

| # | Friction found | Why it mattered | Change |
|---|---|---|---|
| 1 | No tooltips anywhere | Arabic users hovering a mute/mic glyph had no idea what it did | `title` + `aria-label` on every interactive element, all Arabic |
| 2 | Two control surfaces (mic core + icon strip) | Same intents reachable twice; visual noise, ambiguous "which mic?" | Removed the floating `ActionBar`/`IconCluster` strip; one control row |
| 3 | Status text ambiguous ("bridge: live") | English backend jargon leaked into an Arabic UI; no state nuance | Pill now states intent: `متصل وبانتظار الأوامر / استماع / معالجة / تحديث` |
| 4 | Status pill not announced to screen readers | Blind operators missed connection changes | Pill is `role="status" aria-live="polite"` with `data-state` |
| 5 | Silent command results | Clicking mute gave no confirmation it reached the daemon | `announce` live region reports each command's outcome in Arabic |
| 6 | No reconnect affordance | Dropped bridge looked like a frozen app | Amber reconnect banner with auto-retry note; auto-reconnect already in `ws.ts` |
| 7 | Empty states unlabelled | A blank session row looked like a bug | `لا توجد جلسات بعد …` and `لم يُكتشف أي وكيل بعد …` hints |
| 8 | No "last activity" signal | Impossible to tell if the daemon was alive but quiet | `آخر تحديث:` microline from the last event |
| 9 | Mic state was a separate icon from the mic action | Users toggled the wrong control | `MicGlyph`/`MicOffGlyph` are the single mute control |
| 10 | Assistant speech had no dedicated mute | Bot audio couldn't be silenced independently | New `BotGlyph`/`BotOffGlyph` toggle (`mute` command) |
| 11 | Persona control buried in a modal | Frequent action behind two clicks | Segmented persona control directly on the HUD |
| 12 | Credentials mixed with unrelated settings | Long scroll to reach keys; risky surface | Decoupled `?view=keys` window, focused on the 3-key intake only |
| 13 | Keyboard shortcut undiscoverable | `Ctrl+,` existed but was invisible | `Ctrl + ,` kbd pill in the header + on the Settings button tooltip |
| 14 | No keyboard focus indication | Tab navigation was invisible on the matte palette | Global `:focus-visible` accent ring |
| 15 | No way to hand diagnostics to a maintainer | Debugging required screenshots and copy-paste | Redacted `نسخ التشخيصات` (never includes key material) |

## Resulting interaction model

- One row of two toggles: **user mic** (`deafen`) and **assistant speech**
  (`mute`), plus a text **abort**. No duplicated toolbars.
- Sidebar and footer never repeat an action: footer = Settings / API keys;
  header = status; body = session, agent, persona, controls.
- Every visible control is backed by a real command over WS-4097 and reports
  its result in the Arabic announce region.

## Credentials

Keys are inspected with `node scripts/key-report.mjs`, which prints provider,
count, source, length, and a truncated SHA-256 fingerprint — never the value.