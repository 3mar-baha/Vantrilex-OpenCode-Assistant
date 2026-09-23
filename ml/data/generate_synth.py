#!/usr/bin/env python3
"""Synthesize code-switched Ammani SE samples + 4-head labels + group-aware splits.

Corpus v3 — contrastive rebalance (docs/16 §16.8B.1, ml/phase1_data_spec.md).

Phase-1 diagnosis (ml/phase1_diagnosis.json) proved the marker shortcut:
Arabic markers had P(destructive|marker)=1.000 and only 11.2% of
marker-bearing train rows were benign. This version forces every marker
into the balanced range 0.40 <= P(destructive|marker) <= 0.60 via:
  - benign marker-bearing actions (destructive verbs on safe objects),
  - negation minimal pairs (same carrier, negation flips the label),
  - confusable pairs in training (8 morphological pairs, both sides).
Phrasings are deliberately disjoint from ml/adversarial_suite.json (G2.3).

GROUNDING (verified sources only):
  - Jordanian colloquial patterns from ml/data/joda_raw (1685 rows).
  - Levantine negation particles (لا/ما/مش/مو/بلاش/دير بالك).
  - MSA structural templates (تم/انتهى/فشل).
  MADAR-Amman and MASSIVE-Arabic were NOT locally available — nothing is
  attributed to them.

Head labels other than `should_speak` are stratified per split; contrastive
rows carry fixed labels and are distributed 80/10/10 across splits.

Usage:
    python ml/data/generate_synth.py --count 8000 --seed 8 --out ml/data
"""
from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path

GROUNDING = {
    "joda_raw": "KareemBb/Jordanian-Dialect-Instruct-QA (ml/data/joda_raw/sentences.jsonl, 1685 rows)",
    "particles": "Levantine negation/particle inventory (لا/ما/مش/مو/بلاش/دير بالك)",
    "msa": "MSA structural templates (تم/انتهى/فشل)",
    "contrastive": "Phase-2 contrastive rebalance (benign marker actions, negation pairs, confusable pairs)",
    "madar_amman": "not locally available — not used (no fabrication)",
    "massive_ar": "not locally available — not used (no fabrication)",
}

# --- Grounded frame construction ------------------------------------------------
OUTCOME_PREFIXES = [
    "", "تمام، ", "طيب، ", "يلا، ", "خلص، ", "الحمد لله، ", "يعطيك العافية، ",
    "يسعد مساك، ", "هلا، ", "أوكي، ", "ماشي، ", "زبط، ", "يسعد صباحك، ", "هلا والله، ",
]
ROUTINE_PREFIXES = [
    "", "بس، ", "طيب، ", "هلا، ", "تمام، ", "أوكي، ", "ماشي، ", "هلا والله، ",
    "يعطيك العافية، ", "يسعد صباحك، ",
]
OUTCOME_CORES = [
    "خلصت {task}، {result}",
    "{task} خلصت، {result}",
    "صار {task} {result}",
    "تم {task}، {result}",
    "{task} جاهزة، {result}",
    "انتهت {task}، {result}",
    "خلصنا {task}، {result}",
    "{task} رجعت {result}",
    "{module} {result}",
    "البيلد {result} بعد {detail}",
    "{task} صارت {result}",
    "{module} خلص، {result}",
    "{task} تمام، {result}",
    "ضبطت {task}، {result}",
    "{module} جاهز، {result}",
    "{task} خلصت بعد {detail}",
]
ROUTINE_CORES = [
    "{task} شغالة، ما في جديد بعد {detail}",
    "البيلد {result}، {task} شغالة",
    "{task} ماشية عادي، {module} مستقر",
    "{module} مستقر، {task} ماشية",
    "الوضع طبيعي، {task} شغالة، {module} مستقر",
    "ما في جديد، {task} ماشية على {module}",
    "{detail} صار لـ {task}، كل شي تمام",
    "السيرفر مستقر بعد {detail}، {task} شغالة",
    "{task} شغالة على {module}",
    "{module} ماشي طبيعي مع {task}",
    "ما في أخطاء، {task} ماشية على {module}",
    "{task} مستقرة بعد {detail}، ما في جديد",
    "الوضع هادي، {module} شغالة مع {task}",
    "{task} ماشية، {module} ما فيه تحذيرات",
    "كل شي طبيعي، {task} شاغلة على {module}",
    "{module} ماشي مع {task}، ما في جديد",
]

TECH_TASKS = [
    "التيستات", "البيلد", "الـ schema", "الديبلوي", "الريفاكتور",
    "الـ migration", "الـ lint", "الـ code review", "الـ cache", "الـ API",
    "الـ pipeline", "الـ docs",
]
RESULTS = [
    "كلها خضرا", "مشكلة بملفين", "فشل بثلاث تيستات", "في تحذيرين",
    "Type errors", "خلص أخضر", "رجع 500", "البورت محجوز",
    "المفتاح خلص", "ما في أخطاء", "تحذير واحد",
]
MODULES = ["الـ Auth", "الـ billing", "الـ cache", "الـ REF", "الـ gateway", "الـ API"]
FOLLOWUPS = ["أبلش أصلحهم", "تشوف اللوج", "أكمل ولا أوقف", "أفتح لك التفاصيل"]
DETAILS = ["آخر كوميت", "الديبندنسيز", "ريستارت السيرفر", "تنظيف الكاش"]

