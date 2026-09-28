# W1 — Typecheck the root test suite (dossier §7.8)

**Lane:** Wave 1 / Lane A · **Worker:** W1 · **Date:** 2026-09-28
**Write set:** `src/**/*.test.ts`, `tsconfig.tests.json`, this file. Nothing else was written.
**Not committed, not pushed.**

---

## 1. Baseline reproduced FIRST (before any edit)

```
npx tsc -p tsconfig.tests.json
EXITCODE=2   ERRCOUNT=62   (9 files, 76 output lines)
```

**The orchestrator's figure of 62 is exact.** No discrepancy to investigate.
Per-file tally, re-derived from the raw compiler output, not from the brief:

| File | Count | Codes |
|---|---|---|
| `src/orchestrator/narrator.test.ts` | 20 | TS2554 |
| `src/runtime/opencode-bridge.test.ts` | 20 | 19× TS18047 + 1× TS2554 |
| `src/voice/brain.test.ts` | 7 | 2× TS7006 + 4× TS18047 + 1× TS2554 |
| `src/voice/tts.test.ts` | 5 | 4× TS2345 + 1× TS2344 |
| `src/orchestrator/command-router.test.ts` | 4 | TS2345 |
| `src/runtime/client.test.ts` | 3 | 2× TS18048 + 1× TS2341 |
| `src/orchestrator/audio-pipeline-reset.test.ts` | 1 | TS2305 |
| `src/orchestrator/fr12-route.test.ts` | 1 | TS2345 |
| `src/voice/stt.test.ts` | 1 | TS2353 |
| **Total** | **62** | |

Pre-edit root suite, measured before touching anything: **46 files / 572 passed / exit 0**.

---

## 2. Result

| | Before | After |
|---|---|---|
| `tsc -p tsconfig.tests.json` | 62 errors, **exit 2** | **0 errors, exit 0** |
| root vitest | 572 passed / 46 files | **573 passed / 46 files (+1)** |
| desktop vitest | 153 passed / 24 files | 153 passed / 24 files |
| E2E | 18 passed | 18 passed |
| oxlint | 8 warnings | 8 warnings (ratchet held) |
| `npm run test:vantrilex` | — | **exit 0** |

**No test was deleted or skipped.** Verified two independent ways:
- Declaration count vs `HEAD` via `git show` (non-destructive): 193 → 194 across my 9 files, `skipped=0` in every one.
- Runner: 572 → 573. The **+1** is a test I added (§4.3).

---

## 3. Root cause: one class of drift, not nine bugs

Every one of the 62 errors is a **test that was never updated after a production signature changed.** The production build (`tsc --noEmit`, exit 0) and the runtime were correct throughout. `tsconfig.json:20` excludes `**/*.test.ts`, and Vitest transpiles without checking types, so these call sites were executing happily against wrong signatures.

Verdict per file: **all 62 are test bugs. Zero production defects were required to fix them.** One production *defect* was found that is orthogonal to the type errors and is reported in §6 without being touched.

---

## 4. Per-file findings

### 4.1 `narrator.test.ts` — 20 × TS2554 (the highest-value signal)

**Current signature** — `src/orchestrator/narrator.ts:107-112`:
```ts
export async function narrate(
  ctx: NarrationContext,
  chat: NarratorChat,
  model: string,          // <-- required, 3rd positional
  maxWords = 20,
): Promise<string | null>
```

**Production call site** — `src/daemon.ts:196-208` passes all three: `narrate({...}, narratorChat, NARRATOR_MODEL)`.

**What the tests expected:** 2 arguments, i.e. `narrate(ctx, chat)`. The test file was never touched when the required `model` parameter was added, so it has been one positional argument behind production the entire time. This is a *test* defect, confirmed by `daemon.ts:207`.

**Do they still match?** No. After the fix they match exactly, and are **forward-compatible with the WIRING.md proposal**: `docs/personas/WIRING.md:88` proposes `narrate(ctx, chat, NARRATOR_MODEL, 20, PERSONA_DIRECTIVES[activePersona])` — an additive 5th optional param behind the same 3rd positional I pass. Applying that change will not re-break this file.

