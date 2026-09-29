# Archive Notice — docs/01 through docs/28

**Status: frozen history. Not instructions.**

The numbered specification files `docs/01-PRODUCT-REQUIREMENTS.md` through
`docs/28-OWNER-GUIDE.md` were authored as a design suite before much of the
system was implemented. They are preserved verbatim as an architectural
record, but they do **not** describe the shipped system in several places.

Known divergences (non-exhaustive):

- CLI surface: the specs list `start/stop/status/prompt/voice/pair/init` and
  similar commands. The implemented CLI exposes exactly `doctor`,
  `vault bootstrap`, and `live` (`src/cli.ts`).
- Serve auth: specs say Bearer. The 2.0.x contract is HTTP Basic
  `opencode:<password>` (verified live).
- Mobile relay: specified, then ratified out of scope (O5).
- Credential store: specs say DPAPI. Implemented as AES-256-GCM file vault
  with machine-scoped key (Electron `safeStorage` preferred when present).
- Brain route: specs say Groq `gpt-oss-120b`. The live path is Nemotron via
  OpenRouter with strict `response_format: json_object`.

**Single source of truth:** `docs/00-PROJECT-GUIDE.md`, verified against code
and live runs. When any numbered spec conflicts with the guide or the code,
the guide and the code win. Do not implement from `docs/01`–`docs/28`
without re-verifying against the implementation first.
