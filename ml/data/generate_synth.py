#!/usr/bin/env python3
"""Synthesize code-switched Ammani SE samples + 4-head labels + group-aware splits.

P0 hardening (docs/16 §16.8B.1):
  V4  `ديبلوي` (deploy) is a benign task, never a destructive marker.
  V5  every injected loop cue is a declared LOOP_MARKER (hygiene assertion).
  V6  explicit negated-destructive hard negatives (`لا/ما/مش/مو` + verb).
  V1  marker-free destructive positives (semantic paraphrase, no marker).
  V3  `should_speak` is driven by frame family only, decoupled from the other heads.
  V2  group-aware split by frame template — no template crosses train/val/test.

Frames are seeded and varied; the seed is logged for reproducibility. Pure stdlib.

Usage:
    python ml/data/generate_synth.py --count 5200 --seed 8 --out ml/data
"""
from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path

# --- Frame families (V3: should_speak is a function of family, nothing else) -----
# OUTCOME frames report a terminal result worth speaking.
OUTCOME_FRAMES = [
    "خلصت {task}، {result}",
    "البيلد {result}",
    "التيستات {result}",
    "الـ migration {result}",
    "الديبلوي {result}",
    "الريفاكتور خلص، {result}",
    "ركز معي شوي: {task} {result}",
    "تمام، {task} صارت {result}",
    "الـ code review {result}",
    "الـ cache {result} بعد {detail}",
    "الـ API {result}",
    "الـ lint {result}",
    "الـ schema {result}",
    "خلّصت الـ {task}، {followup}",
    "الـ {module} {result}",
    "{task} صارت {result}، {followup}",
]
# ROUTINE frames are unremarkable ticks that stay silent.
ROUTINE_FRAMES = [
    "{task} شغالة، ما في جديد",
    "البيلد ماشي طبيعي",
    "الـ lint خلص بدون ملاحظات",
    "الكاش تحدث، كل شي مستقر",
    "الـ API بيرد طبيعي",
    "{task} ماشية عادي",
    "الـ {module} مستقر، ما في جديد",
    "الوضع طبيعي، {task} شغالة",
    "ما في جديد، {task} ماشية",
    "{detail} صار، كل شي تمام",
    "السيرفر مستقر، ما في ملاحظات",
    "الـ queue فاضية، كل شي هادي",
]

TECH_TASKS = [
    "التيستات", "البيلد", "الـ schema", "الديبلوي", "الريفاكتور",
    "الـ migration", "الـ lint", "الـ code review", "الـ cache", "الـ API",
]
RESULTS = [
    "كلها خضرا بدون مشاكل", "في مشكلة بملفين", "فشل بثلاث تيستات",
    "تمام بس في تحذيرين", "علق على Type errors", "خلص أخضر",
    "رجع 500 من السيرفر", "البورت محجوز", "المفتاح خلصت حصته",
]
MODULES = ["الـ Auth", "الـ billing", "الـ cache", "الـ REF", "الـ gateway"]
FOLLOWUPS = ["أبلش أصلحهم", "تشوف اللوج", "أكمل ولا أوقف", "أفتح لك التفاصيل"]
DETAILS = ["آخر كوميت", "تحديث الديبندنسيز", "ريستارت السيرفر", "تنظيف الكاش"]

# --- Marker sets -----------------------------------------------------------------
# V4: "ديبلوي" removed — deploy is a normal release action, not destruction.
DESTRUCTIVE_MARKERS = ["امسح", "احذف", "دمر", "force-push", "rm -rf", "drop"]
BARGE_MARKERS = ["وقف", "تمام بس", "خلص بكفي", "اسكت"]
LOOP_MARKERS = ["المحاولة", "لسّاني شغال", "ريتراي"]
# V5: each suffix contains a declared LOOP_MARKER (hygiene by construction).
LOOP_SUFFIXES = ["، نعمل ريتراي", "، هاي المحاولة مرة تانية", "، لسّاني شغال عليه"]

