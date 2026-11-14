"""One shared aiohttp session for S3 range reads and IRSA calls, with a concurrency cap and retries.
Written with AI coding assistance (Claude Code).
"""
import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor

import aiohttp

from .sia import S3_BASE

log = logging.getLogger("skydive.spherex")

S3_CONCURRENCY = int(os.environ.get("SKYDIVE_S3_CONCURRENCY", "48"))
UA = {"User-Agent": "sky-viewer"}

# numpy / astropy / scipy work runs here so it never blocks the event loop
POOL = ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 4), thread_name_prefix="sx")

_session: aiohttp.ClientSession | None = None
_sem: asyncio.Semaphore | None = None
_loop = None


def session() -> aiohttp.ClientSession:
    """Lazily created inside the running loop (re-created if the loop changed, e.g. in tests)."""
    global _session, _sem, _loop
    loop = asyncio.get_running_loop()
    if _session is None or _session.closed or _loop is not loop:
        conn = aiohttp.TCPConnector(limit=S3_CONCURRENCY + 16, limit_per_host=S3_CONCURRENCY + 8,
                                    ttl_dns_cache=600, keepalive_timeout=60)
        _session = aiohttp.ClientSession(connector=conn, headers=UA)
        _sem = asyncio.Semaphore(S3_CONCURRENCY)
        _loop = loop
    return _session


async def close():
    global _session
    if _session is not None and not _session.closed:
        await _session.close()
    _session = None


async def run(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(POOL, fn, *args)


class FetchError(RuntimeError):
    pass


async def s3_range(key: str, a: int | None, b: int, tries: int = 4) -> bytes:
    """Bytes a..b inclusive of an S3 object; a=None means the last b bytes."""
    sess = session()
    hdr = {"Range": f"bytes={a}-{b}" if a is not None else f"bytes=-{b}"}
    err = "?"
    for k in range(tries):
        async with _sem:
            try:
                async with sess.get(S3_BASE + key, headers=hdr,
                                    timeout=aiohttp.ClientTimeout(total=45, sock_connect=10)) as r:
                    if r.status == 206:
                        return await r.read()   # aiohttp raises on a body shorter than Content-Length
                    elif r.status in (403, 404):
                        raise FetchError(f"file not available (HTTP {r.status})")
                    else:
                        err = f"HTTP {r.status}"
            except FetchError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                err = type(e).__name__
        if k < tries - 1:
            await asyncio.sleep(0.25 * 2 ** k)
    raise FetchError(f"S3 read failed after {tries} tries ({err})")


async def get_text(url: str, *, method: str = "GET", data=None, timeout: float = 60, tries: int = 3) -> str:
    """Small text fetch (SIA, TAP) with retries."""
    sess = session()
    err = "?"
    for k in range(tries):
        try:
            async with sess.request(method, url, data=data, timeout=aiohttp.ClientTimeout(total=timeout)) as r:
                if r.status == 200:
                    return await r.text()
                err = f"HTTP {r.status}"
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            err = type(e).__name__
        if k < tries - 1:
            await asyncio.sleep(0.5 * 2 ** k)
    raise FetchError(f"{url.split('?')[0]} failed ({err})")
