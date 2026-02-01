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


def _parse_lat_lon(s: str) -> Optional[Tuple[float, float]]:
    """
    očekává "lat, lon"
    """
    m = re.match(r"^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$", s)
    if not m:
        return None
    lat = float(m.group(1))
    lon = float(m.group(3))
    return (lat, lon)


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

    if event_name in {"movestart", "moveend", "popupopen", "popupclose"}:
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
        if str(col).lower() == "userid":
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
