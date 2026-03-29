from __future__ import annotations

from fastapi import FastAPI, UploadFile, File, HTTPException, Form, Request
from fastapi.responses import FileResponse, Response, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi import Body

from pathlib import Path
import re
import threading
import unicodedata
from collections import Counter
from io import StringIO, BytesIO
import shutil
import time
import hmac
import hashlib
import base64
import json
import zipfile
import logging
from typing import Any, Dict, Optional, List
from uuid import uuid4
from difflib import SequenceMatcher

import csv
import pandas as pd

from app.storage import STORE, SessionData
from app.config import (
    WEB_DIR,
    UPLOAD_DIR,
    LOGIN_PASSWORD,
    SESSION_SECRET,
    SESSION_DURATION_HOURS,
    SESSION_DURATION_SECONDS,
    SESSION_COOKIE_SECURE,
)
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

app = FastAPI(title="Mishpink data explorer")

app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

logger = logging.getLogger(__name__)

UPLOAD_JOBS: Dict[str, Dict[str, Any]] = {}
UPLOAD_JOBS_LOCK = threading.Lock()

AUTH_COOKIE_NAME = "diplomka_auth"
AUTH_EXEMPT_PATHS = {
    "/login",
    "/api/auth/login",
}


def _is_auth_exempt_path(path: str) -> bool:
    if path.startswith("/static/"):
        return True
    return path in AUTH_EXEMPT_PATHS


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _base64url_decode(raw: str) -> bytes:
    padding = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw + padding)


def _build_auth_cookie(auth_until: int) -> str:
    payload = {"auth_until": int(auth_until)}
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_b64 = _base64url_encode(payload_json)
    signature = hmac.new(SESSION_SECRET.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{signature}"


def _read_auth_payload(request: Request) -> Optional[Dict[str, Any]]:
    raw_cookie = request.cookies.get(AUTH_COOKIE_NAME)
    if not raw_cookie or "." not in raw_cookie:
        return None

    payload_b64, signature = raw_cookie.rsplit(".", 1)
    expected_signature = hmac.new(
        SESSION_SECRET.encode("utf-8"),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected_signature):
        return None

    try:
        payload = json.loads(_base64url_decode(payload_b64).decode("utf-8"))
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None
    return payload


def _get_auth_until(request: Request) -> Optional[int]:
    payload = _read_auth_payload(request)
    auth_until = payload.get("auth_until") if isinstance(payload, dict) else None
    return auth_until if isinstance(auth_until, int) else None


def _is_authenticated(request: Request) -> bool:
    auth_until = _get_auth_until(request)
    if auth_until is None:
        return False
    return auth_until > int(time.time())


def _clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(AUTH_COOKIE_NAME)


def _set_auth_cookie(response: Response, auth_until: int) -> None:
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=_build_auth_cookie(auth_until),
        max_age=SESSION_DURATION_SECONDS,
        httponly=True,
        samesite="lax",
        secure=SESSION_COOKIE_SECURE,
        path="/",
    )


def _unauthorized_response(path: str) -> Response:
    if path.startswith("/api/"):
        response: Response = JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    else:
        response = RedirectResponse(url="/login", status_code=303)
    _clear_auth_cookie(response)
    return response


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if _is_auth_exempt_path(path):
        return await call_next(request)

    if _is_authenticated(request):
        return await call_next(request)

    return _unauthorized_response(path)

@app.get("/")
def index():
    return FileResponse(str(WEB_DIR / "index.html"))


@app.get("/login")
def login_page(request: Request):
    if _is_authenticated(request):
        return RedirectResponse(url="/", status_code=303)
    return FileResponse(str(WEB_DIR / "login.html"))


@app.get("/api/auth/me")
def auth_me(request: Request):
    if not _is_authenticated(request):
        return _unauthorized_response("/api/auth/me")

    auth_until = int(_get_auth_until(request) or 0)
    return {
        "authenticated": True,
        "expires_at": auth_until,
        "session_duration_hours": SESSION_DURATION_HOURS,
    }


@app.post("/api/auth/login")
async def auth_login(payload: dict = Body(...)):
    password = str(payload.get("password") or "")
    if not hmac.compare_digest(password, LOGIN_PASSWORD):
        raise HTTPException(status_code=401, detail="Invalid password.")

    auth_until = int(time.time()) + SESSION_DURATION_SECONDS
    response = JSONResponse(content={
        "ok": True,
        "expires_at": auth_until,
        "session_duration_hours": SESSION_DURATION_HOURS,
    })
    _set_auth_cookie(response, auth_until)
    return response


@app.post("/api/auth/logout")
def auth_logout():
    response = JSONResponse(content={"ok": True})
    _clear_auth_cookie(response)
    return response


# =========================
# Helpers
# =========================

def _create_upload_job(*, kind: str, filename: str, test_id: str) -> str:
    job_id = uuid4().hex
    with UPLOAD_JOBS_LOCK:
        UPLOAD_JOBS[job_id] = {
            "job_id": job_id,
            "kind": kind,
            "filename": filename,
            "test_id": test_id,
            "status": "uploaded",
            "message": "Upload successful.",
            "error": None,
            "error_code": None,
            "result": None,
        }
    return job_id


def _update_upload_job(job_id: str, **changes: Any) -> None:
    with UPLOAD_JOBS_LOCK:
        job = UPLOAD_JOBS.get(job_id)
        if not job:
            return
        job.update(changes)


