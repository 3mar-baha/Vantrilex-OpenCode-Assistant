# Phase 1 Data Specification — contrastive rebalance (dataset v3)

Source measurements: `ml/phase1_diagnosis.json` (INT8 model, committed corpus).
Seed discipline: seed 8 retained; all quotas verified by `verify_g1.py` + new
contrastive assertions before any retrain.

## Measured shortcut (the problem)

- Train `P(destructive)=0.250`, but `P(destructive|no marker)=0.125`.
- Arabic markers are deterministic: `امسح`, `احذف`, `دمر` each have
  `P(destructive|marker)=1.000` (PMI 1.386). ASCII markers 0.774–0.815.
- Only 113/1008 (11.2%) marker-bearing train rows are benign.
- Test accuracy given marker present is 0.719 vs 0.890 absent;
  marker-bearing benign accuracy 0.667 (n=15);
  marker-free destructive accuracy 0.703 (n=91).
- Worst frames: `outcome-089`, `outcome-219` (0.55).

Conclusion: the heads key on marker presence. The fix is to make every
marker uninformative in isolation while keeping token budget and splits.

## Quotas (all mandatory, verified per split where stated)

1. **Per-marker balance.** For each of the 6 destructive markers:
   `0.40 ≤ P(destructive|marker) ≤ 0.60` in train. Practically: add benign
   uses until benign count ≥ 0.8 × destructive count per marker, and overall
   benign share of marker-bearing rows ≥ 0.40 (from 0.112).
2. **Benign marker-bearing actions (≥ 900 rows).** Full actions with
   destructive verbs on disposable/safe objects: `امسح الكاش`,
   `احذف الكومنتات`, `شيل الـ imports`, `drop temp table`,
   `rm -rf` on build artifacts. Incidental substrings do not count.
3. **Negation minimal pairs (≥ 300 pairs / 600 rows).** Same carrier,
   only the negation particle differs, flipping `is_destructive`
   true→false. ≥ 50% of negated rows carry an ASCII marker under negation
   (`force-push`/`drop`/`rm -rf`) so marker-only rules fail.
4. **Confusable pairs in training (≥ 480 rows).** All 8 suite pairs
   (`اسمع/امسح`, `احفظ/احذف`, …) with ≥ 30 examples per side per pair:
   the benign member must appear as a real action, not just eval-only.
5. **Marker-free positives (≥ 800, keep).** ≥ 200 must use verbs outside
   the current paraphrase list to widen the semantic field.
6. **Length.** Token-aware render enforced: corpus p99 ≤ 32, max ≤ 32
   (preserves the 23.98ms @32 operating point).
7. **Splits.** Group-aware by frame; 0 cross-split frames; every head
   ≥ 20% minority per split; new contrastive rows distributed across
   splits (no quarantining hard cases to train only).

## Pair record format

```json
{
  "pair_id": "neg-041",
  "base_text": "امسح جدول اليوزرز",
  "variant_text": "لا تمسح جدول اليوزرز",
  "changed_span": "لا",
  "labels_base": {"should_speak": true, "is_destructive": true, "barge_in": false, "stuck_in_loop": false},
  "labels_variant": {"should_speak": true, "is_destructive": false, "barge_in": false, "stuck_in_loop": false},
  "provenance": "synthetic|harvested|human"
}
```

## Provenance tags

Every row carries `provenance` plus, for pairs, `pair_id`. Harvested rows
keep `source` (e.g. JODA row id). Human-written hard negatives keep
`author`. Synthetic rows keep `frame` + `seed`.

## Verification before retrain

- `verify_g1.py` 8/8 (incl. p99 ≤ 32).
- Contrastive assertions: per-marker conditional in [0.40, 0.60];
  negation-pair count; confusable per-side count; benign-marker mass.
- `verify_g2.py` overlap zero both directions against the new train split.
