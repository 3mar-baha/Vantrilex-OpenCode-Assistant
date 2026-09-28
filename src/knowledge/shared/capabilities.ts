import type { SharedChunk } from '../types.js';

// TIER 1 — SHARED GROUND TRUTH. Tooling surface with measured bounds.
//
// Every latency here was measured on this machine against a live provider, not
// estimated. The numbers are deliberately included: a persona that says "it is
// slow" without a figure is guessing, and a persona that says "1.4 seconds"
// when it is 5 is worse. Both personas get the same figure.
export const CAPABILITIES_CHUNKS: readonly SharedChunk[] = [
  {
    id: 'cap-tts',
    source: 'src/voice/tts.ts; dossier/P1-TTS-CHUNK-LATENCY.md',
    text:
      'تحويل النص إلى كلام عبر Fish Audio بموديل s2.1-pro-free، ' +
      'مع latency يساوي balanced وصيغة mp3. ' +
      'Text to speech runs on Fish Audio using the s2.1-pro-free model with latency balanced, ' +
      'streaming mp3 chunks. Measured first-chunk latency is 426 to 556 milliseconds.',
  },
  {
    id: 'cap-tts-free-tier',
    source: 'src/voice/tts.ts; CHANGELOG.md',
    text:
      'النسخة المجانية من Fish Audio تنتهي صلاحيتها في 2026-11-30. ' +
      'The free Fish Audio tier expires on 2026-11-30. There is no service level agreement ' +
      'and requests may be retained for training. Everything in Voxaura is free tier by ' +
      'design, so no paid model is ever required.',
  },
  {
    id: 'cap-stt',
    source: 'src/voice/stt.ts',
    text:
      'تفريغ الصوت عبر Groq whisper-large-v3-turbo، measured بين 421 و 688 مللي ثانية. ' +
      'The language parameter is pinned to ar, so English audio returns Arabic output by ' +
      'design. That is not a bug and must never be reported as one. ' +
      'Speech to text runs on Groq whisper-large-v3-turbo with the language pinned to Arabic.',
  },
  {
    id: 'cap-ingest',
    source: 'apps/desktop/src/audio; AGENTS.md#gotchas',
    text:
      'نافذة التسجيل خمس ثوانٍ وتسعة الستين ألف بايت. ' +
      'The capture window is 5 seconds, 160000 bytes at 16 kHz. An utterance shorter than ' +
      'that buffers and does not transcribe yet, which is expected behaviour and not a ' +
      'broken microphone.',
  },
  {
    id: 'cap-frame-limit',
    source: 'src/ipc/protocol.ts; AGENTS.md#gotchas',
    text:
      'إطار صوتي أكبر من 65536 بايت يُرفض بإطار error ولا يصل إلى المعالجة. ' +
      'A binary audio frame larger than 65536 bytes is rejected with an error frame and never ' +
      'reaches the pipeline. The window is 160000 bytes, so audio must be sent in chunks of ' +
      '32 kilobytes or less.',
  },
  {
    id: 'cap-barge-in',
    source: 'src/daemon.ts (speechGate); src/orchestrator/audio-pipeline.ts',
    text:
      'عند مقاطعة المستخدم أثناء الكلام تُلغى الجملة الحالية بالكامل ولا تُنطق. ' +
      'Barge-in increments a generation counter re-checked after every await, so an ' +
      'interrupted turn is abandoned and a stale reply is never spoken aloud.',
  },
  {
    id: 'cap-models',
    source: 'src/orchestrator/coordinator.ts; src/orchestrator/narrator.ts; src/voice/brain.ts',
    text:
      'نموذج Intake هو dots-3، ونموذج التخطيط والسرد هو inkling. ' +
      'The intake model is dots-3 and the coordinator and narrator model is inkling. ' +
      'All models are free tier, all are served through OpenRouter, and none is paid.',
  },
  {
    id: 'cap-openrouter-ua',
    source: 'src/voice/brain.ts; AGENTS.md#models',
    text:
      'واجهة OpenRouter تتطلب ترويسة User-Agent بصيغة opencode/1.0 Voxaura، ' +
      'وإلا ترفض الطلب بخطأ 403. ' +
      'OpenRouter requires an agentic User-Agent of the form opencode/1.0 (Voxaura). ' +
      'Without it every planning and narration call fails with HTTP 403. Node sends no such ' +
      'header by default, so the header must be set explicitly.',
  },
  {
    id: 'cap-effort-none',
    source: 'src/voice/brain.ts; AGENTS.md#models',
    text:
      'نموذج inkling يحتاج reasoning effort none، وإلا استهلك الحصة كاملة ' +
      'وأعاد محتوى فارغاً. ' +
      'The inkling model requires reasoning effort none. Without it the model spends its ' +
      'budget reasoning and returns empty content. This was measured, not documented.',
  },
  {
    id: 'cap-narration',
    source: 'src/orchestrator/narrator.ts',
    text:
      'جملة السرد عربية واحدة لا تتجاوز عشرين كلمة ولا 240 حرفاً، ' +
      'ويجب أن تكون بصيغة JSON فقط. ' +
      'A narration line is one Arabic sentence, at most 20 words and 240 characters, ' +
      'returned as JSON only. A confirmation is one line; a monologue is a bug.',
  },
  {
    id: 'cap-playback',
    source: 'apps/desktop/src/audio/playback.ts',
    text:
      'طابور التشغيل في الواجهة له حد أقصى، ولا يستطيع فشل المستهلك أن يوقفه. ' +
      'The playback queue has a hard cap and a throwing consumer callback cannot wedge it; ' +
      'the draining flag resets before the try block so a failure always clears.',
  },
];
