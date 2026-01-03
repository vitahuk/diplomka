from __future__ import annotations

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pathlib import Path
import shutil
from typing import Any, Dict, Optional, List

from app.storage import STORE, SessionData, ensure_upload_dir
from app.parsing.maptrack_csv import parse_session, list_task_ids, ParsedSession


app = FastAPI(title="MapTrack Analytics (MVP)")


# =========================
# Static UI
# =========================

BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = BASE_DIR / "web"
UPLOAD_DIR = BASE_DIR / "data" / "uploads"

app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(WEB_DIR / "index.html"))


# =========================
# Minimal metrics (temporary)
# - until we rewrite app/analysis/metrics.py
# =========================

def _basic_session_stats(session: ParsedSession) -> Dict[str, Any]:
    """
    Základní metriky session z ParsedSession (bez pandas).
    Později to přesuneme do app/analysis/metrics.py.
    """
    events = session.events
    out: Dict[str, Any] = {}

    out["events_total"] = int(len(events))

    if events:
        ts = [e.timestamp_ms for e in events if isinstance(e.timestamp_ms, int)]
        if ts:
            out["time_min_ms"] = int(min(ts))
            out["time_max_ms"] = int(max(ts))
            out["duration_ms"] = int(max(ts) - min(ts))
        else:
            out["time_min_ms"] = None
            out["time_max_ms"] = None
            out["duration_ms"] = None
    else:
        out["time_min_ms"] = None
        out["time_max_ms"] = None
        out["duration_ms"] = None

    # counts of event_name
    counts: Dict[str, int] = {}
    for e in events:
        k = e.event_name or ""
        counts[k] = counts.get(k, 0) + 1
    out["event_counts"] = counts

    out["movestart_count"] = int(counts.get("movestart", 0))
    out["moveend_count"] = int(counts.get("moveend", 0))
    out["movement_pairs_hint"] = int(min(out["movestart_count"], out["moveend_count"]))

    # tasks
    tasks = list_task_ids(session)
    out["tasks"] = tasks
    out["tasks_count"] = int(len(tasks))

    return out


# =========================
# API
# =========================

@app.post("/api/upload")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Nahraj prosím CSV soubor.")

    upload_dir = ensure_upload_dir()
    dst = upload_dir / file.filename

    # save file to disk
    try:
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Uložení souboru selhalo: {e}")

    # parse + metrics
    try:
        parsed_session = parse_session(str(dst), file.filename)

        # tasks přímo z parseru (spolehlivé)
        tasks: List[str] = list_task_ids(parsed_session)
        primary_task: Optional[str] = tasks[0] if tasks else None

        # stats pak spočítej a tasks do nich vlož jen jako kopii
        stats = _basic_session_stats(parsed_session)
        stats["tasks"] = tasks
        stats["tasks_count"] = len(tasks)

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Zpracování CSV selhalo: {e}")

    # store metadata (MVP: in-memory)
    # NOTE: SessionData ve tvém storage.py může ještě nemít "tasks".
    # Proto je ukládáme do stats + do API response. Až upravíme storage.py, přidáme to i do dataclass.
    session_meta = SessionData(
        session_id=parsed_session.session_id,
        file_path=str(dst),
        user_id=parsed_session.user_id,
        task=primary_task,
        stats=stats,
    )
    STORE.upsert(session_meta)

    return {
        "session_id": parsed_session.session_id,
        "user_id": parsed_session.user_id,
        "task": primary_task,       # legacy
        "tasks": tasks,             # new
        "stats": stats,
    }


@app.get("/api/sessions")
def list_sessions():
    sessions = STORE.list_sessions()

    out = []
    for s in sessions.values():
        # ✅ robustně: tasks držíme v s.stats["tasks"], ale hlídáme typ
        tasks: List[str] = []
        if isinstance(s.stats, dict):
            t = s.stats.get("tasks")
            if isinstance(t, list):
                tasks = [str(x) for x in t if str(x).strip()]

        out.append({
            "session_id": s.session_id,
            "user_id": s.user_id,
            "task": s.task,   # legacy (ponecháme zatím)
            "tasks": tasks,   # ✅ new
            "stats": s.stats,
        })

    return {"sessions": out}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session nenalezena.")

    tasks: List[str] = []
    if isinstance(s.stats, dict):
        t = s.stats.get("tasks")
        if isinstance(t, list):
            tasks = [str(x) for x in t if str(x).strip()]

    return {
        "session_id": s.session_id,
        "user_id": s.user_id,
        "task": s.task,   # legacy
        "tasks": tasks,   # ✅ new
        "stats": s.stats,
        "file_path": s.file_path,
    }
