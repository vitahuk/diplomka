from __future__ import annotations

from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi import Body

from pathlib import Path
import re
import unicodedata
from collections import Counter
from io import StringIO
import shutil
from typing import Any, Dict, Optional, List
from uuid import uuid4
from difflib import SequenceMatcher

import csv
import pandas as pd

from app.storage import STORE, SessionData, ensure_upload_dir
from app.storage import get_test_answers, set_test_answer, list_test_tasks, set_test_answers_bulk
from app.storage import list_groups, upsert_group, delete_sessions, delete_all_sessions_for_test
from app.storage import get_test_settings, update_test_settings, delete_test, update_group_settings, delete_group
from app.storage import list_tests, create_test
from app.parsing.maptrack_csv import (
    parse_session,
    parse_session_df,
    list_task_ids,
    ParsedSession,
    get_user_id_column,
    infer_session_id_from_filename,
    validate_maptrack_df,
    build_spatial_trace_for_user,
)
from app.parsing.column_aliases import SOC_DEMO_COLUMN_ALIASES, resolve_column_aliases, resolve_single_column
from app.analysis.metrics import (
    compute_session_metrics,
    compute_all_task_metrics,
    SOC_DEMO_KEYS,
)
from app.normalization.nationality import normalize_nationality

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

    if df0.empty:
        return {}

    row = df0.iloc[0].to_dict()
    resolved = resolve_column_aliases(df0.columns, SOC_DEMO_COLUMN_ALIASES)
    out: Dict[str, Any] = {}
    for k in SOC_DEMO_KEYS:
        source_col = resolved.get(k)
        if source_col:
            out[k] = row.get(source_col)
    return out

def _normalize_user_id(value: Any) -> Optional[str]:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    s = str(value).strip()
    return s if s else None


def _read_soc_demo_rows_by_user(df: pd.DataFrame, user_col: str) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    resolved = resolve_column_aliases(df.columns, SOC_DEMO_COLUMN_ALIASES)

    for _, row in df.iterrows():
        user_id = _normalize_user_id(row.get(user_col))
        if not user_id or user_id in out:
            continue

        row_dict = row.to_dict()
        soc: Dict[str, Any] = {}
        for k in SOC_DEMO_KEYS:
            source_col = resolved.get(k)
            if source_col:
                soc[k] = row_dict.get(source_col)
        out[user_id] = soc
    return out


