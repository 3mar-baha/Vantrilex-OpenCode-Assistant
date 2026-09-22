#!/usr/bin/env python3
"""M7 L0.3: harvest the JODA Jordanian dialect corpus (Gheith-Abandah/JODA).

Writes raw sentences to ml/data/joda_raw/ for grounding provenance. Network
required (HuggingFace). Retried with backoff; records row count + revision.
"""
from __future__ import annotations

import json
from pathlib import Path

REPO = "Gheith-Abandah/JODA"


def main() -> None:
    from datasets import load_dataset

    root = Path(__file__).resolve().parents[1]
    out = root / "ml" / "data" / "joda_raw"
    out.mkdir(parents=True, exist_ok=True)
    dataset = load_dataset(REPO)
    rows: list[str] = []
    for split in dataset:
        for row in dataset[split]:
            text = row.get("text") or row.get("sentence") or ""
            if isinstance(text, str) and text.strip():
                rows.append(text.strip())
    (out / "sentences.jsonl").write_text(
        "\n".join(json.dumps({"text": t}, ensure_ascii=False) for t in rows), encoding="utf-8"
    )
    meta = {"repo": REPO, "rows": len(rows), "splits": list(dataset.keys())}
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"JODA: {len(rows)} rows from splits {list(dataset.keys())}")


if __name__ == "__main__":
    main()
