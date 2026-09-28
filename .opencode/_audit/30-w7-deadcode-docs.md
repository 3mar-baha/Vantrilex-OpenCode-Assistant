# W7 — dead config, unused dependencies, and documentation truth (Wave 1, Lane C)

**Agent:** Technical Writer · **Date:** 2026-09-28 · **Write set:** `package.json`,
`vitest.config.ts`, `README.md`, `README.ar.md`, `docs/**`, this report.
**Not touched:** `AGENTS.md`, any `src/` file, anything under `apps/`, `scripts/`,
`assets/`, `CHANGELOG.md`. Nothing committed or pushed.

Every claim below is derived from physical source with a `file:line` citation.
Where I could not measure, the item is marked **UNVERIFIED** rather than guessed.

---

## A. The dead coverage threshold — DELETED, not enabled

**Decision: delete.** Enabling it was not honestly available to me.

### What it was

`vitest.config.ts:6-11` declared:

```ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.test.ts'],
  thresholds: { lines: 80 },
}
```

### Why it never executed

1. **`coverage.enabled` defaults to `false`** — confirmed against the Vitest 4
   documentation via context7 (`/vitest-dev/vitest`, *coverage.enabled*: "Enables
   coverage collection. Can be overridden using the `--coverage` CLI option
   (default: `false`)"). `thresholds` is inert without it.
2. **Nothing sets it.** `package.json:17-30` has no `--coverage` in any script;
   `test:vantrilex` is `typecheck && lint && lint:ox && test && test:desktop &&
   test:e2e` (`package.json:25`).
3. **The provider is not installed.** `Test-Path node_modules/@vitest/coverage-v8`
   → **False**. `Get-ChildItem node_modules/@vitest` returns only `expect`,
   `mocker`, `pretty-format`, `runner`, `snapshot`, `spy`, `utils`. Enabling it
   requires an install, and installing is explicitly out of bounds for this lane.
4. **There is no CI.** No `.github/` directory exists at all (verified). So
   nothing else would have run it either.

Net effect: the threshold had **never** been evaluated, while reading exactly
like a floor. A configured floor that never runs is worse than no floor, because
it stops the reader looking.

### Why not enable it

- No gate stage passes `--coverage`, so enabling it in the config changes **no**
  gate's exit code. It would be theatre.
- **The true line-coverage number has never been measured.** I could not measure
  it (no provider installed, no install permitted). Writing `thresholds: { lines:
  80 }` and turning it on would mean asserting 80 is achievable on ground I have
  never sampled — a guess wearing a number's clothes, and the repo's own rule is
  *measure, never assume*.
- `coverage.include` is `src/**/*.ts`, i.e. **every** module, including the
  ML/ONNX and live-provider paths. An 80 % floor over that surface is very
  unlikely to hold, so enabling it would most likely turn the gate permanently
  red — and a permanently red gate gets disabled.

### What I did

Removed the entire `coverage` block and replaced it with a comment recording the
above and the exact three commands to reinstate a real floor (install
`@vitest/coverage-v8` → `npx vitest run --coverage.enabled --coverage.provider=v8`
→ *then* write the threshold and add a `--coverage` gate stage). The comment also
states the current true value: **line coverage is UNMEASURED — no floor exists.**
I deliberately recorded that as *unknown* rather than as `0 %` or `80 %`.

**Consequence for docs:** `docs/11-TESTING.md` §11.1's "≥ 80 % lines" coverage
expectation and `docs/00-PROJECT-GUIDE.md`'s gate table both propagated the same
never-enforced floor. Both corrected.

---

## B. Unused dependencies — verified by import search, not assumption

Method: recursive `Select-String` over `src/`, `apps/desktop/src`,
`apps/desktop/e2e/`, `scripts/`, plus a repo-wide pass over `docs/`, `dossier/`,
`assets/`, `.opencode/` for `*.{ts,tsx,mjs,js,json,md}`. I also checked the
lockfile dependency graph programmatically, not by eye.

| Dep | Verdict | Evidence |
|---|---|---|
| `@opencode/client` | **REMOVED** | Zero imports. Only two **prose comments**: `src/runtime/client.ts:7` ("the documented equivalent of @opencode/client calls") and `:10`. The client is a hand-written `fetch` wrapper. |
| `eventsource` | **REMOVED** | Zero imports, zero mentions in `src/`. Appeared only in `package.json:33` and `scripts/provision-sidecar.mjs:51`. |
| `pino` | **KEPT — flagged, see below** | Real importer chain exists. |
| `lucide-react` | **UNUSED — could not remove, out of write set** | Zero references in any source file. Only `apps/desktop/package.json:19` and its lockfile entry. |
| `simplex-noise` | **UNUSED — could not remove, out of write set** | Only a **comment**: `apps/desktop/src/matrix/matrix-state.ts:3` ("the worker passes simplex-noise, tests pass a stub"). No import anywhere. |

### The audit's open question, now resolved

`.opencode/_audit/01-core-engine.md:989` recorded this as **UNVERIFIED**: *"`eventsource`
… is either a transitive requirement of `groq-sdk` or dead weight in the manifest."*

**Resolved: dead weight.** Checked programmatically, not assumed:

- `groq-sdk@0.9.1` dependencies are `@types/node`, `@types/node-fetch`,
  `abort-controller`, `agentkeepalive`, `form-data-encoder`, `formdata-node`,
  `node-fetch`. **No `eventsource`.**
- A grep across `node_modules/groq-sdk` for `eventsource` → **zero hits**.
- Walking every entry in `package-lock.json` for a dependency/peer/optional/
  dev requirement on `eventsource` → **no package requires it**. It is a
  top-level, root-only, unimported leaf.

### Sidecar payload — the answer is "no", and that is a problem

**Removing `eventsource` from the root manifest does NOT change the shipped
payload. Not by one byte.** `scripts/provision-sidecar.mjs:44-56` writes its
**own** manifest object with a hardcoded dependency list, writes it to
`<sidecar>/package.json` (`:57`), and then runs its own
`npm install --omit=dev` **inside the sidecar directory** (`:59-63`, `cwd: sidecar`).
It never reads the root `package.json`. The sidecar is a fully independent
install.

So the installer still ships `eventsource` because
**`scripts/provision-sidecar.mjs:51` still lists it.** `scripts/` was outside my
write set, so I did **not** edit it. This is the single highest-value follow-up
from this lane:

> **Action for the sidecar/packaging owner:** delete the
> `'eventsource': '^3.0.0',` line at `scripts/provision-sidecar.mjs:51`, then
> re-run `node scripts/provision-sidecar.mjs`. Only then does the dead weight
> actually leave the installer.

### `pino` — deliberately not removed, collision flagged

`pino` **does** have a real importer: `src/common/logger.ts:1`
(`import pino from 'pino'`) and `:30` calls `pino({...})` inside
`createLogger()` (`:29`), which is re-exported by `src/common/index.ts:7`.

**However `createLogger` has zero callers** — a repo-wide search for
`createLogger` returns only the definition (`logger.ts:29`) and the re-export
(`common/index.ts:7`). So the logger is an unimported dead module and `pino` an
unimported dependency. That is the "dead redacting logger" finding, owned by
another lane; per instruction I did **not** remove it. Two notes for that lane:

1. Removing `pino` from the root manifest is **not sufficient** — for the same
   independent-manifest reason as `eventsource`, `'pino': '^9.0.0'` must also
   come out of `scripts/provision-sidecar.mjs:53` or the installer keeps shipping it.
2. `src/common/logger.test.ts:2` imports `redactSecrets` and `containsSecret`
   (not `createLogger`). So the test file must be assessed separately from the
   `createLogger` removal — do not delete `logger.ts` wholesale and take its test
   with it.

---

## C. Test-count truth

### Measured (executed in this lane)

| Quantity | Value | Command |
|---|---|---|
| Root unit | **573 passed / 0 skipped / 46 files** | `npx vitest run` (run twice, stable) |
| Desktop unit | **153 passed / 24 files** | `cd apps/desktop && npx vitest run` |
| Rust unit | **27** | `#[test]` count in `src-tauri/src/main.rs` — **counted, not executed** (needs MSVC `VsDevCmd.bat`) |
| E2E | **18 `test(` / 14 spec files** | counted from `apps/desktop/e2e/*.spec.ts` — **counted, not executed** (I did not hold the E2E lock, per instruction) |
| Oxlint | **8** | `node scripts/lint-baseline.mjs` → `oxlint: 8 warning(s), 0 error(s); baseline 8 / OK`, exit 0 |

### The 572 → 573 delta is NOT mine

The brief states the baseline is 572. My first run measured 572; after my
edits it measured 573. Cause, isolated by diffing the test files:

```
+  test('forwards the model slug it was given — it does not pick its own', ...)
```

A **concurrent swarm lane** added one test to `src/orchestrator/command-router.test.ts`.
`git status` confirms nine `src/**/*.test.ts` files modified by other workers —
the exact nine carrying the 62 `typecheck:tests` errors, i.e. the lane that is
fixing test types — plus `apps/desktop/src-tauri/src/main.rs` (+685 lines, the
Rust lane).

**My lane added zero tests and deleted zero.** The two dependency removals and
the coverage-block removal are not referenced by any test, so neither can move a
count. I re-measured twice; 573 is stable. The documentation states 573 and
`docs/10-CHECKPOINT.md` records the provenance explicitly, with a warning that
the number must be re-derived once the swarm settles.

### Where the six contradictory totals came from

They are **not** competing claims about the present. `docs/10-CHECKPOINT.md` is a
chronological append-only release ledger, and each number is what that release
measured at its own moment: 182 (`:256`) → 220 (v0.4.x rows `:353/:364/:375/:387`)
→ 491 (`:681`) → 498 (`:604`, v0.6.2) → 509 (`:720`, v0.7.1) → 572 → 573.

**I did not rewrite history.** Overwriting a ledger's past would be a worse
artefact than one that disagrees with itself, because a reader could no longer
tell what was known when. Instead I added a *"How to read the test counts in this
file"* section stating which number is current and which are fossils, plus a
`## v0.7.2` ledger entry with the measured state table. Historical rows keep
their original values, now labelled as historical.

### Genuinely wrong counts, fixed

- **README badge** claimed `583 unit + 26 rust`. **Both halves wrong.** → `726 unit + 27 rust` (573 + 153 = 726). The Rust count was never 26; there are exactly **27** `#[test]` attributes in `main.rs` (lines 926, 934, 939, 965, 988, 1001, 1020, 1031, 1043, 1063, 1085, 1111, 1119, 1127, 1133, 1155, 1163, 1172, 1180, 1187, 1197, 1205, 1213, 1223, 1242, 1260, 1283) and it is the only `.rs` file in `src-tauri/src`.
- **README contradicted itself 4×**: `:378` and `:443` said `309`/`220+89`, `:455` said `220+89`, while the table at `:326` correctly said 572/46. All now 573+153.
- **README `15/15` E2E** (twice) → `18/18`.
- **`README.ar.md`** carried the same bad badge and the same `220+89` line. Both fixed, plus an Arabic note that coverage has no floor and the `lines: 80` threshold was deleted.
- **`docs/00-PROJECT-GUIDE.md:136`** `309 pass (220 root + 89 desktop)` → `726 pass (573 root + 153 desktop)`, plus Rust and E2E rows.

All 13 replacements were applied with an **exact-occurrence assertion per file**
(the AGENTS.md rule, after the 0.6.1 bump that flattened eight files). The script
aborts on any mismatch; it reported 13/13 ok and exit 0.

---

## D. Phantom documentation

### `docs/11-TESTING.md` — rewritten. Described a harness that was never built.

Verified non-existent: `test/` **False**, `test/integration/` **False**,
`test/mocks/` **False**, `bench/` **False**, `bench/latency.ts` **False**,
`.github/` **False**, `.github/workflows/ci.yml` **False**. There is no `test/`
and no `bench/` directory in the repository at all, and `package.json` has no
`bench` or `stress` script — npm is the package manager, `pnpm-lock.yaml` is
vestigial.

Corroborating tell: §11.2's mock-server block was **not valid TypeScript** —
`emit.Encode(envelope: EventEnvelope)` (old `:29`) is not a member expression
any compiler accepts. It was never compiled or reviewed.

Rewritten with a supersession banner, a measured §11.0, and **per-section
status**. Three further drifts found while re-deriving, which the brief did not
list:

- **Language-audit harness (§11.5): no such test exists.** Zero hits for
  `language-audit` / `languageAudit` / `arabicRatio` across `src/`. The dialect
  *is* locked and *is* asserted, but only by narrow persona-fixture tests in
  `src/knowledge/personas.test.ts` and `corpus.test.ts`. Not the same guarantee.
- **BLUF 40-word cap (§11.5A): not implemented as a test.** There is no
  `bluf()` function. What exists is a `briefings: 'bluf' | 'full'` enum
  (`src/common/config.ts:26`) and a BLUF instruction inside the brain prompt
  (`src/voice/brain.ts:110`). The ≤45 s / ≤15-word limits are *instructions to a
  model*, not an enforced invariant.
- **Focus-steal harness (§11.6): no such test.** Zero hits. The design position
  is recorded at `src/voice/tts.ts:12` ("no focus APIs"). Left as **unverified**,
  same class as the open SEC-7/L18 microphone row.
- **§11.4's keyring illustration asserted something the real test explicitly
  refuses to assert.** The doc claimed
  `expect(used.slice(0, 10)).toEqual(all('K1'))` — a strict slot *order*.
  `src/voice/keyring.test.ts:24` says: *"Slot order under concurrency is
  nondeterministic; counts are structural."* The real invariant is per-pool
  counts. Flagged so nobody "fixes" the test to match the old doc.

### `docs/25-CLIENT-SERVER-RPC.md` — wrong auth scheme, fixed

§25.1 claimed `Authorization: Bearer` on every call. The shipped client uses
HTTP **Basic**: `basicAuth()` at `src/runtime/client.ts:14` builds
`Basic ${base64("opencode:<password>")}`, and the contract comment at
`src/runtime/client.ts:11` states *"Auth: HTTP Basic `opencode:<password>`
(Bearer is rejected)"*. The spec described a scheme the server refuses. Now
corrected, with the code citation inline.

### `docs/18-VOICE-PIPELINE.md` — phantom file, phantom model, phantom RAG

- **§18.3 cited `src/voice/prompts/ammani.system.md`, which does not exist.**
  `Test-Path src/voice/prompts` → **False**. The prompt is the
  `AMMANI_SYSTEM_PROMPT` const array at `src/voice/brain.ts:105`, sent as the
  `system` role at `src/voice/brain.ts:311`.
- **The heading said "for `gpt-oss-120b`".** `gpt-oss-120b` appears **nowhere**
  in `src/`. The brain is `thinkingmachines/inkling:free` (`brain.ts:177`).
- **§18.3's "RAG grounding (normative)" retracted.** It asserted grounding from
  JODA (59k sentences), UD South Levantine MADAR, `camel_tools`, dair-ai and
  xl-sum, that "corpora are ingested at prompt-build time", and that a
  ledger-recorded manifest of versions and digests exists per release. There is
  **no ingestion step, no manifest, no digests**. The only `joda`/`madar`
  occurrences in shipped source are four inline BM25 fixtures at
  `src/knowledge/retriever.test.ts:18-21`. `src/knowledge/guard.ts:2` states the
  position outright: the blocklist is **injected** and "Tier-D corpora live
  outside the repo".

### `docs/10-CHECKPOINT.md:421` — `latency: normal` → `balanced`

The row claimed `fishRequestBody()` sends `latency: normal`. It sends
`latency: 'balanced'` at `src/voice/tts.ts:386`, asserted by
`src/voice/tts-r3-errors.test.ts:98` (`toBe('balanced')`). Corrected, and I
flagged that **the doc comment at `src/voice/tts.ts:248` carries the same wrong
claim** — `src/` was outside my write set, so it is reported, not edited. This
is a live doc-comment bug that will mislead the next reader.

### `assets/benchmark-matrix.svg` — withdrawn in prose, still on the page

The README's §6 already declared the ten figures fabricated
(Pass@1 94.8 %, tool-calling 99.1 %, zero-hallucination 98.6 %, TTFT 180 ms,
E2E resolution 91.4 %) — but the `<img>` tag still **rendered the SVG** three
lines above that disclaimer. Withdrawing the prose while continuing to display
the artefact still shows a reader the numbers.

I removed the `<img>` tag (`README.md` is mine) and replaced it with a banner
saying the file is withdrawn, not to re-add the tag, and **why**. The file
itself **still exists and still contains all ten fabricated numbers**;
`assets/` was outside my write set, so I did not delete it.

> **Action for the assets owner:** delete `assets/benchmark-matrix.svg` or
> regenerate it from a real harness. There is no baseline agent and no eval
> harness in this repo that could produce those numbers.

### `src/knowledge/` — verified live, and nothing was stale about it

Confirmed on re-derivation, per the brief's warning: `src/cli.ts:205` wires
`knowledgeReport()`, reachable as `node dist/cli.js knowledge "<query>"`, with
`assertParity, buildIndex, verifyKnowledge` imported at `cli.ts:17` and dispatched
at `cli.ts:241-242`. Its index is hand-authored Tier-1 chunks at
`src/knowledge/build.ts:23`, Tier-2/3 selected by `when` at `:32`.

A search of `README.md`, `README.ar.md` and all of `docs/` for "knowledge"
returned **no** document calling it dead, quarantined or unwired — the only hits
were an unrelated MCP `server-memory` description and persona `/new` notes. So
there was nothing to correct here. Recorded as a verified negative, since
"no doc is stale" is itself a claim worth proving.

### Bonus stale claim found (not in the brief): the README's model catalog

`README.md:452-454` named `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` as
the **default model**, "promoted after a live HTTP 200 smoke", and claimed
"Registered OpenRouter slugs — exactly three, locked: Nemotron coordinator,
Dots3 intake, Inkling driver." The source has **two** slugs serving **four**
roles:

| Role | Constant | Slug |
|---|---|---|
| Intake | `INTAKE_MODEL` `coordinator.ts:22` | `dots-studio/dots-3-note-preview:free` |
| Coordinator | `COORDINATOR_MODEL` `coordinator.ts:23` | `thinkingmachines/inkling:free` |
| Narrator | `NARRATOR_MODEL` `narrator.ts:36` | `thinkingmachines/inkling:free` |
| Brain | `BRAIN_OPENROUTER_MODEL` `brain.ts:177` | `thinkingmachines/inkling:free` |

`nemotron` survives only as a *session-model string* in test fixtures
(`coordinator.test.ts:97`, `narrator.test.ts:57,221`,
`prompt-optimizer.test.ts:27`, `fuzzy-match.test.ts:35`) — user-set state, not a
routing default. Replaced with a table citing each constant's line, plus the two
silent-breakage Inkling requirements (agentic `User-Agent` → else 403;
`reasoning: {effort:'none'}` → else `content: null`).

The same paragraph listed MCP servers `github` and `obsidian-vault`, which are
**not** in `.mcp.json`, and omitted `typescript-lsp` and `openrouter`, which
**are** (`.mcp.json:4,12,20,29,37,46`). The count of six was right; the list was
wrong. Corrected against `.mcp.json`.

### Bonus stale claim: `docs/11` propagates a coverage floor

§11.1's test-pyramid table carried "≥ 80 % lines" as a *coverage expectation* —
the same never-executed floor as the config. Corrected.

### Not fixed, flagged

- **`CHANGELOG.md` has no v0.7.2 entry** although 0.7.2 ships in nine carriers
  (`package.json:3` is `0.7.2`, and the v0.7.2 installer path is cited at
  `README.md:466`). `CHANGELOG.md` is **not** in my write set, so I did not add
  one. Its latest entry is v0.7.1 (`:3`).
  > **Action for the release owner:** add a v0.7.2 entry. Content is in the
  > `## v0.7.2` section I added to `docs/10-CHECKPOINT.md`.
- **`.mcp.json:10`** still describes Context7 as "Used for @opencode/client …"
  after that dependency was removed. Harmless prose, not an import, and
  `.mcp.json` is outside my write set.
- **`package-lock.json` is now stale** for the two removed root deps (I could not
  regenerate it: `npm install` is explicitly forbidden and would risk version
  drift). `npm ci` would still install them until someone prunes the lock.
  > **Action for the release owner:** run a deliberate lockfile prune as part of
  > the next `npm install` that the release flow already performs.

---

## E. Blast-radius evidence for the dead-module owner

Brief paths were **wrong for 2 of 3 modules** — verified by directory listing:

| Brief said | Actually is |
|---|---|
| `apps/desktop/src/audio/earcons.ts` | ✅ correct |
| `apps/desktop/src/audio/brand/Crest.tsx` | ❌ `apps/desktop/src/**components**/brand/Crest.tsx` |
| `apps/desktop/src/audio/portals/CredentialPortal.tsx` | ❌ `apps/desktop/src/**components**/portals/CredentialPortal.tsx` |

`apps/desktop/src/audio/` contains only `capture.ts`, `playback.ts`, `vad.ts` and
their tests — no `brand/` and no `portals/` subdirectory exists there at all.
Use the corrected paths.

### Importer analysis

| Module | Production importers | Test importers | Exported |
|---|---|---|---|
| `audio/earcons.ts` | **0** | `audio/earcons.test.ts:2` | `earconRecipe`, `renderEarcon` (5 recipes) |
| `components/brand/Crest.tsx` | **0** | `components/brand/Crest.test.tsx:4` | `Crest`, `CrestProps` |
| `components/portals/CredentialPortal.tsx` | **0** | `components/portals/portals.test.tsx:5` | `CredentialPortal`, `CredentialPortalProps` |

Confirmed by a repo-wide `Select-String` for `earcons`, `brand/Crest`, `Crest.x`,
`CredentialPortal`, `portals/Credential` across `src/` and `apps/desktop/src/`.
All three are imported **only by their own test file**. This is exactly the
"passing tests, zero importers" class the project exists to hunt.

### Recommendation: `Crest.tsx` is the safest to delete

- **`Crest.tsx` — delete.** Lowest-risk of the three.
  - 4 lines of JSX body (`:7-15`), one `data-testid="voxaura-crest"`, one
    `aria-label="Voxaura crest"`, an inline inline-SVG logo mark.
  - **Unique marker:** `data-testid="voxaura-crest"` is defined *only* in
    `Crest.tsx:15`. Verified — no other file in the repo contains that string, so
    nothing else can depend on it.
  - The word "Crest" appears in `audio/earcons.test.ts:42-51` as the unrelated
    **crest factor** of a waveform (`const crest = (kind: 'arm' | 'abort')`).
    That is a local variable, not an import — do **not** let it block the
    deletion or, worse, tempt anyone to edit an earcons test.
  - Only `Crest.test.tsx` (a size-parameterisation test) needs deleting with it.
  - No `src/` module references it, and `src/knowledge/` does not mention it.

- **`CredentialPortal.tsx` — delete, but check the API-keys window first.**
  It renders **credential pool counts** (`portals.test.tsx:53-55`: "shows pool
  counts and never key material"). The AGENTS.md flow says keys enter only via
  the API-keys window → `saveApiKeys`, and a keyless daemon is the known-broken
  state. If any real UI surface is expected to reach this component, it is
  currently *not* being reached — which is itself a product finding, not just a
  dead-code one. Confirm with the HUD owner before deleting; if the API-keys
  window is supposed to render it, the defect is a **missing import**, and the
  right fix is to wire it, not delete it.
  - Note `portals.test.tsx` is a **shared** file — it imports `CredentialPortal`
    at `:5` and has its own `describe` at `:53`. Deleting the component means
    removing that import and that describe block, not the whole file.

- **`earcons.ts` — do NOT delete. Wire it.**
  It is the only one of the three with a **live cross-language reference**:
  `src/knowledge/shared/commands.ts:71` records a `source:` provenance string
  naming `apps/desktop/src/audio/earcons.ts` as a real origin. So the knowledge
  layer's Tier-1 ground truth asserts earcons exist and are part of the system.
  Deleting it would leave `src/knowledge/` asserting a file that is not there —
  the exact "documented but not wired" pathology this project is remediating.
  It is the only candidate of the three for **wiring into the HUD** rather than
  deleting, and it is also the only one whose test asserts a *behaviour*
  (waveform crest factor, `earcons.test.ts:42-51`) rather than a render.

**Ordering note:** deleting any of these will change the desktop test count
(153/24). The three test files hold a non-trivial share of those 153. Whoever
owns them should re-measure `cd apps/desktop && npx vitest run` and update
`README.md:327`, `README.md:455`, `docs/00-PROJECT-GUIDE.md:136` and the
`## v0.7.2` table in `docs/10-CHECKPOINT.md` in the same change — the count
must not silently drift from the document that states it.

---

## Gate status at handoff

| Check | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run lint:ox` | **exit 0**, `oxlint: 8 warning(s); baseline 8 / OK` — ratchet still exactly 8 |
| `npx vitest run` | **573 passed / 46 files, exit 0** (was 572 at my first run; +1 from a concurrent lane — see §C) |
| `cd apps/desktop && npx vitest run` | **153 passed / 24 files, exit 0** — unchanged |
| `npm run test:e2e` | **NOT RUN** — I do not hold the E2E lock |
| Committed / pushed | **No** |
| `git status --porcelain` | shows only my write set **plus** other workers' in-flight changes to `src/**/*.test.ts`, `apps/desktop/src-tauri/{main.rs,Cargo.toml,Cargo.lock}`, and untracked `dossier/REMEDIATION_SWARM_PLAN.md`. None of those are mine; I verified my own diff touches only `README.md`, `README.ar.md`, `docs/00-PROJECT-GUIDE.md`, `docs/10-CHECKPOINT.md`, `docs/11-TESTING.md`, `docs/18-VOICE-PIPELINE.md`, `docs/25-CLIENT-SERVER-RPC.md`, `package.json`, `vitest.config.ts` and this report. |

### Open items for other lanes (ranked)

1. **`scripts/provision-sidecar.mjs:51`** — drop `eventsource`; only then does
   the installer payload shrink.
2. **`pino` + `createLogger`** — dead, but owned elsewhere. Also drop
   `provision-sidecar.mjs:53`. Do not delete `logger.ts` without preserving
   `redactSecrets`/`containsSecret`, which its test imports.
3. **`apps/desktop/package.json:19,22`** — `lucide-react` and `simplex-noise`,
   zero importers. Outside my write set.
4. **`apps/desktop/src-tauri/src/main.rs:248`** (in `src/voice/tts.ts:248`) —
   the doc comment claiming `latency: 'normal'` where the code sends `balanced`.
5. **`assets/benchmark-matrix.svg`** — delete or regenerate; the README no longer
   renders it but the file remains.
6. **`CHANGELOG.md`** — add the v0.7.2 entry (content drafted in
   `docs/10-CHECKPOINT.md`).
7. **`package-lock.json`** — prune the two removed deps deliberately.
8. **Re-derive the root test count** after the swarm settles; 573 is not stable.