def _sanitize_filename_component(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", value).strip("_")
    return cleaned or "user"

def _read_session_events_df(csv_path: Path) -> pd.DataFrame:
    usecols = ["timestamp", "event_name", "event_detail", "task"]
    try:
        df = pd.read_csv(csv_path, usecols=lambda c: c in usecols)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Unable to load events from CSV: {e}")

    if "timestamp" not in df.columns or "event_name" not in df.columns:
        raise HTTPException(status_code=400, detail="CSV does not contain required columns.")

    df = df[df["timestamp"].notna() & df["event_name"].notna()].copy()
    if df.empty:
        return df

    df["timestamp"] = pd.to_numeric(df["timestamp"], errors="coerce")
    df = df[df["timestamp"].notna()].copy()
    if df.empty:
        return df

    df["timestamp"] = df["timestamp"].astype(int)
    return df.sort_values(by=["timestamp"], kind="stable")

def _to_text_detail(value: Any) -> Optional[str]:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    if not text:
        return None
    if re.match(r"^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$", text):
        return None
    return text


def _build_timeline_items_from_events_df(df: pd.DataFrame) -> List[Dict[str, Any]]:
    events = []
    for _, row in df.iterrows():
        task = row.get("task") if "task" in df.columns else None
        events.append({
            "timestamp": int(row["timestamp"]),
            "event_name": str(row["event_name"]),
            "event_detail": row.get("event_detail") if "event_detail" in df.columns else None,
            "task": None if pd.isna(task) else str(task),
        })

    items: List[Dict[str, Any]] = []
    open_move: Optional[Dict[str, Any]] = None
    open_popup: Optional[Dict[str, Any]] = None

    for event in events:
        ts = int(event["timestamp"])
        name = str(event["event_name"])
        detail = _to_text_detail(event.get("event_detail"))
        task = event.get("task")

        if name == "movestart":
            if open_move:
                items.append({
                    "type": "interval",
                    "name": "ZOOM" if open_move.get("hadZoom") else "MOVE",
                    "startTs": int(open_move["startTs"]),
                    "endTs": ts,
                    "task": open_move.get("task") or task,
                })
            open_move = {"startTs": ts, "hadZoom": False, "task": task, "details": []}
            continue

        if name in {"zoom in", "zoom out"}:
            if open_move:
                open_move["hadZoom"] = True
                if not open_move.get("task") and task:
                    open_move["task"] = task
                if detail:
                    open_move["details"].append(f"{name}: {detail}")
            else:
                items.append({"type": "instant", "name": name, "ts": ts, "task": task})
            continue

        if name == "moveend":
            if open_move:
                items.append({
                    "type": "interval",
                    "name": "ZOOM" if open_move.get("hadZoom") else "MOVE",
                    "startTs": int(open_move["startTs"]),
                    "endTs": ts,
                    "task": open_move.get("task") or task,
                })
                open_move = None
            else:
                items.append({"type": "instant", "name": name, "ts": ts, "task": task})
            continue

        if name == "popupopen":
            if open_popup:
                items.append({
                    "type": "interval",
                    "name": "POPUP",
                    "startTs": int(open_popup["startTs"]),
                    "endTs": ts,
                    "task": open_popup.get("task") or task,
                })
            open_popup = {"startTs": ts, "task": task, "details": []}
            if detail:
                open_popup["details"].append(f"popupopen: {detail}")
            continue

        if name == "popupclose":
            if open_popup:
                items.append({
                    "type": "interval",
                    "name": "POPUP",
                    "startTs": int(open_popup["startTs"]),
                    "endTs": ts,
                    "task": open_popup.get("task") or task,
                })
                open_popup = None
            else:
                items.append({"type": "instant", "name": name, "ts": ts, "task": task})
            continue

        if open_popup and not open_popup.get("task") and task:
            open_popup["task"] = task

        items.append({"type": "instant", "name": name, "ts": ts, "task": task})

    last_ts = int(events[-1]["timestamp"]) if events else 0

    if open_move:
        items.append({
            "type": "interval",
            "name": "ZOOM" if open_move.get("hadZoom") else "MOVE",
            "startTs": int(open_move["startTs"]),
            "endTs": last_ts,
            "task": open_move.get("task"),
        })

    if open_popup:
        items.append({
            "type": "interval",
            "name": "POPUP",
            "startTs": int(open_popup["startTs"]),
            "endTs": last_ts,
            "task": open_popup.get("task"),
        })

    if events and int(events[0]["timestamp"]) > 0:
        items.insert(0, {
            "type": "interval",
            "name": "INTRO",
            "startTs": 0,
            "endTs": int(events[0]["timestamp"]),
            "task": events[0].get("task"),
        })

    return items

def _read_csv_flexible(path: Path) -> pd.DataFrame:
    """
    Tries common delimiters (comma/tab/auto) to support slightly different CSV exports.
    """
    attempts = [
        {"kwargs": {"low_memory": False}},
        {"kwargs": {"sep": "	", "low_memory": False}},
        {"kwargs": {"sep": None, "engine": "python", "low_memory": False}},
    ]

    for attempt in attempts:
        try:
            df = pd.read_csv(path, **attempt["kwargs"])
        except Exception:
            continue
        if {"timestamp", "event_name"}.issubset(set(df.columns)):
            return df

    # last resort: return default read result (will fail later with clearer message if invalid)
    return pd.read_csv(path, low_memory=False)

def _normalize_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _extract_answers_by_task_from_df(df: pd.DataFrame) -> Dict[str, str]:
    if df.empty or "event_name" not in df.columns:
        return {}
    
    answer_event_names = {"answer selected", "polygon selected"}

    if "task" not in df.columns:
        return {}

    finalized: Dict[str, str] = {}
    for row in df.to_dict("records"):
        event_name_raw = row.get("event_name")
        if event_name_raw is None or (isinstance(event_name_raw, float) and pd.isna(event_name_raw)):
            continue

        event_name = str(event_name_raw).strip().lower()
        if event_name not in answer_event_names:
            continue

        task_raw = row.get("task")
        if task_raw is None or (isinstance(task_raw, float) and pd.isna(task_raw)):
            continue

        task_id = str(task_raw).strip()
        if not task_id:
            continue

        event_detail_raw = row.get("event_detail") if "event_detail" in df.columns else None
        answer_text = "" if event_detail_raw is None or (isinstance(event_detail_raw, float) and pd.isna(event_detail_raw)) else str(event_detail_raw).strip()
        if not answer_text:
            continue

        # Keep latest explicit answer event per task.
        finalized[task_id] = answer_text

    return finalized


def _similarity_score(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio() * 100.0


def _evaluate_answer(correct_answer: str, user_answer: str, threshold: float = 85.0) -> tuple[bool, float]:
    if not correct_answer or not user_answer:
        return False, 0.0

    norm_correct = _normalize_text(correct_answer)
    norm_user = _normalize_text(user_answer)
    score = _similarity_score(norm_correct, norm_user)
    return score >= threshold, score


def _build_answers_eval_for_session(
    answers_by_task: Dict[str, str],
    answer_key: Dict[str, str],
) -> Dict[str, Any]:
    task_records: Dict[str, Dict[str, Any]] = {}
    answered_count = 0
    correct_count = 0

    for task_id, user_answer in answers_by_task.items():
        task = str(task_id or "").strip()
        if not task:
            continue
        answer_text = str(user_answer or "").strip()
        if not answer_text:
            continue

        answered_count += 1
        correct_answer = answer_key.get(task)
        is_correct = False
        similarity = None
        if isinstance(correct_answer, str) and correct_answer.strip():
            is_correct, score = _evaluate_answer(correct_answer, answer_text)
            similarity = score
            if is_correct:
                correct_count += 1

        task_records[task] = {
            "task_id": task,
            "answer": answer_text,
            "correct_answer": correct_answer,
            "is_correct": is_correct,
            "similarity_score": similarity,
        }

    expected_count = len([
        t for t, val in answer_key.items()
        if str(t).strip() and isinstance(val, str) and val.strip()
    ])
    accuracy = (correct_count / answered_count) if answered_count else None
    coverage = (answered_count / expected_count) if expected_count else None

    return {
        "by_task": task_records,
        "summary": {
            "answered_count": answered_count,
            "correct_count": correct_count,
            "expected_count": expected_count,
            "accuracy": accuracy,
            "coverage": coverage,
        },
    }


def _ensure_session_answers_eval(session_data: SessionData) -> Dict[str, Any]:
    stats = session_data.stats if isinstance(session_data.stats, dict) else {}
    answers_by_task = stats.get("answers_by_task") if isinstance(stats.get("answers_by_task"), dict) else {}
    answer_key = get_test_answers(getattr(session_data, "test_id", "TEST") or "TEST")
    eval_payload = _build_answers_eval_for_session(answers_by_task, answer_key)
    stats = {**stats, "answers_by_task": answers_by_task, "answers_eval": eval_payload}
    session_data.stats = stats
    return eval_payload

def _refresh_session_answers_eval(session_data: SessionData, persist: bool = False) -> Dict[str, Any]:
    prev_stats = session_data.stats if isinstance(session_data.stats, dict) else {}
    prev_eval = prev_stats.get("answers_eval") if isinstance(prev_stats.get("answers_eval"), dict) else None
    prev_answers = prev_stats.get("answers_by_task") if isinstance(prev_stats.get("answers_by_task"), dict) else {}

    payload = _ensure_session_answers_eval(session_data)
    new_stats = session_data.stats if isinstance(session_data.stats, dict) else {}
    new_answers = new_stats.get("answers_by_task") if isinstance(new_stats.get("answers_by_task"), dict) else {}

    nationality_changed = _normalize_session_nationality(session_data, persist=False)
    changed = prev_eval != payload or prev_answers != new_answers or nationality_changed
    if persist and changed:
        STORE.upsert(session_data)

    return payload

def _normalize_session_nationality(session_data: SessionData, persist: bool = False) -> bool:
    stats = session_data.stats if isinstance(session_data.stats, dict) else {}
    session_stats = stats.get("session") if isinstance(stats.get("session"), dict) else {}
    soc_demo = session_stats.get("soc_demo") if isinstance(session_stats.get("soc_demo"), dict) else {}

    if not soc_demo:
        return False

    original = soc_demo.get("nationality")
    normalized = normalize_nationality(original)
    if normalized == original:
        return False

    updated_soc_demo = {**soc_demo, "nationality": normalized}
    updated_session_stats = {**session_stats, "soc_demo": updated_soc_demo}
    session_data.stats = {**stats, "session": updated_session_stats}

    if persist:
        STORE.upsert(session_data)

    return True

def _recompute_answers_eval_for_test(test_id: str) -> Dict[str, int]:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    sessions = STORE.list_sessions()
    matched = 0
    updated = 0

    for session in sessions.values():
        if (getattr(session, "test_id", "TEST") or "TEST") != normalized_test_id:
            continue
        matched += 1
        prev_stats = session.stats if isinstance(session.stats, dict) else {}
        prev_eval = prev_stats.get("answers_eval") if isinstance(prev_stats.get("answers_eval"), dict) else None
        prev_answers = prev_stats.get("answers_by_task") if isinstance(prev_stats.get("answers_by_task"), dict) else {}

        payload = _refresh_session_answers_eval(session, persist=True)
        new_stats = session.stats if isinstance(session.stats, dict) else {}
        new_answers = new_stats.get("answers_by_task") if isinstance(new_stats.get("answers_by_task"), dict) else {}
        if prev_eval != payload or prev_answers != new_answers:
            updated += 1

    return {"matched": matched, "updated": updated}

def _build_group_answers_payload(group: Dict[str, Any]) -> Dict[str, Any]:
    sessions = group.get("sessions", []) if isinstance(group.get("sessions"), list) else []
    test_id = str(group.get("test_id") or "TEST")
    answer_key = get_test_answers(test_id)

    by_task: Dict[str, Dict[str, Any]] = {}
    for session in sessions:
        user_id = str(session.get("user_id") or "").strip()
        stats = session.get("stats") if isinstance(session.get("stats"), dict) else {}
        answers_map = stats.get("answers_by_task") if isinstance(stats.get("answers_by_task"), dict) else {}

        for task_id, answer_text in answers_map.items():
            task = str(task_id).strip()
            answer = str(answer_text).strip()
            if not task or not answer:
                continue

            correct = answer_key.get(task)
            record = by_task.setdefault(task, {
                "task_id": task,
                "answers": [],
                "correct_answer": correct,
                "correct_count": 0,
                "total_count": 0,
            })
            is_correct, similarity = _evaluate_answer(correct or "", answer) if isinstance(correct, str) else (False, 0.0)
            record["answers"].append({
                "user_id": user_id or None,
                "answer": answer,
                "is_correct": is_correct,
                "similarity_score": similarity,
            })
            record["total_count"] += 1
            if is_correct:
                record["correct_count"] += 1

    for record in by_task.values():
        total = record.get("total_count") or 0
        correct_count = record.get("correct_count") or 0
        record["accuracy"] = (correct_count / total) if total else None
    
    answered_total = sum(record.get("total_count", 0) for record in by_task.values())
    correct_total = sum(record.get("correct_count", 0) for record in by_task.values())
    expected_count = len([
        t for t, val in answer_key.items()
        if str(t).strip() and isinstance(val, str) and val.strip()
    ])

    by_user: Dict[str, Dict[str, Any]] = {}
    for session in sessions:
        sid = str(session.get("session_id") or "").strip()
        uid = str(session.get("user_id") or "").strip()
        stats = session.get("stats") if isinstance(session.get("stats"), dict) else {}
        eval_payload = stats.get("answers_eval") if isinstance(stats.get("answers_eval"), dict) else {}
        summary = eval_payload.get("summary") if isinstance(eval_payload.get("summary"), dict) else {}

        by_user[sid or uid or f"session_{len(by_user)+1}"] = {
            "session_id": sid or None,
            "user_id": uid or None,
            "answered_count": summary.get("answered_count", 0),
            "correct_count": summary.get("correct_count", 0),
            "accuracy": summary.get("accuracy"),
            "coverage": summary.get("coverage"),
        }

    return {
        "group_id": group.get("id"),
        "test_id": test_id,
        "tasks": by_task,
        "summary": {
            "answered_count": answered_total,
            "correct_count": correct_total,
            "expected_count": expected_count,
            "accuracy": (correct_total / answered_total) if answered_total else None,
        },
        "users": by_user,
    }

def _build_wordcloud_from_group_payload(payload: Dict[str, Any], task_id: Optional[str] = None) -> List[Dict[str, Any]]:
    tasks = payload.get("tasks", {}) if isinstance(payload.get("tasks"), dict) else {}
    counter: Counter[str] = Counter()

    for t_id, record in tasks.items():
        if task_id and t_id != task_id:
            continue
        answers = record.get("answers", []) if isinstance(record.get("answers"), list) else []
        for item in answers:
            answer = str(item.get("answer") or "").strip()
            if answer:
                counter[answer] += 1

    return [{"text": text, "count": count} for text, count in counter.most_common(80)]


# =========================
# API
# =========================

@app.post("/api/upload")
async def upload_csv(
    file: UploadFile = File(...),
    test_id: str = Form("TEST"),
):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a CSV file.")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dst = UPLOAD_DIR / file.filename

    # save file to disk
    try:
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {e}")

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
        source_df = _read_csv_flexible(dst)
        answers_by_task = _extract_answers_by_task_from_df(source_df)
        answers_eval = _build_answers_eval_for_session(answers_by_task, get_test_answers(test_id or "TEST"))

        stats: Dict[str, Any] = {
            "session": session_metrics,
            "tasks": task_metrics,
            "answers_by_task": answers_by_task,
            "answers_eval": answers_eval,
        }

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"CSV processing failed: {e}")

    # store metadata (MVP: in-memory)
    session_meta = SessionData(
        session_id=parsed_session.session_id,
        test_id=test_id or "TEST",
        file_path=str(dst),
        user_id=parsed_session.user_id,
        task=primary_task,
        stats=stats,
    )
    STORE.upsert(session_meta)

    return {
        "session_id": parsed_session.session_id,
        "user_id": parsed_session.user_id,
        "test_id": test_id or "TEST",
        "task": primary_task,
        "tasks": tasks,
        "stats": stats,
    }

@app.post("/api/upload/bulk")
async def upload_bulk_csv(
    file: UploadFile = File(...),
    test_id: str = Form("TEST"),
):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a CSV file")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dst = UPLOAD_DIR / file.filename

    try:
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {e}")

    try:
        df = pd.read_csv(dst, low_memory=False)
        age_col = resolve_single_column(df.columns, "age", SOC_DEMO_COLUMN_ALIASES["age"])
        if age_col:
            df[age_col] = pd.to_numeric(df[age_col], errors="coerce")
        validate_maptrack_df(df)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"CSV processing failed: {e}")

    user_col = get_user_id_column(df)
    if not user_col:
        raise HTTPException(status_code=400, detail="CSV does not contain the required column 'userid'.")

    df["_user_id_norm"] = df[user_col].apply(_normalize_user_id)
    df = df[df["_user_id_norm"].notna()]
    if df.empty:
        raise HTTPException(status_code=400, detail="CSV does not contain any valid values in the 'userid' column.")

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
            answers_by_task = _extract_answers_by_task_from_df(df_user)
            answers_eval = _build_answers_eval_for_session(answers_by_task, get_test_answers(test_id or "TEST"))

            stats: Dict[str, Any] = {
                "session": session_metrics,
                "tasks": task_metrics,
                "answers": answers_by_task,
                "answers_by_task": answers_by_task,
                "answers_eval": answers_eval,
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
        raise HTTPException(status_code=400, detail=f"Bulk CSV processing failed: {e}")

    return {
        "count": len(sessions_out),
        "sessions": sessions_out,
    }


@app.get("/api/sessions")
def list_sessions():
    sessions = STORE.list_sessions()

    out = []
    for s in sessions.values():
        _refresh_session_answers_eval(s, persist=True)
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
        raise HTTPException(status_code=404, detail="Session not found.")

    _refresh_session_answers_eval(s, persist=True)
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
        raise HTTPException(status_code=404, detail="Session not found.")

    stats = s.stats if isinstance(s.stats, dict) else {}
    task_metrics = stats.get("tasks", {}) if isinstance(stats.get("tasks"), dict) else {}

    m = task_metrics.get(task_id)
    if not isinstance(m, dict):
        raise HTTPException(status_code=404, detail="Task not found in session.")

    answers_eval = _refresh_session_answers_eval(s, persist=True)
    task_eval_map = answers_eval.get("by_task") if isinstance(answers_eval.get("by_task"), dict) else {}
    task_eval = task_eval_map.get(task_id) if isinstance(task_eval_map.get(task_id), dict) else {}

    return {
        **m,
        "answer": task_eval.get("answer"),
        "correct_answer": task_eval.get("correct_answer"),
        "is_correct": task_eval.get("is_correct"),
        "similarity_score": task_eval.get("similarity_score"),
    }

@app.get("/api/sessions/{session_id}/answers-eval")
def get_session_answers_eval(session_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")

    payload = _refresh_session_answers_eval(s, persist=True)
    return {
        "session_id": s.session_id,
        "user_id": s.user_id,
        "test_id": getattr(s, "test_id", "TEST") or "TEST",
        **payload,
    }



# ===== NEW: raw events for timeline =====
@app.get("/api/sessions/{session_id}/events")
def get_session_events(session_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")

    csv_path = Path(s.file_path)
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="CSV file for session not found.")

    df = _read_session_events_df(csv_path)

    out = []
    for _, row in df.iterrows():
        detail = row.get("event_detail") if "event_detail" in df.columns else None
        task = row.get("task") if "task" in df.columns else None

        out.append({
            "timestamp": int(row["timestamp"]),
            "event_name": str(row["event_name"]),
            "event_detail": None if pd.isna(detail) else str(detail),
            "task": None if pd.isna(task) else str(task),
        })

    return {
        "session_id": s.session_id,
        "user_id": s.user_id,
        "events": out,
    }


@app.get("/api/sessions/{session_id}/events/export")
def export_session_events_gazeplotter_csv(session_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")

    csv_path = Path(s.file_path)
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="CSV file for session not found.")

    df = _read_session_events_df(csv_path)

    participant = str(s.user_id or "")
    if not participant and not df.empty:
        participant = "unknown"

    timeline_items = _build_timeline_items_from_events_df(df)

    segments: List[Dict[str, Any]] = []
    for item in timeline_items:
        if item.get("type") == "interval":
            from_ts = int(item.get("startTs", 0))
            to_ts = int(item.get("endTs", from_ts))
        else:
            point_ts = int(item.get("ts", 0))
            from_ts = point_ts
            to_ts = point_ts

        if to_ts < from_ts:
            continue

        stimulus_raw = item.get("task")
        stimulus = "" if stimulus_raw is None else str(stimulus_raw)

        segments.append({
            "From": from_ts,
            "To": to_ts,
            "Participant": participant,
            "Stimulus": stimulus,
            "AOI": str(item.get("name", "")),
        })

    export_df = pd.DataFrame(segments, columns=["From", "To", "Participant", "Stimulus", "AOI"])
    csv_data = export_df.to_csv(index=False, sep=',')

    filename = f"gazeplotter_segments_{_sanitize_filename_component(s.session_id)}.csv"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(content=csv_data, media_type="text/csv; charset=utf-8", headers=headers)


@app.get("/api/sessions/{session_id}/spatial-trace")
def get_session_spatial_trace(session_id: str, task_id: Optional[str] = None):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")

    csv_path = Path(s.file_path)
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="CSV file for session not found.")

    usecols = [
        "timestamp",
        "event_name",
        "event_detail",
        "task",
        "userId",
        "userid",
        "user_id",
        "viewportSize",
        "orientation",
    ]
    try:
        df = pd.read_csv(csv_path, usecols=lambda c: c in usecols)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Cannot load spatial data from CSV: {e}")

    user_id = s.user_id
    user_col = get_user_id_column(df)
    if not user_id and user_col and not df.empty:
        first_uid = df.iloc[0].get(user_col)
        if first_uid is not None and not (isinstance(first_uid, float) and pd.isna(first_uid)):
            user_id = str(first_uid).strip()

    try:
        trace = build_spatial_trace_for_user(df, user_id=user_id, task_id=task_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "session_id": s.session_id,
        "user_id": s.user_id,
        "spatial": trace,
    }


@app.delete("/api/tests/{test_id}/sessions")
def api_delete_test_sessions(test_id: str, payload: dict = Body(...)):
    session_ids = payload.get("session_ids", [])
    if not isinstance(session_ids, list) or not session_ids:
        raise HTTPException(status_code=400, detail="session_ids must be non-empty list")

    normalized_ids = [str(sid).strip() for sid in session_ids if isinstance(sid, str) and str(sid).strip()]
    if not normalized_ids:
        raise HTTPException(status_code=400, detail="session_ids must contain valid values")

    deleted_count = delete_sessions(test_id=test_id, session_ids=normalized_ids)
    return {
        "test_id": test_id,
        "requested_count": len(normalized_ids),
        "deleted_count": deleted_count,
    }


@app.delete("/api/tests/{test_id}/sessions/all")
def api_delete_all_test_sessions(test_id: str):
    deleted_count = delete_all_sessions_for_test(test_id=test_id)
    return {
        "test_id": test_id,
        "deleted_count": deleted_count,
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
    else:
        if not isinstance(answer, str):
            raise HTTPException(status_code=400, detail="'answer' must be a string or null.")
        updated = set_test_answer(test_id, task_id, answer)

    recalc = _recompute_answers_eval_for_test(test_id)

    return {
        "test_id": test_id,
        "answers": updated,
        "recalculation": recalc,
    }


@app.get("/api/tests/{test_id}/answers/export-csv")
def api_export_test_answers_csv(test_id: str):
    task_ids = list_test_tasks(test_id)
    answers = get_test_answers(test_id)

    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(["task_id", "answer"])
    for task_id in task_ids:
        writer.writerow([task_id, answers.get(task_id, "")])

    filename = f"test_{test_id}_answers.csv"
    csv_payload = output.getvalue().encode("utf-8")
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Type": "text/csv; charset=utf-8",
    }
    return Response(content=csv_payload, media_type="text/csv", headers=headers)


@app.get("/api/tests/{test_id}/answers/template-csv")
def api_export_test_answers_template_csv(test_id: str):
    task_ids = list_test_tasks(test_id)

    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(["task_id", "answer"])
    for task_id in task_ids:
        writer.writerow([task_id, ""])

    filename = f"test_{test_id}_answers_template.csv"
    csv_payload = output.getvalue().encode("utf-8")
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Type": "text/csv; charset=utf-8",
    }
    return Response(content=csv_payload, media_type="text/csv", headers=headers)


