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
    "device": {"device", "zarizeni", "zařízení", "device_type", "devicetype", "platform", "device_by_url", "devicebyurl"},
    "confidence": {"confidence", "confident"},
    "paper_maps": {"paper_maps", "papermaps", "papermap", "paper_map"},
    "computer_maps": {"computer_maps", "computermaps", "computermap", "computer_map"},
    "mobile_maps": {"mobile_maps", "mobilemaps", "mobilemap", "mobile_map"},
    "screenResolution": {"screenResolution", "screen_resolution", "screenresolution"},
    "viewportSize": {"viewportSize", "viewport_size", "viewportsize"},
    "browser": {"browser"},
    "browserVersion": {"browserVersion", "browser_version", "browserversion"},
    "os": {"os", "operatingSystem", "operating_system", "platform_os"},
    "ip": {"ip", "ipAddress", "ip_address", "ipaddress"},
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