"""Tiny disk cache shared by all routes: files under backend/.cache keyed by a hash."""
import hashlib
import json
import os
import time
from pathlib import Path

# On Vercel the bundle is read-only; /tmp is the only writable place.
_DEFAULT = "/tmp/skydive" if os.environ.get("VERCEL") else Path(__file__).resolve().parent.parent / ".cache"
ROOT = Path(os.environ.get("SKYDIVE_CACHE", _DEFAULT))


def _path(ns: str, key: str) -> Path:
    h = hashlib.sha1(key.encode()).hexdigest()
    return ROOT / ns / h[:2] / h


def get_bytes(ns: str, key: str, max_age_s: float | None = None) -> bytes | None:
    p = _path(ns, key)
    try:
        if max_age_s is not None and time.time() - p.stat().st_mtime > max_age_s:
            return None
        return p.read_bytes()
    except FileNotFoundError:
        return None


def put_bytes(ns: str, key: str, data: bytes) -> None:
    p = _path(ns, key)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".tmp{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, p)


def get_json(ns: str, key: str, max_age_s: float | None = None):
    b = get_bytes(ns, key, max_age_s)
    return None if b is None else json.loads(b)


def put_json(ns: str, key: str, obj) -> None:
    put_bytes(ns, key, json.dumps(obj).encode())