@app.post("/api/tests/{test_id}/answers/upload-csv")
async def api_upload_test_answers_csv(test_id: str, file: UploadFile = File(...)):
    filename = (file.filename or "").lower()
    if filename and not filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are allowed.")

    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1250")

    try:
        reader = csv.DictReader(StringIO(text))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Cannot load CSV: {e}")

    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV is empty or has no header.")

    normalized = {str(name).strip().lower(): name for name in reader.fieldnames if name is not None}
    task_col = normalized.get("task_id")
    answer_col = normalized.get("answer")
    if not task_col or not answer_col:
        raise HTTPException(status_code=400, detail="CSV must contain columns 'task_id' and 'answer'.")

    updates = {}
    total_rows = 0
    for row in reader:
        total_rows += 1
        task_id = str(row.get(task_col, "") or "").strip()
        if not task_id:
            continue

        answer_raw = row.get(answer_col)
        answer_text = str(answer_raw).strip() if answer_raw is not None else ""
        updates[task_id] = answer_text if answer_text else None

    updated_answers = set_test_answers_bulk(test_id, updates)
    recalc = _recompute_answers_eval_for_test(test_id)
    return {
        "test_id": test_id,
        "rows_total": total_rows,
        "rows_valid": len(updates),
        "answers": updated_answers,
        "recalculation": recalc,
    }


