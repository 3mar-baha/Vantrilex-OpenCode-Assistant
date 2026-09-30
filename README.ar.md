# Voxaura — النسخة العربية الكاملة

<p align="center">
  <img src="assets/icon.svg" alt="أيقونة Voxaura" width="128" />
</p>

[![English](https://img.shields.io/badge/English-README.md-blue)](README.md)

<p align="center">
  <a href="docs/10-CHECKPOINT.md"><img src="https://img.shields.io/badge/tests-726%20unit%20%2B%2027%20rust-brightgreen" alt="الاختبارات" /></a>
  <a href="apps/desktop/e2e"><img src="https://img.shields.io/badge/e2e-18%2F18-brightgreen" alt="E2E" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="الرخصة" /></a>
  <a href="apps/desktop/src-tauri/Cargo.toml"><img src="https://img.shields.io/badge/version-0.8.1-blueviolet" alt="الإصدار" /></a>
</p>

<p align="center">
  <a href="https://github.com/3mar-baha/Vantrilex-OpenCode-Assistant/releases/tag/v0.8.1"><img src="https://img.shields.io/badge/download-Voxaura_0.8.1_setup.exe-2563eb" alt="تنزيل الإصدار" /></a>
</p>

## ما هو Voxaura؟

Voxaura رفيق مكتبي محيطي (Tauri v2 + React) مبني فوق خادم Node يدير جلسات
OpenCode v2. يستقبل الأوامر صوتياً بالعربية عبر كريم (Kareem) ونور (Nour)،
بينما يتم التنسيق بين النماذج بالإنجليزية حصراً.

## النموذج الأساس والأدوار

- **A.R.E.E.B. (أَرِيب)**: نموذج الطبقة الأولى للحضانة المعرفية.
- **Dots3** (`dots-studio/dots-3-note-preview:free`): الاستقبال الحواري بالعربية،
  ويترجم كل نية إلى مهمة إنجليزية دقيقة — مع كبح الاستدلال الخفي فيرد خلال
  ~1.5 ثانية كمسار أساسي سريع، مع تحويل احتياطي واحد إلى Inkling عند الحاجة.
- **Inkling** (`thinkingmachines/inkling:free`): المنسق الرئيسي —
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
                          Inkling ← تفكيك DAG ← إرسال الأوامر
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
  [v0.7.2](https://github.com/3mar-baha/Vantrilex-OpenCode-Assistant/releases/tag/v0.7.2))
  تحمل `node.exe` والجانب التشغيلي — لا يحتاج المستخدم النهائي Node أو npm.
  Windows فقط؛ macOS/Linux مؤجلة حتى استقرار Windows الكامل.
- **الخزينة**: AES-256-GCM محلي (`vault/keyring.dat`)، صفر أسرار في السجلات
  أو الاختبارات، مع رمز IPC لكل تثبيت وحد إطار 1 MiB.

## الجودة المثبتة

726 اختتبارات وحدة (573 جذر + 153 واجهة) و18/18 E2E خضراء؛ tsc/eslint/oxlint
بصفر أخطاء؛ `cargo check` بصفر أخطاء. الأرقام مقيسة (`npx vitest run`)، و27
اختبار Rust عبر `#[test]`، ولا يوجد حد أدنى لتغطية الأسطر — حُذف عتبة `lines: 80`
من `vitest.config.ts` لأنها لم تُفعَّل قط ولم تُقَس الدسبة الحقيقية.

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

## مُثبِّت v0.8.1

| | |
|---|---|
| الملف | `Voxaura_0.8.1_x64-setup.exe` — 24.80 ميغابايت (26,009,032 بايت) |
| بصمة SHA-256 | `AC8F40572934511AF17DEE29261D153FE135C94AF015847DAB99DCFEB82AE080` |
| مبنيّ من | `main` عند وسم v0.8.1 — `npm run build` ← `provision-sidecar` ← `build:tauri`، الثلاث بخروج 0 |
| التحقّق | **بناءٌ فقط.** لم يمرّ بـ`release:verify`: **لم يُثبَّت صامتاً ولم يُقلَع بارداً.** آخر ما مرّ بهما هو مُثبِّت 0.8.0 أدناه. |

```powershell
Get-FileHash .\Voxaura_0.8.1_x64-setup.exe -Algorithm SHA256
```

## مُثبِّت v0.8.0

> **اسم `Voxaura_0.8.0_x64-setup.exe` ملتبس، وكان دائماً كذلك.** ملفّان يحملانه:
> `AD6FD13D…` (25,994,215 بايت، موسوم، مُثبَت بـ`release:verify`) و`05494180…`
> (25,999,611 بايت، مبنيّ بعد أربعة التزامات أُخرى، **لم يُثبَّت قط**). إن كان لديك
> ملفّ من جيل 0.8.0 فاعرفه **بالبصمة لا بالاسم** — فالاسم عاجز عن ذلك.
> **هذا هو سبب وجود 0.8.1.**

| | |
|---|---|
| الملف | `Voxaura_0.8.0_x64-setup.exe` — 24.79 ميغابايت (25,994,215 بايت) |
| بصمة SHA-256 | `AD6FD13D6B17F34C7AFB2D6BA109C16CA5F9214CC3B0100D5CD0F111B4E42B1B` |
| التحقّق | `npm run release:verify` — تثبيت صامت، إقلاع بارد، 4096 + 4097 على loopback، و`daemon.log` لم يتغيّر (0 بايت) |

```powershell
Get-FileHash .\Voxaura_0.8.0_x64-setup.exe -Algorithm SHA256
```

**حزمة تشخيص:** `node dist/cli.js doctor --bundle --out diag.json` تنتج ملفاً
**مُنقّىاً يُمكن لصقه في تذكرة عامة**. راجع ما لا تستطيع حجزه فيه قبل النشر.

## قاموس المصطلحات

| المصطلح | المعنى |
|---|---|
| Daemon (الخادم الخلفي) | خدمة Node التي تدير الجلسات والأوامر |
| Serve | محرك OpenCode v2 على المنفذ 4096 |
| WS-4097 | بروتوكول WebSocket بين الواجهة والخادم (`voice-ui.v1`) |
| FR-12 | قاعدة التأكيد قبل أي فعل مدمر |
| Ledger (السجل) | سجل تدقيق إلحاقي لكل الأحداث |
| Vault (الخزينة) | تخزين مشفر للمفاتيح + ملاحظات Obsidian للذاكرة |
