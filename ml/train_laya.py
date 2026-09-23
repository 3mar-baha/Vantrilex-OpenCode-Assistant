#!/usr/bin/env python3
"""M7 L1: fine-tune 4 linear heads over the laya-multilingual backbone (CPU).

Top 1-2 transformer blocks may be unfrozen with differential LRs (see
training_config.yaml); everything else stays frozen. Reads
ml/training_config.yaml. Writes checkpoint + ml/eval_report.md.
Exits nonzero when the accuracy gates fail (one retrain allowed by operator).
"""
from __future__ import annotations

import json
import os
import random
from pathlib import Path

import numpy as np
import torch
import yaml
from sklearn.metrics import accuracy_score, f1_score
from torch import nn
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModel, AutoTokenizer


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


HEADS = ["should_speak", "is_destructive", "barge_in", "stuck_in_loop"]


class LayaHeadDataset(Dataset):
    def __init__(self, path: Path, tokenizer, max_length: int):
        self.rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict:
        row = self.rows[index]
        # `tokenizers` lib directly: repo tokenizer_config is custom-shaped and
        # breaks transformers' AutoTokenizer init — bypass it, pad manually.
        enc = self.tokenizer.encode(row["text"])
        ids = enc.ids[: self.max_length]
        mask = [1] * len(ids)
        while len(ids) < self.max_length:
            ids.append(0)
            mask.append(0)
        labels = torch.tensor([1.0 if row["labels"][h] else 0.0 for h in HEADS])
        return {
            "input_ids": torch.tensor(ids, dtype=torch.long),
            "attention_mask": torch.tensor(mask, dtype=torch.long),
            "labels": labels,
        }


class LayaHeads(nn.Module):
    def __init__(self, backbone: nn.Module, hidden: int, unfreeze_top_layers: int = 0):
        super().__init__()
        self.backbone = backbone
        for param in self.backbone.parameters():
            param.requires_grad = False
        self.unfrozen_blocks: list[str] = unfreeze_top_blocks(backbone, unfreeze_top_layers)
        self.heads = nn.ModuleDict({h: nn.Linear(hidden, 1) for h in HEADS})

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> dict[str, torch.Tensor]:
        outputs = self.backbone(input_ids=input_ids, attention_mask=attention_mask)
        # Masked mean pooling matches the mmBERT pretraining head (classifier_pooling=mean).
        mask = attention_mask.unsqueeze(-1).float()
        pooled = (outputs.last_hidden_state * mask).sum(dim=1) / mask.sum(dim=1).clamp_min(1.0)
        return {h: self.heads[h](pooled).squeeze(-1) for h in HEADS}

    def head_state(self) -> dict:
        return {h: self.heads[h].state_dict() for h in HEADS}

    def tunable_backbone_state(self) -> dict:
        """State of backbone params with requires_grad (empty when frozen)."""
        return {n: p.detach().cpu() for n, p in self.backbone.named_parameters() if p.requires_grad}

    def load_tunable_state(self, heads_state: dict, backbone_state: dict) -> None:
        for h in HEADS:
            self.heads[h].load_state_dict(heads_state[h])
        if backbone_state:
            own = dict(self.named_parameters())
            provided = {f"backbone.{k}": v for k, v in backbone_state.items()}
            absent = [k for k in provided if k not in own]
            _, unexpected = self.load_state_dict(provided, strict=False)
            if absent or unexpected:
                raise SystemExit(f"backbone weight load FAILED: absent={absent[:5]} unexpected={unexpected[:5]}")


def unfreeze_top_blocks(backbone: nn.Module, n: int) -> list[str]:
    """Unfreeze the top n transformer blocks in place; return their names.

    Fail-closed: raises instead of guessing when no layer list is found, so a
    silent heads-only run can never masquerade as a backbone-adaptation run.
    """
    if n <= 0:
        return []
    blocks = find_layer_blocks(backbone)
    if blocks is None:
        raise SystemExit("no transformer layer list found — refusing to guess unfreeze targets")
    prefix, modules = blocks
    if n > len(modules):
        raise SystemExit(f"unfreeze_top_layers={n} exceeds {len(modules)} blocks under {prefix}")
    names = []
    for block in modules[len(modules) - n :]:
        for param in block.parameters():
            param.requires_grad = True
    for name, _ in backbone.named_parameters():
        if name.startswith(prefix + "."):
            names.append(name)
    unfrozen = [name for name in names if dict(backbone.named_parameters())[name].requires_grad]
    print(f"unfrozen {len(modules) - n}..{len(modules) - 1} under {prefix} ({len(unfrozen)} params live)")
    return [f"{prefix}.{i}" for i in range(len(modules) - n, len(modules))]