@app.get("/api/tests/{test_id}/settings")
def api_get_test_settings(test_id: str):
    settings = get_test_settings(test_id)
    return {
        "test_id": test_id,
        "name": settings.get("name"),
        "note": settings.get("note"),
    }


@app.get("/api/tests")
def api_list_tests():
    return {"tests": list_tests()}


@app.post("/api/tests")
def api_create_test(payload: dict = Body(...)):
    test_id = str(payload.get("test_id", "")).strip()
    if not test_id:
        raise HTTPException(status_code=400, detail="test_id is required")

    name = payload.get("name")
    note = payload.get("note")
    try:
        created = create_test(test_id=test_id, name=name, note=note)
    except ValueError as e:
        msg = str(e)
        status = 409 if msg == "Test already exists" else 400
        raise HTTPException(status_code=status, detail=msg)

    return {"test": created}


@app.put("/api/tests/{test_id}/settings")
def api_update_test_settings(test_id: str, payload: dict = Body(...)):
    name = payload.get("name")
    note = payload.get("note")

    try:
        updated = update_test_settings(test_id=test_id, name=name, note=note)
    except ValueError as e:
        msg = str(e)
        status = 409 if msg == "Test already exists" else 400
        raise HTTPException(status_code=status, detail=msg)

    return {
        "test_id": updated.get("id") or test_id,
        "name": updated.get("name"),
        "note": updated.get("note"),
    }