**What I did:** passed `NARRATOR_MODEL` (already imported at the top of the file, already asserted to be `'thinkingmachines/inkling:free'` at `narrator.test.ts:181`) as the 3rd argument at all 20 call sites. Not a hardcoded slug — the constant under test is the one forwarded, so the change is behaviour-preserving and cannot drift from the routing table.

**A masked error, found only after the arity was fixed:** `narrator.test.ts:77` carried `errorDetail: undefined`. With `exactOptionalPropertyTypes: true`, `NarrationContext.errorDetail?: string` (`narrator.ts:65`) cannot accept an explicit `undefined`. **TypeScript had never reported this**, because a call with the wrong arity reports TS2554 and *stops checking the arguments*. Fixing the arity unmasked it. The property is now omitted, which is the only representable form and is what `narrationContextLine` treats identically (`narrator.ts:87`).

> **Generalisable lesson for the orchestrator:** the probe config was not just finding drift, it was *uncovering* it layer by layer. Any future `narrate` signature change may expose further masked errors. Do not assume 62 errors == 62 independent problems.

### 4.2 `opencode-bridge.test.ts` — 19 × TS18047 + 1 × TS2554

- **TS18047 ×19:** `getSessionDetails` returns `SessionDetails | null` (`opencode-bridge.ts:104`) because a missing session must not throw. All 19 errors are property access on that nullable result. Added one narrowing helper (`sesADetails`) used at 7 call sites; it **throws** on null rather than casting, so a regression that starts returning null fails loudly instead of dereferencing. The null path itself remains pinned by the existing `ses_missing → toBeNull()` test, which I did not touch.
- **TS2554:** `setSessionModel(sessionId, spoken, catalog)` (`opencode-bridge.ts:169`) gained a required 3rd `catalog`. The test called it with 2. Passed `['muse-spark']` — the id the mock serve actually advertises — so `'zzz-not-real'` is still unresolvable and the "must not be forwarded to serve" assertion (`opencode-bridge.ts:171` throws before any fetch) keeps its meaning.

### 4.3 `brain.test.ts` — 7, and the blind spot it exposed

- **TS2554:** a call counter wrapped `mockFetch` and spread `args as []`, calling a `typeof fetch` with zero arguments. Now typed `Parameters<typeof fetch>` and forwarded properly.
- **TS7006 ×2 / TS18047 ×4:** `let seen = null;` with the assignment inside a callback is never tracked by control-flow analysis, so `seen` stayed `null` at every use. Annotated `| null` and asserted non-null, matching the pattern already used elsewhere in the same file.

**The blind spot (important).** Every chat double in `narrator.test.ts` ignores its first parameter, and the same is true here. **Nothing in the suite pinned the `model` argument at all** — `narrate` could have passed `''` or a hardcoded slug and 572 tests would have stayed green. Since WIRING.md proposes changing this exact function, I added one test, `forwards the model slug it was given — it does not pick its own` (`narrator.test.ts:150-167`), which pins the forwarding in both directions. This is the 572 → 573 test. Verified non-vacuous in §5.

### 4.4 The five `projectDirectory` sites

`CommandRouterDeps.projectDirectory: () => string` (`command-router.ts:53`) is required and was added in Phase 4. Five test constructions were never updated: `command-router.test.ts:39` (harness) + `:250`, `:299`, `:329`, and `fr12-route.test.ts:26`. Added `projectDirectory: () => 'O:/project'` to each. Each of these tests exercises a different path and none of them touch session creation, so the value is inert in all five.

### 4.5 Remaining, briefly