def find_layer_blocks(backbone: nn.Module) -> tuple[str, nn.ModuleList] | None:
    """Locate the stacked transformer blocks, preferring known layouts."""
    for path in ("layers", "encoder.layer", "transformer.layer", "bert.encoder.layer"):
        node: nn.Module = backbone
        try:
            for part in path.split("."):
                node = getattr(node, part)
        except AttributeError:
            continue
        if isinstance(node, nn.ModuleList) and len(node) >= 2:
            return path, node
    # Generic fallback: deepest ModuleList child holding parameterized blocks.
    best: tuple[str, nn.ModuleList] | None = None
    stack: list[tuple[str, nn.Module]] = [("", backbone)]
    while stack:
        prefix, node = stack.pop()
        for child_name, child in node.named_children():
            child_path = f"{prefix}.{child_name}" if prefix else child_name
            if isinstance(child, nn.ModuleList) and len(child) >= 2:
                if all(any(p.numel() > 0 for p in b.parameters()) for b in child):
                    best = (child_path, child)
            stack.append((child_path, child))
    return best


def load_trained_laya(root: Path, training: dict, output_cfg: dict) -> LayaHeads:
    """Rebuild the exact trained model: remapped backbone + heads + any
    fine-tuned backbone blocks from best.pt. Shared by export and parity."""
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from laya_hub import load_backbone

    backbone = load_backbone(training["model_id"])
    model = LayaHeads(
        backbone,
        backbone.config.hidden_size,
        unfreeze_top_layers=int(training.get("unfreeze_top_layers", 0) or 0),
    )
    checkpoint = torch.load(
        root / output_cfg["dir"] / "best.pt", map_location="cpu", weights_only=True
    )
    model.load_tunable_state(checkpoint["heads"], checkpoint.get("backbone", {}))
    model.eval()
    return model


