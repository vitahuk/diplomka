from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
import re
import math

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

MERCATOR_MAX_LAT = 85.05112878

def _normalize_orientation(v: Any) -> Optional[str]:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).strip().lower()
    if not s:
        return None
    if s.startswith("landscape"):
        return "landscape-primary"
    if s.startswith("portrait"):
        return "portrait-primary"
    return s

ORIENTATION_DETAIL_PATTERN = re.compile(r"\b(landscape|portrait)\s*[-_ ]?\s*(primary|secondary)\b", re.IGNORECASE)

def _extract_orientation_from_event_detail(event_detail: Any) -> Optional[str]:
    """
    orientation change event_detail může být ve volném textu:
    např. "portrait-primary, 90 degrees." nebo "landscape secondary".
    Vrací normalizaci pro výpočet viewportu (landscape/portrait primary).
    """
    if event_detail is None or (isinstance(event_detail, float) and pd.isna(event_detail)):
        return None
    s = str(event_detail).strip()
    if not s:
        return None
    match = ORIENTATION_DETAIL_PATTERN.search(s)
    if not match:
        return None
    axis = match.group(1).lower()
    return f"{axis}-primary"

def _resolve_viewport_with_orientation(
    viewport_raw: Any,
    orientation_raw: Any,
) -> Viewport:
    viewport = _parse_viewport_size(viewport_raw)
    if not viewport.width or not viewport.height:
        return Viewport()

    width = int(viewport.width)
    height = int(viewport.height)
    orientation = _normalize_orientation(orientation_raw)

    if orientation == "portrait-primary" and width > height:
        width, height = height, width
    elif orientation == "landscape-primary" and width < height:
        width, height = height, width

    return Viewport(width=width, height=height)


def _compute_viewport_bounds(
    lat: float,
    lon: float,
    zoom: float,
    viewport_width: int,
    viewport_height: int,
) -> Optional[List[List[float]]]:
    """
    Compute geographic rectangle [[south, west], [north, east]] for slippy map viewport.
    """
    if not (math.isfinite(lat) and math.isfinite(lon) and math.isfinite(zoom)):
        return None
    if viewport_width <= 0 or viewport_height <= 0:
        return None

    clamped_lat = max(min(lat, MERCATOR_MAX_LAT), -MERCATOR_MAX_LAT)
    world_size = 256.0 * (2.0 ** float(zoom))
    if not math.isfinite(world_size) or world_size <= 0:
        return None

    lat_rad = math.radians(clamped_lat)
    cx = world_size * (lon + 180.0) / 360.0
    cy = world_size * (1.0 - math.log(math.tan(lat_rad) + (1.0 / math.cos(lat_rad))) / math.pi) / 2.0

    half_w = viewport_width / 2.0
    half_h = viewport_height / 2.0

    left = cx - half_w
    right = cx + half_w
    top = cy - half_h
    bottom = cy + half_h

    def unproject(px: float, py: float) -> Tuple[float, float]:
        lon_out = (px / world_size) * 360.0 - 180.0
        lat_out = math.degrees(math.atan(math.sinh(math.pi * (1.0 - (2.0 * py / world_size)))))
        return lat_out, lon_out

    north_lat, west_lon = unproject(left, top)
    south_lat, _ = unproject(left, bottom)
    _, east_lon = unproject(right, top)

    lon_span = abs(east_lon - west_lon)
    if lon_span >= 360.0:
        west_lon = -180.0
        east_lon = 180.0
    else:
        def normalize_lon(lon_value: float) -> float:
            normalized = ((lon_value + 180.0) % 360.0) - 180.0
            # preserve +180 instead of -180 for readability when edge-aligned
            if normalized == -180.0 and lon_value > 0:
                return 180.0
            return normalized

        west_lon = normalize_lon(west_lon)
        east_lon = normalize_lon(east_lon)

    north_lat = max(min(north_lat, MERCATOR_MAX_LAT), -MERCATOR_MAX_LAT)
    south_lat = max(min(south_lat, MERCATOR_MAX_LAT), -MERCATOR_MAX_LAT)

    return [[south_lat, west_lon], [north_lat, east_lon]]

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

