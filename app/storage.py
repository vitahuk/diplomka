from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Any, Optional
import threading


@dataclass
class SessionData:
    session_id: str
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
