#!/usr/bin/env python3
"""G1 exit-gate verifier — docs/16 §16.8B.1 (Laya P0 Phase 1).

Reads ml/data/synth_meta.json and asserts every Phase-1 gate. Exit 0 = pass.
G1.9 (pyright clean on the ml scripts) is verified separately via
`opencode debug lsp diagnostics`.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MIN_MINORITY = 0.20
MIN_NEGATIONS = 40
MIN_MARKER_FREE = 60
MIN_FRAMES = 200
MAX_PHI = 0.30
MAX_P99_TOKENS = 32
HEADS = ("should_speak", "is_destructive", "barge_in", "stuck_in_loop")
HF_TOKENIZER = (
    "O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/"
    "snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json"
)


def main() -> None:
    meta = json.loads((Path(__file__).resolve().parents[1] / "ml" / "data" / "synth_meta.json").read_text(encoding="utf-8"))
    results: list[tuple[str, bool, str]] = []

    hygiene = meta.get("hygiene", {})
    hygiene_ok = hygiene and all(v == 0 for v in hygiene.values())
    results.append(("G1.1 marker hygiene (all violations == 0)", hygiene_ok, json.dumps(hygiene)))

    neg = meta.get("negation_coverage", 0)
    results.append((f"G1.2 negation coverage >= {MIN_NEGATIONS}", neg >= MIN_NEGATIONS, f"count={neg}"))

    mf = meta.get("marker_free_positives", 0)
    results.append((f"G1.3 marker-free positives >= {MIN_MARKER_FREE}", mf >= MIN_MARKER_FREE, f"count={mf}"))

    cross = meta.get("split_integrity", {}).get("cross_split_frames", -1)
    results.append(("G1.4 split integrity (cross-split frames == 0)", cross == 0, f"cross={cross}"))

    corr = meta.get("head_correlation", {})
    max_phi = max((abs(v) for k, v in corr.items() if k.startswith("should_speak")), default=1.0)
    results.append((f"G1.5 head independence (max |phi| < {MAX_PHI})", max_phi < MAX_PHI, f"max|phi|={max_phi:.4f}"))

    def parse_minorities(block: str) -> dict[str, float]:
        out: dict[str, float] = {}
        for line in block.splitlines():
            m = re.match(r"(\w+): true=([\d.]+)% false=([\d.]+)%", line.strip())
            if m:
                out[m.group(1)] = min(float(m.group(2)), float(m.group(3))) / 100.0
        return out

    per_split = meta.get("balance_splits", {})
    parsed = {name: parse_minorities(block) for name, block in per_split.items()}
    balance_ok = bool(parsed) and all(
        len(mins) == len(HEADS) and all(v >= MIN_MINORITY for v in mins.values())
        for mins in parsed.values()
    )
    detail = "; ".join(
        f"{name}[" + ",".join(f"{h}={v:.0%}" for h, v in mins.items()) + "]" for name, mins in parsed.items()
    )
    results.append((f"G1.6 balance per split (every head >= {MIN_MINORITY:.0%} minority)", balance_ok, detail))

    frames_total = meta.get("frames_total", 0)
    results.append((f"G1.7 template diversity (frames >= {MIN_FRAMES})", frames_total >= MIN_FRAMES, f"frames={frames_total}"))

    # G1.8 token length — critical: keeps the ~26 ms latency operating point.
    try:
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(HF_TOKENIZER)
        corpus = ROOT / "ml" / "data" / "synth_ammani_se.jsonl"
        lengths = sorted(
            len(tokenizer.encode(json.loads(line)["text"]).ids)
            for line in corpus.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
        p99 = lengths[int(len(lengths) * 0.99)]
        length_ok = p99 <= MAX_P99_TOKENS
        detail = f"max={lengths[-1]} p99={p99} n={len(lengths)}"
    except Exception as exc:  # noqa: BLE001
        length_ok = False
        detail = f"tokenizer/length check failed: {exc}"
    results.append((f"G1.8 token length p99 <= {MAX_P99_TOKENS}", length_ok, detail))

    width = max(len(name) for name, _, _ in results)
    failed = False
    for name, ok, detail in results:
        status = "PASS" if ok else "FAIL"
        failed |= not ok
        print(f"[{status}] {name.ljust(width)}  {detail}")
    print(f"\nG1 {'PASS' if not failed else 'FAIL'} — {len(results) - sum(1 for _, ok, _ in results if not ok)}/{len(results)} gates")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()