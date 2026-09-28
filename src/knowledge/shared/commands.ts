import type { SharedChunk } from '../types.js';

// TIER 1 — SHARED GROUND TRUTH. What the user can say and what actually happens.
//
// These are the product facts most likely to be stated wrongly, because each has
// a plausible-sounding but false version. The false version is recorded here too,
// so a persona is never left to guess which is true.
export const COMMAND_CHUNKS: readonly SharedChunk[] = [
  {
    id: 'cmd-compact',
    source: 'src/orchestrator/slash.ts',
    text:
      'الأمر /compact يلخّص سياق الجلسة. ' +
      'This is handled natively and never reaches a model, so it works even with no keys. ' +
      'The /compact command compacts the session context and is answered locally.',
  },
  {
    id: 'cmd-new',
    source: 'src/orchestrator/slash.ts',
    text:
      'الأمر /new يفتح جلسة جديدة، وأي كلمة بعده تُؤكَّد لكنها لا تُحفظ. ' +
      'The /new command opens a new session. A trailing word is acknowledged but NOT ' +
      'persisted, because no rename endpoint exists. Never claim a title was set.',
  },
  {
    id: 'cmd-help',
    source: 'src/orchestrator/slash.ts',
    text:
      'الأمر /help يعرض الأوامر المتاحة من جدول محلي بدون أي طلب خارجي. ' +
      'The /help command lists available commands from a local table and makes no provider ' +
      'call at all, so it works offline and with no API keys.',
  },
  {
    id: 'cmd-mentions',
    source: 'src/orchestrator/mentions.ts',
    text:
      'الإشارات @file و @agent و @skill تُحل قبل أن يرى النموذج النص. ' +
      'Mentions of the form @file, @agent or @skill are resolved before any model sees the ' +
      'text. A rejected token, such as a path traversal, an absolute path or a symlink ' +
      'escape, never reaches a model.',
  },
  {
    id: 'cmd-destructive',
    source: 'src/voice/brain.ts (AMMANI_SYSTEM_PROMPT)',
    text:
      'الأفعال الخطرة destroy و delete و drop و force-push و deploy و rm -rf ' +
      'تتطلب سؤالاً قبل التنفيذ دائماً. ' +
      'Destructive verbs always ask first: destroy, delete, drop, force-push, deploy, rm -rf. ' +
      'When a request is ambiguous, ask; never act on a guess.',
  },
  {
    id: 'cmd-retry',
    source: 'src/voice/brain.ts (AMMANI_SYSTEM_PROMPT)',
    text:
      'في حلقة إعادة المحاولة: صمت في الخطوات الوسيطة، ' +
      'وتحديث كل خمس دقائق أو بعد ثلاثة إخفاقات، والتوقف عند خمسة وطلب قرار. ' +
      'On retry loops stay silent during intermediate steps, send a heartbeat every 5 ' +
      'minutes or after 3 failures, and halt at 5 attempts to ask.',
  },
  {
    id: 'cmd-status',
    source: 'apps/desktop/src/App.tsx; src/ipc/protocol.ts',
    text:
      'حالة النظام واحدة من idle أو listening أو thinking أو speaking. ' +
      'The status pill reads idle, listening, thinking or speaking, and the wave speaker ' +
      'takes the colour of the active persona. Context occupancy above 85 percent is worth ' +
      'one gentle mention of /compact.',
  },
  {
    id: 'cmd-persona-effect',
    // W6: `apps/desktop/src/audio/earcons.ts` was deleted as dead code (zero
    // production importers, proven by an import-graph scan). The provenance had
    // to move with it, AND the two sentences that asserted a persona-specific
    // "completion earcon tone" had to go: fixing the citation while leaving the
    // claim would have left Tier 1 asserting a deleted feature — the exact
    // defect class this corpus exists to prevent. The two surviving effects are
    // the Fish voice id (`daemon.ts:607` -> `common/brands.ts:22`) and the wave
    // gradient (`SiriWaveCanvas.tsx:20`, selected by persona in `App.tsx`).
    source: 'src/daemon.ts:607; src/common/brands.ts:22; apps/desktop/src/components/waveform/SiriWaveCanvas.tsx:20; src/orchestrator/narrator.ts',
    text:
      'اختيار الشخصية يغيّر الصوت ولون الموجة فقط. ' +
      'العبارة المنطوقة نفسها متطابقة بين الشخصيتين اليوم. ' +
      'Selecting a persona changes only the voice id and the wave colour. ' +
      'The spoken wording is currently IDENTICAL for both personas: narrator.ts ' +
      'contains no persona reference at all, and the dossier instructions are NOT yet ' +
      'injected into it. Never claim the two assistants speak differently.',
  },
];
