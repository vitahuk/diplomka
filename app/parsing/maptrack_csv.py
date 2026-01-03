from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Any, Optional, Tuple
import re
import pandas as pd


@dataclass
class ParsedUpload:
    session_id: str
    user_id: Optional[str]
    task: Optional[str]
    df: pd.DataFrame


def infer_session_id_from_filename(filename: str) -> str:
    """
    SessionID máš v názvu souboru. Pro MVP:
    - vezmeme "stem" bez přípony
    - vyčistíme na [a-zA-Z0-9_-]
    """
    stem = filename.rsplit(".", 1)[0]
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", stem).strip("_")
    return cleaned or "session"


def read_maptrack_csv(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)

    # základní validace
    required = {"timestamp", "event_name", "event_detail"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV chybí povinné sloupce: {sorted(missing)}")

    return df


def parse_event_detail(event_name: str, event_detail: Any) -> Dict[str, Any]:
    """
    Normalizační parser: z raw event_detail vyrobí strukturovaná pole.
    Pro MVP pokrýváme hlavně pohyb a zoom. Ostatní necháme jako raw.
    """
    if pd.isna(event_detail):
        return {}

    s = str(event_detail).strip()

    # souřadnice "lat, lon"
    if event_name in {"movestart", "moveend", "popupopen", "popupclose"}:
        m = re.match(r"^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$", s)
        if m:
            lat = float(m.group(1))
            lon = float(m.group(3))
            return {"lat": lat, "lon": lon}

    # zoom in/out – typicky číslo
    if event_name in {"zoom in", "zoom out"}:
        try:
            return {"zoom": float(s)}
        except ValueError:
            return {}

    # popupopen:name, polygon selected, show layer, hide layer, answer selected...
    # zatím ponecháme jako "value"
    return {"value": s}


def parse_upload(csv_path: str, filename: str) -> ParsedUpload:
    df = read_maptrack_csv(csv_path)

    # session id z názvu souboru
    session_id = infer_session_id_from_filename(filename)

    # userId sloupec ve tvých datech existuje
    user_id = None
    if "userId" in df.columns and len(df) > 0:
        user_id = str(df["userId"].iloc[0]) if not pd.isna(df["userId"].iloc[0]) else None

    task = None
    if "task" in df.columns and len(df) > 0:
        task = str(df["task"].iloc[0]) if not pd.isna(df["task"].iloc[0]) else None

    # přidáme parsed fields
    parsed = df.apply(lambda r: parse_event_detail(str(r["event_name"]), r["event_detail"]), axis=1)
    df = df.copy()
    df["parsed"] = parsed

    return ParsedUpload(session_id=session_id, user_id=user_id, task=task, df=df)
