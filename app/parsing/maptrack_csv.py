from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
import re

import pandas as pd


# =========================
# Data model (parsed output)
# =========================

@dataclass(frozen=True)
class Viewport:
    width: Optional[int] = None
    height: Optional[int] = None


@dataclass
class ParsedEvent:
    """
    Normalizovaný event z MapTrack CSV.
    Všechno, co budeš později analyzovat, je tady:
    - timestamp_ms: int
    - event_name: str
    - task_id: str | None
    - viewport: Viewport
    - detail: původní raw event_detail
    - parsed: strukturovaný detail (lat/lon/zoom/value/...)
    - row_index: index řádku v CSV (pro debug)
    """
    timestamp_ms: int
    event_name: str
    task_id: Optional[str]
    viewport: Viewport
    detail: Optional[str]
    parsed: Dict[str, Any]
    row_index: int


@dataclass
class TaskStream:
    """
    Jeden task (úloha) uvnitř session.
    - events: všechny eventy patřící do tasku (v časovém pořadí)
    """
    task_id: str
    events: List[ParsedEvent]


@dataclass
class ParsedSession:
    """
    Celá session (jeden CSV soubor).
    - tasks: mapuje task_id -> TaskStream
    - events: všechny eventy (také v pořadí), i když třeba task_id není známé
    """
    session_id: str
    user_id: Optional[str]
    events: List[ParsedEvent]
    tasks: Dict[str, TaskStream]


# =========================
# Helpers
# =========================

def infer_session_id_from_filename(filename: str) -> str:
    """
    SessionID máš v názvu souboru. Bereme stem bez přípony a vyčistíme.
    """
    stem = filename.rsplit(".", 1)[0]
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", stem).strip("_")
    return cleaned or "session"


def _parse_timestamp_ms(v: Any) -> int:
    """
    timestamp v MapTrack datech bývá ms od startu session.
    Potřebujeme int, ať se na tom dá dělat diff/thresholdy.
    """
    try:
        n = int(float(v))
        return n
    except Exception:
        # fallback: když je to fakt rozbité, dáme 0 a později to ošetříme v metrikách
        return 0


def _parse_viewport_size(v: Any) -> Viewport:
    """
    viewportSize typicky: "1280x585" nebo "1920x1080"
    """
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return Viewport()

    s = str(v).strip()
    m = re.match(r"^\s*(\d+)\s*[x×]\s*(\d+)\s*$", s)
    if not m:
        return Viewport()

    try:
        w = int(m.group(1))
        h = int(m.group(2))
        return Viewport(width=w, height=h)
    except Exception:
        return Viewport()

COORDINATE_EVENT_NAMES: set[str] = {"movestart", "moveend", "popupopen", "popupclose"}
COORDINATE_PATTERN = re.compile(
    r"^\s*(?P<lat>-?\d+(?:\.\d+)?)\s*,\s*(?P<lon>-?\d+(?:\.\d+)?)\s*$"
)


def _parse_lat_lon(s: str) -> Optional[Tuple[float, float]]:
    """
    očekává "lat, lon" ve WGS84 a validuje rozsahy.
    """
    m = COORDINATE_PATTERN.match(s)
    if not m:
        return None
    
    lat = float(m.group("lat"))
    lon = float(m.group("lon"))
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return (lat, lon)

def parse_coordinate_detail_if_allowed(event_name: str, event_detail: Any) -> Optional[Tuple[float, float]]:
    """
    Souřadnice parsuje pouze pro explicitně podporované eventy.
    event_detail je polymorfní, proto pro ostatní eventy vždy vrací None.
    """
    if event_name not in COORDINATE_EVENT_NAMES:
        return None
    if event_detail is None or (isinstance(event_detail, float) and pd.isna(event_detail)):
        return None
    return _parse_lat_lon(str(event_detail))

def parse_event_detail(event_name: str, event_detail: Any) -> Dict[str, Any]:
    """
    Z event_detail udělá strukturovaný dict.
    Teď pokrýváme to, co víme, že budeme potřebovat:
    - movestart/moveend/popupopen/popupclose: lat/lon
    - zoom in/zoom out: zoom
    - setting task: task_id
    - ostatní: value (string)
    """
    if event_detail is None or (isinstance(event_detail, float) and pd.isna(event_detail)):
        return {}

    s = str(event_detail).strip()

    if event_name in COORDINATE_EVENT_NAMES:
        ll = _parse_lat_lon(s)
        if ll:
            lat, lon = ll
            return {"lat": lat, "lon": lon}

    if event_name in {"zoom in", "zoom out"}:
        try:
            return {"zoom": float(s)}
        except Exception:
            return {}

    if event_name == "setting task":
        # v event_detail bývá id tasku typu "01A-v1" apod.
        return {"task_id": s}

    # popupopen:name / polygon selected / show layer / hide layer / answer selected / ...
    return {"value": s}


