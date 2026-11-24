"""Reel Engine — viral short-form variant generator (IG Reels / TikTok)."""
import os as _os

__version__ = "0.1.0"


def _load_root_env() -> None:
    """Load the repo-root .env (SETUP.md step 6) so the engine sees the same settings as the desk.
    Variables already set in the environment win. Values are never printed."""
    path = _os.path.join(_os.path.dirname(__file__), "..", "..", "..", ".env")
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key, val = key.strip(), val.strip()
        if val[:1] in ("'", '"'):
            end = val.find(val[0], 1)
            val = val[1:end] if end > 0 else val[1:]
        else:
            hash_at = 0 if val.startswith("#") else val.find(" #")
            if hash_at >= 0:
                val = val[:hash_at]
            val = val.strip()
        if key and val and key not in _os.environ:
            _os.environ[key] = val


_load_root_env()