def _resolve_row_task_id(row: pd.Series, current_task: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    event_name = str(row.get("event_name", "")).strip()
    parsed = parse_event_detail(event_name, row.get("event_detail"))

    task_id = _normalize_task_id(row.get("task")) if "task" in row.index else None
    next_current_task = current_task

    if event_name == "setting task":
        inferred = parsed.get("task_id")
        if isinstance(inferred, str) and inferred.strip():
            next_current_task = inferred.strip()
            if not task_id:
                task_id = next_current_task

    if not task_id:
        task_id = current_task

    return task_id, next_current_task

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
      track: {
        points: [[lat, lon], ...],
        samples: [{lat, lon, timestamp, zoom, viewportWidth, viewportHeight, orientation, viewportBounds}, ...]
      },
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

    data = data.copy()
    data["_timestamp"] = pd.to_numeric(data["timestamp"], errors="coerce")
    data = data[data["_timestamp"].notna()]
    if data.empty:
        return {
            "userId": normalized_user or "",
            "taskId": normalized_task or "",
            "track": {"points": [], "samples": []},
            "popups": [],
            "movementEndpoints": {"start": None, "end": None},
        }

    data["_timestamp"] = data["_timestamp"].astype(int)
    data = data.sort_values(by=["_timestamp"], kind="stable")

    resolved_user_id = normalized_user
    if not resolved_user_id and uid_col and not data.empty:
        resolved_user_id = str(data.iloc[0][uid_col]).strip()

    track_points: List[List[float]] = []
    track_samples: List[Dict[str, Any]] = []
    popups: List[Dict[str, Any]] = []
    last_popup_name: Optional[str] = None
    first_movestart_point: Optional[Dict[str, Any]] = None
    last_moveend_point: Optional[Dict[str, Any]] = None
    last_zoom: Optional[float] = None
    current_task: Optional[str] = None
    current_orientation: Optional[str] = None
    orientation_driven_by_events = False

    def _matches_selected_task(row_task: Optional[str]) -> bool:
        if not normalized_task:
            return True
        if not isinstance(row_task, str):
            return False
        return row_task.strip() == normalized_task

    for _, row in data.iterrows():
        event_name = str(row.get("event_name", "")).strip()
        event_name_lower = event_name.lower()
        event_detail = row.get("event_detail")
        timestamp = int(row.get("_timestamp"))
        row_task, current_task = _resolve_row_task_id(row, current_task)
        is_selected_task_row = _matches_selected_task(row_task)
        row_orientation = _normalize_orientation(row.get("orientation"))
        if not orientation_driven_by_events and row_orientation is not None:
            current_orientation = row_orientation

        if event_name_lower == "orientation change":
            detail_orientation = _extract_orientation_from_event_detail(event_detail)
            if detail_orientation is not None:
                current_orientation = detail_orientation
                orientation_driven_by_events = True
            elif row_orientation is not None:
                current_orientation = row_orientation
                orientation_driven_by_events = True
            continue

        if event_name == "popupopen:name":
            if event_detail is None or (isinstance(event_detail, float) and pd.isna(event_detail)):
                last_popup_name = None
            else:
                text = str(event_detail).strip()
                last_popup_name = text if text else None
            continue

        parsed = parse_event_detail(event_name, event_detail)
        if event_name in {"zoom in", "zoom out"}:
            zoom_value = parsed.get("zoom")
            if isinstance(zoom_value, (int, float)) and math.isfinite(float(zoom_value)):
                last_zoom = float(zoom_value)
            continue

        coord = parse_coordinate_detail_if_allowed(event_name, event_detail)

        if event_name == "movestart" and coord is not None and first_movestart_point is None and is_selected_task_row:
            lat, lon = coord
            first_movestart_point = {
                "lat": lat,
                "lon": lon,
                "timestamp": timestamp,
                "task": row_task,
                "zoom": last_zoom,
            }
            continue

        if event_name == "moveend" and coord is not None and is_selected_task_row:
            lat, lon = coord
            last_moveend_point = {"lat": lat, "lon": lon, "timestamp": timestamp, "task": row_task}

            viewport = _resolve_viewport_with_orientation(
                row.get("viewportSize"),
                current_orientation,
            )
            orientation = current_orientation

            viewport_bounds = None
            if viewport.width and viewport.height and last_zoom is not None:
                viewport_bounds = _compute_viewport_bounds(
                    lat=lat,
                    lon=lon,
                    zoom=last_zoom,
                    viewport_width=int(viewport.width),
                    viewport_height=int(viewport.height),
                )

            track_samples.append({
                "lat": lat,
                "lon": lon,
                "timestamp": timestamp,
                "zoom": last_zoom if last_zoom is not None else 0,
                "viewportWidth": viewport.width,
                "viewportHeight": viewport.height,
                "orientation": orientation,
                "viewportBounds": viewport_bounds,
                "task": row_task,
            })

            if track_points:
                prev_lat, prev_lon = track_points[-1]
                if abs(lat - prev_lat) < 1e-6 and abs(lon - prev_lon) < 1e-6:
                    continue
            track_points.append([lat, lon])
            continue

        if event_name == "popupopen" and coord is not None and is_selected_task_row:
            lat, lon = coord
            popups.append({
                "lat": lat,
                "lon": lon,
                "name": last_popup_name or "—",
                "timestamp": timestamp,
            })
            last_popup_name = None

    if first_movestart_point and track_points:
        fs_lat = float(first_movestart_point["lat"])
        fs_lon = float(first_movestart_point["lon"])
        first_lat, first_lon = track_points[0]
        if abs(fs_lat - first_lat) >= 1e-6 or abs(fs_lon - first_lon) >= 1e-6:
            track_points.insert(0, [fs_lat, fs_lon])
            start_zoom_raw = first_movestart_point.get("zoom")
            start_zoom = float(start_zoom_raw) if isinstance(start_zoom_raw, (int, float)) and math.isfinite(float(start_zoom_raw)) else 0
            seed_sample = {
                "lat": fs_lat,
                "lon": fs_lon,
                "timestamp": int(first_movestart_point["timestamp"]),
                "zoom": start_zoom,
                "viewportWidth": track_samples[0].get("viewportWidth") if track_samples else None,
                "viewportHeight": track_samples[0].get("viewportHeight") if track_samples else None,
                "orientation": track_samples[0].get("orientation") if track_samples else None,
                "viewportBounds": None,
                "task": first_movestart_point.get("task"),
            }
            effective_zoom_raw = start_zoom_raw
            if not (isinstance(effective_zoom_raw, (int, float)) and math.isfinite(float(effective_zoom_raw))):
                first_sample = track_samples[0] if track_samples else None
                if (
                    isinstance(first_sample, dict)
                    and abs(float(first_sample.get("lat", float("nan"))) - fs_lat) < 1e-6
                    and abs(float(first_sample.get("lon", float("nan"))) - fs_lon) < 1e-6
                ):
                    first_sample_zoom = first_sample.get("zoom")
                    if isinstance(first_sample_zoom, (int, float)) and math.isfinite(float(first_sample_zoom)) and float(first_sample_zoom) > 0:
                        effective_zoom_raw = float(first_sample_zoom)
                        seed_sample["zoom"] = float(first_sample_zoom)
            vw = seed_sample.get("viewportWidth")
            vh = seed_sample.get("viewportHeight")
            if (
                isinstance(vw, int)
                and isinstance(vh, int)
                and isinstance(effective_zoom_raw, (int, float))
                and math.isfinite(float(effective_zoom_raw))
            ):
                seed_sample["viewportBounds"] = _compute_viewport_bounds(
                    lat=fs_lat,
                    lon=fs_lon,
                    zoom=float(effective_zoom_raw),
                    viewport_width=vw,
                    viewport_height=vh,
                )
            track_samples.insert(0, seed_sample)

    if len(track_points) < 2:
        track_points = []
        track_samples = []
    
    start_point = first_movestart_point
    end_point = last_moveend_point


    return {
        "userId": resolved_user_id or "",
        "taskId": normalized_task or "",
        "track": {"points": track_points, "samples": track_samples},
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
