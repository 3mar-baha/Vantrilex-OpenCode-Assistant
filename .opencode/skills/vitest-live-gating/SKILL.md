---
name: Vitest live gating
description: How this repo splits hermetic unit tests from opt-in live-model integration tests. Use when adding or running tests, when a test needs a real ONNX model or tokenizer, or when native dependencies must be stubbed.
---

# Vitest live gating

The default suite must stay fast, hermetic, and green on a machine with no model
artifacts. Anything that needs the real Laya ONNX model or checkpoint tokenizer
is gated behind `LAYA_LIVE=1`.

## Two tiers

| Tier | Location | Requirement | Runs by default |
|------|----------|-------------|-----------------|
| Unit | `src/**/*.test.ts` | none (stub native deps) | yes |
| Live | `src/runtime/laya/laya.integration.test.ts` | `LAYA_LIVE=1` + artifacts | no (skipped) |

Gate the live tier with a single computed boolean:

```ts
const live =
  process.env['LAYA_LIVE'] === '1' &&
  existsSync(HF_TOKENIZER) &&
  existsSync(MODEL_INT8);

describe.skipIf(!live)('Laya live model', () => { /* ... */ });
```

## Stubbing native dependencies

`onnxruntime-node` must not load in unit tests. `LayaEngine` accepts an optional
`sessionFactory`, so inject a stub and assert on the shape:

```ts
const engine = new LayaEngine(tokenizer, 'models/laya-m7-int8.onnx', 8, async () => ({
  run: async () => ({
    logit_should_speak: new Tensor('float32', [2.0], [1]),
    // ...
  }),
}));
```

## Golden vectors

For anything with a deterministic external oracle (tokenizers, quantization),
commit a golden fixture and assert byte-for-byte. The tokenizer fixture lives at
`src/runtime/laya/__fixtures__/tokenizer_golden.json` and is produced by
`ml/gen_tokenizer_golden.py` from the authoritative Python `tokenizers` lib.
Regenerate the fixture when the tokenizer changes; never edit it by hand.

## Rules

- Never make a unit test depend on `models/`, `.hf_cache/`, or the network.
- Never `Promise.all` many `engine.decide` calls to measure latency — that
  inflates timings and races session creation. Measure sequentially.
- Do not cherry-pick an assertion phrase to make a live test pass. Assert on
  real held-out data (e.g. mean score over labelled test rows) instead.

## Run

```sh
npx vitest run                                  # unit tier
LAYA_LIVE=1 npx vitest run src/runtime/laya/laya.integration.test.ts
```