@app.delete("/api/tests/{test_id}")
def api_delete_test(test_id: str):
    deleted = delete_test(test_id=test_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="User experiment not found.")
    return {
        "test_id": test_id,
        "deleted": True,
    }


@app.get("/api/groups")
def api_list_groups(test_id: Optional[str] = None):
    groups = list_groups(test_id=test_id)

    out = []
    for g in groups:
        session_ids = g.get("session_ids", []) if isinstance(g.get("session_ids"), list) else []
        sessions_out = []

        for sid in session_ids:
            session = STORE.get(sid)
            if not session:
                continue
            _refresh_session_answers_eval(session, persist=True)
            stats = session.stats if isinstance(session.stats, dict) else {}
            sessions_out.append({
                "session_id": session.session_id,
                "user_id": session.user_id,
                "test_id": getattr(session, "test_id", "TEST") or "TEST",
                "task": session.task,
                "tasks": list((stats or {}).get("tasks", {}).keys()),
                "stats": stats,
            })

        out.append({
            "id": g.get("id"),
            "test_id": g.get("test_id"),
            "name": g.get("name"),
            "note": g.get("note"),
            "session_ids": session_ids,
            "sessions": sessions_out,
        })

    return {"groups": out}


@app.get("/api/groups/{group_id}/export-csv")
def api_export_group_csv(group_id: str):
    group = next((g for g in list_groups() if g.get("id") == group_id), None)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found.")

    session_ids = group.get("session_ids", []) if isinstance(group.get("session_ids"), list) else []
    if not session_ids:
        raise HTTPException(status_code=400, detail="Group contains no sessions.")

    csv_frames: List[pd.DataFrame] = []
    user_id_values: List[str] = []
    all_columns: List[str] = []

    for sid in session_ids:
        session = STORE.get(sid)
        if not session:
            continue

        csv_path = Path(session.file_path)
        if not csv_path.exists():
            continue

        try:
            df = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Cannot load CSV for session '{sid}': {e}")

        if df.empty:
            continue

        user_col = get_user_id_column(df)
        user_id = _normalize_user_id(session.user_id)
        if not user_id and user_col and not df.empty:
            user_id = _normalize_user_id(df.iloc[0].get(user_col))

        if user_col and user_id:
            filtered = df[df[user_col].astype(str).str.strip() == user_id]
        elif user_col:
            filtered = df
        else:
            filtered = df

        if filtered.empty:
            continue

        csv_frames.append(filtered)
        if user_id:
            user_id_values.append(user_id)
        for col in filtered.columns:
            if col not in all_columns:
                all_columns.append(col)

    if not csv_frames:
        raise HTTPException(status_code=404, detail="No CSV data found for this group.")

    export_df = pd.concat(csv_frames, ignore_index=True, sort=False)
    if all_columns:
        export_df = export_df.reindex(columns=all_columns)

    output = StringIO()
    export_df.to_csv(output, index=False)

    group_name = str(group.get("name") or group_id)
    filename = f"group_export_{_sanitize_filename_component(group_name)}.csv"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(content=output.getvalue(), media_type="text/csv; charset=utf-8", headers=headers)


