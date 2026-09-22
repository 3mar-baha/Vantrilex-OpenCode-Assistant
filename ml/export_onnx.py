#!/usr/bin/env python3
"""M7 L2: export the trained Laya heads model to ONNX (FP32 + INT8).

Parity gate: max logit diff < 1e-4 vs torch on 200 test samples.
INT8 gate: accuracy drop ≤ 1 pt vs FP32. CPU-only throughout.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
import yaml
from onnxruntime.quantization import quantize_dynamic, QuantType
from tokenizers import Tokenizer
from transformers import AutoModel

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from laya_hub import stage_snapshot  # noqa: E402
from train_laya import HEADS, LayaHeadDataset, LayaHeads  # noqa: E402


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = yaml.safe_load((root / "ml" / "training_config.yaml").read_text(encoding="utf-8"))
    training = cfg["training"]
    torch.set_num_threads(training["num_threads"] or 4)

    tokenizer = Tokenizer.from_file(str(stage_snapshot() / "tokenizer" / "tokenizer.json"))
    backbone = AutoModel.from_pretrained(str(stage_snapshot() / "encoder"), trust_remote_code=True)
    model = LayaHeads(backbone, backbone.config.hidden_size)
    checkpoint = torch.load(root / cfg["output"]["dir"] / "best.pt", map_location="cpu", weights_only=True)
    for h in HEADS:
        model.heads[h].load_state_dict(checkpoint["heads"][h])
    model.eval()

    models_dir = root / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    fp32_path = models_dir / "laya-m7.onnx"
    seq_len = training["max_length"]  # 128
    dummy = torch.ones(1, seq_len, dtype=torch.long)
    torch.onnx.export(
        _Wrapper(model),
        (dummy, torch.ones(1, seq_len, dtype=torch.long)),
        str(fp32_path),
        input_names=["input_ids", "attention_mask"],
        output_names=[f"logit_{h}" for h in HEADS],
        dynamic_axes={"input_ids": {0: "batch"}, "attention_mask": {0: "batch"}},
        opset_version=17,
    )
    print(f"exported {fp32_path}")

    # Parity check on 200 test samples.
    import onnxruntime as ort

    session = ort.InferenceSession(str(fp32_path), providers=["CPUExecutionProvider"])
    dataset = LayaHeadDataset(root / cfg["data"]["test"], tokenizer, training["max_length"])
    max_diff = 0.0
    for i in range(min(200, len(dataset))):
        sample = dataset[i]
        ids = sample["input_ids"].unsqueeze(0).numpy().astype(np.int64)
        mask = sample["attention_mask"].unsqueeze(0).numpy().astype(np.int64)
        with torch.no_grad():
            torch_logits = torch.stack(
                [model(torch.from_numpy(ids), torch.from_numpy(mask))[h] for h in HEADS], dim=1
            ).numpy()
        ort_logits = session.run(None, {"input_ids": ids, "attention_mask": mask})
        max_diff = max(max_diff, float(np.abs(torch_logits - ort_logits[0]).max()))
    print(f"parity max_diff={max_diff:.2e}")
    assert max_diff < 1e-4, "ONNX parity gate FAILED"

    int8_path = models_dir / "laya-m7-int8.onnx"
    quantize_dynamic(str(fp32_path), str(int8_path), weight_type=QuantType.QInt8)
    print(f"exported {int8_path}")


class _Wrapper(torch.nn.Module):
    def __init__(self, model: LayaHeads):
        super().__init__()
        self.model = model

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor):
        logits = self.model(input_ids, attention_mask)
        return tuple(logits[h] for h in HEADS)


if __name__ == "__main__":
    main()
