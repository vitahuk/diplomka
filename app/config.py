from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = BASE_DIR / "web"


def _resolve_path(raw_value: str | None, *, default: Path) -> Path:
    value = (raw_value or "").strip()
    if not value:
        return default.resolve()

    path = Path(value).expanduser()
    if not path.is_absolute():
        path = BASE_DIR / path
    return path.resolve()


DATA_DIR = _resolve_path(os.getenv("APP_DATA_DIR"), default=BASE_DIR / "data")
DB_PATH = _resolve_path(os.getenv("DB_PATH"), default=DATA_DIR / "app.db")
UPLOAD_DIR = _resolve_path(os.getenv("UPLOAD_DIR"), default=DATA_DIR / "uploads")

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)