@app.get("/api/groups/{group_id}/answers")
def api_group_answers(group_id: str):
    group = next((g for g in list_groups() if g.get("id") == group_id), None)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found.")

    session_ids = group.get("session_ids", []) if isinstance(group.get("session_ids"), list) else []
    sessions_out = []
    for sid in session_ids:
        session = STORE.get(sid)
        if not session:
            continue

        stats = session.stats if isinstance(session.stats, dict) else {}
        answers_by_task = stats.get("answers_by_task") if isinstance(stats.get("answers_by_task"), dict) else {}

        if not answers_by_task:
            # Backfill for sessions uploaded before answers extraction existed.
            csv_path = Path(session.file_path)
            if csv_path.exists():
                try:
                    df_session = _read_csv_flexible(csv_path)
                    answers_by_task = _extract_answers_by_task_from_df(df_session)
                except Exception:
                    answers_by_task = {}
            stats = {**stats, "answers_by_task": answers_by_task}
            session.stats = stats
        
        _refresh_session_answers_eval(session, persist=True)
        stats = session.stats if isinstance(session.stats, dict) else {}


        sessions_out.append({
            "session_id": session.session_id,
            "user_id": session.user_id,
            "test_id": getattr(session, "test_id", "TEST") or "TEST",
            "task": session.task,
            "tasks": list((stats or {}).get("tasks", {}).keys()),
            "stats": stats,
        })

    payload = _build_group_answers_payload({**group, "sessions": sessions_out})
    return payload


