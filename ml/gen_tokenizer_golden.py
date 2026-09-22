#!/usr/bin/env python3
"""Emit golden token IDs from the authoritative `tokenizers` lib for the TS BPE
bridge. The runtime tokenizer MUST reproduce these byte-for-byte; the TS test
compares against this fixture. Includes ASCII, Ammani Arabic, mixed, and
rare/emoji cases that exercise byte-fallback.
"""
from __future__ import annotations

import json
from pathlib import Path

from tokenizers import Tokenizer

HF = (
    "O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/"
    "snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json"
)
OUT = Path("src/runtime/laya/__fixtures__/tokenizer_golden.json")

SAMPLES = [
    "hello world",
    "التيستات شغالة، ما في جديد",
    "امسح الداتابيز كلها",
    "وقف اللي بتعمله، في مشكلة",
    "خلص البيلد، كله أخضر",
    "deploy to production now",
    "مشكلة في الـ migration 2024",
    "الـ API رجع 500 error",
    "git push origin main",
    "الله يعطيك العافية",
    "نص طويل شوي فيه كلمات كتير وبرضو رح يشتغل مع الموديل",
    "🚀 deploy",
    "Zürich café naïve",
    "  leading and trailing  ",
    "",
]


def main() -> None:
    tokenizer = Tokenizer.from_file(HF)
    golden = []
    for text in SAMPLES:
        enc = tokenizer.encode(text)
        golden.append({"text": text, "ids": enc.ids, "tokens": enc.tokens})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(golden, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {OUT} ({len(golden)} samples)")
    for row in golden[:6]:
        print(row["text"][:30], "->", row["ids"][:14], "|", row["tokens"][:8])


if __name__ == "__main__":
    main()