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

def _get_required_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _get_positive_int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"Environment variable {name} must be an integer.") from exc
    if value <= 0:
        raise RuntimeError(f"Environment variable {name} must be greater than 0.")
    return value


def _get_bool_env(name: str, default: bool) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"Environment variable {name} must be a boolean.")


DATA_DIR = _resolve_path(os.getenv("APP_DATA_DIR"), default=BASE_DIR / "data")
DB_PATH = _resolve_path(os.getenv("DB_PATH"), default=DATA_DIR / "app.db")
UPLOAD_DIR = _resolve_path(os.getenv("UPLOAD_DIR"), default=DATA_DIR / "uploads")

LOGIN_PASSWORD = _get_required_env("APP_LOGIN_PASSWORD")
SESSION_SECRET = _get_required_env("APP_SESSION_SECRET")
SESSION_DURATION_HOURS = _get_positive_int_env("APP_SESSION_HOURS", 2)
SESSION_DURATION_SECONDS = SESSION_DURATION_HOURS * 60 * 60
SESSION_COOKIE_SECURE = _get_bool_env("APP_SESSION_SECURE", False)

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)