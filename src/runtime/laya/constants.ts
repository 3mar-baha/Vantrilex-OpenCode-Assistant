// Laya System-1 constants — M7 L3.
//
// These live in their own dependency-free module on purpose. `loader.ts` needs
// the head list to build its façade, and `laya-engine.ts` statically imports
// `onnxruntime-node`. If the constants stayed in the engine, the safe loader
// would need a static edge to the unsafe module and the two-layer defence
// described in loader.ts would collapse to one. See
// `src/policy/laya-sidecar-safety.test.ts`.

// Operating length 32 tokens: the corpus p99 is 32 (max 35) and masked mean
// pooling makes logits invariant to pad length, so 32 is the latency-optimal
// point that still covers 99% of utterances — p50 25.8 ms vs 66.4 ms at 128
// (docs/09 ADR-008, ml/l2_report.json). UNVERIFIED: not re-measured here; the
// only live number for this file comes from the archived integration test.
export const LAYA_OPERATING_LENGTH = 32;

export const LAYA_HEADS = ['should_speak', 'is_destructive', 'barge_in', 'stuck_in_loop'] as const;
export type LayaHead = (typeof LAYA_HEADS)[number];
