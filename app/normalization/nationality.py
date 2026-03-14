from __future__ import annotations

import re
import unicodedata
from difflib import get_close_matches
from typing import Any, Dict, Optional

try:
    import pycountry  # type: ignore
except Exception:  # pragma: no cover
    pycountry = None  # type: ignore

try:
    from rapidfuzz import fuzz, process  # type: ignore
except Exception:  # pragma: no cover
    fuzz = None  # type: ignore
    process = None  # type: ignore

def _normalize_token(value: Any) -> str:
    if value is None:
        return ""
    s = str(value).strip().casefold()
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

_COUNTRY_BY_TOKEN: Dict[str, str] = {}
if pycountry is not None:
    for country in list(pycountry.countries):
        canonical = str(getattr(country, "name", "")).strip()
        if not canonical:
            continue

        candidates = {
            canonical,
            getattr(country, "official_name", ""),
            getattr(country, "common_name", ""),
            getattr(country, "alpha_2", ""),
            getattr(country, "alpha_3", ""),
        }

        # některé datasety používají historické GER apod.
        historic_alpha3 = getattr(country, "bibliographic", "")
        if historic_alpha3:
            candidates.add(historic_alpha3)

        for candidate in candidates:
            token = _normalize_token(candidate)
            if token:
                _COUNTRY_BY_TOKEN[token] = canonical


# fallback a demonyma / běžné varianty
_DEMONYM_ALIASES = {
    "german": "Germany",
    "ger": "Germany",
    "deutsch": "Germany",
    "deutsche": "Germany",
    "deutschland": "Germany",
    "nemecko": "Germany",
    "italian": "Italy",
    "italy": "Italy",
    "italia": "Italy",
    "austrian": "Austria",
    "polish": "Poland",
    "russian": "Russia",
    "greek": "Greece",
    "czech": "Czechia",
    "czech republic": "Czechia",
    "cesko": "Czechia",
    "ceska republika": "Czechia",
    "slovak": "Slovakia",
    "ukrainian": "Ukraine",
    "turkish": "Turkey",
    "bosnian": "Bosnia and Herzegovina",
}

for alias, canonical_country in _DEMONYM_ALIASES.items():
    token = _normalize_token(alias)
    if token:
        _COUNTRY_BY_TOKEN[token] = canonical_country


_KNOWN_TOKENS = sorted(_COUNTRY_BY_TOKEN.keys())


def normalize_nationality(value: Any) -> Optional[str]:
    token = _normalize_token(value)
    if not token:
        return None

    direct = _COUNTRY_BY_TOKEN.get(token)
    if direct:
        return direct

    # pokud je k dispozici knihovna, zkusíme její lookup
    if pycountry is not None:
        try:
            looked_up = pycountry.countries.lookup(str(value).strip())
            looked_up_name = str(getattr(looked_up, "name", "")).strip()
            if looked_up_name:
                return looked_up_name
        except Exception:
            pass

    if process is not None and fuzz is not None and _KNOWN_TOKENS:
        matched = process.extractOne(token, _KNOWN_TOKENS, scorer=fuzz.WRatio, score_cutoff=86)
        if matched:
            return _COUNTRY_BY_TOKEN[matched[0]]

    close = get_close_matches(token, _KNOWN_TOKENS, n=1, cutoff=0.8)
    if close:
        return _COUNTRY_BY_TOKEN[close[0]]

    return str(value).strip() or None