def pool_dataset(loader: DataLoader, model: LayaHeads) -> tuple[np.ndarray, np.ndarray]:
    model.eval()
    all_logits: list[np.ndarray] = []
    all_labels: list[np.ndarray] = []
    with torch.no_grad():
        for batch in loader:
            logits = model(batch["input_ids"], batch["attention_mask"])
            all_logits.append(torch.stack([logits[h] for h in HEADS], dim=1).cpu().numpy())
            all_labels.append(batch["labels"].cpu().numpy())
    return np.concatenate(all_logits), np.concatenate(all_labels)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = yaml.safe_load((root / "ml" / "training_config.yaml").read_text(encoding="utf-8"))
    training = cfg["training"]
    set_seed(training["seed"])
    threads = training["num_threads"] or (os.cpu_count() or 4)
    torch.set_num_threads(threads)
    assert not torch.cuda.is_available(), "CPU-only invariant violated"
    print(f"threads={threads} cuda_available=False")

    # Laya repo layout: backbone config under `encoder/`, weights
    # (model.safetensors) at repo root, tokenizer.json under `tokenizer/`.
    # Tokenizer loads via the `tokenizers` lib (custom config breaks AutoTokenizer).
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from laya_hub import load_backbone, stage_snapshot
    from tokenizers import Tokenizer

    snapshot = stage_snapshot(training["model_id"])
    tokenizer = Tokenizer.from_file(str(snapshot / "tokenizer" / "tokenizer.json"))
    backbone = load_backbone(training["model_id"])
    hidden = backbone.config.hidden_size
    unfreeze_n = int(training.get("unfreeze_top_layers", 0) or 0)
    backbone_lr = float(training.get("backbone_lr", 0.0) or 0.0)
    if unfreeze_n and backbone_lr <= 0.0:
        raise SystemExit("unfreeze_top_layers>0 requires backbone_lr>0 (differential LRs)")
    model = LayaHeads(backbone, hidden, unfreeze_top_layers=unfreeze_n)

    def make_loader(name: str) -> DataLoader:
        dataset = LayaHeadDataset(root / cfg["data"][name], tokenizer, training["max_length"])
        return DataLoader(dataset, batch_size=training["batch_size"], shuffle=(name == "train"))

    train_loader = make_loader("train")
    val_loader = make_loader("val")
    test_loader = make_loader("test")

    # Per-head positive weights from the training split.
    rows = [json.loads(line) for line in (root / cfg["data"]["train"]).read_text(encoding="utf-8").splitlines() if line.strip()]
    positives = [float(sum(1 for r in rows if r["labels"][h])) for h in HEADS]
    total = float(len(rows))
    pos_weight = torch.tensor([(total - p) / max(p, 1.0) for p in positives])
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    backbone_params = [p for n, p in model.backbone.named_parameters() if p.requires_grad]
    head_params = [p for p in model.heads.parameters() if p.requires_grad]
    param_groups: list[dict] = [{"params": head_params, "lr": training["lr"]}]
    if backbone_params:
        # Differential LRs: gentle on pretrained representations, full speed on heads.
        param_groups.insert(0, {"params": backbone_params, "lr": backbone_lr})
    print(f"tunable backbone params={sum(p.numel() for p in backbone_params)} "
          f"head params={sum(p.numel() for p in head_params)} "
          f"backbone_lr={backbone_lr} heads_lr={training['lr']}")
    optimizer = torch.optim.AdamW(param_groups, weight_decay=training["weight_decay"])

    best_f1 = -1.0
    patience_left = training["early_stop_patience"]
    out_dir = root / cfg["output"]["dir"]
    out_dir.mkdir(parents=True, exist_ok=True)

    model.train()
    for epoch in range(training["epochs"]):
        epoch_loss = 0.0
        for batch in train_loader:
            optimizer.zero_grad()
            logits = model(batch["input_ids"], batch["attention_mask"])
            stacked = torch.stack([logits[h] for h in HEADS], dim=1)
            loss = criterion(stacked, batch["labels"])
            loss.backward()
            optimizer.step()
            epoch_loss += float(loss.item())
        val_logits, val_labels = pool_dataset(val_loader, model)
        val_pred = (val_logits > 0).astype(int)
        macro_f1 = float(f1_score(val_labels, val_pred, average="macro", zero_division=0))
        print(f"epoch={epoch} loss={epoch_loss:.3f} val_macro_f1={macro_f1:.4f}", flush=True)
        if macro_f1 > best_f1:
            best_f1 = macro_f1
            patience_left = training["early_stop_patience"]
            torch.save(
                {"heads": model.head_state(),
                 "backbone": model.tunable_backbone_state(),
                 "unfrozen_blocks": model.unfrozen_blocks,
                 "hidden": hidden},
                out_dir / "best.pt",
            )
        else:
            patience_left -= 1
            if patience_left <= 0:
                print("early stop", flush=True)
                break

    checkpoint = torch.load(out_dir / "best.pt", map_location="cpu", weights_only=True)
    model.load_tunable_state(checkpoint["heads"], checkpoint.get("backbone", {}))
    test_logits, test_labels = pool_dataset(test_loader, model)
    test_pred = (test_logits > 0).astype(int)

    report_lines = ["# Laya M7 eval report", ""]
    primary_ok = True
    for i, h in enumerate(HEADS):
        acc = float(accuracy_score(test_labels[:, i], test_pred[:, i]))
        f1 = float(f1_score(test_labels[:, i], test_pred[:, i], zero_division=0))
        gate = cfg["gates"]["primary_accuracy"] if i < 2 else cfg["gates"]["secondary_accuracy"]
        status = "PASS" if acc >= gate else "FAIL"
        if acc < gate:
            primary_ok = False
        report_lines.append(f"- {h}: acc={acc:.4f} f1={f1:.4f} gate={gate} {status}")
    (root / cfg["output"]["report"]).write_text("\n".join(report_lines) + "\n", encoding="utf-8")
    print("\n".join(report_lines))
    if not primary_ok:
        raise SystemExit("accuracy gates FAILED — retrain with rebalanced sampling or escalate")


if __name__ == "__main__":
    main()
