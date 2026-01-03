from __future__ import annotations

from typing import Dict, Any
import pandas as pd


def basic_stats(df: pd.DataFrame) -> Dict[str, Any]:
    """
    MVP metriky pro Nástěnku:
    - počet eventů
    - rozsah času (duration)
    - počty typů eventů
    - hrubý počet "pohybových segmentů" (movestart/moveend)
    """
    out: Dict[str, Any] = {}

    out["events_total"] = int(len(df))

    # timestamp bereme jako ms od startu (typicky)
    ts = pd.to_numeric(df["timestamp"], errors="coerce")
    ts = ts.dropna()
    if len(ts) > 0:
        out["time_min_ms"] = int(ts.min())
        out["time_max_ms"] = int(ts.max())
        out["duration_ms"] = int(ts.max() - ts.min())
    else:
        out["time_min_ms"] = None
        out["time_max_ms"] = None
        out["duration_ms"] = None

    counts = df["event_name"].astype(str).value_counts().to_dict()
    out["event_counts"] = {k: int(v) for k, v in counts.items()}

    out["movestart_count"] = int(counts.get("movestart", 0))
    out["moveend_count"] = int(counts.get("moveend", 0))
    out["movement_pairs_hint"] = int(min(out["movestart_count"], out["moveend_count"]))

    return out
