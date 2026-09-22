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
