#!/usr/bin/env python3
"""Synthesize code-switched Ammani SE samples + 4-head labels + group-aware splits.

Corpus v2 — expanded to 200+ grounded frames (docs/16 §16.8B.1).

GROUNDING (verified sources only; see GROUNDING below for provenance):
  - Jordanian colloquial syntactic patterns mined from the harvested corpus
    `ml/data/joda_raw/sentences.jsonl` (KareemBb/Jordanian-Dialect-Instruct-QA,
    1,685 rows): politeness `يعطيك العافية`, question frames `شو بصير إذا`,
    `كيف بقدر`, `وين بقدر`, modals `بقدر` / `لازم` / `بدي`, `قبل ما`, and the
    negations `ما` / `مش`.
  - Levantine negation particles `لا / ما / مش / مو / بلاش / دير بالك` (standard
    Jordanian/Levantine; not all present in the harvested slice).
  - MSA structural templates (`تم …`, `انتهى …`, `فشل …`).
  MADAR-Amman and MASSIVE-Arabic were NOT locally available, so no template is
  attributed to them and none is invented on their behalf.

P0 hardening retained: V4 (deploy benign), V5 (loop-marker hygiene), V6
(negation labels), V1 (marker-free positives), V3 (should_speak decoupled),
V2 (group-aware split). Head labels other than `should_speak` are assigned
stratified per split so every split clears the 20% minority floor.

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
    "madar_amman": "not locally available — not used (no fabrication)",
    "massive_ar": "not locally available — not used (no fabrication)",
}

# --- Grounded frame construction ------------------------------------------------
# Politeness / discourse particles attested in the harvested corpus or standard Ammani.
OUTCOME_PREFIXES = [
    "", "تمام، ", "طيب، ", "يلا، ", "خلص، ", "الحمد لله، ", "يعطيك العافية، ",
    "يسعد مساك، ", "هلا، ", "أوكي، ", "ماشي، ", "زبط، ", "يسعد صباحك، ", "هلا والله، ",
]
ROUTINE_PREFIXES = [
    "", "بس، ", "طيب، ", "هلا، ", "تمام، ", "أوكي، ", "ماشي، ", "هلا والله، ",
    "يعطيك العافية، ", "يسعد صباحك، ",
]
# Outcome cores: terminal results worth speaking. <= 7 words each.
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
    "البيلد {result}",
    "{task} صارت {result}",
    "{module} خلص، {result}",
    "{task} تمام، {result}",
    "ضبطت {task}، {result}",
    "{module} جاهز، {result}",
    "{task} خلصت بعد {detail}",
]
# Routine cores: unremarkable ticks that stay silent. <= 7 words each.
ROUTINE_CORES = [
    "{task} شغالة، ما في جديد",
    "البيلد ماشي طبيعي",
    "{task} ماشية عادي",
    "{module} مستقر، ما في جديد",
    "الوضع طبيعي، {task} شغالة",
    "ما في جديد، {task} ماشية",
    "{detail} صار، كل شي تمام",
    "السيرفر مستقر، ما في ملاحظات",
    "{task} شغالة على {module}",
    "{module} ماشي طبيعي",
    "ما في أخطاء، {task} ماشية",
    "{task} مستقرة، ما في جديد",
    "الوضع هادي، {module} شغالة",
    "{task} ماشية، ما في تحذيرات",
    "كل شي طبيعي، {task} شاغلة",
    "{module} ماشي، ما في جديد",
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
# V4: "ديبلوي" removed — deploy is a normal release action, not destruction.
DESTRUCTIVE_MARKERS = ["امسح", "احذف", "دمر", "force-push", "rm -rf", "drop"]
BARGE_MARKERS = ["وقف", "وقّف", "تمام بس", "خلص بكفي", "اسكت", "لحظة", "استنى"]
LOOP_MARKERS = ["المحاولة", "لسّاني شغال", "ريتراي"]
# V5: each suffix contains a declared LOOP_MARKER.
LOOP_SUFFIXES = [
    "، نعمل ريتراي", "، هاي المحاولة التانية", "، لسّاني شغال",
    "، ريتراي كمان مرة", "، المحاولة الخامسة",
]

# V1: destructive intent with NO declared marker (short, <= 4 words).
# Phrasings are deliberately disjoint from ml/adversarial_suite.json (G2.3).
MARKER_FREE_DESTRUCTIVE = [
    "فرّغ الجداول", "فرمت الستوريج", "خلّي الداتابيز صفر", "شيل الجداول كلها",
    "نظّف الداتا كلها", "اطفي الداتابيز", "امحي الملفات كلها", "الغي الصلاحيات كلها",
    "احرق النسخ الاحتياطية", "فرّغ السيرفر", "قفل البورتات", "ضيّع الهيستوري",
    "شيل الـ containers", "خرب البيئة", "فرّغ المخزن", "ضيّع الباكب",
    "امحي الـ traces", "شيل المستخدمين", "فرمت القرص", "خرب السيرفر",
]

# V6: negated destructive commands — is_destructive=False hard negatives.
# Phrasings are deliberately distinct from ml/adversarial_suite.json (G2.3).
NEGATION_TEMPLATES = [
    "ما تمسح {module}", "لا تحذف {task}", "مش وقتها force-push",
    "مو لازم drop", "بلاش rm -rf", "دير بالك تمسح {module}",
    "ما تعمل ديبلوي هلق", "لا تشيل {module}", "مش رح نمسح الـ cache",
    "ما تحرق الباكب", "بلاش reset hard", "دير بالك تحذف {task}",
    "مو وقتها ننظف", "ما تطفّي {module}", "لا تفرغ الداتا",
    "بلاش تمسح شي", "ما تشيل اليوزرز", "دير بالك تفرمت الديسك",
]

# V8: benign imperative prefixes — teach the confusable *benign* member.
BENIGN_IMPERATIVES = [
    "اسمع، ", "احفظ الملف، ", "صدّر الداتا، ", "راجع {module}، ",
    "تأكد من {task}، ", "خليك معي، ", "بس ركز، ",
]

# --- Target head rates (stratified per split) ------------------------------------
DESTRUCTIVE_RATE = 0.25
MARKER_FREE_SHARE = 0.45
NEGATION_RATE = 0.14
BARGE_RATE = 0.22
LOOP_RATE = 0.24
BENIGN_IMPERATIVE_RATE = 0.12
HEADS = ("should_speak", "is_destructive", "barge_in", "stuck_in_loop")


def build_frames() -> list[tuple[str, str, str]]:
    """Cross grounded prefixes with cores; dedupe; interleave families."""
    outcome: list[str] = []
    for prefix in OUTCOME_PREFIXES:
        for core in OUTCOME_CORES:
            outcome.append(f"{prefix}{core}")
    routine: list[str] = []
    for prefix in ROUTINE_PREFIXES:
        for core in ROUTINE_CORES:
            routine.append(f"{prefix}{core}")
    outcome = sorted(set(outcome))
    routine = sorted(set(routine))
    frames: list[tuple[str, str, str]] = []
    for i in range(max(len(outcome), len(routine))):
        if i < len(outcome):
            frames.append((f"outcome-{i:03d}", "outcome", outcome[i]))
        if i < len(routine):
            frames.append((f"routine-{i:03d}", "routine", routine[i]))
    return frames


def split_of_frame(frames: list[tuple[str, str, str]]) -> dict[str, str]:
    """Deterministic 80/10/10 per family so every split gets both families (V2)."""
    assignment: dict[str, str] = {}
    counters = {"outcome": 0, "routine": 0}
    for fid, family, _template in frames:
        idx = counters[family]
        counters[family] += 1
        bucket = idx % 10
        assignment[fid] = "train" if bucket < 8 else ("val" if bucket == 8 else "test")
    return assignment


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
                "labels": labels,
            }
    return {
        "id": slot["id"],
        "text": text,
        "frame": slot["frame"],
        "marker_free": marker_free,
        "negated": negated,
        "labels": labels,
    }


def _render_once(rng: random.Random, slot: dict, short: bool, drop_optional: bool) -> tuple[str, bool, bool]:
    text = slot["template"].format(
        task=rng.choice(TECH_TASKS),
        result=rng.choice(RESULTS),
        module=rng.choice(MODULES),
        followup=rng.choice(FOLLOWUPS),
        detail=rng.choice(DETAILS),
    )
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
    for fid, family, template in frames:
        for _ in range(per_frame):
            slots.append(
                {
                    "id": f"synth-{index:05d}",
                    "frame": fid,
                    "family": family,
                    "template": template,
                    "split": assignment[fid],
                    "labels": {"should_speak": family == "outcome"},
                }
            )
            index += 1

    stratify_labels(rng, slots)
    samples = [render_sample(rng, slot) for slot in slots]
    rng.shuffle(samples)

    hygiene = hygiene_check(samples)

    splits: dict[str, list[dict]] = {"train": [], "val": [], "test": []}
    for s in samples:
        splits[assignment[s["frame"]]].append(s)

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

    meta = {
        "seed": args.seed,
        "count": len(samples),
        "frames_total": len(frames),
        "frames_outcome": len({f for f, fam, _ in frames if fam == "outcome"}),
        "frames_routine": len({f for f, fam, _ in frames if fam == "routine"}),
        "splits": {k: len(v) for k, v in splits.items()},
        "balance_overall": balance_report(samples),
        "balance_splits": {k: balance_report(v) for k, v in splits.items()},
        "hygiene": hygiene,
        "negation_coverage": sum(1 for s in samples if s["negated"]),
        "marker_free_positives": sum(1 for s in samples if s["marker_free"]),
        "head_correlation": correlations,
        "split_integrity": {
            "cross_split_frames": len(cross),
            "frames_per_split": {k: len(v) for k, v in frame_sets.items()},
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
    print(f"hygiene={hygiene}")
    print(f"max |phi| with should_speak={max_should_speak_phi:.4f}")
    print(f"cross_split_frames={len(cross)}")


if __name__ == "__main__":
    main()