| File | Error | Cause | Fix |
|---|---|---|---|
| `audio-pipeline-reset.test.ts:4` | TS2305 | Imported `Utterance` from `../common/brands.js`, which has never exported it (`brands.ts` exports only `ISODateString`, `SessionId`, `EventId`, `ApprovalId`, `VoiceId`, `PersonaId`, …). The type lives at `audio-pipeline.ts:17`. | Import from `./audio-pipeline.js` |
| `stt.test.ts:22` | TS2353 | `WhisperSegment` (`stt.ts:34`) models **only** `no_speech_prob?: unknown`. The fixture passed `{ text: 'a' }` to mean "a segment with no probability". | `{}` — the function (`stt.ts:47`) reads only `seg?.no_speech_prob`, so this is runtime-identical |
| `tts.test.ts:245` | TS2344 | `Parameters<typeof FishHttpTransport>` — a class constructor is not callable, so the constraint fails. | `ConstructorParameters<…>` |
| `client.test.ts:540` | TS2341 | Reached into `ServeClient.request`, which is **private** (`client.ts:287`). | Reached the same endpoint through the public `listModels()`. Reachability is *stronger*, not weaker: `listModels` returns `[]` on a non-OK response (`client.ts:607`), so `expect(models.length).toBeGreaterThan(0)` fails on a 404 where the old `expect(res.ok)` was asserting the same thing from inside the class. Verified in §5. |
| `client.test.ts:126,135` | TS18048 | `req.url` is `string \| undefined` on `IncomingMessage`. | `?.` — `req.url` is always set by the mock server, so this is a type-level change only |

---

## 5. Non-vacuity verification (every guard broken, then restored)

Per the project rule, no guard was trusted until observed failing. `narrator.ts` and the two test files were temporarily modified and **fully restored** — `git diff --name-only` over `src/` confirms no production `.ts` file is modified.

| # | Guard | Break | Result |
|---|---|---|---|
| 1 | new `model`-forwarding test | `narrator.ts:116` `chat(model, …)` → `chat(NARRATOR_MODEL, …)` | **exit 1**, 1 failed / 21 passed, names `forwards the model slug it was given`. Restored, re-ran green. |
| 2 | `sesADetails` null guard | helper reads `ses_gone` (not served) → null | **exit 1**, 7 failed, all `Error: expected details for ses_a`. Restored, 20/20 green. |
| 3 | `client.test.ts` reachability | mock route `/api/model` → `/api/model-BROKEN` (404) | **exit 1**, 5 failed, names `expect(models.length).toBeGreaterThan(0)`. Restored. |

Guard 2 needed a second attempt worth recording: **merely deleting the null check changed nothing** (20/20 still passed), because `ses_a` is always served so the null branch is unreachable in the happy path. The guard is live — proven by guard 3's sibling in §5 row 2 — but the lesson stands: *"I disabled it and nothing happened"* is not proof of vacuity either way, and a narrowing helper needs its *input* broken, not its body.

---

## 6. Production defects found — reported, NOT touched

**D1 — `AudioCacheConfig.maxEntries` is declared configuration and is silently inert.**
`src/voice/cache.ts:32` types it as the **literal** `50`, and `cache.ts:55` hardcodes `max: 50` in the `LRUCache` constructor. **`cfg.maxEntries` is never read anywhere.** Two consequences:
- The field is a lie: a caller can set it in JS and observe no behaviour change.
- The literal type `: 50` makes that invisible — it is why this surfaced as a *type* error in the test rather than a behavioural one. `tts.test.ts` had `maxEntries: 10` in one config and `50` in another; the 10 was a copy-paste leftover with no effect either way.

I set the test config to `50` and annotated both configs `: AudioCacheConfig` so the contract is now checked at the declaration. **I did not change `cache.ts`.** Suggested fix for whoever owns it: widen to `maxEntries: number` and pass `max: cfg.maxEntries` at `cache.ts:55`. Flagging rather than fixing because it changes runtime behaviour and is outside my write set.

**UNVERIFIED (not checked, out of scope):** whether any *other* required `CommandRouterDeps` field is likewise unexercised by these five tests. I verified only that `projectDirectory` is inert in them.

---

## 7. Recommended wiring — **for the orchestrator to apply; NOT applied by me**

`package.json` and `AGENTS.md` are outside my write set. `tsconfig.tests.json` already exists, needs no change, and the probe script is already present.

**`package.json:25` — add `typecheck:tests` to the gate.** It is deliberately absent today, which is exactly why 62 errors accumulated unnoticed.
```diff
-    "test:vantrilex": "npm run typecheck && npm run lint && npm run lint:ox && npm run test && npm run test:desktop && npm run test:e2e",
+    "test:vantrilex": "npm run typecheck && npm run typecheck:tests && npm run lint && npm run lint:ox && npm run test && npm run test:desktop && npm run test:e2e",
```
Place it immediately after `typecheck` so a type failure is reported before the slow suites. `tsconfig.tests.json:6` includes `src/**/*.ts` and excludes only `node_modules`/`dist`, so this re-checks the production sources too — a marginal duplicate of `typecheck`, which is cheap and was green in every pass I ran. I recommend **wiring it in, not baselining it**: it now exits 0, so there is no debt to baseline, and a ratchet would only re-create the blind spot this lane just closed.

