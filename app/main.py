from __future__ import annotations

from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi import Body

from pathlib import Path
import re
import shutil
from typing import Any, Dict, Optional, List

import pandas as pd

from app.storage import STORE, SessionData, ensure_upload_dir
from app.storage import get_test_answers, set_test_answer
from app.parsing.maptrack_csv import (
    parse_session,
    parse_session_df,
    list_task_ids,
    ParsedSession,
    get_user_id_column,
    infer_session_id_from_filename,
    validate_maptrack_df,
)
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
    try:
        df0 = pd.read_csv(csv_path, nrows=1)
    except Exception:
        return {}

    row = df0.iloc[0].to_dict() if len(df0) else {}
    out = {}
    for k in SOC_DEMO_KEYS:
        if k in row:
            out[k] = row.get(k)
    return out

def _normalize_user_id(value: Any) -> Optional[str]:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    s = str(value).strip()
    return s if s else None


def _read_soc_demo_rows_by_user(df: pd.DataFrame, user_col: str) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for _, row in df.iterrows():
        user_id = _normalize_user_id(row.get(user_col))
        if not user_id or user_id in out:
            continue
        row_dict = row.to_dict()
        out[user_id] = {k: row_dict.get(k) for k in SOC_DEMO_KEYS if k in row_dict}
    return out


def _sanitize_filename_component(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", value).strip("_")
    return cleaned or "user"

# =========================
# API
# =========================

@app.post("/api/upload")
async def upload_csv(
    file: UploadFile = File(...),
    test_id: str = Form("TEST"),
):
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
        test_id=test_id or "TEST",
        file_path=str(dst),
        user_id=parsed_session.user_id,
        task=primary_task,   # legacy (keep for now)
        stats=stats,
    )
    STORE.upsert(session_meta)

    return {
        "session_id": parsed_session.session_id,
        "user_id": parsed_session.user_id,
        "test_id": test_id or "TEST",
        "task": primary_task,  # legacy
        "tasks": tasks,        # list of tasks for UI
        "stats": stats,        # { session:..., tasks:{...} }
    }

@app.post("/api/upload/bulk")
async def upload_bulk_csv(
    file: UploadFile = File(...),
    test_id: str = Form("TEST"),
):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Nahraj prosím CSV soubor.")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dst = UPLOAD_DIR / file.filename

    try:
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Uložení souboru selhalo: {e}")

    try:
        df = pd.read_csv(dst, low_memory=False)
        df["age"] = pd.to_numeric(df["age"], errors="coerce")
        validate_maptrack_df(df)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Zpracování CSV selhalo: {e}")

    user_col = get_user_id_column(df)
    if not user_col:
        raise HTTPException(status_code=400, detail="CSV neobsahuje povinný sloupec 'userid'.")

    df["_user_id_norm"] = df[user_col].apply(_normalize_user_id)
    df = df[df["_user_id_norm"].notna()]
    if df.empty:
        raise HTTPException(status_code=400, detail="CSV neobsahuje žádné platné hodnoty ve sloupci 'userid'.")

    soc_rows = _read_soc_demo_rows_by_user(df, "_user_id_norm")
    base_session_id = infer_session_id_from_filename(file.filename)

    sessions_out: List[Dict[str, Any]] = []

    try:
        for user_id, df_user in df.groupby("_user_id_norm", sort=False):
            df_user = df_user.drop(columns=["_user_id_norm"])

            user_suffix = _sanitize_filename_component(str(user_id))
            user_filename = f"{dst.stem}__{user_suffix}.csv"
            user_path = UPLOAD_DIR / user_filename
            df_user.to_csv(user_path, index=False)

            session_id = f"{base_session_id}__{user_suffix}"
            parsed_session = parse_session_df(
                df_user,
                user_filename,
                user_id_override=str(user_id),
                session_id_override=session_id,
            )

            tasks: List[str] = list_task_ids(parsed_session)
            primary_task: Optional[str] = tasks[0] if tasks else None

            soc_row = soc_rows.get(str(user_id), {})
            session_metrics = compute_session_metrics(session=parsed_session, raw_row=soc_row)
            task_metrics = compute_all_task_metrics(parsed_session)

            stats: Dict[str, Any] = {
                "session": session_metrics,
                "tasks": task_metrics,
            }

            session_meta = SessionData(
                session_id=parsed_session.session_id,
                test_id=test_id or "TEST",
                file_path=str(user_path),
                user_id=parsed_session.user_id,
                task=primary_task,
                stats=stats,
            )
            STORE.upsert(session_meta)

            sessions_out.append({
                "session_id": parsed_session.session_id,
                "test_id": test_id or "TEST",
                "user_id": parsed_session.user_id,
                "task": primary_task,
                "tasks": tasks,
                "stats": stats,
            })
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Zpracování hromadného CSV selhalo: {e}")

    return {
        "count": len(sessions_out),
        "sessions": sessions_out,
    }


