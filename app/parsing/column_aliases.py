from __future__ import annotations

import re
import unicodedata
from typing import Dict, Iterable, Optional


def _normalize_column_name(value: str) -> str:
    s = str(value or "").strip().casefold()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


SOC_DEMO_COLUMN_ALIASES = {
    "age": {"age", "vek", "v", "years", "ages"},
    "gender": {"gender", "sex", "pohlavi", "pohlaví"},
    "occupation": {"occupation", "job", "employment", "zamestnani", "zamestnání", "profese"},
    "education": {"education", "vzdelani", "vzdělání", "schooling"},
    "nationality": {"nationality", "narodnost", "národnost", "nation", "country", "citizenship", "statniobcanstvi"},
}


def resolve_column_aliases(
    columns: Iterable[str],
    alias_map: Dict[str, set[str]],
) -> Dict[str, str]:
    normalized_columns: Dict[str, str] = {
        _normalize_column_name(col): col for col in columns
    }
    resolved: Dict[str, str] = {}
    for canonical, aliases in alias_map.items():
        candidates = {canonical, *aliases}
        for alias in candidates:
            found = normalized_columns.get(_normalize_column_name(alias))
            if found is not None:
                resolved[canonical] = found
                break
    return resolved


def resolve_single_column(columns: Iterable[str], canonical: str, aliases: set[str]) -> Optional[str]:
    resolved = resolve_column_aliases(columns, {canonical: aliases})
    return resolved.get(canonical)