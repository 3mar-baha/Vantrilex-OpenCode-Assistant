#!/usr/bin/env python3
"""M7 L0.3: harvest Jordanian dialect grounding data.

Primary target Gheith-Abandah/JODA is not published on the Hub (verified
2026-09-22) — provenance downgrade invoked per plan: fall back to
KareemBb/Jordanian-Dialect-Instruct-QA, then levantdata sample. The source used
is recorded in meta.json. Synthetic code-switched data (generate_synth.py)
remains the primary training signal.
"""
from __future__ import annotations

import json
from pathlib import Path

CANDIDATES = [
    "Gheith-Abandah/JODA",
    "KareemBb/Jordanian-Dialect-Instruct-QA",
    "levantdata/jordanian-dialect-sample-v1",
]


def extract_text(row: dict) -> str:
    for key in ("text", "sentence", "input", "question", "instruction"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def main() -> None:
    from datasets import load_dataset
    from datasets.exceptions import DatasetNotFoundError

    root = Path(__file__).resolve().parents[1]
    out = root / "ml" / "data" / "joda_raw"
    out.mkdir(parents=True, exist_ok=True)
    used: str | None = None
    dataset = None
    for candidate in CANDIDATES:
        try:
            dataset = load_dataset(candidate)
            used = candidate
            break
        except DatasetNotFoundError:
            print(f"absent: {candidate}")
            continue
    if dataset is None or used is None:
        raise SystemExit("no dialect corpus available — harvest FAILED")
    rows: list[str] = []
    for split in dataset:
        for row in dataset[split]:
            text = extract_text(row)
            if text:
                rows.append(text)
    (out / "sentences.jsonl").write_text(
        "\n".join(json.dumps({"text": t}, ensure_ascii=False) for t in rows), encoding="utf-8"
    )
    meta = {"repo": used, "candidates": CANDIDATES, "rows": len(rows), "splits": list(dataset.keys())}
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"dialect corpus: {used} — {len(rows)} rows from splits {list(dataset.keys())}")


if __name__ == "__main__":
    main()