@app.get("/api/sessions")
def list_sessions():
    sessions = STORE.list_sessions()

    out = []
    for s in sessions.values():
        stats = s.stats if isinstance(s.stats, dict) else {}
        session_stats = stats.get("session", {}) if isinstance(stats.get("session"), dict) else {}

        task_metrics = stats.get("tasks", {}) if isinstance(stats.get("tasks"), dict) else {}
        tasks = list(task_metrics.keys())

        out.append({
            "session_id": s.session_id,
            "test_id": getattr(s, "test_id", "TEST") or "TEST",
            "user_id": s.user_id,
            "task": s.task,      # legacy
            "tasks": tasks,      # new
            "stats": stats,
            "session_stats": session_stats,
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
        "test_id": getattr(s, "test_id", "TEST") or "TEST",
        "user_id": s.user_id,
        "task": s.task,      # legacy
        "tasks": tasks,      # new
        "stats": stats,
        "file_path": s.file_path,
    }


@app.get("/api/sessions/{session_id}/tasks/{task_id}/metrics")
def get_task_metrics(session_id: str, task_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session nenalezena.")

    stats = s.stats if isinstance(s.stats, dict) else {}
    task_metrics = stats.get("tasks", {}) if isinstance(stats.get("tasks"), dict) else {}

    m = task_metrics.get(task_id)
    if not isinstance(m, dict):
        raise HTTPException(status_code=404, detail="Task nenalezen v session.")

    return m


# ===== NEW: raw events for timeline =====
@app.get("/api/sessions/{session_id}/events")
def get_session_events(session_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session nenalezena.")

    csv_path = Path(s.file_path)
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="CSV soubor pro session nenalezen.")

    # read only required columns
    usecols = ["timestamp", "event_name", "event_detail", "task"]
    try:
        df = pd.read_csv(csv_path, usecols=lambda c: c in usecols)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Nelze načíst eventy z CSV: {e}")

    # normalize + drop rows without essentials
    if "timestamp" not in df.columns or "event_name" not in df.columns:
        raise HTTPException(status_code=400, detail="CSV neobsahuje required sloupce (timestamp, event_name).")

    # keep order as in file
    out = []
    for _, row in df.iterrows():
        ts = row.get("timestamp")
        name = row.get("event_name")
        if pd.isna(ts) or pd.isna(name):
            continue
        detail = row.get("event_detail") if "event_detail" in df.columns else None
        task = row.get("task") if "task" in df.columns else None

        out.append({
            "timestamp": int(ts),
            "event_name": str(name),
            "event_detail": None if pd.isna(detail) else str(detail),
            "task": None if pd.isna(task) else str(task),
        })

    return {
        "session_id": s.session_id,
        "user_id": s.user_id,
        "events": out,
    }


@app.get("/api/tests/{test_id}/answers")
def api_get_test_answers(test_id: str):
    return {"test_id": test_id, "answers": get_test_answers(test_id)}


@app.put("/api/tests/{test_id}/answers/{task_id}")
def api_put_test_answer(
    test_id: str,
    task_id: str,
    payload: dict = Body(...),
):
    if "answer" not in payload:
        raise HTTPException(status_code=400, detail="Missing 'answer' in body.")

    answer = payload["answer"]
    if answer is None:
        updated = set_test_answer(test_id, task_id, None)
        return {"test_id": test_id, "answers": updated}

    if not isinstance(answer, int):
        raise HTTPException(status_code=400, detail="'answer' must be an integer or null.")

    updated = set_test_answer(test_id, task_id, int(answer))
    return {"test_id": test_id, "answers": updated}