def _get_upload_job(job_id: str) -> Optional[Dict[str, Any]]:
    with UPLOAD_JOBS_LOCK:
        job = UPLOAD_JOBS.get(job_id)
        return dict(job) if job else None
    
def _extract_error_code(detail: Any) -> Optional[str]:
    if isinstance(detail, dict):
        code = detail.get("error_code")
        if isinstance(code, str) and code.strip():
            return code.strip()
    return None


def _extract_error_message(detail: Any, fallback: str = "Request failed.") -> str:
    if isinstance(detail, dict):
        message = detail.get("message") or detail.get("detail")
        if isinstance(message, str) and message.strip():
            return message.strip()
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    return fallback


def _raise_api_error(status_code: int, message: str, *, error_code: Optional[str] = None) -> None:
    payload: Dict[str, str] = {"message": message}
    if error_code:
        payload["error_code"] = error_code
    raise HTTPException(status_code=status_code, detail=payload)

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

def _build_session_id_for_test_user(test_id: str, user_id: Any) -> str:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    normalized_user_id = _normalize_user_id(user_id)
    if not normalized_user_id:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unable to determine User ID for this upload. "
                "Session identity now requires test_id + user_id."
            ),
        )
    return f"S{_sanitize_filename_component(normalized_test_id)}__{_sanitize_filename_component(normalized_user_id)}"

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
    df = df.sort_values(by=["timestamp"], kind="stable").reset_index(drop=True)

    if "task" not in df.columns:
        df["task"] = None

    inferred_tasks: List[Optional[str]] = []
    current_task: Optional[str] = None
    for _, row in df.iterrows():
        raw_task = row.get("task")
        task = None if pd.isna(raw_task) else str(raw_task).strip() or None

        if task:
            current_task = task
            inferred_tasks.append(task)
            continue

        event_name = str(row.get("event_name") or "").strip()
        raw_detail = row.get("event_detail")
        detail = None if pd.isna(raw_detail) else str(raw_detail).strip() or None

        if event_name == "setting task" and detail:
            current_task = detail
            inferred_tasks.append(detail)
            continue

        inferred_tasks.append(current_task)

    df["task"] = inferred_tasks
    return df

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
        
        if name == "setting task" and open_popup:
            items.append({
                "type": "interval",
                "name": "POPUP",
                "startTs": int(open_popup["startTs"]),
                "endTs": ts,
                "task": open_popup.get("task") or task,
            })
            open_popup = None

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

    first_task_id: Optional[str] = None
    setting_task_start_by_task: Dict[str, int] = {}
    question_closed_by_task: Dict[str, int] = {}
    for event in events:
        task_raw = event.get("task")
        task_id = str(task_raw).strip() if task_raw is not None else ""
        if not task_id:
            continue
        if first_task_id is None:
            first_task_id = task_id
        event_name = str(event.get("event_name") or "")
        ts = int(event.get("timestamp", 0))
        if event_name == "setting task" and task_id not in setting_task_start_by_task:
            setting_task_start_by_task[task_id] = ts
        if event_name == "question dialog closed" and task_id not in question_closed_by_task:
            question_closed_by_task[task_id] = ts

    intro_items: List[Dict[str, Any]] = []
    for task_id, end_ts in question_closed_by_task.items():
        if task_id in setting_task_start_by_task:
            start_ts = setting_task_start_by_task[task_id]
        elif task_id == first_task_id:
            start_ts = 0
        else:
            continue
        if end_ts < start_ts:
            continue
        intro_items.append({
            "type": "interval",
            "name": "INTRO",
            "startTs": int(start_ts),
            "endTs": int(end_ts),
            "task": task_id,
        })

    if intro_items:
        intro_items.sort(key=lambda item: (int(item.get("startTs", 0)), int(item.get("endTs", 0))))
        items = intro_items + items

    items.sort(
        key=lambda item: (
            int(item.get("startTs", item.get("ts", 0))),
            int(item.get("endTs", item.get("ts", 0))),
            0 if str(item.get("type") or "") == "interval" else 1,
        )
    )
   
    return items

def _build_task_start_offsets(events: List[Dict[str, Any]]) -> Dict[str, int]:
    task_offsets: Dict[str, int] = {}
    first_task_id: Optional[str] = None

    for event in events:
        task_raw = event.get("task")
        task_id = str(task_raw).strip() if task_raw is not None else ""
        if task_id:
            first_task_id = task_id
            break
    
    for event in events:
        task_raw = event.get("task")
        task_id = str(task_raw).strip() if task_raw is not None else ""
        if not task_id or task_id in task_offsets:
            continue
        if task_id == first_task_id:
            task_offsets[task_id] = 0
        else:
            task_offsets[task_id] = int(event.get("timestamp", 0))

    return task_offsets