def _normalize_task_id(v: Any) -> Optional[str]:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).strip()
    return s if s else None

def build_spatial_trace_for_user(
    df: pd.DataFrame,
    user_id: Optional[str] = None,
    task_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Připraví spatial data pro Leaflet pro jednoho uživatele/session.
    Výstup:
    {
      userId: str,
      track: { points: [[lat, lon], ...] },
      popups: [{lat, lon, name, timestamp}, ...],
      movementEndpoints: {start: {lat, lon, timestamp}|null, end: {lat, lon, timestamp}|null}
    }
    """
    required = {"timestamp", "event_name", "event_detail"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns for spatial trace: {sorted(missing)}")

    data = df.copy()
    uid_col = get_user_id_column(data)

    normalized_user = None if user_id is None else str(user_id).strip()
    normalized_task = None if task_id is None else str(task_id).strip()
    if uid_col and normalized_user:
        data = data[data[uid_col].astype(str).str.strip() == normalized_user]
    
    if normalized_task:
        if "task" in data.columns:
            data = data[data["task"].astype(str).str.strip() == normalized_task]
        else:
            current_task: Optional[str] = None
            inferred_tasks: List[Optional[str]] = []
            for _, row in data.iterrows():
                event_name = str(row.get("event_name", "")).strip()
                raw_detail = row.get("event_detail")
                if event_name == "setting task":
                    parsed = parse_event_detail(event_name, raw_detail)
                    inferred = parsed.get("task_id")
                    if isinstance(inferred, str) and inferred.strip():
                        current_task = inferred.strip()
                inferred_tasks.append(current_task)
            data = data.copy()
            data["_task_id_inferred"] = inferred_tasks
            data = data[data["_task_id_inferred"].astype(str).str.strip() == normalized_task]

    data = data.copy()
    data["_timestamp"] = pd.to_numeric(data["timestamp"], errors="coerce")
    data = data[data["_timestamp"].notna()]
    if data.empty:
        return {
            "userId": normalized_user or "",
            "taskId": normalized_task or "",
            "track": {"points": []},
            "popups": [],
            "movementEndpoints": {"start": None, "end": None},
        }

    data["_timestamp"] = data["_timestamp"].astype(int)
    data = data.sort_values(by=["_timestamp"], kind="stable")

    resolved_user_id = normalized_user
    if not resolved_user_id and uid_col and not data.empty:
        resolved_user_id = str(data.iloc[0][uid_col]).strip()

    track_points: List[List[float]] = []
    popups: List[Dict[str, Any]] = []
    all_coordinate_points: List[Dict[str, Any]] = []
    last_popup_name: Optional[str] = None

    for _, row in data.iterrows():
        event_name = str(row.get("event_name", "")).strip()
        event_detail = row.get("event_detail")
        timestamp = int(row.get("_timestamp"))

        if event_name == "popupopen:name":
            if event_detail is None or (isinstance(event_detail, float) and pd.isna(event_detail)):
                last_popup_name = None
            else:
                text = str(event_detail).strip()
                last_popup_name = text if text else None
            continue

        coord = parse_coordinate_detail_if_allowed(event_name, event_detail)
        if coord is not None:
            lat, lon = coord
            all_coordinate_points.append({"lat": lat, "lon": lon, "timestamp": timestamp})

        if event_name == "moveend" and coord is not None:
            lat, lon = coord
            if track_points:
                prev_lat, prev_lon = track_points[-1]
                if abs(lat - prev_lat) < 1e-6 and abs(lon - prev_lon) < 1e-6:
                    continue
            track_points.append([lat, lon])
            continue

        if event_name == "popupopen" and coord is not None:
            lat, lon = coord
            popups.append({
                "lat": lat,
                "lon": lon,
                "name": last_popup_name or "—",
                "timestamp": timestamp,
            })
            last_popup_name = None

    if len(track_points) < 2:
        track_points = []
    
    start_point = all_coordinate_points[0] if all_coordinate_points else None
    end_point = all_coordinate_points[-1] if all_coordinate_points else None


    return {
        "userId": resolved_user_id or "",
        "taskId": normalized_task or "",
        "track": {"points": track_points},
        "popups": popups,
        "movementEndpoints": {
            "start": start_point,
            "end": end_point,
        },
    }


# =========================
# Main parsing entry points
# =========================

def validate_maptrack_df(df: pd.DataFrame) -> None:
    required = {"timestamp", "event_name", "event_detail"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV chybí povinné sloupce: {sorted(missing)}")

def read_maptrack_csv(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    validate_maptrack_df(df)
    return df


def get_user_id_column(df: pd.DataFrame) -> Optional[str]:
    for col in df.columns:
        normalized = re.sub(r"[^a-z0-9]", "", str(col).lower())
        if normalized == "userid":
            return col
    return None


def parse_session_df(
    df: pd.DataFrame,
    filename: str,
    *,
    user_id_override: Optional[str] = None,
    session_id_override: Optional[str] = None,
) -> ParsedSession:
    """
    Komplexní parsing:
    - načte CSV
    - udělá ParsedEvent pro každý řádek
    - přiřadí eventy do tasků:
        A) primárně podle sloupce 'task' (pokud existuje)
        B) fallback: když 'task' není, tak state machine přes event 'setting task'
    """
    validate_maptrack_df(df)

    session_id = session_id_override or infer_session_id_from_filename(filename)

    user_id: Optional[str] = None
    if user_id_override is not None:
        user_id = _normalize_task_id(user_id_override)
    else:
        user_id_col = get_user_id_column(df)
        if user_id_col and len(df) > 0:
            user_id = _normalize_task_id(df[user_id_col].iloc[0])

    has_task_column = "task" in df.columns
    current_task: Optional[str] = None  # pro fallback režim

    events: List[ParsedEvent] = []
    tasks: Dict[str, TaskStream] = {}

    for i, row in df.iterrows():
        ts = _parse_timestamp_ms(row.get("timestamp"))
        event_name = str(row.get("event_name", "")).strip()

        raw_detail = row.get("event_detail")
        detail_str = None if (raw_detail is None or (isinstance(raw_detail, float) and pd.isna(raw_detail))) else str(raw_detail)

        viewport = _parse_viewport_size(row.get("viewportSize")) if "viewportSize" in df.columns else Viewport()

        parsed = parse_event_detail(event_name, raw_detail)

        task_id: Optional[str] = None

        if has_task_column:
            task_id = _normalize_task_id(row.get("task"))
        else:
            # fallback: task se přepíná podle "setting task"
            if event_name == "setting task":
                inferred = parsed.get("task_id")
                if isinstance(inferred, str) and inferred.strip():
                    current_task = inferred.strip()
            task_id = current_task

        # ještě jeden fallback: některá data mohou mít task prázdný,
        # ale zároveň je možné ho vyčíst z eventu "setting task"
        if (task_id is None or task_id == "") and event_name == "setting task":
            inferred = parsed.get("task_id")
            if isinstance(inferred, str) and inferred.strip():
                task_id = inferred.strip()

        ev = ParsedEvent(
            timestamp_ms=ts,
            event_name=event_name,
            task_id=task_id,
            viewport=viewport,
            detail=detail_str,
            parsed=parsed,
            row_index=int(i),
        )
        events.append(ev)

        if task_id:
            if task_id not in tasks:
                tasks[task_id] = TaskStream(task_id=task_id, events=[])
            tasks[task_id].events.append(ev)

    return ParsedSession(
        session_id=session_id,
        user_id=user_id,
        events=events,
        tasks=tasks,
    )


def parse_session(csv_path: str, filename: str) -> ParsedSession:
    df = read_maptrack_csv(csv_path)
    return parse_session_df(df, filename)


# =========================
# Convenience for later
# =========================

def list_task_ids(session: ParsedSession) -> List[str]:
    """
    Stabilní pořadí tasků (podle prvního výskytu).
    """
    # první výskyt task_id v events
    seen = set()
    ordered: List[str] = []
    for ev in session.events:
        if ev.task_id and ev.task_id not in seen:
            seen.add(ev.task_id)
            ordered.append(ev.task_id)
    return ordered
