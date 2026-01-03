from __future__ import annotations

from dataclasses import asdict
from typing import Any, Dict, Optional, List, Tuple

# Navazuje na tvůj parser
from app.parsing.maptrack_csv import ParsedSession, TaskStream


SOC_DEMO_KEYS = ["age", "gender", "occupation", "education", "nationality"]


def _safe_int(x: Any) -> Optional[int]:
    try:
        return int(x)
    except Exception:
        return None


def _first_nonempty(raw_row: Optional[Dict[str, Any]], key: str) -> Optional[str]:
    """
    V CSV jsou soc-demo hodnoty typicky stejné pro všechny řádky.
    Bereme první použitelnou.
    """
    if not raw_row:
        return None
    v = raw_row.get(key)
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None


def extract_soc_demo(
    *,
    session: ParsedSession,
    raw_row: Optional[Dict[str, Any]] = None,
) -> Dict[str, Optional[str]]:
    """
    Vrací soc-demo charakteristiky:
    age, gender, occupation, education, nationality

    Zdroj prioritně:
    1) session.soc_demo (pokud si to časem přidáš do parseru)
    2) raw_row (typicky df.iloc[0].to_dict())
    3) None
    """
    out: Dict[str, Optional[str]] = {}

    # 1) session.soc_demo (optional future extension)
    soc_from_session = getattr(session, "soc_demo", None)
    if isinstance(soc_from_session, dict):
        for k in SOC_DEMO_KEYS:
            v = soc_from_session.get(k)
            if v is None:
                out[k] = None
            else:
                s = str(v).strip()
                out[k] = s if s else None
        return out

    # 2) raw_row
    for k in SOC_DEMO_KEYS:
        out[k] = _first_nonempty(raw_row, k)

    return out


def compute_session_metrics(
    *,
    session: ParsedSession,
    raw_row: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Metriky za session:
    1) session_id + user_id (už máš)
    2) počet tasků
    3) počet eventů
    4) celkový čas řešení (duration)
    5) soc-demo (age, gender, occupation, education, nationality)
    """
    events = session.events
    event_count = len(events)

    # duration
    if event_count:
        ts = [e.timestamp_ms for e in events if isinstance(e.timestamp_ms, int)]
        if ts:
            time_min = min(ts)
            time_max = max(ts)
            duration_ms = time_max - time_min
        else:
            time_min = None
            time_max = None
            duration_ms = None
    else:
        time_min = None
        time_max = None
        duration_ms = None

    # tasks count
    task_ids = list(session.tasks.keys())
    # zachovej pořadí dle průchodu eventy, pokud chceš:
    # (když máš list_task_ids(session) v parseru, můžeš použít ten)
    tasks_count = len(task_ids)

    soc_demo = extract_soc_demo(session=session, raw_row=raw_row)

    return {
        "session_id": session.session_id,
        "user_id": session.user_id,
        "tasks_count": tasks_count,
        "events_total": event_count,
        "time_min_ms": time_min,
        "time_max_ms": time_max,
        "duration_ms": duration_ms,
        "soc_demo": soc_demo,
    }


def compute_task_metrics(task: TaskStream) -> Dict[str, Any]:
    """
    Metriky za jednu úlohu (task):
    1) čas řešení úlohy = max(timestamp) - min(timestamp) v rámci tasku
    2) počet eventů v úloze
    """
    events = task.events
    event_count = len(events)

    if event_count:
        ts = [e.timestamp_ms for e in events if isinstance(e.timestamp_ms, int)]
        if ts:
            tmin = min(ts)
            tmax = max(ts)
            duration_ms = tmax - tmin
        else:
            tmin = None
            tmax = None
            duration_ms = None
    else:
        tmin = None
        tmax = None
        duration_ms = None

    return {
        "task_id": task.task_id,
        "events_total": event_count,
        "time_min_ms": tmin,
        "time_max_ms": tmax,
        "duration_ms": duration_ms,
    }


def compute_all_task_metrics(session: ParsedSession) -> Dict[str, Dict[str, Any]]:
    """
    Vrací dict: { task_id: task_metrics }
    """
    out: Dict[str, Dict[str, Any]] = {}
    for task_id, task_stream in session.tasks.items():
        out[task_id] = compute_task_metrics(task_stream)
    return out


# =========================
# Future: aggregation (tests)
# =========================

def aggregate_sessions(
    sessions: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Připravené pro budoucnost:
    vstup je list session_metrics (tj. výsledky compute_session_metrics)
    typicky pro jeden "TEST" / experiment.

    Teď základ:
    - počet sessions
    - průměrná délka
    - průměrný počet eventů
    """
    if not sessions:
        return {
            "sessions_count": 0,
            "avg_duration_ms": None,
            "avg_events_total": None,
        }

    durations = [s.get("duration_ms") for s in sessions if isinstance(s.get("duration_ms"), int)]
    events = [s.get("events_total") for s in sessions if isinstance(s.get("events_total"), int)]

    avg_duration = int(sum(durations) / len(durations)) if durations else None
    avg_events = int(sum(events) / len(events)) if events else None

    return {
        "sessions_count": len(sessions),
        "avg_duration_ms": avg_duration,
        "avg_events_total": avg_events,
    }
