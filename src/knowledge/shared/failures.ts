import type { SharedChunk } from '../types.js';

// TIER 1 — SHARED GROUND TRUTH. Failure taxonomy and remedy.
//
// The load-bearing distinction in this file: a REJECTED key and an EXHAUSTED
// balance have opposite remedies. Telling a user to replace a working key
// because the credit ran out wastes their time and can break a working setup.
export const FAILURE_CHUNKS: readonly SharedChunk[] = [
  {
    id: 'fail-key-rejected',
    source: 'src/voice/keyring.ts (withKey, httpStatusOf)',
    text:
      'المفتاح المرفوض يعني رمز 401 أو 403، فيتم تدويره تلقائياً. ' +
      'A rejected key means HTTP 401 or 403, and the keyring rotates automatically. ' +
      'Say the key needs attention and that a replacement is needed.',
  },
  {
    id: 'fail-credit',
    source: 'src/voice/keyring.ts; dossier/FISH-AUDIO-COMPLIANCE-AUDIT.md R4',
    text:
      'نفاد الرصيد يعني رمز 402، وهو لا يعني أن المفتاح خاطئ ولا يدور تلقائياً. ' +
      'HTTP 402 means out of credit. It does NOT rotate the key, because the key is fine. ' +
      'Say the credit ran out, not that the key failed. A key that is present but invalid ' +
      'looks identical to a healthy one until the first utterance.',
  },
  {
    id: 'fail-ratelimit',
    source: 'src/voice/keyring.ts',
    text:
      'رمز 429 يعني تجاوز الحد، فيتم تدوير المفتاح لمحاولة آخر. ' +
      'HTTP 429 means rate limited, and the keyring advances to the next key to retry. ' +
      'This is a capacity condition, not a fault, and should be reported calmly.',
  },
  {
    id: 'fail-unknown',
    source: 'src/voice/keyring.ts (L17 decision)',
    text:
      'أخطاء غير المعروفة مثل 500 لا تدوّر المفتاح. ' +
      'Unrecognised failures such as a 5xx do NOT rotate the key, because a server-side ' +
      'error must not burn an otherwise valid key pool.',
  },
  {
    id: 'fail-nokeys',
    source: 'src/daemon.ts; AGENTS.md#vault',
    text:
      'بدون مفاتيح تبقى لوحة التحكم تعمل لكن الصوت معطّل، ' +
      'مع إشعار voice-disabled-no-keys. ' +
      'With no keys the control plane stays up and audio is dropped, with a ' +
      'voice-disabled-no-keys notice. Saving keys rebuilds the pipeline live, so voice ' +
      'stays dead until keys are actually saved.',
  },
  {
    id: 'fail-ports-busy',
    source: 'AGENTS.md#gotchas; apps/desktop/e2e',
    text:
      'إذا كان المنفذ 4096 أو 4097 مشغولاً فإن التطبيق المثبت يعمل بالفعل. ' +
      'If port 4096 or 4097 is already bound, an installed copy is still running and must be ' +
      'stopped first. A second launch fails with EADDRINUSE and that is expected, not a ' +
      'corrupt installation.',
  },
  {
    id: 'fail-jargon',
    source: 'AGENTS.md; docs/personas/nour.agent.md section 4',
    text:
      'لا تُنطق رموز الخطأ ولا أسماء الدوال بالإنجليزية. ' +
      'Never speak an error code, a stack trace or a function name aloud. ' +
      'Name what broke in plain language and give exactly one next step.',
  },
  {
    id: 'fail-firstrun',
    source: 'dossier/PHASE2_AUDIT_REPORT.md',
    text:
      'حالة KEYS_MISSING عند أول تشغيل سلوك مقصود وليست عطلاً. ' +
      'The KEYS_MISSING state on first run is designed behaviour, not a fault. ' +
      'The vault is created and seeded on first run, and an installed build resolves to ' +
      'the Voxaura vault under LOCALAPPDATA rather than the repo vault.',
  },
];
