from __future__ import annotations

from difflib import get_close_matches
import re
import unicodedata
from typing import Any, Dict, Optional


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


_CANONICAL_SYNONYMS = {
    "Czech": {
        "czech", "czech republic", "cesko", "ceska republika", "ceska", "cesky", "cz", "cze", "bohemia",
    },
    "German": {
        "german", "germany", "deutsch", "deutsche", "deutschland", "nemecko", "nemec", "de",
    },
    "Bosnian": {
        "bosnian", "bosnia", "bosna", "bosnian and herzegovinian", "bosnia and herzegovina", "ba",
    },
    "Turkish": {
        "turkish", "turk", "turkiye", "turkey", "tr", "turecko",
    },
    "Austrian": {
        "austrian", "austria", "osterreich", "at",
    },
    "Slovak": {
        "slovak", "slovakia", "slovensko", "sk",
    },
    "Polish": {
        "polish", "poland", "polsko", "pl",
    },
    "Ukrainian": {
        "ukrainian", "ukraine", "ukrajina", "ua",
    },
}

_LOOKUP: Dict[str, str] = {}
for canonical, variants in _CANONICAL_SYNONYMS.items():
    _LOOKUP[_normalize_token(canonical)] = canonical
    for variant in variants:
        _LOOKUP[_normalize_token(variant)] = canonical


_KNOWN_TOKENS = sorted(_LOOKUP.keys())


def normalize_nationality(value: Any) -> Optional[str]:
    token = _normalize_token(value)
    if not token:
        return None

    direct = _LOOKUP.get(token)
    if direct:
        return direct

    close = get_close_matches(token, _KNOWN_TOKENS, n=1, cutoff=0.88)
    if close:
        return _LOOKUP[close[0]]

    return token.title()