from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Any, Optional
import threading
import json

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

TEST_ANSWERS_FILE = DATA_DIR / "test_answers.json"
_TEST_ANSWERS_LOCK = threading.Lock()


@dataclass
class SessionData:
    session_id: str
    test_id: str
    file_path: str
    user_id: Optional[str]
    task: Optional[str]
    stats: Dict[str, Any]


class InMemoryStore:
    """
    Pro MVP ukládáme metadata do paměti.
    CSV soubory ukládáme na disk do data/uploads.
    Později lze nahradit DB (SQLite/Postgres) bez změny API kontraktu.
    """
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, SessionData] = {}

    def upsert(self, session: SessionData) -> None:
        with self._lock:
            self._sessions[session.session_id] = session

    def get(self, session_id: str) -> Optional[SessionData]:
        with self._lock:
            return self._sessions.get(session_id)

    def list_sessions(self) -> Dict[str, SessionData]:
        with self._lock:
            return dict(self._sessions)


STORE = InMemoryStore()


def ensure_upload_dir() -> Path:
    p = Path("data/uploads")
    p.mkdir(parents=True, exist_ok=True)
    return p


# =========================
# Test answers persistence
# =========================

def _read_test_answers_file() -> Dict[str, Dict[str, int]]:
    """
    Returns structure: { test_id: { task_id: int } }
    Robust against missing file / invalid JSON.
    """
    if not TEST_ANSWERS_FILE.exists():
        return {}

    try:
        raw = json.loads(TEST_ANSWERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

    if not isinstance(raw, dict):
        return {}

    out: Dict[str, Dict[str, int]] = {}
    for test_id, answers in raw.items():
        if not isinstance(test_id, str):
            continue
        if not isinstance(answers, dict):
            continue
        out[test_id] = {}
        for task_id, val in answers.items():
            if isinstance(task_id, str) and isinstance(val, int):
                out[test_id][task_id] = val
    return out


def _write_test_answers_file(data: Dict[str, Dict[str, int]]) -> None:
    TEST_ANSWERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    TEST_ANSWERS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def get_test_answers(test_id: str) -> Dict[str, int]:
    """
    Get answers for one test: { task_id: int }
    """
    with _TEST_ANSWERS_LOCK:
        all_answers = _read_test_answers_file()
        answers = all_answers.get(test_id, {})
        return dict(answers) if isinstance(answers, dict) else {}


def set_test_answer(test_id: str, task_id: str, answer: Optional[int]) -> Dict[str, int]:
    """
    Set or delete answer for (test_id, task_id).
    If answer is None => delete key.
    Returns updated mapping for given test.
    """
    if not isinstance(test_id, str) or not test_id:
        test_id = "TEST"
    if not isinstance(task_id, str) or not task_id:
        task_id = "unknown"

    with _TEST_ANSWERS_LOCK:
        all_answers = _read_test_answers_file()

        if test_id not in all_answers or not isinstance(all_answers.get(test_id), dict):
            all_answers[test_id] = {}

        if answer is None:
            all_answers[test_id].pop(task_id, None)
        else:
            # ensure int
            all_answers[test_id][task_id] = int(answer)

        _write_test_answers_file(all_answers)
        return dict(all_answers[test_id])
