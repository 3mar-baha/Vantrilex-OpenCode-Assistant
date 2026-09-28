import type { SharedChunk } from '../types.js';

// TIER 1 — SHARED GROUND TRUTH. Bilingual technical computing lexicon.
//
// The product rule, already in force in the narrator prompt: code identifiers,
// paths, logs, error codes, sessions and commands stay in TECHNICAL ENGLISH
// inside the Arabic sentence. These chunks exist so the model does not invent an
// Arabic transliteration of an English term, and so that a user asking in either
// language retrieves the same chunk.
//
// Each chunk pairs the Arabic concept with the exact English token, and is
// written so that a query in EITHER language matches: the tokenizer splits
// Arabic and Latin runs, and `normalizeToken` case-folds Latin and unifies
// Arabic orthography, so `الـ commit`, `commit` and `Commit` all land here.
export const LEXICON_CHUNKS: readonly SharedChunk[] = [
  {
    id: 'lex-vcs',
    source: 'dossier/KNOWLEDGE-ARCHITECTURE-PROPOSAL.md tier 1 lexicon',
    text:
      'المصطلحات: البناء build، الاختبارات tests، الإيداع commit، الفرع branch، ' +
      'الدمج merge، الدفع push، السحب pull، المستودع repository. ' +
      'These stay in English inside the Arabic sentence and are never transliterated. ' +
      'VCS vocabulary: build, test, commit, branch, merge, push, pull, repository.',
  },
  {
    id: 'lex-runtime',
    source: 'src/cli.ts; src/daemon.ts; src/voice/tts.ts',
    text:
      'المصطلحات: الخدمة daemon، الخادم server، المنفذ port، العملية process، ' +
      'الخلفية background، لوحة التحكم dashboard، السجل log. ' +
      'Runtime vocabulary: daemon, server, port, process, background, dashboard, log.',
  },
  {
    id: 'lex-ai',
    source: 'src/voice/stt.ts; src/voice/brain.ts; src/voice/tts.ts',
    text:
      'المصطلحات: تفريغ الصوت STT or transcription، تحويل النص إلى كلام TTS، ' +
      'النموذج model، الوسم token، الموجّه prompt، السياق context. ' +
      'AI vocabulary: STT, TTS, model, token, prompt, context window.',
  },
  {
    id: 'lex-deps',
    source: 'package.json; AGENTS.md#commands',
    text:
      'المصطلحات: الحزمة package، الاعتمادية dependency، التثبيت install، ' +
      'البوابة gate، التغطية coverage. ' +
      'Build and tooling vocabulary: package, dependency, install, gate, coverage, ' +
      'typecheck, lint, test suite.',
  },
  {
    id: 'lex-editor',
    source: 'apps/desktop; AGENTS.md#conventions',
    text:
      'المصطلحات: المحرر editor، الملف file، المسار path، الشجرة worktree، ' +
      'الصفحة window، النافذة context window، الفرع branch. ' +
      'Editor and workspace vocabulary: editor, file, path, worktree, window. ' +
      'Note the distinction: نافذة is the context window, صفحة is the UI window.',
  },
  {
    id: 'lex-danger',
    source: 'src/voice/brain.ts (AMMANI_SYSTEM_PROMPT)',
    text:
      'الأفعال الخطرة بالنص التقني: delete، drop، destroy، force-push، deploy، rm -rf. ' +
      'Destructive operations are always spoken with the English verb intact, ' +
      'because that is what the user will read in the terminal.',
  },
  {
    id: 'lex-errors',
    source: 'src/ipc/protocol.ts; src/voice/keyring.ts',
    text:
      'رموز الأخطاء تبقى بالأرقام: 401، 403، 402، 429، 500. ' +
      'Error codes are never spoken as numbers. Say "the key was rejected" or ' +
      '"the credit ran out", never the digits.',
  },
  {
    id: 'lex-dialect',
    source: 'src/voice/brain.ts; decision locked 2026-09-28',
    text:
      'اللهجة هي الأردنية البيضاء، أممية طبيعية ومحترمة، ' +
      'مع الإبقاء على المصطلحات التقنية بالإنجليزية. ' +
      'The dialect is Ammani, White Jordanian Arabic, natural and respectful, ' +
      'never stiff newsreader Modern Standard Arabic and never Beirusi slang. ' +
      'Technical terms stay in English.',
  },
];
