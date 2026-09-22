#!/usr/bin/env python3
"""G1 exit-gate verifier — docs/16 §16.8B.1 (Laya P0 Phase 1).

Reads ml/data/synth_meta.json and asserts every Phase-1 gate. Exit 0 = pass.
G1.7 (pyright clean) is verified separately via `opencode debug lsp diagnostics`.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

MIN_MINORITY = 0.20
MIN_NEGATIONS = 40
MIN_MARKER_FREE = 60
MAX_PHI = 0.30
HEADS = ("should_speak", "is_destructive", "barge_in", "stuck_in_loop")


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

    balance = meta.get("balance_overall", "")
    minorities = {}
    for line in balance.splitlines():
        m = re.match(r"(\w+): true=([\d.]+)% false=([\d.]+)%", line.strip())
        if m:
            head, t, f = m.group(1), float(m.group(2)), float(m.group(3))
            minorities[head] = min(t, f) / 100.0
    balance_ok = len(minorities) == len(HEADS) and all(v >= MIN_MINORITY for v in minorities.values())
    detail = ", ".join(f"{h}={v:.2%}" for h, v in minorities.items())
    results.append((f"G1.6 balance (every head >= {MIN_MINORITY:.0%} minority)", balance_ok, detail))

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