from __future__ import annotations

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pathlib import Path
import shutil
from typing import Any, Dict, Optional, List

import pandas as pd

from app.storage import STORE, SessionData, ensure_upload_dir
from app.parsing.maptrack_csv import parse_session, list_task_ids, ParsedSession
from app.analysis.metrics import (
    compute_session_metrics,
    compute_all_task_metrics,
    SOC_DEMO_KEYS,
)


app = FastAPI(title="MapTrack Analytics (MVP)")

# --- Robust absolute paths (prevents slow/buggy relative FS issues) ---
BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = BASE_DIR / "web"

# Static UI
BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = BASE_DIR / "web"
UPLOAD_DIR = BASE_DIR / "data" / "uploads"

app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(WEB_DIR / "index.html"))


# =========================
# Helpers
# =========================

def _read_soc_demo_row(csv_path: Path) -> Dict[str, Any]:
    """
    Read just first row + relevant columns for soc-demo.
    Fast and robust even for big CSVs.
    """
    cols = [c for c in SOC_DEMO_KEYS]  # may not exist in file
    try:
        df0 = pd.read_csv(csv_path, nrows=1)
    except Exception:
        return {}

    row = df0.iloc[0].to_dict() if len(df0) else {}
    # keep only soc-demo keys if present
    out = {}
    for k in SOC_DEMO_KEYS:
        if k in row:
            out[k] = row.get(k)
    return out


# =========================
# API
# =========================

@app.post("/api/upload")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Nahraj prosím CSV soubor.")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dst = UPLOAD_DIR / file.filename

    # save file to disk
    try:
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Uložení souboru selhalo: {e}")

    # parse + metrics
    try:
        parsed_session = parse_session(str(dst), file.filename)

        # tasks list (stable order)
        tasks: List[str] = list_task_ids(parsed_session)
        primary_task: Optional[str] = tasks[0] if tasks else None

        # soc-demo from first row (optional columns)
        soc_row = _read_soc_demo_row(dst)

        # session metrics (+ soc-demo inside)
        session_metrics = compute_session_metrics(session=parsed_session, raw_row=soc_row)

        # task metrics (duration + event_count per task)
        task_metrics = compute_all_task_metrics(parsed_session)

        # store all stats in one structure
        stats: Dict[str, Any] = {
            "session": session_metrics,
            "tasks": task_metrics,
        }

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Zpracování CSV selhalo: {e}")

    # store metadata (MVP: in-memory)
    session_meta = SessionData(
        session_id=parsed_session.session_id,
        file_path=str(dst),
        user_id=parsed_session.user_id,
        task=primary_task,   # legacy (keep for now)
        stats=stats,
    )
    STORE.upsert(session_meta)

    return {
        "session_id": parsed_session.session_id,
        "user_id": parsed_session.user_id,
        "task": primary_task,  # legacy
        "tasks": tasks,        # list of tasks for UI
        "stats": stats,        # { session:..., tasks:{...} }
    }


@app.get("/api/sessions")
def list_sessions():
    sessions = STORE.list_sessions()

    out = []
    for s in sessions.values():
        stats = s.stats if isinstance(s.stats, dict) else {}
        session_stats = stats.get("session", {}) if isinstance(stats.get("session"), dict) else {}

        # tasks list: compute from task_metrics keys (keeps consistent even if tasks list not stored separately)
        task_metrics = stats.get("tasks", {}) if isinstance(stats.get("tasks"), dict) else {}
        tasks = list(task_metrics.keys())

        out.append({
            "session_id": s.session_id,
            "user_id": s.user_id,
            "task": s.task,      # legacy
            "tasks": tasks,      # new
            "stats": stats,      # keep full stats for UI
            "session_stats": session_stats,  # convenience (optional)
        })

    return {"sessions": out}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session nenalezena.")

    stats = s.stats if isinstance(s.stats, dict) else {}
    task_metrics = stats.get("tasks", {}) if isinstance(stats.get("tasks"), dict) else {}
    tasks = list(task_metrics.keys())

    return {
        "session_id": s.session_id,
        "user_id": s.user_id,
        "task": s.task,      # legacy
        "tasks": tasks,      # new
        "stats": stats,
        "file_path": s.file_path,
    }


@app.get("/api/sessions/{session_id}/tasks/{task_id}/metrics")
def get_task_metrics(session_id: str, task_id: str):
    """
    Used by frontend pop-up. Returns:
    - duration_ms for task
    - events_total for task
    """
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session nenalezena.")

    stats = s.stats if isinstance(s.stats, dict) else {}
    task_metrics = stats.get("tasks", {}) if isinstance(stats.get("tasks"), dict) else {}

    m = task_metrics.get(task_id)
    if not isinstance(m, dict):
        raise HTTPException(status_code=404, detail="Task nenalezen v session.")

    return m
