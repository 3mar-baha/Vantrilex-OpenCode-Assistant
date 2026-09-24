// One-shot memory probe — measures the daemon-side footprint with both ONNX
// models loaded. Numbers are recorded in docs/RELEASE-CHECKLIST.md; this is a
// measurement script, not a gate (CI machines vary).
const rss = () => `${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`;

console.log(`baseline: ${rss()}`);
const { SileroVad } = await import('../dist/runtime/vad.js');
const vad = await SileroVad.load('models/silero-vad.onnx');
console.log(`+silero-vad (2.2MB): ${rss()}`);

const ort = await import('onnxruntime-node');
const laya = await ort.InferenceSession.create('models/laya-m7-int8.onnx', { executionProviders: ['cpu'] });
console.log(`+laya-m7-int8 (308MB): ${rss()}`);

// Touch both graphs so pages are actually resident.
await vad.prob(new Float32Array(512));
const ids = new BigInt64Array(32);
const mask = new BigInt64Array(32).fill(1n);
await laya.run({
  input_ids: new ort.Tensor('int64', ids, [1, 32]),
  attention_mask: new ort.Tensor('int64', mask, [1, 32]),
});
if (global.gc !== undefined) global.gc();
console.log(`after inference + gc: ${rss()}`);
await vad.dispose();
