#!/usr/bin/env python3
"""Shared Laya Hub staging — M7. The laya-multilingual repo keeps the backbone
config under `encoder/`, weights at repo root, and tokenizer under `tokenizer/`.
This helper stages weights beside the config so transformers loads work locally.
CPU-only; no CUDA imports anywhere in this file by design.
"""
from __future__ import annotations

import shutil
from pathlib import Path

MODEL_ID = "convaiinnovations/laya-multilingual"


def stage_snapshot(model_id: str = MODEL_ID) -> Path:
    from huggingface_hub import snapshot_download

    snapshot = Path(
        snapshot_download(
            model_id,
            allow_patterns=["encoder/*", "model.safetensors", "tokenizer/tokenizer.json"],
        )
    )
    staged = snapshot / "encoder" / "model.safetensors"
    if not staged.exists():
        shutil.copyfile(snapshot / "model.safetensors", staged)
    return snapshot


def load_backbone(model_id: str = MODEL_ID):
    """Load the mmBERT backbone with root-checkpoint weights remapped.

    Raises SystemExit on any still-missing backbone key — silent random-init
    training/export is forbidden by this gate.
    """
    from safetensors.torch import load_file
    from transformers import AutoModel

    snapshot = stage_snapshot(model_id)
    backbone = AutoModel.from_pretrained(str(snapshot / "encoder"), trust_remote_code=True)
    full_state = load_file(str(snapshot / "model.safetensors"))
    remapped = {k[len("encoder.") :]: v for k, v in full_state.items() if k.startswith("encoder.")}
    missing, _ = backbone.load_state_dict(remapped, strict=False)
    backbone_keys = {n for n, _ in backbone.named_parameters()}
    still_missing = [n for n in missing if n in backbone_keys]
    print(f"weight remap: {len(remapped)} keys, still missing: {len(still_missing)}")
    if still_missing:
        print(f"missing sample: {still_missing[:5]}")
        raise SystemExit("backbone weight load FAILED — aborting before random-init use")
    return backbone
