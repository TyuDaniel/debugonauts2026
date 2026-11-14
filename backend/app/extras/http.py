"""Shared async HTTP client with timeout, retry and disk cache for the extras routes.

Written with AI coding assistance (Claude Code); see README.
"""
import asyncio
import urllib.parse

import httpx

from app import cache

UA = "sky-viewer"
DAY = 86400.0
WEEK = 7 * DAY

_client: httpx.AsyncClient | None = None
_client_loop = None
_sems: dict[tuple, asyncio.Semaphore] = {}


class UpstreamError(Exception):
    """An outside service failed (after the retry)."""


def client() -> httpx.AsyncClient:
    """One client per event loop (uvicorn has one; tests may make several)."""
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client_loop is not loop:
        _client = httpx.AsyncClient(
            headers={"User-Agent": UA},
            follow_redirects=True,
            limits=httpx.Limits(max_connections=256, max_keepalive_connections=64),
            timeout=httpx.Timeout(30.0, connect=10.0),
        )
        _client_loop = loop
        _sems.clear()
    return _client


def _sem(host: str, n: int) -> asyncio.Semaphore:
    key = (host, n)
    if key not in _sems:
        _sems[key] = asyncio.Semaphore(n)
    return _sems[key]


def build_url(url: str, params: dict | None) -> str:
    if not params:
        return url
    q = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    return f"{url}{'&' if '?' in url else '?'}{q}"


async def fetch(
    url: str,
    params: dict | None = None,
    *,
    ns: str,
    ttl: float | None = WEEK,
    timeout: float = 30.0,
    retries: int = 1,
    concurrency: int = 16,
    empty_status: tuple[int, ...] = (),
    use_cache: bool = True,
) -> bytes:
    """GET with disk cache. Returns the body; a status in `empty_status` gives b"".

    Only successful answers are cached. Raises UpstreamError otherwise.
    """
    full = build_url(url, params)
    if use_cache:
        hit = cache.get_bytes(ns, full, ttl)
        if hit is not None:
            return hit
    host = urllib.parse.urlsplit(full).netloc
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            async with _sem(host, concurrency):
                r = await client().get(full, timeout=timeout)
            if r.status_code in empty_status:
                body = b""
            elif r.status_code == 200:
                body = r.content
            elif r.status_code >= 500 or r.status_code == 429:
                raise UpstreamError(f"{host} answered HTTP {r.status_code}")
            else:
                # a 4xx will not get better on retry
                last = UpstreamError(f"{host} answered HTTP {r.status_code}")
                break
            if use_cache:
                cache.put_bytes(ns, full, body)
            return body
        except (httpx.HTTPError, UpstreamError) as e:
            last = e if isinstance(e, UpstreamError) else UpstreamError(f"{host}: {type(e).__name__} {e}".strip())
            if attempt < retries:
                await asyncio.sleep(0.4 * (attempt + 1))
    raise last or UpstreamError(f"{host} failed")