@app.get("/api/groups/{group_id}/wordcloud")
def api_group_wordcloud(group_id: str, task_id: Optional[str] = None):
    answers_payload = api_group_answers(group_id)
    words = _build_wordcloud_from_group_payload(answers_payload, task_id=task_id)
    return {
        "group_id": group_id,
        "task_id": task_id,
        "words": words,
    }


@app.put("/api/groups/{group_id}/settings")
def api_update_group_settings(group_id: str, payload: dict = Body(...)):
    name = payload.get("name")
    note = payload.get("note")
    try:
        updated = update_group_settings(group_id=group_id, name=name, note=note)
    except ValueError as e:
        message = str(e)
        if message == "Skupina nenalezena.":
            raise HTTPException(status_code=404, detail=message)
        raise HTTPException(status_code=400, detail=message)

    return {"group": updated}


@app.delete("/api/groups/{group_id}")
def api_delete_group(group_id: str):
    deleted = delete_group(group_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Group not found.")
    return {"group_id": group_id, "deleted": True}


@app.post("/api/groups/compare/wordcloud")
def api_compare_wordcloud(payload: dict = Body(...)):
    group_ids = payload.get("group_ids", [])
    task_id = payload.get("task_id")
    if not isinstance(group_ids, list) or not group_ids:
        raise HTTPException(status_code=400, detail="group_ids must be non-empty list")

    out_groups = []
    for gid in group_ids:
        gid_str = str(gid).strip()
        if not gid_str:
            continue
        try:
            answers_payload = api_group_answers(gid_str)
        except HTTPException:
            continue
        words = _build_wordcloud_from_group_payload(answers_payload, task_id=str(task_id).strip() if isinstance(task_id, str) and task_id.strip() else None)
        out_groups.append({
            "group_id": gid_str,
            "words": words,
        })

    return {
        "task_id": task_id if isinstance(task_id, str) and task_id.strip() else None,
        "groups": out_groups,
    }


@app.post("/api/groups")
def api_create_group(payload: dict = Body(...)):
    name = str(payload.get("name", "")).strip()
    test_id = str(payload.get("test_id", "TEST")).strip() or "TEST"
    session_ids = payload.get("session_ids", [])

    if not name:
        raise HTTPException(status_code=400, detail="Group name is required.")
    if not isinstance(session_ids, list) or not session_ids:
        raise HTTPException(status_code=400, detail="Please select at least one session.")

    group_id = f"grp_{uuid4().hex[:12]}"
    try:
        group = upsert_group(group_id=group_id, test_id=test_id, name=name, session_ids=session_ids)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"group": group}


@app.put("/api/groups/{group_id}")
def api_update_group(group_id: str, payload: dict = Body(...)):
    existing = next((g for g in list_groups() if g.get("id") == group_id), None)
    if not existing:
        raise HTTPException(status_code=404, detail="Group not found.")

    name = str(payload.get("name", existing.get("name", ""))).strip()
    test_id = str(payload.get("test_id", existing.get("test_id", "TEST"))).strip() or "TEST"
    session_ids = payload.get("session_ids", existing.get("session_ids", []))
    if not isinstance(session_ids, list):
        raise HTTPException(status_code=400, detail="session_ids must be a list.")

    try:
        group = upsert_group(group_id=group_id, test_id=test_id, name=name, session_ids=session_ids)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"group": group}