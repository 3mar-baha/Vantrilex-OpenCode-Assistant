#!/usr/bin/env python3
"""Synthesize 5,000+ code-switched Ammani SE samples + 4-head labels + splits.

Blends colloquial Ammani frames with software-engineering terminology and emits
balanced labels for: should_speak, is_destructive, barge_in, stuck_in_loop.
Frames are seeded and varied (never fixed templates); the seed is logged for
reproducibility. Pure stdlib (runs before/after the venv install alike).

Usage:
    python ml/data/generate_synth.py --count 5200 --seed 7 --out ml/data
"""
from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path

AMMANI_FRAMES = [
    "خلصت {task}، {result}",
    "لسّاني شغال على {task}، {result}",
    "يا عمر {result} بملف {module}",
    "التيستات {result}، {followup}",
    "البيلد {result} بعد {detail}",
    "{result}، بتحب {followup}؟",
    "هاي المحاولة {attempt} والمشكلة {result}",
    "ركز معي شوي: {task} {result}",
    "تمام، {task} صارت {result}",
    "وقف اللي بتعمله، {result}",
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
FOLLOWUPS = [
    "أبلش أصلحهم", "تشوف اللوج", "أكمل ولا أوقف",
    "نعمل ريتراي", "أفتح لك التفاصيل",
]
DETAILS = ["آخر كوميت", "تحديث الديبندنسيز", "ريستارت السيرفر", "تنظيف الكاش"]

DESTRUCTIVE_MARKERS = ["امسح", "احذف", "دمر", "ديبلوي", "force-push", "rm -rf", "drop"]
BARGE_MARKERS = ["وقف", "تمام بس", "خلص بكفي", "اسكت"]
LOOP_MARKERS = ["المحاولة", "لسّاني شغال", "ريتراي"]

# Routine ticks: unremarkable progress that stays silent (should_speak=false).
ROUTINE_FRAMES = [
    "التيستات شغالة، ما في جديد",
    "البيلد ماشي طبيعي",
    "الـ lint خلص بدون ملاحظات",
    "الكاش تحدث، كل شي مستقر",
    "الـ API بيرد طبيعي",
]


def make_sample(rng: random.Random, index: int) -> dict:
    if rng.random() < 0.38:
        # Routine tick — silent by construction.
        return {
            "id": f"synth-{index:05d}",
            "text": rng.choice(ROUTINE_FRAMES),
            "labels": {
                "should_speak": False,
                "is_destructive": False,
                "barge_in": False,
                "stuck_in_loop": False,
            },
        }
    frame = rng.choice(AMMANI_FRAMES)
    text = frame.format(
        task=rng.choice(TECH_TASKS),
        result=rng.choice(RESULTS),
        module=rng.choice(MODULES),
        followup=rng.choice(FOLLOWUPS),
        detail=rng.choice(DETAILS),
        attempt=rng.randint(2, 6),
    )
    roll = rng.random()
    lowered = text
    is_destructive = any(m in lowered for m in DESTRUCTIVE_MARKERS) or roll < 0.30
    if roll < 0.18:
        text = f"{rng.choice(DESTRUCTIVE_MARKERS)} {text}"
        is_destructive = True
    barge_in = any(m in text for m in BARGE_MARKERS) or roll < 0.18
    if roll < 0.08:
        text = f"{rng.choice(BARGE_MARKERS)}، {text}"
        barge_in = True
    stuck_in_loop = any(m in text for m in LOOP_MARKERS) or roll < 0.20
    # Deterministic surface: every true label must have a visible marker.
    # (Prior version left ~10% of true labels markerless — unlearnable noise.)
    if is_destructive and not any(m in text for m in DESTRUCTIVE_MARKERS):
        text = f"{rng.choice(DESTRUCTIVE_MARKERS)} {text}"
    if barge_in and not any(m in text for m in BARGE_MARKERS):
        text = f"{rng.choice(BARGE_MARKERS)}، {text}"
    if stuck_in_loop and not any(m in text for m in LOOP_MARKERS):
        text = f"{text}، وبعدنا بنحاول"
    should_speak = True
    if roll < 0.25 and not (is_destructive or barge_in or stuck_in_loop):
        should_speak = False  # routine tick, stays silent
    return {
        "id": f"synth-{index:05d}",
        "text": text,
        "labels": {
            "should_speak": should_speak,
            "is_destructive": is_destructive,
            "barge_in": barge_in,
            "stuck_in_loop": stuck_in_loop,
        },
    }


def balance_report(samples: list[dict]) -> str:
    lines = []
    for head in ("should_speak", "is_destructive", "barge_in", "stuck_in_loop"):
        counts = Counter(s["labels"][head] for s in samples)
        total = len(samples)
        lines.append(
            f"{head}: true={counts[True] / total:.2%} false={counts[False] / total:.2%}"
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=5200)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=str, default="ml/data")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    samples = [make_sample(rng, i) for i in range(args.count)]
    rng.shuffle(samples)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "synth_ammani_se.jsonl").write_text(
        "\n".join(json.dumps(s, ensure_ascii=False) for s in samples), encoding="utf-8"
    )
    n = len(samples)
    splits = {
        "train": samples[: int(n * 0.8)],
        "val": samples[int(n * 0.8) : int(n * 0.9)],
        "test": samples[int(n * 0.9) :],
    }
    for name, subset in splits.items():
        (out / "splits").mkdir(parents=True, exist_ok=True)
        (out / "splits" / f"{name}.jsonl").write_text(
            "\n".join(json.dumps(s, ensure_ascii=False) for s in subset), encoding="utf-8"
        )
    meta = {
        "seed": args.seed,
        "count": n,
        "splits": {k: len(v) for k, v in splits.items()},
        "balance_overall": balance_report(samples),
        "balance_train": balance_report(splits["train"]),
    }
    (out / "synth_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {n} samples (seed={args.seed})")
    print("overall balance:\n" + meta["balance_overall"])
    print("train balance:\n" + meta["balance_train"])


if __name__ == "__main__":
    main()
