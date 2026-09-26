# Voxaura — النسخة العربية الكاملة

<p align="center">
  <img src="assets/icon.svg" alt="أيقونة Voxaura" width="128" />
</p>

[![English](https://img.shields.io/badge/English-README.md-blue)](README.md)

<p align="center">
  <a href="docs/10-CHECKPOINT.md"><img src="https://img.shields.io/badge/tests-309%20pass-brightgreen" alt="الاختبارات" /></a>
  <a href="apps/desktop/e2e"><img src="https://img.shields.io/badge/e2e-15%2F15-brightgreen" alt="E2E" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="الرخصة" /></a>
  <a href="apps/desktop/src-tauri/Cargo.toml"><img src="https://img.shields.io/badge/version-0.4.1-blueviolet" alt="الإصدار" /></a>
</p>

<p align="center">
  <a href="https://github.com/3mar-baha/Vantrilex-OpenCode-Assistant/releases/tag/v0.4.1"><img src="https://img.shields.io/badge/download-Voxaura_0.4.1_setup.exe-2563eb" alt="تنزيل الإصدار" /></a>
</p>

## ما هو Voxaura؟

Voxaura رفيق مكتبي محيطي (Tauri v2 + React) مبني فوق خادم Node يدير جلسات
OpenCode v2. يستقبل الأوامر صوتياً بالعربية عبر كريم (Kareem) ونور (Nour)،
بينما يتم التنسيق بين النماذج بالإنجليزية حصراً.

## النموذج الأساس والأدوار

- **A.R.E.E.B. (أَرِيب)**: نموذج الطبقة الأولى للحضانة المعرفية.
- **Dots3** (`dots-studio/dots-3-note-preview:free`): الاستقبال الحواري بالعربية،
  ويترجم كل نية إلى مهمة إنجليزية دقيقة — مع كبح الاستدلال الخفي فيرد خلال
  ~1.5 ثانية كمسار أساسي سريع، مع تحويل احتياطي واحد إلى Nemotron عند الحاجة.
- **Nemotron** (`nvidia/nemotron-3-ultra-550b-a55b:free`): المنسق الرئيسي —
  يفكك المهام إلى رسم بياني موجه (DAG)، ويرسل الأوامر، ويدير الضغط العكسي.
- **Inkling** (`thinkingmachines/inkling:free`): وكيل فرعي يعمل داخل حدود جلسة
  OpenCode حصراً، بلا أي إجراءات خارج الجلسة.

## الشخصيتان

- **كريم (Kareem)**: الصوت الافتراضي للذكور، إدارة المشاريع والمهام الجادة.
- **نور (Nour)**: الصوت البديل، التفاعل الخفيف والمتابعة.

## معمارية الجلسات المتعددة

```text
واجهة Voxaura ◄── WS-4097 ──► خادم Node ◄── HTTP ──► opencode serve
                                    │
                          Dots3 ← مهمة إنجليزية ← المستخدم
                          Nemotron ← تفكيك DAG ← إرسال الأوامر
                          Inkling ← تنفيذ داخل الجلسة ← تقارير موجزة
```

- الجسر WS-4097: مصادقة عبر subprotocol، استئناف بـ `?lastSeq=`، عقود عميل مجمدة.
- مستويات التفاعل: لقطات الجلسات لحظية، الأوامر تُرد بإشعارات نجاح/فشل منظمة.
- قاعدة البيانات مشتركة، مع نسخ احتياطي قبل أي تعديل، وصفر فقدان للبيانات.

## الحلقة الصوتية الكاملة (Full-Duplex)

- **الرفع**: ميكروفون عبر AudioWorklet (16kHz أحادي) ← إطارات PCM ثنائية ←
  Whisper للنسخ ← سلسلة الوكلاء الثلاثة.
- **التنزيل**: Fish TTS ← بث MP3 لكل جملة على حدة ← تشغيل FIFO صارم مع مؤشر تحدث.
- **المقاطعة (Barge-in)**: أثناء تحدث المساعد تُخفض الإطارات الهادئة محلياً،
  وصوتك الحقيقي يوقف التشغيل ويلغي الرد فوراً — يمكنك المقاطعة دائماً.
- **بث الجمل**: الجملة الأولى تُصنع وتُبث فوراً؛ زمن أول مقطع صوتي 977–4029ms
  (تفاوت خوادم Fish) مقابل ميزانية 800ms، وصفر عند إصابة الذاكرة.
- مؤشر الموجة يعرض بصمة الأعمدة الخمسة الزرقاء (`assets/icon.svg`) نابضة مع الصوت.

## المشرف والمثبت

- **المشرف**: خلفية Tauri تدير النافذة/الدرج/الاختصارات، مع إقلاع ثلاثي
  الطبقات وكائن Job في Windows (`KILL_ON_JOB_CLOSE`) — قتل التطبيق قسراً
  يجمع كل العمليات الفرعية، صفر عمليات يتيمة.
- **المثبت المستقل**: حزمة NSIS (الإصدار
  [v0.4.1](https://github.com/3mar-baha/Vantrilex-OpenCode-Assistant/releases/tag/v0.4.1))
  تحمل `node.exe` والجانب التشغيلي — لا يحتاج المستخدم النهائي Node أو npm.
  Windows فقط؛ macOS/Linux مؤجلة حتى استقرار Windows الكامل.
- **الخزينة**: AES-256-GCM محلي (`vault/keyring.dat`)، صفر أسرار في السجلات
  أو الاختبارات، مع رمز IPC لكل تثبيت وحد إطار 1 MiB.

## الجودة المثبتة

309 اختبارات وحدة (220 جذر + 89 واجهة) و15/15 E2E خضراء؛ tsc/eslint/oxlint
بصفر أخطاء؛ `cargo check` بصفر أخطاء.

## الذاكرة والمهارات

- خزينة Obsidian محلية (`vault/projects/voxaura/`) بملاحظات ذرية وفهرس رئيسي،
  تُبنى تلقائياً عند أول تشغيل.
- مهارات الجسر: handoff للمهام، prompt-synthesis للصياغة، vault-sync للمزامنة.
- القاعدة الذهبية: FR-12 — أي فعل مدمر يتطلب تأكيداً صريحاً قبل التنفيذ.

## البدء السريع (60 ثانية)

```bash
npm install
npm run build
node dist/cli.js doctor
npm run test:vantrilex
cd apps/desktop && npm run test:e2e
```

## قاموس المصطلحات

| المصطلح | المعنى |
|---|---|
| Daemon (الخادم الخلفي) | خدمة Node التي تدير الجلسات والأوامر |
| Serve | محرك OpenCode v2 على المنفذ 4096 |
| WS-4097 | بروتوكول WebSocket بين الواجهة والخادم (`voice-ui.v1`) |
| FR-12 | قاعدة التأكيد قبل أي فعل مدمر |
| Ledger (السجل) | سجل تدقيق إلحاقي لكل الأحداث |
| Vault (الخزينة) | تخزين مشفر للمفاتيح + ملاحظات Obsidian للذاكرة |
