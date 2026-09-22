# 11 — Testing: Vitest Strategy, Mock Servers, Latency Harness & Stress Suites

> **Canonical status:** Governance. Quality truth; Gate-4 implementation detail (`16` §16.6.2).
> Types: `05` · Chaos detail: `23` · Docs-gate checks: `16` §16.6.1.

## 11.1 — Test Pyramid (normative)

| Layer | Runner | Scope | Coverage expectation |
|-------|--------|-------|---------------------|
| Unit | `vitest run` (`src/**/*.test.ts`, colocated) | keyring rotation, LRU cache, BLUF formatter, 3-Case classifier, validators, speech queue | ≥ 80% lines, 100% of `keyring.ts` + `cache.ts` branches |
| Integration | `vitest run` (`test/integration/`) | orchestrator vs mock `serve` (HTTP+SSe), voice vs mock Groq/Fish, vault round-trip on CI fixture | Every FR-1–FR-10 happy path + E-1–E-12 edge |
| Benchmark | `pnpm bench` (harness below) | STT p50, brain p50/p99, TTS first-chunk, cache-hit start | Budgets in `01` NFR-1/2/3 |
| Chaos/stress | `pnpm stress` (see `23`) | kill -9, SSE gaps, 429 storms, 100k bursts, leak watch | SLAs in `10` §10.2, `23` |
| Docs gates | PowerShell checks (`16` §16.6.1) | existence, placeholders, cross-refs, fences | Exact counts per batch |

**Green gate:** `tsc --noEmit` (0 errors) + `eslint --max-warnings 0` + `vitest run`
(100% pass) + benchmarks within budget + placeholder grep clean. Red returns to
Gate 3 (`16` §16.6.2).

## 11.2 — Mock Servers (normative fixtures)

All external I/O is mockable via interfaces; tests never touch live Groq/Fish/serve.

```ts
// test/mocks/serve.ts — mock opencode serve (HTTP + SSE)
export interface MockServe {
  readonly baseUrl: string;
  createSession(dir: string): { sessionId: string };
  emit.Encode(envelope: EventEnvelope): void; // inject SSE frame incl. duplicates/gaps
  dropConnection(): void;                     // simulate E-2 / E-4
  close(): Promise<void>;
}

// test/mocks/groq.ts — scripted Whisper + chat responses with programmable latency
export interface MockGroq {
  setSttLatencyMs(p50: number): void;
  setBrainLatencyMs(p50: number, p99: number): void;
  failNext(n: number, status: 429 | 500 | 'timeout'): void; // E-3 / E-8 drills
}

// test/mocks/fish.ts — scripted TTS chunks; first-chunk delay programmable
export interface MockFish {
  setFirstChunkMs(ms: number): void;
  failWith(status: 429 | 500): void;          // E-7 drill
}
```

**Contract fidelity rule:** mock payloads are generated from the same `zod` schemas as
production validators — a mock that emits schema-invalid data fails the test setup,
not the code under test.

## 11.3 — Latency Benchmark Harness (normative)

```ts
// bench/latency.ts — 200 samples per subsystem, reference network profile
export interface LatencyReport {
  readonly subsystem: 'stt' | 'brain' | 'tts-first-chunk' | 'cache-hit';
  readonly samples: number;                   // ≥ 200 (docs), ≥ 1000 (release)
  readonly p50Ms: number; readonly p99Ms: number;
  readonly budget: { readonly p50Ms: number; readonly p99Ms?: number };
  readonly pass: boolean;
}
export const BUDGETS = {
  stt:            { p50Ms: 500 },
  brain:          { p50Ms: 2000, p99Ms: 5000 },
  'tts-first-chunk': { p50Ms: 800 },
  'cache-hit':    { p50Ms: 50 },
} as const;
```

Procedure: warm the path (10 samples discarded) → collect N samples through mocks at
reference latency → compute percentiles → assert `pass`. Release runs repeat against
live providers (sandbox keys, `27-CREDENTIALS.md`) and record before/after in the
tuning log (`08` M5).

## 11.4 — Rotation Exactness Test (normative, ADR-003 proof)

```ts
// src/voice/keyring.test.ts (illustrative core)
test('25 requests over 3-key pool roll over exactly on #11 and #21', async () => {
  const ring = await Keyring.load(fixtureVault(3));
  const used: string[] = [];
  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    withPoolMutex('groq', async () => {
      const k = await ring.acquire('groq'); used[i] = k.id; await ring.release('groq', true);
    })));
  expect(used.slice(0, 10)).toEqual(all('K1'));
  expect(used.slice(10, 20)).toEqual(all('K2'));
  expect(used.slice(20, 25)).toEqual(all('K3'));
});
```

Concurrency: 8-way parallel dispatch; the pool mutex guarantees no slot double-spend.
Failure injection: scripted 429 on K1 at request 5 → forced rollover asserted
(`lastRolloverReason: 'rate-limited'`).

## 11.5 — Language-Audit Test (normative, `02` §2.3.3 proof)

Brain outputs are scanned: narrative spans must contain zero non-technical English
words (allowlist: code identifiers, paths, error codes, session names); code spans
must contain zero Arabic-script characters. Fixture corpus: 100 representative
briefings, bilingual. One violation fails the suite.

## 11.6 — Focus-Steal Harness (normative, `02` §2.2 proof)

50 completion injections on Windows reference host with a focus-log hook: asserts zero
foreground window activations and zero focus-API calls (spy on the audio/focus
boundary). Any activation fails the suite.

## 11.7 — CI Gates (normative)

```yaml
# .github/workflows/ci.yml (shape — full file in implementation milestone)
# jobs: typecheck (tsc --noEmit) → lint (eslint --max-warnings 0) →
#       unit+integration (vitest run) → bench (budgets) → docs-gates (counts/grep/refs)
# Docs-only changes run docs-gates + typecheck; code changes run the full chain.
```

---

*End of `11-TESTING.md`. Next: `12-SECURITY.md`.*