# --- Marker sets -----------------------------------------------------------------
DESTRUCTIVE_MARKERS = ["امسح", "احذف", "دمر", "force-push", "rm -rf", "drop"]
BARGE_MARKERS = ["وقف", "وقّف", "تمام بس", "خلص بكفي", "اسكت", "لحظة", "استنى"]
LOOP_MARKERS = ["المحاولة", "لسّاني شغال", "ريتراي"]
LOOP_SUFFIXES = [
    "، نعمل ريتراي", "، هاي المحاولة التانية", "، لسّاني شغال",
    "، ريتراي كمان مرة", "، المحاولة الخامسة",
]

MARKER_FREE_DESTRUCTIVE = [
    "فرّغ الجداول", "فرمت الستوريج", "خلّي الداتابيز صفر", "شيل الجداول كلها",
    "نظّف الداتا كلها", "اطفي الداتابيز", "امحي الملفات كلها", "الغي الصلاحيات كلها",
    "احرق النسخ الاحتياطية", "فرّغ السيرفر", "قفل البورتات", "ضيّع الهيستوري",
    "شيل الـ containers", "خرب البيئة", "فرّغ المخزن", "ضيّع الباكب",
    "امحي الـ traces", "شيل المستخدمين", "فرمت القرص", "خرب السيرفر",
]

NEGATION_TEMPLATES = [
    "ما تمسح {module}", "لا تحذف {task}", "مش وقتها force-push",
    "مو لازم drop", "بلاش rm -rf", "دير بالك تمسح {module}",
    "ما تعمل ديبلوي هلق", "لا تشيل {module}", "مش رح نمسح الـ cache",
    "ما تحرق الباكب", "بلاش reset hard", "دير بالك تحذف {task}",
    "مو وقتها ننظف", "ما تطفّي {module}", "لا تفرغ الداتا",
    "بلاش تمسح شي", "ما تشيل اليوزرز", "دير بالك تفرمت الديسك",
]

BENIGN_IMPERATIVES = [
    "اسمع، ", "احفظ الملف، ", "صدّر الداتا، ", "راجع {module}، ",
    "تأكد من {task}، ", "خليك معي، ", "بس ركز، ",
]

# Optional benign context keeps top-up rows unique without changing their
# benign reading (a safe action stays safe with a purpose clause attached).
BENIGN_CONTEXTS = ["", " قبل {task}", " بعد {task}", " عشان {task}"]

# --- Contrastive rebalance (Phase 2) ---------------------------------------------
# Benign full actions per marker. Destructive verbs on safe/disposable objects.
# Phrasings avoid ml/adversarial_suite.json texts (G2.3 symmetric check).
BENIGN_MARKER_ACTIONS: dict[str, list[str]] = {
    "امسح": [
        "امسح ملفات الـ tmp في {module}", "امسح سجلات {module} المؤقتة", "امسح داتا {task} المؤقتة",
        "امسح الـ drafts من {module}", "امسح صور الـ cache قبل {task}", "امسح الـ temp في {module}",
        "امسح الـ debris بعد {task}", "امسح الـ out folder في {module}",
    ],
    "احذف": [
        "احذف سطور الـ debug من {module}", "احذف الـ drafts القديمة في {module}", "احذف تعليق الـ TODO من {task}",
        "احذف ملفات الـ dist بعد {task}", "احذف الـ snapshots المؤقتة من {module}", "احذف تحذيرات {task}",
        "احذف الـ stale branches من {module}", "احذف الـ coverage القديم قبل {task}",
    ],
    "دمر": [
        "دمر الـ bug في {module}", "دمر الـ errors قبل {task}", "دمر الـ blocker في {module}",
        "دمر الـ flaky tests بعد {task}", "دمر الـ leak في {module}", "دمر الـ hotfix الفاشل من {module}",
    ],
    "force-push": [
        "اعمل force-push عالـ draft قبل {task}", "الـ force-push للـ feature مسموح في {module}",
        "force-push بس عالـ sandbox قبل {task}", "اعمل force-push لفرع التجربة بعد {task}",
        "force-push الـ WIP مسموح في {module}",
    ],
    "rm -rf": [
        "اعمل rm -rf للـ build في {module}", "rm -rf مجلد الـ dist بعد {task}", "rm -rf الـ node_modules في {module}",
        "امسح بـ rm -rf الـ tmp قبل {task}", "rm -rf فولدر الـ out في {module}",
    ],
    "drop": [
        "اعمل drop لجدول الـ tmp في {module}", "drop الـ cache key قبل {task}", "drop الـ staging view قبل {task}",
        "drop الـ test index من {module}", "drop عمود الـ debug في {task}",
    ],
}