def _build_gazeplotter_segments_for_session(session: SessionData) -> List[Dict[str, Any]]:
    csv_path = Path(session.file_path)
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail=f"CSV file for session '{session.session_id}' not found.")

    df = _read_session_events_df(csv_path)
    participant = str(session.user_id or "").strip()
    if not participant and not df.empty:
        participant = "unknown"

    timeline_items = _build_timeline_items_from_events_df(df)
    task_start_offsets = _build_task_start_offsets(df.to_dict("records"))

    filtered_instant_events = {"movestart", "moveend", "zoom in", "zoom out", "popupopen:name", "popupclose", "setting task", "question dialog closed"}
    segments: List[Dict[str, Any]] = []
    previous_non_interval_key: Optional[tuple] = None
    for item in timeline_items:
        item_type = str(item.get("type") or "")
        aoi_name = str(item.get("name", ""))
        is_interval = item_type == "interval"

        if not is_interval and aoi_name.strip().lower() in filtered_instant_events:
            continue

        if is_interval:
            from_ts = int(item.get("startTs", 0))
            to_ts = int(item.get("endTs", from_ts))
        else:
            point_ts = int(item.get("ts", 0))
            from_ts = point_ts
            to_ts = point_ts

        stimulus_raw = item.get("task")
        stimulus = "" if stimulus_raw is None else str(stimulus_raw)
        stimulus_key = stimulus.strip()
        task_offset = task_start_offsets.get(stimulus_key, 0) if stimulus_key else 0
        from_ts -= task_offset
        to_ts -= task_offset

        if to_ts < from_ts or from_ts < 0:
            continue

        segment = {
            "From": from_ts,
            "To": to_ts,
            "Participant": participant,
            "Stimulus": stimulus,
            "AOI": aoi_name,
        }

        if not is_interval:
            dedupe_key = (
                segment["Participant"],
                segment["Stimulus"],
                segment["AOI"],
                segment["From"],
                segment["To"],
            )
            if previous_non_interval_key == dedupe_key:
                continue
            previous_non_interval_key = dedupe_key
        else:
            previous_non_interval_key = None

        segments.append(segment)
    return segments


def _resolve_test_export_name(test_id: str) -> str:
    normalized_test_id = str(test_id or "").strip()
    if not normalized_test_id:
        return "user_experiment"
    for test in list_tests():
        if str(test.get("id") or "").strip() != normalized_test_id:
            continue
        candidate = str(test.get("name") or "").strip() or normalized_test_id
        return candidate
    return normalized_test_id

def _load_spatial_trace_for_session(session: SessionData, task_id: Optional[str] = None) -> Dict[str, Any]:
    csv_path = Path(session.file_path)
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

    user_id = session.user_id
    user_col = get_user_id_column(df)
    if not user_id and user_col and not df.empty:
        first_uid = df.iloc[0].get(user_col)
        if first_uid is not None and not (isinstance(first_uid, float) and pd.isna(first_uid)):
            user_id = str(first_uid).strip()

    try:
        trace = build_spatial_trace_for_user(df, user_id=user_id, task_id=task_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    user_experiment = _resolve_test_export_name(session.test_id)
    return {
        "session_id": session.session_id,
        "user_id": user_id,
        "user_experiment": user_experiment,
        "spatial": trace,
    }


def _build_viewport_polygon_coordinates(bounds: Any) -> List[List[List[float]]]:
    if not isinstance(bounds, list) or len(bounds) != 2:
        return []
    sw, ne = bounds
    if not isinstance(sw, list) or not isinstance(ne, list) or len(sw) < 2 or len(ne) < 2:
        return []

    try:
        south = float(sw[0])
        west = float(sw[1])
        north = float(ne[0])
        east = float(ne[1])
    except (TypeError, ValueError):
        return []

    def _build_ring(ring_west: float, ring_east: float) -> List[List[float]]:
        return [
            [ring_west, south],
            [ring_east, south],
            [ring_east, north],
            [ring_west, north],
            [ring_west, south],
        ]

    if west > east:
        return [_build_ring(west, 180.0), _build_ring(-180.0, east)]
    return [_build_ring(west, east)]


def _build_spatial_export_collections(items: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    trajectory_features: List[Dict[str, Any]] = []
    trajectory_points_features: List[Dict[str, Any]] = []
    viewport_features: List[Dict[str, Any]] = []

    for item in items:
        spatial = item.get("spatial") if isinstance(item.get("spatial"), dict) else {}
        session_id = item.get("session_id")
        base_props = {
            "session_id": session_id,
            "user_id": item.get("user_id"),
            "user_experiment": item.get("user_experiment"),
        }
        if "group" in item:
            base_props["group"] = item.get("group")

        track = spatial.get("track") if isinstance(spatial.get("track"), dict) else {}
        points = track.get("points") if isinstance(track.get("points"), list) else []
        coordinates: List[List[float]] = []
        for xy in points:
            if not isinstance(xy, list) or len(xy) < 2:
                continue
            try:
                lat = float(xy[0])
                lon = float(xy[1])
            except (TypeError, ValueError):
                continue
            coordinates.append([lon, lat])
        if len(coordinates) >= 2:
            trajectory_features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coordinates},
                "properties": dict(base_props),
            })

        samples = track.get("samples") if isinstance(track.get("samples"), list) else []
        movement_endpoints = spatial.get("movementEndpoints") if isinstance(spatial.get("movementEndpoints"), dict) else {}
        start_endpoint = movement_endpoints.get("start") if isinstance(movement_endpoints.get("start"), dict) else None
        end_endpoint = movement_endpoints.get("end") if isinstance(movement_endpoints.get("end"), dict) else None

        def _resolve_endpoint_index(endpoint_payload: Optional[Dict[str, Any]], kind: str) -> Optional[int]:
            if not endpoint_payload:
                return None
            for sample_idx, sample_payload in enumerate(samples):
                if not isinstance(sample_payload, dict):
                    continue
                if sample_payload.get("timestamp") != endpoint_payload.get("timestamp"):
                    continue
                if sample_payload.get("lat") != endpoint_payload.get("lat") or sample_payload.get("lon") != endpoint_payload.get("lon"):
                    continue
                return sample_idx
            same_coord_indices = [
                sample_idx
                for sample_idx, sample_payload in enumerate(samples)
                if isinstance(sample_payload, dict)
                and sample_payload.get("lat") == endpoint_payload.get("lat")
                and sample_payload.get("lon") == endpoint_payload.get("lon")
            ]
            if not same_coord_indices:
                return None
            return same_coord_indices[0] if kind == "start" else same_coord_indices[-1]

        start_index = _resolve_endpoint_index(start_endpoint, "start")
        end_index = _resolve_endpoint_index(end_endpoint, "end")
        
        for index, sample in enumerate(samples):
            if not isinstance(sample, dict):
                continue
            try:
                lat = float(sample.get("lat"))
                lon = float(sample.get("lon"))
            except (TypeError, ValueError):
                continue
            point_props = {
                **base_props,
                "point_type": "start" if start_index == index else ("end" if end_index == index else "trajectory_point"),
                "index": index,
                "t": int(sample.get("timestamp")) if sample.get("timestamp") is not None else None,
                "z": float(sample.get("zoom")) if sample.get("zoom") is not None else None,
                "task": sample.get("task"),
                "viewportBounds": sample.get("viewportBounds") if isinstance(sample.get("viewportBounds"), list) else None,
            }
            trajectory_points_features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": point_props,
            })

            rings = _build_viewport_polygon_coordinates(sample.get("viewportBounds"))
            if rings:
                viewport_features.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "MultiPolygon" if len(rings) > 1 else "Polygon",
                        "coordinates": [[ring] for ring in rings] if len(rings) > 1 else [rings[0]],
                    },
                    "properties": {
                        **base_props,
                        "point_index": index,
                        "t": int(sample.get("timestamp")) if sample.get("timestamp") is not None else None,
                        "z": float(sample.get("zoom")) if sample.get("zoom") is not None else None,
                        "task": sample.get("task"),
                    },
                })

    return {
        "trajectory": {"type": "FeatureCollection", "features": trajectory_features},
        "trajectory_points": {"type": "FeatureCollection", "features": trajectory_points_features},
        "viewports": {"type": "FeatureCollection", "features": viewport_features},
    }


