import type { SharedChunk } from '../types.js';

// TIER 1 — SHARED GROUND TRUTH. Architecture and runtime topology.
//
// No chunk in this file has a persona member, by type. Nour and Kareem both
// retrieve from this identical set; neither can be given a fact the other lacks.
//
// Every `source` below is a path or a measured value, so a reviewer can check
// any line against the repo rather than trusting this file.
export const ARCHITECTURE_CHUNKS: readonly SharedChunk[] = [
  {
    id: 'arch-ports',
    source: 'AGENTS.md#runtime-topology; src/ipc/ui-server.ts',
    text:
      'المنفذ 4096 هو opencode serve والمنفذ 4097 هو جسر WS-4097 للواجهة. ' +
      'المنفذ 1420 هو خادم Vite في وضع التطوير، والمنفذ 4197 هو stub للاختبارات E2E. ' +
      'Voxaura daemon runs on port 4097 and drives opencode serve on port 4096. ' +
      'These four ports are a fixed contract: if one is busy, the daemon is not running.',
  },
  {
    id: 'arch-daemon',
    source: 'AGENTS.md#layout; src/cli.ts; src/daemon.ts',
    text:
      'الـ daemon هو عملية Node تعمل في الخلفية continually. نقطة الدخول هي cli.ts ' +
      'بأوامر doctor و vault bootstrap و live و serve. ' +
      'The daemon is a background Node process, not a foreground UI. ' +
      'It is useful with the window closed, and hiding the window releases the microphone.',
  },
  {
    id: 'arch-job-object',
    source: 'apps/desktop/src-tauri/src/main.rs',
    text:
      'الـ supervisor في Rust يستخدم Job Object على ويندوز بـ KILL_ON_JOB_CLOSE، ' +
      'فيقتل عمليات الأبناء تلقائياً عند إغلاق التطبيق. ' +
      'A Windows Job Object with KILL_ON_JOB_CLOSE reaps the serve process and the daemon, ' +
      'so no orphaned process survives a crash or a hard close.',
  },
  {
    id: 'arch-token',
    source: 'AGENTS.md#runtime-topology',
    text:
      'الـ token يُنقل كبروتوكول فرعي إضافي [voice-ui.v1, token] لأن المتصفح ' +
      'لا يستطيع ضبط ترويسات upgrade. ' +
      'The WS bearer travels as an extra subprotocol token because browsers cannot set ' +
      'upgrade headers. The token is written to ipc.token before the webview loads, ' +
      'and is never baked into the bundle.',
  },
  {
    id: 'arch-runtime-state',
    source: 'AGENTS.md#runtime-topology',
    text:
      'الحالة وقت التشغيل في المجلد .opencode-voice-runtime ويحتوي ipc.token ' +
      'و serve.pass و machine.key و daemon.log. ' +
      'Runtime state lives in ~/.opencode-voice-runtime. The machine key decrypts the vault, ' +
      'and child logs are append-only so a restart never erases the previous failure.',
  },
  {
    id: 'arch-vault',
    source: 'AGENTS.md#vault; src/voice/keyring.ts',
    text:
      'المفاتيح محفوظة في vault/keyring.dat بتشفير AES-256-GCM، ' +
      'ومفتاحها موجود في machine.key. ' +
      'Keys are encrypted at rest with AES-256-GCM. The daemon never prints or logs key ' +
      'material, and doctor reports counts only, never values.',
  },
  {
    id: 'arch-reachability',
    source: 'AGENTS.md#dead-code',
    text:
      'الكود غير المستخدم في src هو صفر: 51 وحدة حية و 0 وحدة ميتة، و 8056 سطر. ' +
      'Dead code in src is zero, at 51 live modules and 8056 source lines. Reachability is ' +
      'measured by resolving relative imports transitively from daemon.ts and cli.ts, ' +
      'following DYNAMIC imports as well as static ones - runtime/vad.ts is loaded by ' +
      'import() on purpose and a static-only scan wrongly reports it as dead.',
  },
  {
    id: 'arch-gates',
    source: 'AGENTS.md#gates',
    text:
      'بوابة الاختبار test:vantrilex هي typecheck ثم eslint ثم oxlint ثم vitest ' +
      'للمشروع ثم vitest لسطح المكتب. ' +
      'The test:vantrilex gate runs typecheck, eslint, oxlint, root vitest, then desktop vitest. ' +
      'End-to-end tests are NOT part of that gate and run separately.',
  },
];