# Confusable pairs in training: same 8 morphological pairs as the suite, all
# phrasings rewritten. {module}/{task} slots give 30 unique rows per side.
CONFUSABLE_TRAIN = [
    {"pair": "asmar-vs-amsah",
     "benign": ["اسمع، خليك معي قبل {task}", "اسمع، راجع {module}", "اسمع، تأكد من {task}", "اسمع، وقف دقيقة", "اسمع، دير بالك في {module}"],
     "destructive": ["امسح سجلات {module}", "امسح داتا {task} القديمة", "امسح ملفات الـ tmp من {module}", "امسح أرشيف {module}", "امسح نسخ {task}"]},
    {"pair": "ahfad-vs-ahdif",
     "benign": ["احفظ الشغل قبل {task}", "احفظ نسخة من {module}", "احفظ التعديلات هلق في {module}", "احفظ الـ draft", "احفظ قبل الـ push في {module}"],
     "destructive": ["احذف سجلات {module}", "احذف داتا {task} القديمة", "احذف ملفات الـ dist في {module}", "احذف الـ drafts", "احذف نسخ {module}"]},
    {"pair": "damj-vs-dammar",
     "benign": ["ادمج التعديلات بأمان في {module}", "ادمج {module} مع الـ main", "ادمج الفرع هلق", "ادمج بعد الـ review في {module}", "ادمج التغييرات الصغيرة"],
     "destructive": ["دمر {module}", "دمر سيرفر الـ dev", "دمر الـ sandbox قبل {task}", "دمر بيئة {task}", "دمر الـ staging في {module}"]},
    {"pair": "saddir-vs-saffir",
     "benign": ["صدّر تقرير {task}", "صدّر نسخة من {module}", "صدّر الداتا للتحليل في {module}", "صدّر الـ logs", "صدّر الجدول CSV قبل {task}"],
     "destructive": ["صفّر عدادات {module}", "صفّر جدول {task}", "صفّر الإحصائيات في {module}", "صفّر الكاونترز", "صفّر أرقام {module}"]},
    {"pair": "rakkib-vs-kharrib",
     "benign": ["ركّب {module} من جديد", "ركّب الديبندنسيز هلق في {module}", "ركّب الـ tools", "ركّب البيئة قبل {task}", "ركّب الـ package في {module}"],
     "destructive": ["خرّب {module}", "خرّب إعدادات {task}", "خرّب الـ config في {module}", "خرّب بيئة {module}", "خرّب الـ setup قبل {task}"]},
    {"pair": "insakh-vs-amsah",
     "benign": ["انسخ {module} للباكب", "انسخ الشغل هلق", "انسخ الملفات الجديدة في {module}", "انسخ قبل {task}", "انسخ الـ folder"],
     "destructive": ["امسح {module} من الباكب", "امسح النسخ القديمة في {module}", "امسح باكب {task}", "امسح الـ snapshots", "امسح نسخة {module}"]},
    {"pair": "shaghil-vs-shil",
     "benign": ["شغّل {module} من جديد", "شغّل الـ tests قبل {task}", "شغّل السيرفر هلق", "شغّل الـ pipeline في {module}", "شغّل الـ worker"],
     "destructive": ["شيل {module} نهائي", "شيل سيرفر الـ dev", "شيل الـ deployment قبل {task}", "شيل {task} من السيرفر", "شيل الـ stack في {module}"]},
    {"pair": "ahtafiz-vs-atlaf",
     "benign": ["احتفظ بنسخة {module}", "احتفظ بالشغل القديم", "احتفظ قبل {task}", "احتفظ بالـ logs في {module}", "احتفظ بالتقارير"],
     "destructive": ["أتلف نسخة {module}", "أتلف الأرشيف قبل {task}", "أتلف ملفات {task}", "أتلف الـ backup في {module}", "أتلف السجلات"]},
]

CRITICAL_OBJECTS = [
    "جدول الطلبات", "ملفات الشغل", "داتابيز الزباين", "سيرفر الـ dev",
    "فولدر المشروع", "جدول الفواتير", "نسخة الشغل", "سيرفر الـ staging",
    "جدول الجلسات", "ملفات الـ release", "داتابيز التقارير", "الـ repo المركزي",
    "سيرفر الـ cache", "جدول الصلاحيات", "ملفات الـ backup", "فرع الـ main",
    "جدول المدفوعات", "سيرفر الـ prod", "جدول الحسابات", "ملفات العملاء",
    "سيرفر الشركة", "داتابيز الفواتير", "أرشيف الشركة", "سجل المعاملات",
    "قاعدة الزباين", "جدول الشحن", "ملفات العقود", "سيرفر الـ API",
    "جدول الاشتراكات", "مجلد الشركة",
]
BRANCH_TARGETS = [
    "فرع الـ feature", "فرع التجربة", "الـ draft", "فرع الـ hotfix", "الـ sandbox",
    "فرع الـ dev", "الـ WIP", "فرع الـ release", "فرع الـ staging", "فرع الـ refactor",
    "فرع الـ migration", "الـ spike", "فرع الـ prototype", "فرع الـ demo",
    "الـ playground", "فرع الـ test", "فرع الـ fix", "الـ experiment",
    "فرع الـ docs", "فرع الـ chore", "الـ temp-branch", "فرع الـ review",
    "فرع الـ qa", "الـ scratch", "فرع الـ spike-2",
]
DIR_TARGETS = [
    "مجلد الـ build", "مجلد الـ dist", "الـ node_modules", "فولدر الـ tmp",
    "مجلد الـ out", "فولدر الـ cache", "مجلد الـ logs", "فولدر الـ coverage",
    "مجلد الـ artifacts", "فولدر الـ dist", "مجلد الـ temp", "فولدر الـ backup-tmp",
    "مجلد الـ snapshots", "فولدر الـ staging-tmp", "مجلد الـ vendor",
    "فولدر الـ public-build", "مجلد الـ .cache", "فولدر الـ parts",
    "مجلد الـ chunks", "فولدر الـ uploads-tmp", "مجلد الـ fixtures-gen",
    "فولدر الـ reports-tmp", "مجلد الـ dist-test", "فولدر الـ local-build",
    "مجلد الـ obj",
]
NEG_PAIR_TEMPLATES = [
    {"marker": "امسح", "affirm": "امسح {o}", "negate": "لا تمسح {o}", "span": "لا", "fills": CRITICAL_OBJECTS},
    {"marker": "امسح", "affirm": "امسح {o} هلق", "negate": "ما تمسح {o} هلق", "span": "ما", "fills": CRITICAL_OBJECTS},
    {"marker": "احذف", "affirm": "احذف {o}", "negate": "لا تحذف {o}", "span": "لا", "fills": CRITICAL_OBJECTS},
    {"marker": "احذف", "affirm": "احذف {o} كله", "negate": "مش رح نحذف {o} كله", "span": "مش", "fills": CRITICAL_OBJECTS},
    {"marker": "دمر", "affirm": "دمر {o}", "negate": "لا تدمر {o}", "span": "لا", "fills": CRITICAL_OBJECTS},
    {"marker": "دمر", "affirm": "دمر {o} نهائي", "negate": "مو لازم ندمر {o} نهائي", "span": "مو لازم", "fills": CRITICAL_OBJECTS},
    {"marker": "force-push", "affirm": "اعمل force-push {o}", "negate": "مش وقتها force-push {o}", "span": "مش وقتها", "fills": BRANCH_TARGETS},
    {"marker": "force-push", "affirm": "ساوي force-push {o}", "negate": "بلاش force-push {o}", "span": "بلاش", "fills": BRANCH_TARGETS},
    {"marker": "rm -rf", "affirm": "اعمل rm -rf {o}", "negate": "بلاش rm -rf {o}", "span": "بلاش", "fills": DIR_TARGETS},
    {"marker": "rm -rf", "affirm": "نفذ rm -rf {o}", "negate": "لا تنفذ rm -rf {o}", "span": "لا", "fills": DIR_TARGETS},
    {"marker": "drop", "affirm": "اعمل drop {o}", "negate": "مو ضروري drop {o}", "span": "مو ضروري", "fills": CRITICAL_OBJECTS},
    {"marker": "drop", "affirm": "ساوي drop {o}", "negate": "دير بالك تعمل drop {o}", "span": "دير بالك", "fills": CRITICAL_OBJECTS},
]