# V1: destructive intent with NO declared marker (semantic paraphrase).
MARKER_FREE_DESTRUCTIVE = [
    "فرمت الداتابيز كلها",
    "شيل جدول اليوزرز من السيرفر",
    "نظّف كل الداتا من الـ prod",
    "اطفي السيرفر نهائي",
    "امحي كل الملفات من السيرفر",
    "شيل صلاحيات اليوزرز كلهم",
    "حرق النسخة الاحتياطية",
]

# V6: negated destructive commands — is_destructive=False hard negatives.
# Some deliberately contain an ASCII marker under negation (force-push/drop/rm -rf),
# so a marker-only rule cannot pass; the head must read the negation.
NEGATION_TEMPLATES = [
    "ما تمسح شي",
    "لا تحذف الداتابيز",
    "مش وقتها force-push",
    "مو لازم drop للجدول",
    "لا تسوي rm -rf",
    "ما تدمر شي",
    "مش هلق نمسح",
    "لا تلمس الداتابيز",
]

# --- Sampling rates (independent across heads -> low correlation, V3) -------------
DESTRUCTIVE_RATE = 0.25
MARKER_FREE_SHARE = 0.40   # of destructive positives
NEGATION_RATE = 0.10       # of non-destructive samples
BARGE_RATE = 0.22
LOOP_RATE = 0.24


def make_sample(rng: random.Random, index: int, frame_id: str, family: str, template: str) -> dict:
    text = template.format(
        task=rng.choice(TECH_TASKS),
        result=rng.choice(RESULTS),
        module=rng.choice(MODULES),
        followup=rng.choice(FOLLOWUPS),
        detail=rng.choice(DETAILS),
        attempt=rng.randint(2, 6),
    )
    should_speak = family == "outcome"

    is_destructive = rng.random() < DESTRUCTIVE_RATE
    marker_free = False
    if is_destructive:
        if rng.random() < MARKER_FREE_SHARE:
            text = f"{rng.choice(MARKER_FREE_DESTRUCTIVE)}، {text}"
            marker_free = True
        else:
            text = f"{rng.choice(DESTRUCTIVE_MARKERS)} {text}"

    negated = False
    if not is_destructive and rng.random() < NEGATION_RATE:
        text = f"{rng.choice(NEGATION_TEMPLATES)}. {text}"
        negated = True

    barge_in = rng.random() < BARGE_RATE
    if barge_in:
        text = f"{rng.choice(BARGE_MARKERS)}، {text}"

    stuck_in_loop = rng.random() < LOOP_RATE
    if stuck_in_loop:
        text = f"{text}{rng.choice(LOOP_SUFFIXES)}"

    return {
        "id": f"synth-{index:05d}",
        "text": text,
        "frame": frame_id,
        "marker_free": marker_free,
        "negated": negated,
        "labels": {
            "should_speak": should_speak,
            "is_destructive": is_destructive,
            "barge_in": barge_in,
            "stuck_in_loop": stuck_in_loop,
        },
    }


def build_frames() -> list[tuple[str, str, str]]:
    """Interleave outcome/routine frames so every split gets both families."""
    frames: list[tuple[str, str, str]] = []
    for i in range(max(len(OUTCOME_FRAMES), len(ROUTINE_FRAMES))):
        if i < len(OUTCOME_FRAMES):
            frames.append((f"outcome-{i:02d}", "outcome", OUTCOME_FRAMES[i]))
        if i < len(ROUTINE_FRAMES):
            frames.append((f"routine-{i:02d}", "routine", ROUTINE_FRAMES[i]))
    return frames


def split_of_frame(frames: list[tuple[str, str, str]]) -> dict[str, str]:
    """Deterministic 80/10/10 assignment by interleaved frame index (V2)."""
    assignment: dict[str, str] = {}
    for i, (fid, _family, _template) in enumerate(frames):
        bucket = i % 10
        assignment[fid] = "train" if bucket < 8 else ("val" if bucket == 8 else "test")
    return assignment


def phi(a: list[bool], b: list[bool]) -> float:
    n11 = sum(1 for x, y in zip(a, b) if x and y)
    n10 = sum(1 for x, y in zip(a, b) if x and not y)
    n01 = sum(1 for x, y in zip(a, b) if not x and y)
    n00 = sum(1 for x, y in zip(a, b) if not x and not y)
    denom = ((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00)) ** 0.5
    return (n11 * n00 - n10 * n01) / denom if denom else 0.0