def _build_spatial_export_zip(filename_base: str, collections: Dict[str, Dict[str, Any]]) -> Response:
    files = [
        (f"{filename_base}_trajectory.geojson", collections["trajectory"]),
        (f"{filename_base}_trajectory points.geojson", collections["trajectory_points"]),
        (f"{filename_base}_viewports.geojson", collections["viewports"]),
    ]

    zip_buffer = BytesIO()
    with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for filename, payload in files:
            archive.writestr(filename, json.dumps(payload, ensure_ascii=False))
    zip_buffer.seek(0)

    zip_name = f"{filename_base}_spatial_data.zip"
    headers = {"Content-Disposition": f'attachment; filename="{zip_name}"'}
    return Response(content=zip_buffer.getvalue(), media_type="application/zip", headers=headers)

INTERVAL_EVENT_NAME_MAP: Dict[str, str] = {
    "MOVE": "move",
    "ZOOM": "zoom",
    "POPUP": "popup",
}

def _empty_interval_duration_bucket() -> Dict[str, int]:
    return {event_key: 0 for event_key in INTERVAL_EVENT_NAME_MAP.values()}

def _compute_dominant_behavior(events: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    dominant_key: Optional[str] = None
    dominant_duration = -1

    for event_key in INTERVAL_EVENT_NAME_MAP.values():
        payload = events.get(event_key) if isinstance(events, dict) else {}
        duration_ms = int(payload.get("duration_ms", 0)) if isinstance(payload, dict) else 0
        if duration_ms > dominant_duration:
            dominant_duration = duration_ms
            dominant_key = event_key

    if dominant_key is None or dominant_duration <= 0:
        return None

    payload = events.get(dominant_key) if isinstance(events, dict) else {}
    ratio = payload.get("ratio") if isinstance(payload, dict) else None

    return {
        "event_key": dominant_key,
        "label": dominant_key.capitalize(),
        "duration_ms": dominant_duration,
        "ratio": ratio,
    }

def _enrich_interval_ratio_scope(scope_payload: Dict[str, Any]) -> Dict[str, Any]:
    events_payload = scope_payload.get("events") if isinstance(scope_payload.get("events"), dict) else {}
    normalized_events: Dict[str, Any] = {}

    for event_key in INTERVAL_EVENT_NAME_MAP.values():
        event_row = events_payload.get(event_key) if isinstance(events_payload.get(event_key), dict) else {}
        normalized_events[event_key] = {
            "duration_ms": int(event_row.get("duration_ms", 0)) if event_row.get("duration_ms") is not None else 0,
            "ratio": event_row.get("ratio"),
        }

    out = dict(scope_payload)
    out["events"] = normalized_events
    out["dominant_behavior"] = _compute_dominant_behavior(normalized_events)
    return out

def _normalize_interval_event_ratios_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    by_task_raw = payload.get("by_task") if isinstance(payload.get("by_task"), dict) else {}
    all_tasks_raw = payload.get("all_tasks") if isinstance(payload.get("all_tasks"), dict) else {}

    by_task: Dict[str, Any] = {}
    for task_id, scope_payload in by_task_raw.items():
        if not isinstance(scope_payload, dict):
            continue
        by_task[str(task_id)] = _enrich_interval_ratio_scope(scope_payload)

    normalized_all_tasks = _enrich_interval_ratio_scope(all_tasks_raw) if all_tasks_raw else {
        "task_id": "ALL_TASKS",
        "task_duration_ms": 0,
        "events": {
            event_key: {"duration_ms": 0, "ratio": None}
            for event_key in INTERVAL_EVENT_NAME_MAP.values()
        },
        "dominant_behavior": None,
    }

    return {
        "event_order": list(INTERVAL_EVENT_NAME_MAP.values()),
        "by_task": by_task,
        "all_tasks": normalized_all_tasks,
    }

def _refresh_session_interval_event_ratios(session: SessionData, persist: bool = False) -> Optional[Dict[str, Any]]:
    stats = session.stats if isinstance(session.stats, dict) else {}
    payload = stats.get("interval_event_ratios") if isinstance(stats.get("interval_event_ratios"), dict) else None
    if payload is None:
        return None

    normalized = _normalize_interval_event_ratios_payload(payload)
    if normalized != payload:
        stats["interval_event_ratios"] = normalized
        session.stats = stats
        if persist:
            STORE.upsert(session)
    return normalized

def _compute_interval_event_ratios(
    timeline_items: List[Dict[str, Any]],
    task_metrics: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    by_task_durations: Dict[str, Dict[str, int]] = {
        str(task_id): _empty_interval_duration_bucket()
        for task_id in task_metrics.keys()
    }

    for item in timeline_items:
        if item.get("type") != "interval":
            continue

        raw_name = str(item.get("name") or "").strip().upper()
        event_key = INTERVAL_EVENT_NAME_MAP.get(raw_name)
        if not event_key:
            continue

        task_id = str(item.get("task") or "").strip()
        if not task_id:
            continue

        if task_id not in by_task_durations:
            by_task_durations[task_id] = _empty_interval_duration_bucket()

        start_ts = int(item.get("startTs", 0))
        end_ts = int(item.get("endTs", start_ts))
        duration_ms = max(0, end_ts - start_ts)
        by_task_durations[task_id][event_key] += duration_ms

    by_task: Dict[str, Any] = {}
    total_task_duration_ms = 0
    all_tasks_durations = _empty_interval_duration_bucket()

    for task_id, metrics in task_metrics.items():
        task_id_str = str(task_id)
        task_duration_ms = metrics.get("duration_ms")
        task_duration_int = int(task_duration_ms) if isinstance(task_duration_ms, int) else 0
        total_task_duration_ms += max(0, task_duration_int)

        event_rows: Dict[str, Any] = {}
        durations = by_task_durations.get(task_id_str, _empty_interval_duration_bucket())
        for event_key, duration_ms in durations.items():
            all_tasks_durations[event_key] += duration_ms
            ratio = (duration_ms / task_duration_int) if task_duration_int > 0 else None
            event_rows[event_key] = {
                "duration_ms": duration_ms,
                "ratio": ratio,
            }

        by_task[task_id_str] = {
            "task_id": task_id_str,
            "task_duration_ms": task_duration_int if task_duration_ms is not None else None,
            "events": event_rows,
        }

    all_tasks_events: Dict[str, Any] = {}
    for event_key, duration_ms in all_tasks_durations.items():
        ratio = (duration_ms / total_task_duration_ms) if total_task_duration_ms > 0 else None
        all_tasks_events[event_key] = {
            "duration_ms": duration_ms,
            "ratio": ratio,
        }

    return _normalize_interval_event_ratios_payload({
        "event_order": list(INTERVAL_EVENT_NAME_MAP.values()),
        "by_task": by_task,
        "all_tasks": {
            "task_id": "ALL_TASKS",
            "task_duration_ms": total_task_duration_ms,
            "events": all_tasks_events,
        },
    })

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
    sessions = STORE.list_sessions(test_id=normalized_test_id)
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

def _serialize_session_payload(session: SessionData, *, include_file_path: bool = False) -> Dict[str, Any]:
    stats = session.stats if isinstance(session.stats, dict) else {}
    task_metrics = stats.get("tasks", {}) if isinstance(stats.get("tasks"), dict) else {}
    payload = {
        "session_id": session.session_id,
        "test_id": getattr(session, "test_id", "TEST") or "TEST",
        "user_id": session.user_id,
        "task": session.task,
        "tasks": list(task_metrics.keys()),
        "stats": stats,
        "session_stats": stats.get("session", {}) if isinstance(stats.get("session"), dict) else {},
    }
    if include_file_path:
        payload["file_path"] = session.file_path
    return payload


def _build_group_sessions_payload(session_ids: List[str]) -> List[Dict[str, Any]]:
    ordered_ids = [str(sid).strip() for sid in session_ids if isinstance(sid, str) and str(sid).strip()]
    if not ordered_ids:
        return []

    sessions_by_id = STORE.list_sessions(session_ids=ordered_ids)
    return _serialize_group_sessions_payload(sessions_by_id, ordered_ids)


def _serialize_group_sessions_payload(
    sessions_by_id: Dict[str, SessionData],
    ordered_ids: List[str],
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for session_id in ordered_ids:
        session = sessions_by_id.get(session_id)
        if session is None:
            continue
        out.append(_serialize_session_payload(session))
    return out

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

def _process_single_csv(dst: Path, filename: str, test_id: str) -> Dict[str, Any]:
    parsed_session = parse_session(str(dst), filename)
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    resolved_user_id = _normalize_user_id(parsed_session.user_id)
    session_id = _build_session_id_for_test_user(normalized_test_id, resolved_user_id)

    tasks: List[str] = list_task_ids(parsed_session)
    primary_task: Optional[str] = tasks[0] if tasks else None

    soc_row = _read_soc_demo_row(dst)
    session_metrics = compute_session_metrics(session=parsed_session, raw_row=soc_row)
    task_metrics = compute_all_task_metrics(parsed_session)

    source_df = _read_csv_flexible(dst)
    answers_by_task = _extract_answers_by_task_from_df(source_df)
    answers_eval = _build_answers_eval_for_session(answers_by_task, get_test_answers(test_id or "TEST"))

    stats: Dict[str, Any] = {
        "session": session_metrics,
        "tasks": task_metrics,
        "answers_by_task": answers_by_task,
        "answers_eval": answers_eval,
    }
    stats["interval_event_ratios"] = _compute_interval_event_ratios(
        _build_timeline_items_from_events_df(_read_session_events_df(dst)),
        task_metrics,
    )

    session_meta = SessionData(
        session_id=session_id,
        test_id=normalized_test_id,
        file_path=str(dst),
        user_id=resolved_user_id,
        task=primary_task,
        stats=stats,
    )
    STORE.upsert(session_meta)

    return {
        "session_id": session_id,
        "user_id": resolved_user_id,
        "test_id": normalized_test_id,
        "task": primary_task,
        "tasks": tasks,
    }


def _process_bulk_csv(dst: Path, filename: str, test_id: str) -> Dict[str, Any]:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    df = pd.read_csv(dst, low_memory=False)
    age_col = resolve_single_column(df.columns, "age", SOC_DEMO_COLUMN_ALIASES["age"])
    if age_col:
        df[age_col] = pd.to_numeric(df[age_col], errors="coerce")
    validate_maptrack_df(df)

    user_col = get_user_id_column(df)
    if not user_col:
        _raise_api_error(400, "CSV must include the required 'userid' column.", error_code="MISSING_USERID_COLUMN")

    df["_user_id_norm"] = df[user_col].apply(_normalize_user_id)
    df = df[df["_user_id_norm"].notna()]
    if df.empty:
        _raise_api_error(400, "CSV does not contain valid values in the 'userid' column.", error_code="INVALID_USERID_VALUES")

    soc_rows = _read_soc_demo_rows_by_user(df, "_user_id_norm")
    
    sessions_out: List[Dict[str, Any]] = []

    for user_id, df_user in df.groupby("_user_id_norm", sort=False):
        df_user = df_user.drop(columns=["_user_id_norm"])

        user_suffix = _sanitize_filename_component(str(user_id))
        user_filename = f"{dst.stem}__{user_suffix}.csv"
        user_path = UPLOAD_DIR / user_filename
        df_user.to_csv(user_path, index=False)

        session_id = _build_session_id_for_test_user(normalized_test_id, user_id)
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

        stats["interval_event_ratios"] = _compute_interval_event_ratios(
            _build_timeline_items_from_events_df(_read_session_events_df(user_path)),
            task_metrics,
        )

        session_meta = SessionData(
            session_id=parsed_session.session_id,
            test_id=normalized_test_id,
            file_path=str(user_path),
            user_id=parsed_session.user_id,
            task=primary_task,
            stats=stats,
        )
        STORE.upsert(session_meta)

        sessions_out.append({
            "session_id": parsed_session.session_id,
            "test_id": normalized_test_id,
            "user_id": parsed_session.user_id,
            "task": primary_task,
            "tasks": tasks,
        })

    return {
        "count": len(sessions_out),
        "sessions": sessions_out,
        "first_session_id": sessions_out[0]["session_id"] if sessions_out else None,
    }


def _run_upload_job(job_id: str, *, kind: str, dst: Path, filename: str, test_id: str) -> None:
    _update_upload_job(
        job_id,
        status="processing",
        message="Processing CSV... this might take a while for large files.",
    )
    try:
        if kind == "single":
            result = _process_single_csv(dst, filename, test_id)
        elif kind == "bulk":
            result = _process_bulk_csv(dst, filename, test_id)
        else:
            raise RuntimeError(f"Unsupported upload kind: {kind}")

        _update_upload_job(
            job_id,
            status="completed",
            message="CSV processing finished.",
            result=result,
        )
    except HTTPException as exc:
        _update_upload_job(
            job_id,
            status="failed",
            message="CSV processing failed.",
            error=_extract_error_message(exc.detail, "CSV processing failed."),
            error_code=_extract_error_code(exc.detail),
        )
    except Exception:
        logger.exception("Unexpected error while processing upload job", extra={"job_id": job_id, "kind": kind})
        _update_upload_job(
            job_id,
            status="failed",
            message="CSV processing failed.",
            error="Unexpected server error while processing CSV.",
            error_code="UPLOAD_PROCESSING_ERROR",
        )


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
    filename = (file.filename or "").strip()
    if not filename.lower().endswith(".csv"):
        _raise_api_error(400, "Please upload a CSV file.", error_code="INVALID_FILE_TYPE")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dst = UPLOAD_DIR / filename

    try:
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception:
        logger.exception("Failed to save uploaded CSV", extra={"filename": filename, "kind": "single"})
        _raise_api_error(500, "Could not save the uploaded file. Please try again.", error_code="FILE_SAVE_FAILED")

    job_id = _create_upload_job(kind="single", filename=filename, test_id=test_id or "TEST")
    worker = threading.Thread(
        target=_run_upload_job,
        args=(job_id,),
        kwargs={"kind": "single", "dst": dst, "filename": filename, "test_id": test_id or "TEST"},
        daemon=True,
    )
    worker.start()

    return {
        "job_id": job_id,
        "status": "uploaded",
        "message": "Upload successful.",
        "test_id": test_id or "TEST",
        "filename": filename,
    }

@app.post("/api/upload/bulk")
async def upload_bulk_csv(
    file: UploadFile = File(...),
    test_id: str = Form("TEST"),
):
    filename = (file.filename or "").strip()
    if not filename.lower().endswith(".csv"):
        _raise_api_error(400, "Please upload a CSV file.", error_code="INVALID_FILE_TYPE")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dst = UPLOAD_DIR / filename

    try:
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception:
        logger.exception("Failed to save uploaded CSV", extra={"filename": filename, "kind": "bulk"})
        _raise_api_error(500, "Could not save the uploaded file. Please try again.", error_code="FILE_SAVE_FAILED")

    try:
        df = pd.read_csv(dst, low_memory=False)
        age_col = resolve_single_column(df.columns, "age", SOC_DEMO_COLUMN_ALIASES["age"])
        if age_col:
            df[age_col] = pd.to_numeric(df[age_col], errors="coerce")
        validate_maptrack_df(df)
    except Exception:
        logger.exception("Bulk CSV validation failed", extra={"filename": filename, "test_id": test_id})
        _raise_api_error(400, "Could not process the CSV file. Please check the format and required columns.", error_code="CSV_PROCESSING_FAILED")

    user_col = get_user_id_column(df)
    if not user_col:
        _raise_api_error(400, "CSV must include the required 'userid' column.", error_code="MISSING_USERID_COLUMN")

    df["_user_id_norm"] = df[user_col].apply(_normalize_user_id)
    df = df[df["_user_id_norm"].notna()]
    if df.empty:
        _raise_api_error(400, "CSV does not contain valid values in the 'userid' column.", error_code="INVALID_USERID_VALUES")

    soc_rows = _read_soc_demo_rows_by_user(df, "_user_id_norm")
    base_session_id = infer_session_id_from_filename(file.filename)

    sessions_out: List[Dict[str, Any]] = []

    job_id = _create_upload_job(kind="bulk", filename=filename, test_id=test_id or "TEST")
    worker = threading.Thread(
        target=_run_upload_job,
        args=(job_id,),
        kwargs={"kind": "bulk", "dst": dst, "filename": filename, "test_id": test_id or "TEST"},
        daemon=True,
    )
    worker.start()

    return {
        "job_id": job_id,
        "status": "uploaded",
        "message": "Upload successful.",
        "test_id": test_id or "TEST",
        "filename": filename,
    }


@app.get("/api/upload/jobs/{job_id}")
def get_upload_job(job_id: str):
    job = _get_upload_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Upload job not found.")
    return job


@app.get("/api/sessions")
def list_sessions(test_id: Optional[str] = None):
    sessions = STORE.list_sessions(test_id=test_id)
    return {"sessions": [_serialize_session_payload(session) for session in sessions.values()]}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")

    return _serialize_session_payload(s, include_file_path=True)


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

    answers_eval = stats.get("answers_eval") if isinstance(stats.get("answers_eval"), dict) else {}
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

    stats = s.stats if isinstance(s.stats, dict) else {}
    payload = stats.get("answers_eval") if isinstance(stats.get("answers_eval"), dict) else {
        "summary": {},
        "by_task": {},
    }
    return {
        "session_id": s.session_id,
        "user_id": s.user_id,
        "test_id": getattr(s, "test_id", "TEST") or "TEST",
        **payload,
    }

@app.get("/api/sessions/{session_id}/interval-event-ratios")
def get_session_interval_event_ratios(session_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")

    stats = s.stats if isinstance(s.stats, dict) else {}
    payload = stats.get("interval_event_ratios") if isinstance(stats.get("interval_event_ratios"), dict) else None
    if payload is None:
        raise HTTPException(status_code=404, detail="Interval event ratios not available for this session.")

    return {
        "session_id": s.session_id,
        "user_id": s.user_id,
        "test_id": getattr(s, "test_id", "TEST") or "TEST",
        **payload,
    }

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
    segments = _build_gazeplotter_segments_for_session(s)

    export_df = pd.DataFrame(segments, columns=["From", "To", "Participant", "Stimulus", "AOI"])
    csv_data = export_df.to_csv(index=False, sep=',')
    test_name = _resolve_test_export_name(s.test_id)
    participant = _sanitize_filename_component(str(s.user_id or "unknown"))
    filename = f"{_sanitize_filename_component(test_name)}_{participant}_gazeplotter_export.csv"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(content=csv_data, media_type="text/csv; charset=utf-8", headers=headers)


@app.get("/api/tests/{test_id}/sessions/events/export")
def export_test_events_gazeplotter_csv(test_id: str):
    sessions = list(STORE.list_sessions(test_id=test_id).values())
    if not sessions:
        raise HTTPException(status_code=404, detail="No sessions found for this user experiment.")

    segments: List[Dict[str, Any]] = []
    for session in sessions:
        segments.extend(_build_gazeplotter_segments_for_session(session))

    export_df = pd.DataFrame(segments, columns=["From", "To", "Participant", "Stimulus", "AOI"])
    csv_data = export_df.to_csv(index=False, sep=',')

    test_name = _resolve_test_export_name(test_id)
    filename = f"{_sanitize_filename_component(test_name)}_all_sessions_gazeplotter_export.csv"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(content=csv_data, media_type="text/csv; charset=utf-8", headers=headers)


@app.get("/api/groups/{group_id}/events/export")
def export_group_events_gazeplotter_csv(group_id: str):
    group = next((g for g in list_groups() if g.get("id") == group_id), None)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found.")

    session_ids = group.get("session_ids", []) if isinstance(group.get("session_ids"), list) else []
    if not session_ids:
        raise HTTPException(status_code=400, detail="Group contains no sessions.")

    sessions_by_id = STORE.list_sessions(session_ids=session_ids)
    ordered_sessions = [sessions_by_id[sid] for sid in session_ids if sid in sessions_by_id]
    if not ordered_sessions:
        raise HTTPException(status_code=404, detail="No sessions found for this group.")

    segments: List[Dict[str, Any]] = []
    for session in ordered_sessions:
        segments.extend(_build_gazeplotter_segments_for_session(session))

    export_df = pd.DataFrame(segments, columns=["From", "To", "Participant", "Stimulus", "AOI"])
    csv_data = export_df.to_csv(index=False, sep=',')

    test_name = _resolve_test_export_name(str(group.get("test_id") or ""))
    group_name = str(group.get("name") or group_id)
    filename = (
        f"{_sanitize_filename_component(test_name)}_"
        f"{_sanitize_filename_component(group_name)}_gazeplotter_export.csv"
    )
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(content=csv_data, media_type="text/csv; charset=utf-8", headers=headers)


@app.get("/api/sessions/{session_id}/spatial-trace")
def get_session_spatial_trace(session_id: str, task_id: Optional[str] = None):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")
    return _load_spatial_trace_for_session(s, task_id=task_id)


@app.get("/api/tests/{test_id}/sessions/spatial/export")
def export_test_sessions_spatial_data(test_id: str):
    sessions = STORE.list_sessions(test_id=test_id)
    ordered_sessions = sorted(sessions.values(), key=lambda x: x.session_id)
    if not ordered_sessions:
        raise HTTPException(status_code=404, detail="No sessions found for this user experiment.")

    items = [_load_spatial_trace_for_session(session) for session in ordered_sessions]
    collections = _build_spatial_export_collections(items)
    experiment_name = _resolve_test_export_name(test_id)
    filename_base = f"{_sanitize_filename_component(experiment_name)}_all sessions"
    return _build_spatial_export_zip(filename_base, collections)


@app.get("/api/groups/{group_id}/sessions/spatial/export")
def export_group_sessions_spatial_data(group_id: str):
    group = next((g for g in list_groups() if g.get("id") == group_id), None)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found.")

    session_ids = group.get("session_ids", []) if isinstance(group.get("session_ids"), list) else []
    if not session_ids:
        raise HTTPException(status_code=400, detail="Group contains no sessions.")

    sessions_by_id = STORE.list_sessions(session_ids=session_ids)
    ordered_sessions = [sessions_by_id[sid] for sid in session_ids if sid in sessions_by_id]
    if not ordered_sessions:
        raise HTTPException(status_code=404, detail="No sessions found for this group.")

    group_name = str(group.get("name") or group_id).strip()
    items: List[Dict[str, Any]] = []
    for session in ordered_sessions:
        item = _load_spatial_trace_for_session(session)
        item["group"] = group_name
        items.append(item)

    collections = _build_spatial_export_collections(items)
    filename_base = _sanitize_filename_component(group_name)
    return _build_spatial_export_zip(filename_base, collections)


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

    test_name = _resolve_test_export_name(test_id)
    filename = f"{_sanitize_filename_component(test_name)}_answers.csv"
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

    test_name = _resolve_test_export_name(test_id)
    filename = f"{_sanitize_filename_component(test_name)}_answers_template.csv"
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
    test_id = str(payload.get("test_id", "")).strip() or None

    name = payload.get("name")
    note = payload.get("note")
    try:
        created = create_test(test_id=test_id, name=name, note=note)
    except ValueError as e:
        msg = str(e)
        status = 409 if msg == "Test already exists" else 400
        error_code = "TEST_ALREADY_EXISTS" if status == 409 else "INVALID_TEST_INPUT"
        _raise_api_error(status, msg, error_code=error_code)

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
        error_code = "TEST_ALREADY_EXISTS" if status == 409 else "INVALID_TEST_INPUT"
        _raise_api_error(status, msg, error_code=error_code)

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

    all_session_ids = [
        str(session_id).strip()
        for group in groups
        for session_id in (group.get("session_ids", []) if isinstance(group.get("session_ids"), list) else [])
        if isinstance(session_id, str) and str(session_id).strip()
    ]
    sessions_by_id = STORE.list_sessions(session_ids=list(dict.fromkeys(all_session_ids)))
    return {
        "groups": [
            {
                "id": group.get("id"),
                "test_id": group.get("test_id"),
                "name": group.get("name"),
                "note": group.get("note"),
                "session_ids": session_ids,
                "sessions": _serialize_group_sessions_payload(sessions_by_id, session_ids),
            }
            for group in groups
            for session_ids in [group.get("session_ids", []) if isinstance(group.get("session_ids"), list) else []]
        ]
    }


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
    payload = _build_group_answers_payload({**group, "sessions": _build_group_sessions_payload(session_ids)})
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


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    normalized = full_path.strip("/")
    if normalized.startswith("api/") or normalized.startswith("static/"):
        raise HTTPException(status_code=404, detail="Not found")
    if normalized == "login":
        return RedirectResponse(url="/login", status_code=307)
    return FileResponse(str(WEB_DIR / "index.html"))