N_NEG_PAIRS = 300
CONF_PER_SIDE = 30
MIN_BENIGN_MARKER = 900
MIN_NEG_PAIRS = 300
MIN_CONFUSABLE = 480
COND_LO, COND_HI = 0.40, 0.50

# --- Target head rates (stratified per split) ------------------------------------
DESTRUCTIVE_RATE = 0.25
MARKER_FREE_SHARE = 0.45
NEGATION_RATE = 0.14
BARGE_RATE = 0.22
LOOP_RATE = 0.24
BENIGN_IMPERATIVE_RATE = 0.12
HEADS = ("should_speak", "is_destructive", "barge_in", "stuck_in_loop")


def build_frames() -> list[tuple[str, str, str, str]]:
    """Cross grounded prefixes with cores; dedupe; interleave families.

    Returns (fid, family, prefix, core): prefix is kept separate so the
    render retry ladder can drop it under token pressure. Frame identity
    (fid) is unchanged, so split integrity is unaffected.
    """
    outcome: list[tuple[str, str]] = []
    for prefix in OUTCOME_PREFIXES:
        for core in OUTCOME_CORES:
            outcome.append((prefix, core))
    routine: list[tuple[str, str]] = []
    for prefix in ROUTINE_PREFIXES:
        for core in ROUTINE_CORES:
            routine.append((prefix, core))
    outcome = sorted(set(outcome))
    routine = sorted(set(routine))
    frames: list[tuple[str, str, str, str]] = []
    for i in range(max(len(outcome), len(routine))):
        if i < len(outcome):
            prefix, core = outcome[i]
            frames.append((f"outcome-{i:03d}", "outcome", prefix, core))
        if i < len(routine):
            prefix, core = routine[i]
            frames.append((f"routine-{i:03d}", "routine", prefix, core))
    return frames


SLOT_POOLS: dict[str, list[str]] = {
    "task": TECH_TASKS,
    "result": RESULTS,
    "module": MODULES,
    "followup": FOLLOWUPS,
    "detail": DETAILS,
}


def frame_fill_space(template: str) -> list[dict[str, str]]:
    """Full slot-value product for a frame template (deterministic order)."""
    from itertools import product
    from string import Formatter

    fields = [name for _, name, _, _ in Formatter().parse(template) if name]
    pools = [SLOT_POOLS[f] for f in fields]
    return [dict(zip(fields, combo)) for combo in product(*pools)]


def split_of_frame(frames: list[tuple[str, str, str, str]]) -> dict[str, str]:
    """Deterministic 80/10/10 per family so every split gets both families (V2)."""
    assignment: dict[str, str] = {}
    counters = {"outcome": 0, "routine": 0}
    for fid, family, _prefix, _core in frames:
        idx = counters[family]
        counters[family] += 1
        bucket = idx % 10
        assignment[fid] = "train" if bucket < 8 else ("val" if bucket == 8 else "test")
    return assignment


def contrast_split(kind_index: int) -> str:
    """Same 80/10/10 rule for contrastive rows, per kind sequence."""
    bucket = kind_index % 10
    return "train" if bucket < 8 else ("val" if bucket == 8 else "test")


def stratify_labels(rng: random.Random, slots: list[dict]) -> None:
    by_split: dict[str, list[dict]] = {}
    for slot in slots:
        by_split.setdefault(slot["split"], []).append(slot)
    for items in by_split.values():
        n = len(items)
        order = list(range(n))
        for head, rate in (
            ("is_destructive", DESTRUCTIVE_RATE),
            ("barge_in", BARGE_RATE),
            ("stuck_in_loop", LOOP_RATE),
        ):
            rng.shuffle(order)
            chosen = set(order[: round(rate * n)])
            for i, slot in enumerate(items):
                slot["labels"][head] = i in chosen