def hygiene_check(samples: list[dict]) -> dict:
    """Fail-closed: raise on any hygiene violation."""
    markerless_positives = 0
    marker_bearing_paraphrase = 0
    loop_markerless = 0
    barge_markerless = 0
    for s in samples:
        text = s["text"]
        labels = s["labels"]
        has_marker = any(m in text for m in DESTRUCTIVE_MARKERS)
        if labels["is_destructive"]:
            if s["marker_free"]:
                if has_marker:
                    marker_bearing_paraphrase += 1
            elif not has_marker:
                markerless_positives += 1
        if labels["stuck_in_loop"] and not any(m in text for m in LOOP_MARKERS):
            loop_markerless += 1
        if labels["barge_in"] and not any(m in text for m in BARGE_MARKERS):
            barge_markerless += 1
    problems = {
        "markerless_positives": markerless_positives,
        "marker_free_paraphrase_contains_marker": marker_bearing_paraphrase,
        "loop_markerless": loop_markerless,
        "barge_markerless": barge_markerless,
    }
    if any(problems.values()):
        raise SystemExit(f"HYGIENE FAILED: {problems}")
    return problems


def balance_report(samples: list[dict]) -> str:
    lines = []
    for head in ("should_speak", "is_destructive", "barge_in", "stuck_in_loop"):
        counts = Counter(s["labels"][head] for s in samples)
        total = len(samples)
        lines.append(f"{head}: true={counts[True] / total:.2%} false={counts[False] / total:.2%}")
    return "\n".join(lines)


def correlation_report(samples: list[dict]) -> dict:
    heads = ("should_speak", "is_destructive", "barge_in", "stuck_in_loop")
    cols = {h: [s["labels"][h] for s in samples] for h in heads}
    out: dict[str, float] = {}
    for i, a in enumerate(heads):
        for b in heads[i + 1 :]:
            out[f"{a}~{b}"] = round(phi(cols[a], cols[b]), 4)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=5200)
    parser.add_argument("--seed", type=int, default=8)
    parser.add_argument("--out", type=str, default="ml/data")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    frames = build_frames()
    assignment = split_of_frame(frames)
    per_frame = max(1, args.count // len(frames))

    splits: dict[str, list[dict]] = {"train": [], "val": [], "test": []}
    index = 0
    for fid, family, template in frames:
        target = assignment[fid]
        for _ in range(per_frame):
            splits[target].append(make_sample(rng, index, fid, family, template))
            index += 1

    samples = splits["train"] + splits["val"] + splits["test"]
    rng.shuffle(samples)

    hygiene = hygiene_check(samples)

    # V2: no frame template may cross splits.
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

    negation_coverage = sum(1 for s in samples if s["negated"])
    marker_free_positives = sum(1 for s in samples if s["marker_free"])
    meta = {
        "seed": args.seed,
        "count": len(samples),
        "splits": {k: len(v) for k, v in splits.items()},
        "balance_overall": balance_report(samples),
        "balance_train": balance_report(splits["train"]),
        "hygiene": hygiene,
        "negation_coverage": negation_coverage,
        "marker_free_positives": marker_free_positives,
        "head_correlation": correlations,
        "split_integrity": {
            "cross_split_frames": len(cross),
            "frames_per_split": {k: sorted(v) for k, v in frame_sets.items()},
        },
        "destructive_markers": DESTRUCTIVE_MARKERS,
        "loop_markers": LOOP_MARKERS,
    }
    (out / "synth_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"wrote {len(samples)} samples (seed={args.seed}, {len(frames)} frames)")
    print("splits:", meta["splits"])
    print("overall balance:\n" + meta["balance_overall"])
    print(f"negation_coverage={negation_coverage} marker_free_positives={marker_free_positives}")
    print(f"hygiene={hygiene}")
    print(f"max |phi| with should_speak={max_should_speak_phi:.4f}")
    print(f"cross_split_frames={len(cross)}")


if __name__ == "__main__":
    main()