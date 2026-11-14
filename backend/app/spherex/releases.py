"""SPHEREx release (collection) discovery. The TAP query takes 13-37 s, so no request ever
waits for it: we serve the cached or built-in list and refresh in the background once a day.
Written with AI coding assistance (Claude Code).
"""
import asyncio
import csv
import io
import time
from datetime import datetime, timezone

from .. import cache
from . import net

TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
TAP_QUERY = "SELECT collection, COUNT(*) FROM spherex.observation GROUP BY collection"

BUILTIN = ["spherex_dr1", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"]
BUILTIN_TS = datetime(2026, 11, 14, tzinfo=timezone.utc).timestamp()   # when the built-in list was checked
MAX_AGE_S = 86400
RETRY_S = 1800

_state: dict | None = None      # {"releases": [...], "ts": epoch seconds, "source": "builtin" | "tap"}
_task: asyncio.Task | None = None
_next_try = 0.0


def filter_collections(names) -> list[str]:
    """Keep science image collections; drop calibration and cube products."""
    out = {n.strip() for n in names}
    return sorted(n for n in out if n.startswith("spherex_") and not n.endswith(("_cal", "_cube")))


def parse_tap_csv(text: str) -> list[str]:
    rows = list(csv.reader(io.StringIO(text)))
    return filter_collections(r[0] for r in rows[1:] if r)


def _load() -> dict:
    global _state
    if _state is None:
        d = cache.get_json("sxrel", "collections")
        if d and d.get("releases"):
            _state = {"releases": list(d["releases"]), "ts": float(d["ts"]), "source": "tap"}
        else:
            _state = {"releases": list(BUILTIN), "ts": BUILTIN_TS, "source": "builtin"}
    return _state


async def refresh() -> list[str]:
    """Run the slow TAP query and store the result. Raises on failure."""
    global _state
    text = await net.get_text(TAP_URL, method="POST", data={"FORMAT": "CSV", "QUERY": TAP_QUERY},
                              timeout=150, tries=2)
    rel = parse_tap_csv(text)
    if not rel:
        raise net.FetchError("TAP returned no collections")
    _state = {"releases": rel, "ts": time.time(), "source": "tap"}
    cache.put_json("sxrel", "collections", {"releases": rel, "ts": _state["ts"]})
    return rel


async def _refresh_quietly():
    global _next_try
    try:
        rel = await refresh()
        net.log.info("releases refreshed: %s", rel)
    except Exception as e:  # keep serving the old list
        _next_try = time.time() + RETRY_S
        net.log.warning("release refresh failed: %s", e)


def kick():
    """Start a background refresh if the list is stale and none is running. Never blocks."""
    global _task
    st = _load()
    now = time.time()
    stale = st["source"] == "builtin" or now - st["ts"] > MAX_AGE_S
    if stale and now >= _next_try and (_task is None or _task.done()):
        try:
            _task = asyncio.get_running_loop().create_task(_refresh_quietly())
        except RuntimeError:
            pass


def current() -> list[str]:
    kick()
    return list(_load()["releases"])


def info() -> dict:
    kick()
    st = _load()
    return {"releases": list(st["releases"]),
            "updated": datetime.fromtimestamp(st["ts"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": st["source"]}