def _load_token_len():
    """Return a token-length function when the checkpoint tokenizer is available,
    else a conservative word-count proxy. The p99<=32 constraint is critical, so
    the real tokenizer is used whenever possible."""
    try:
        from tokenizers import Tokenizer

        hf = (
            "O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/"
            "snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json"
        )
        tokenizer = Tokenizer.from_file(hf)
        return lambda text: len(tokenizer.encode(text).ids)
    except Exception:  # noqa: BLE001
        return lambda text: int(len(text.split()) * 1.7)


TOKEN_LEN = _load_token_len()
MAX_TOKENS = 32
BARGE_SHORT = ["وقف", "لحظة", "اسكت"]
LOOP_SHORT = ["، ريتراي", "، لسّاني شغال"]


def _with_barge_loop(rng: random.Random, text: str, labels: dict) -> str:
    if labels.get("barge_in"):
        text = f"{rng.choice(BARGE_SHORT)}، {text}"
    if labels.get("stuck_in_loop"):
        text = f"{text}{rng.choice(LOOP_SHORT)}"
    return text


def _roll_barge_loop(rng: random.Random, labels: dict) -> None:
    labels["barge_in"] = rng.random() < BARGE_RATE
    labels["stuck_in_loop"] = rng.random() < LOOP_RATE


def render_sample(rng: random.Random, slot: dict) -> dict:
    """Render one sample, enforcing the token budget by construction.

    Optional prefixes (negation, benign imperative) carry no label, so they may
    be dropped to fit. Label-bearing cues (destructive, barge, loop) are kept;
    when space is tight the shorter variants are used.
    """
    labels = slot["labels"]
    for attempt in range(6):
        short = attempt >= 2
        drop_optional = attempt >= 4
        text, marker_free, negated = _render_once(rng, slot, short=short, drop_optional=drop_optional)
        if TOKEN_LEN(text) <= MAX_TOKENS:
            return {
                "id": slot["id"],
                "text": text,
                "frame": slot["frame"],
                "marker_free": marker_free,
                "negated": negated,
                "over_budget": False,
                "labels": labels,
            }
    # Triple-stacked rows (marker-free + barge + loop) can rarely exceed the
    # budget even fully shortened. The G1.8 gate is p99-based, so a capped
    # overflow budget is honest; main() fails closed above 0.5%.
    return {
        "id": slot["id"],
        "text": text,
        "frame": slot["frame"],
        "marker_free": marker_free,
        "negated": negated,
        "over_budget": True,
        "labels": labels,
    }


def _render_once(rng: random.Random, slot: dict, short: bool, drop_optional: bool) -> tuple[str, bool, bool]:
    fill = slot.get("fill") or {}
    core = slot["core_template"].format(
        task=fill.get("task", rng.choice(TECH_TASKS)),
        result=fill.get("result", rng.choice(RESULTS)),
        module=fill.get("module", rng.choice(MODULES)),
        followup=fill.get("followup", rng.choice(FOLLOWUPS)),
        detail=fill.get("detail", rng.choice(DETAILS)),
    )
    text = ("" if drop_optional else slot["prefix"]) + core
    labels = slot["labels"]

    marker_free = False
    if labels["is_destructive"]:
        if rng.random() < MARKER_FREE_SHARE:
            text = f"{rng.choice(MARKER_FREE_DESTRUCTIVE)}، {text}"
            marker_free = True
        else:
            text = f"{rng.choice(DESTRUCTIVE_MARKERS)} {text}"

    negated = False
    if not drop_optional and not labels["is_destructive"] and rng.random() < NEGATION_RATE:
        template = rng.choice(NEGATION_TEMPLATES)
        text = f"{template.format(module=rng.choice(MODULES), task=rng.choice(TECH_TASKS))}. {text}"
        negated = True

    if (
        not drop_optional
        and not labels["is_destructive"]
        and not negated
        and rng.random() < BENIGN_IMPERATIVE_RATE
    ):
        template = rng.choice(BENIGN_IMPERATIVES)
        text = f"{template.format(module=rng.choice(MODULES), task=rng.choice(TECH_TASKS))}{text}"

    if labels["barge_in"]:
        marker = rng.choice(BARGE_SHORT) if short else rng.choice(BARGE_MARKERS)
        text = f"{marker}، {text}"

    if labels["stuck_in_loop"]:
        suffix = rng.choice(LOOP_SHORT) if short else rng.choice(LOOP_SUFFIXES)
        text = f"{text}{suffix}"

    return text, marker_free, negated


def _fit(text: str, context: str) -> str:
    if TOKEN_LEN(text) > MAX_TOKENS:
        raise SystemExit(f"TOKEN BUDGET EXCEEDED ({context}): {text!r}")
    return text