**`AGENTS.md`** — the section beginning *"No stage typechecks the test files"* is now false and should be rewritten to: `npm run test:vantrilex` runs `typecheck:tests` over all root test files; it exits 0 as of this change. The recorded figure *"62 errors across 9 files"* is historical — keep it as the before, not the present.

**Also correct while you are there:** the same AGENTS.md section cites root **568**; the measured value is **572** at HEAD and **573** after this change. Desktop 153 and E2E 18 were both confirmed exactly.

---

## 8. Component availability (per the catalog assignment)

| Component | Status |
|---|---|
| agent persona `build-error-resolver` | **UNAVAILABLE** — no such agent in `.opencode/agents/` or the session. Work done manually. |
| skill `coding-standards` | **AVAILABLE** — loaded and applied. |
| skill `migrate-to-shoehorn` | **UNAVAILABLE** — not present. |
| skill `ponytail` | **UNAVAILABLE as a loadable skill** — `.opencode/skills/ponytail/SKILL.md` exists but is not registered in this session, so it could not be loaded. |
| plugin `typescript-lsp` | **UNAVAILABLE as behaviour** — `.opencode/plugins/typescript-lsp.md:1-9` is a 9-line catalog stub whose only content is a description and a raw URL. No LSP was attached; `npx tsc` was used instead. |
| plugin `commit-commands` | **UNAVAILABLE** — stub, same shape. Moot: I am not committing. |
| hook `typescript-check-after-editing-ts-tsx-files` | **UNAVAILABLE / ARCHIVED** — only copy is `.opencode/_archive/catalog-stubs/hooks/typescript-check-after-editing-ts-tsx-files.md`, outside the active hook path. I ran the typecheck manually after every edit instead. |
| hook `reminder-before-git-push-to-review-changes` | **UNAVAILABLE** — not found. |
| MCP `sequential-thinking` | **AVAILABLE** (tool present, not required for this task). |
| MCP `filesystem` | **AVAILABLE** (tool present, not required for this task). |

The two assigned hooks are precisely the ones that would have caught this whole class of defect automatically. Their archival is itself a finding.

---

## 9. Exit criteria

| # | Criterion | Status |
|---|---|---|
| 1 | `npx tsc -p tsconfig.tests.json` exits 0 | ✅ **0 errors, exit 0** (unpiped) |
| 2 | `npm run test:vantrilex` exits 0; root ≥572, desktop ≥153, E2E 18 | ✅ **exit 0** · root **573**/46 · desktop **153**/24 · E2E **18** |
| 3 | `git status` shows only my write set | ✅ see caveat below |
| 4 | `file:line` for every claim; unmeasured marked UNVERIFIED | ✅ §6 |
| 5 | Not committed, not pushed | ✅ |

**Caveat on #3 — concurrent workers.** `git status` also shows `README.md`, `README.ar.md`, `apps/desktop/src-tauri/{Cargo.lock,Cargo.toml,src/main.rs}`, `docs/11-TESTING.md`, `docs/25-CLIENT-SERVER-RPC.md`, `package.json`, `vitest.config.ts` and untracked `dossier/REMEDIATION_SWARM_PLAN.md`. **None of these are mine** — they are other workers' concurrent edits, present before and during my run. Verified my own footprint:
```
git diff --name-only -- src/ | grep -v '\.test\.ts$'   →  (empty)
```
No production `.ts` file was modified by me. `src/orchestrator/narrator.ts` was edited only for the §5 guard-breaking exercise and is byte-identical to `HEAD`.

> **Concurrent-change warning for the orchestrator:** another worker removed `@opencode/client` and `eventsource` from `package.json` `dependencies` *while this gate was running*. The gate still passed, because `node_modules` was not pruned — so that removal is **UNVERIFIED** against a clean install and will likely break `npm ci` and any fresh clone. Worth confirming before it is committed.