def gen_contrastive(rng: random.Random, start_index: int, seen: set[str],
                    existing: list[dict]) -> tuple[list[dict], list[dict]]:
    """Build contrastive rows + minimal-pair records (all fail-closed).

    `seen` holds every text emitted so far; each candidate is claimed
    (added) exactly once — any unresolvable collision raises instead of
    silently leaking duplicates across splits.
    Returns (rows, pairs). Every row carries frame/split/provenance; pair rows
    share pair_id. Barge/loop rolls keep head rates stable; negation pairs share
    the roll across base and variant so only the negation differs.
    """
    rows: list[dict] = []
    pairs: list[dict] = []
    index = start_index

    def new_labels(destructive: bool) -> dict:
        labels = {"should_speak": True, "is_destructive": destructive,
                  "barge_in": False, "stuck_in_loop": False}
        _roll_barge_loop(rng, labels)
        return labels

    # --- 1. Negation minimal pairs (300) ---
    pair_seq = 0
    for template in NEG_PAIR_TEMPLATES:
        for fill in template["fills"][:25]:
            if pair_seq >= N_NEG_PAIRS:
                break
            base_text = template["affirm"].format(o=fill)
            var_text = template["negate"].format(o=fill)
            assert template["marker"] in base_text, f"pair base lacks marker: {base_text!r}"
            pair_id = f"negpair-{pair_seq:03d}"
            shared = {"barge_in": rng.random() < BARGE_RATE,
                      "stuck_in_loop": rng.random() < LOOP_RATE}
            base_lab = {"should_speak": True, "is_destructive": True, **shared}
            var_labels = {"should_speak": True, "is_destructive": False, **shared}
            base_text = _fit(_with_barge_loop(rng, base_text, base_lab), pair_id)
            var_text = _fit(_with_barge_loop(rng, var_text, var_labels), pair_id)
            for candidate in (base_text, var_text):
                if candidate in seen:
                    raise SystemExit(f"PAIR COLLISION ({pair_id}): {candidate!r}")
                seen.add(candidate)
            split = contrast_split(pair_seq)
            rows.append({"id": f"synth-{index:05d}", "text": base_text,
                         "frame": f"contrast-neg-{pair_seq:03d}", "marker_free": False,
                         "negated": False, "benign_marker": False, "confusable_pair": None,
                         "pair_id": pair_id, "provenance": "synthetic", "split": split,
                         "labels": base_lab})
            index += 1
            rows.append({"id": f"synth-{index:05d}", "text": var_text,
                         "frame": f"contrast-neg-{pair_seq:03d}", "marker_free": False,
                         "negated": True, "benign_marker": False, "confusable_pair": None,
                         "pair_id": pair_id, "provenance": "synthetic", "split": split,
                         "labels": var_labels})
            index += 1
            pairs.append({"pair_id": pair_id, "base_text": base_text, "variant_text": var_text,
                          "changed_span": template["span"],
                          "labels_base": base_lab, "labels_variant": var_labels,
                          "provenance": "synthetic"})
            pair_seq += 1
        if pair_seq >= N_NEG_PAIRS:
            break
    if pair_seq < N_NEG_PAIRS:
        raise SystemExit(f"NEGATION PAIR SHORTFALL: {pair_seq} < {N_NEG_PAIRS}")

    # --- 2. Confusable pairs in training (8 pairs x 30/side) ---
    for entry in CONFUSABLE_TRAIN:
        for side, texts in (("benign", entry["benign"]), ("destructive", entry["destructive"])):
            made = 0
            combo = 0
            while made < CONF_PER_SIDE:
                template = texts[combo % len(texts)]
                module = MODULES[(combo // len(texts)) % len(MODULES)]
                task = TECH_TASKS[(combo // (len(texts) * len(MODULES))) % len(TECH_TASKS)]
                text = template.format(module=module, task=task)
                labels = new_labels(destructive=(side == "destructive"))
                text = _with_barge_loop(rng, text, labels)
                text = _fit(text, f"conf-{entry['pair']}-{side}")
                combo += 1
                if combo > CONF_PER_SIDE * len(texts) * len(MODULES) * len(TECH_TASKS) + 1000:
                    raise SystemExit(f"CONFUSABLE EXHAUSTED: {entry['pair']}/{side}")
                if text in seen:
                    continue
                seen.add(text)
                marker_free = side == "destructive" and not any(m in text for m in DESTRUCTIVE_MARKERS)
                rows.append({"id": f"synth-{index:05d}", "text": text,
                             "frame": f"contrast-conf-{entry['pair']}-{side}-{made:02d}",
                             "marker_free": marker_free, "negated": False,
                             "benign_marker": False, "confusable_pair": entry["pair"],
                             "pair_id": None, "provenance": "synthetic",
                             "split": contrast_split(made), "labels": labels})
                index += 1
                made += 1

    # --- 3. Adaptive benign top-up per marker into [0.40, 0.60] ---
    # Counts combine base + contrastive rows (see base_db/added_db below).

    per_marker_seq: dict[str, int] = {m: 0 for m in DESTRUCTIVE_MARKERS}
    topup_seq = 0
    guard = 0
    # Base counts are fixed; track added benign mass incrementally so the
    # loop balances the FULL corpus conditional, not the contrastive subset.
    base_db: dict[str, list[int]] = {m: [0, 0] for m in DESTRUCTIVE_MARKERS}
    for r in existing:
        for m in DESTRUCTIVE_MARKERS:
            if m in r["text"]:
                base_db[m][0 if r["labels"]["is_destructive"] else 1] += 1
    added_db: dict[str, list[int]] = {m: [0, 0] for m in DESTRUCTIVE_MARKERS}
    for r in rows:
        for m in DESTRUCTIVE_MARKERS:
            if m in r["text"]:
                added_db[m][0 if r["labels"]["is_destructive"] else 1] += 1

    def full_conditional(marker: str) -> float:
        d = base_db[marker][0] + added_db[marker][0]
        b = base_db[marker][1] + added_db[marker][1]
        return d / (d + b) if (d + b) else 0.0

    while True:
        conds = {m: full_conditional(m) for m in DESTRUCTIVE_MARKERS}
        worst = max(conds.items(), key=lambda kv: kv[1])
        if worst[1] <= COND_HI:
            break
        marker = worst[0]
        actions = BENIGN_MARKER_ACTIONS[marker]
        placed = False
        for _ in range(5000):
            k = per_marker_seq[marker]
            per_marker_seq[marker] = k + 1
            stride_m, stride_t = len(MODULES), len(MODULES) * len(TECH_TASKS)
            stride_s = stride_t * len(BENIGN_CONTEXTS)
            action = actions[(k // stride_s) % len(actions)]
            module = MODULES[k % stride_m]
            task = TECH_TASKS[(k // stride_m) % len(TECH_TASKS)]
            suffix = BENIGN_CONTEXTS[(k // stride_t) % len(BENIGN_CONTEXTS)]
            text = action.format(module=module, task=task) + suffix.format(task=task)
            barge = (k % 5 == 0)
            loop = (k % 4 == 0)
            labels = {"should_speak": True, "is_destructive": False,
                      "barge_in": barge, "stuck_in_loop": loop}
            if barge:
                text = f"{BARGE_SHORT[k % len(BARGE_SHORT)]}، {text}"
            if loop:
                text = f"{text}{LOOP_SHORT[k % len(LOOP_SHORT)]}"
            if TOKEN_LEN(text) > MAX_TOKENS or text in seen:
                continue
            seen.add(text)
            for m in DESTRUCTIVE_MARKERS:
                if m in text:
                    added_db[m][1] += 1
            rows.append({"id": f"synth-{index:05d}", "text": text,
                         "frame": f"contrast-ben-{topup_seq:04d}", "marker_free": False,
                         "negated": False, "benign_marker": True, "confusable_pair": None,
                         "pair_id": None, "provenance": "synthetic",
                         "split": contrast_split(topup_seq), "labels": labels})
            index += 1
            topup_seq += 1
            placed = True
            break
        if not placed:
            raise SystemExit(f"TOP-UP EXHAUSTED for {marker}: {conds}")
        guard += 1
        if guard > 5000:
            raise SystemExit(f"TOP-UP FAILED TO CONVERGE: {conds}")
    final = {m: full_conditional(m) for m in DESTRUCTIVE_MARKERS}
    low = [m for m, p in final.items() if p < COND_LO]
    if low:
        raise SystemExit(f"CONDITIONAL OVERSHOOT below {COND_LO}: {low} {final}")

    return rows, pairs


def marker_conditionals(samples: list[dict]) -> dict[str, float]:
    out = {}
    for m in DESTRUCTIVE_MARKERS:
        d = sum(1 for s in samples if m in s["text"] and s["labels"]["is_destructive"])
        b = sum(1 for s in samples if m in s["text"] and not s["labels"]["is_destructive"])
        out[m] = round(d / (d + b), 4) if (d + b) else 0.0
    return out


def phi(a: list[bool], b: list[bool]) -> float:
    n11 = sum(1 for x, y in zip(a, b) if x and y)
    n10 = sum(1 for x, y in zip(a, b) if x and not y)
    n01 = sum(1 for x, y in zip(a, b) if not x and y)
    n00 = sum(1 for x, y in zip(a, b) if not x and not y)
    denom = ((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00)) ** 0.5
    return (n11 * n00 - n10 * n01) / denom if denom else 0.0


def hygiene_check(samples: list[dict]) -> dict:
    markerless_positives = 0
    marker_free_contains_marker = 0
    loop_markerless = 0
    barge_markerless = 0
    for s in samples:
        text = s["text"]
        labels = s["labels"]
        has_marker = any(m in text for m in DESTRUCTIVE_MARKERS)
        if labels["is_destructive"]:
            if s["marker_free"]:
                if has_marker:
                    marker_free_contains_marker += 1
            elif not has_marker:
                markerless_positives += 1
        if labels["stuck_in_loop"] and not any(m in text for m in LOOP_MARKERS):
            loop_markerless += 1
        if labels["barge_in"] and not any(m in text for m in BARGE_MARKERS):
            barge_markerless += 1
    problems = {
        "markerless_positives": markerless_positives,
        "marker_free_paraphrase_contains_marker": marker_free_contains_marker,
        "loop_markerless": loop_markerless,
        "barge_markerless": barge_markerless,
    }
    if any(problems.values()):
        raise SystemExit(f"HYGIENE FAILED: {problems}")
    return problems


def balance_report(samples: list[dict]) -> str:
    lines = []
    for head in HEADS:
        counts = Counter(s["labels"][head] for s in samples)
        total = len(samples)
        lines.append(f"{head}: true={counts[True] / total:.2%} false={counts[False] / total:.2%}")
    return "\n".join(lines)


def correlation_report(samples: list[dict]) -> dict:
    cols = {h: [s["labels"][h] for s in samples] for h in HEADS}
    out: dict[str, float] = {}
    for i, a in enumerate(HEADS):
        for b in HEADS[i + 1 :]:
            out[f"{a}~{b}"] = round(phi(cols[a], cols[b]), 4)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=8000)
    parser.add_argument("--seed", type=int, default=8)
    parser.add_argument("--out", type=str, default="ml/data")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    frames = build_frames()
    if len(frames) < 200:
        raise SystemExit(f"FRAME COUNT TOO LOW: {len(frames)} < 200")
    assignment = split_of_frame(frames)
    per_frame = max(1, args.count // len(frames))

    slots: list[dict] = []
    index = 0
    for fid, family, prefix, core in frames:
        space = frame_fill_space(core)
        if len(space) < per_frame:
            raise SystemExit(f"FRAME SPACE EXHAUSTED: {fid} has {len(space)} fills < {per_frame} renders")
        for fill in rng.sample(space, per_frame):
            slots.append(
                {
                    "id": f"synth-{index:05d}",
                    "frame": fid,
                    "family": family,
                    "template": prefix + core,
                    "prefix": prefix,
                    "core_template": core,
                    "fill": fill,
                    "split": assignment[fid],
                    "labels": {"should_speak": family == "outcome"},
                }
            )
            index += 1

    stratify_labels(rng, slots)
    samples = [render_sample(rng, slot) for slot in slots]
    for s in samples:
        s.setdefault("benign_marker", False)
        s.setdefault("confusable_pair", None)
        s.setdefault("pair_id", None)
        s.setdefault("provenance", "synthetic")
    over_budget = sum(1 for s in samples if s.get("over_budget"))
    if over_budget / max(len(samples), 1) >= 0.005:
        bad = sorted({s["frame"] for s in samples if s.get("over_budget")})
        raise SystemExit(f"OVER BUDGET: {over_budget}/{len(samples)} rows exceed {MAX_TOKENS} tokens (frames={bad})")

    contrast_rows, pairs = gen_contrastive(rng, index, {s["text"] for s in samples}, samples)
    samples.extend(contrast_rows)

    texts = [s["text"] for s in samples]
    if len(set(texts)) != len(texts):
        dupes = len(texts) - len(set(texts))
        raise SystemExit(f"DUPLICATE TEXTS: {dupes} collisions (cross-split leakage risk)")

    rng.shuffle(samples)

    hygiene = hygiene_check(samples)

    splits: dict[str, list[dict]] = {"train": [], "val": [], "test": []}
    for s in samples:
        splits[s["split"] if "split" in s else assignment[s["frame"]]].append(s)

    frame_sets = {name: {s["frame"] for s in rows} for name, rows in splits.items()}
    cross = (
        (frame_sets["train"] & frame_sets["val"])
        | (frame_sets["train"] & frame_sets["test"])
        | (frame_sets["val"] & frame_sets["test"])
    )
    if cross:
        raise SystemExit(f"SPLIT LEAK: frames cross splits: {sorted(cross)}")

    correlations = correlation_report(samples)
    max_should_speak_phi = max(
        (abs(v) for k, v in correlations.items() if k.startswith("should_speak")), default=0.0
    )
    if max_should_speak_phi >= 0.3:
        raise SystemExit(f"HEAD CORRELATION FAILED: max |phi| with should_speak = {max_should_speak_phi}")

    conds = marker_conditionals(samples)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "synth_ammani_se.jsonl").write_text(
        "\n".join(json.dumps(s, ensure_ascii=False) for s in samples), encoding="utf-8"
    )
    for name, subset in splits.items():
        (out / "splits").mkdir(parents=True, exist_ok=True)
        (out / "splits" / f"{name}.jsonl").write_text(
            "\n".join(json.dumps(s, ensure_ascii=False) for s in subset), encoding="utf-8"
        )
    (out / "contrastive_pairs.json").write_text(
        "\n".join(json.dumps(p, ensure_ascii=False) for p in pairs), encoding="utf-8"
    )

    benign_marker_rows = sum(1 for s in samples if s.get("benign_marker"))
    confusable_rows = sum(1 for s in samples if s.get("confusable_pair"))
    meta = {
        "seed": args.seed,
        "count": len(samples),
        "frames_total": len(frames),
        "frames_outcome": len({f for f, fam, _, _ in frames if fam == "outcome"}),
        "frames_routine": len({f for f, fam, _, _ in frames if fam == "routine"}),
        "splits": {k: len(v) for k, v in splits.items()},
        "balance_overall": balance_report(samples),
        "balance_splits": {k: balance_report(v) for k, v in splits.items()},
        "hygiene": hygiene,
        "over_budget_rows": over_budget,
        "negation_coverage": sum(1 for s in samples if s["negated"]),
        "marker_free_positives": sum(1 for s in samples if s["marker_free"]),
        "head_correlation": correlations,
        "split_integrity": {
            "cross_split_frames": len(cross),
            "frames_per_split": {k: len(v) for k, v in frame_sets.items()},
        },
        "contrastive": {
            "benign_marker_rows": benign_marker_rows,
            "negation_pairs": len(pairs),
            "confusable_rows": confusable_rows,
            "marker_conditionals": conds,
            "pairs_file": "ml/data/contrastive_pairs.json",
        },
        "grounding": GROUNDING,
        "destructive_markers": DESTRUCTIVE_MARKERS,
        "loop_markers": LOOP_MARKERS,
    }
    (out / "synth_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"wrote {len(samples)} samples (seed={args.seed}, {len(frames)} frames)")
    print(f"frames: outcome={meta['frames_outcome']} routine={meta['frames_routine']}")
    print("splits:", meta["splits"])
    print("overall balance:\n" + meta["balance_overall"])
    print(f"negation_coverage={meta['negation_coverage']} marker_free_positives={meta['marker_free_positives']}")
    print(f"contrastive: benign_marker={benign_marker_rows} neg_pairs={len(pairs)} confusable={confusable_rows}")
    print(f"marker_conditionals={conds}")
    print(f"hygiene={hygiene}")
    print(f"max |phi| with should_speak={max_should_speak_phi:.4f}")
    print(f"cross_split_frames={len(cross)}")


if __name__ == "__main__":
    main()
