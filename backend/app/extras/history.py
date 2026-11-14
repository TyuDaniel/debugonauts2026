"""/api/history: WISE (unWISE time-resolved coadds via byw.tools) and Pan-STARRS warp frames.

Every frame is resampled onto one north-up tangent-plane grid centred on the request:
row 0 = north, column 0 = east, exactly `arcsec` on a side.

Written with AI coding assistance (Claude Code); see README.
"""
import asyncio
import io
import json
import math
import warnings

import numpy as np

from app import cache

from . import astro
from .http import DAY, WEEK, UpstreamError, fetch

WISE_SCALE = 2.75
WISE_HEDGE_S = 5.5
PS1_SCALE = 0.25
PS1_MAX_PX = 512
PS1_MIN_DEC = -30.0
PS1_NOTE = "No Pan-STARRS coverage south of -30°"
PS1_ORDER = "grizy"  # blue -> red
PS1_MAX_WARPS_PER_SEASON = 10
PS1_MAX_FILL_WARPS = 10
PS1_FILL_BELOW = 0.98   # fill holes from the other filters when less than this fraction has data
SEASON_GAP_DAYS = 100.0
CACHE_NS = "history"
CACHE_VERSION = 4

# catch_warnings() is not thread-safe and the FITS work runs in threads: silence astropy's
# header-fixing chatter once, here.
try:
    from astropy.io.fits.verify import VerifyWarning
    from astropy.wcs import FITSFixedWarning

    warnings.filterwarnings("ignore", category=FITSFixedWarning)
    warnings.filterwarnings("ignore", category=VerifyWarning)
except Exception:  # pragma: no cover
    pass


# ---------- pure parts ----------

def parse_ps1_list(text: str) -> list[dict]:
    """ps1filenames.py output -> [{filter, mjd, filename}] (bad rows skipped)."""
    lines = [ln.split() for ln in text.splitlines() if ln.strip()]
    if not lines or "filename" not in lines[0]:
        return []
    col = {name: i for i, name in enumerate(lines[0])}
    out = []
    for p in lines[1:]:
        try:
            out.append({"filter": p[col["filter"]], "mjd": float(p[col["mjd"]]), "filename": p[col["filename"]]})
        except (IndexError, ValueError):
            continue
    return out


def group_seasons(rows: list[dict], gap_days: float = SEASON_GAP_DAYS) -> list[dict]:
    """Split warps into observing seasons (a gap longer than gap_days starts a new one) and keep
    the reddest filter present in each. The season's warps in other filters are returned as
    `others` (reddest first); they are only used to fill holes. Returns [{filter, mjd, rows, others}]
    sorted by date."""
    rows = sorted((r for r in rows if r["filter"] in PS1_ORDER), key=lambda r: r["mjd"])
    seasons: list[list[dict]] = []
    for r in rows:
        if seasons and r["mjd"] - seasons[-1][-1]["mjd"] <= gap_days:
            seasons[-1].append(r)
        else:
            seasons.append([r])
    out = []
    for s in seasons:
        red = max((r["filter"] for r in s), key=PS1_ORDER.index)
        keep = [r for r in s if r["filter"] == red]
        others = sorted((r for r in s if r["filter"] != red), key=lambda r: -PS1_ORDER.index(r["filter"]))
        out.append({"filter": red, "mjd": float(np.median([r["mjd"] for r in keep])), "rows": keep, "others": others})
    return out


def thin(rows: list, n: int) -> list:
    if len(rows) <= n:
        return rows
    idx = sorted({round(i * (len(rows) - 1) / (n - 1)) for i in range(n)})
    return [rows[i] for i in idx]


def thin_exposures(rows: list[dict], n: int) -> list[dict]:
    """Like thin(), but by exposure: one exposure can appear once per sky tile, and all of its
    tiles are kept together so the frame is covered edge to edge."""
    keep = set(thin(sorted({round(r["mjd"], 4) for r in rows}), n))
    return [r for r in rows if round(r["mjd"], 4) in keep]


def wise_grid(arcsec: float) -> tuple[int, float]:
    n = max(8, round(arcsec / WISE_SCALE))
    return n, arcsec / n


def ps1_grid(arcsec: float) -> tuple[int, float]:
    n = max(8, min(PS1_MAX_PX, round(arcsec / PS1_SCALE)))
    return n, arcsec / n


def _open_fits(blob: bytes):
    from astropy.io import fits
    from astropy.wcs import WCS

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with fits.open(io.BytesIO(blob), memmap=False) as hdul:
            hdu = next(h for h in hdul if h.data is not None and h.data.ndim == 2)
            data = np.array(hdu.data, dtype=np.float32)
            hdr = hdu.header
            return data, hdr, WCS(hdr)


def wise_frame(blob: bytes, ra: float, dec: float, n_px: int, scale: float):
    data, hdr, wcs = _open_fits(blob)
    img = astro.reproject(data, wcs, ra, dec, n_px, scale)
    lo, hi = hdr.get("MJDMIN"), hdr.get("MJDMAX")
    mjd = (float(lo) + float(hi)) / 2 if lo is not None and hi is not None else None
    return img, mjd


def ps1_warp(blob: bytes, ra: float, dec: float, n_px: int, scale: float) -> np.ndarray:
    """One warp on the output grid: background-subtracted, scaled to zero point 25 mag for 1 s."""
    data, hdr, wcs = _open_fits(blob)
    img = astro.reproject(data, wcs, ra, dec, n_px, scale)
    if not np.isfinite(img).any():
        return img
    exptime = float(hdr.get("EXPTIME") or 1.0) or 1.0
    zp = hdr.get("FPA.ZP")
    zp = float(zp) if zp is not None and math.isfinite(float(zp)) and float(zp) > 0 else 25.0
    img -= np.nanmedian(img)
    img *= 10 ** (0.4 * (25.0 - zp)) / exptime
    return img


def nanmedian_stack(imgs: list[np.ndarray]) -> np.ndarray:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.nanmedian(np.stack(imgs), axis=0).astype(np.float32)


# ---------- WISE ----------

async def wise_frames(ra: float, dec: float, arcsec: float):
    tiles = json.loads(await fetch("http://byw.tools/tiles", {"ra": f"{ra:.6f}", "dec": f"{dec:.6f}"},
                                   ns="wise", ttl=WEEK, timeout=20, concurrency=32))
    tl = tiles.get("tiles") or []
    if not tl:
        raise UpstreamError("no WISE tiles at this position")
    epochs = [(int(e["band"]), int(e["epoch"]), float(e["mjdmean"])) for e in tl[0]["epochs"] if int(e["band"]) in (1, 2)]
    n_px, scale = wise_grid(arcsec)
    # the tile grid can be rotated a little against local north: ask for a margin
    size = math.ceil(arcsec * 1.08 / WISE_SCALE) + 4

    async def get(band: int, epoch: int) -> bytes:
        return await fetch("http://byw.tools/cutout",
                           {"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "size": size, "band": band, "epoch": epoch},
                           ns="wise", ttl=None, timeout=12, retries=1, concurrency=64)

    async def hedged(band: int, epoch: int) -> bytes:
        # Asked all at once the cutouts take 3-6 s each, but in most runs one or two hang for
        # 10 s or more. A second request for a straggler comes back in a second or two, so after
        # WISE_HEDGE_S we ask again and take whichever answers first.
        tasks = {asyncio.ensure_future(get(band, epoch))}
        try:
            done, _ = await asyncio.wait(tasks, timeout=WISE_HEDGE_S)
            if not done:
                tasks.add(asyncio.ensure_future(get(band, epoch)))
            err: BaseException | None = None
            pending = set(tasks)
            while pending:
                done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                for t in done:
                    if t.exception() is None:
                        return t.result()
                    err = t.exception()
            raise err or UpstreamError("byw.tools failed")
        finally:
            for t in tasks:
                if not t.done():
                    t.cancel()

    async def one(band: int, epoch: int, mjd_tile: float):
        try:
            blob = await hedged(band, epoch)
            if not blob.startswith(b"SIMPLE"):
                return None
            img, mjd = await asyncio.to_thread(wise_frame, blob, ra, dec, n_px, scale)
        except Exception:
            return None
        if not np.isfinite(img).any():
            return None
        mjd = mjd if mjd is not None else mjd_tile
        meta = {"survey": "wise", "band": f"W{band}", "mjd": round(mjd, 4), "n_px": n_px,
                "pixscale_arcsec": round(scale, 6), "label": f"WISE W{band} {astro.mjd_to_date(mjd)[:7]}"}
        return meta, img

    got = await asyncio.gather(*(one(*e) for e in epochs))
    frames = [g for g in got if g]
    if not frames:
        raise UpstreamError("no WISE cutouts came back")
    missing = len(got) - len(frames)
    note = f"WISE: {missing} of {len(got)} frames could not be loaded" if missing else None
    return frames, note


# ---------- Pan-STARRS ----------

async def ps1_frames(ra: float, dec: float, arcsec: float):
    # Warps are stored per sky tile ("skycell") and a cutout only returns the part inside its own
    # tile. A field near a tile edge needs the neighbours too, so list the warps at the centre and
    # at the four corners of the field and use every tile that turns up.
    half = arcsec * 0.45 / 3600.0
    cosd = max(0.05, math.cos(math.radians(dec)))
    spots = [(ra, dec)] + [((ra + sx * half / cosd) % 360.0, max(-89.9, min(89.9, dec + sy * half)))
                           for sx in (-1, 1) for sy in (-1, 1)]

    async def listing(r: float, d: float) -> list[dict]:
        try:
            text = (await fetch("https://ps1images.stsci.edu/cgi-bin/ps1filenames.py",
                                {"ra": f"{r:.6f}", "dec": f"{d:.6f}", "filters": "grizy", "type": "warp"},
                                ns="ps1", ttl=WEEK, timeout=20)).decode("utf-8", "replace")
        except Exception:
            return []
        return parse_ps1_list(text)

    lists = await asyncio.gather(*(listing(r, d) for r, d in spots))
    if not lists[0] and not any(lists[1:]):
        return [], "No Pan-STARRS frames at this position"
    rows_all = list({r["filename"]: r for rows in lists for r in rows}.values())
    seasons = group_seasons(rows_all)
    if not seasons:
        return [], "No Pan-STARRS frames at this position"
    n_px, scale = ps1_grid(arcsec)
    size = math.ceil(arcsec * 1.06 / PS1_SCALE) + 8          # native pixels asked for
    out_size = min(size, math.ceil(n_px * 1.06) + 8)          # the server block-averages and fixes the WCS

    async def warp(row: dict):
        params = {"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "size": size, "format": "fits", "red": row["filename"]}
        if out_size < size:
            params["output_size"] = out_size
        try:
            blob = await fetch("https://ps1images.stsci.edu/cgi-bin/fitscut.cgi", params,
                               ns="ps1", ttl=None, timeout=25, concurrency=24)
            if not blob.startswith(b"SIMPLE"):
                return None
            img = await asyncio.to_thread(ps1_warp, blob, ra, dec, n_px, scale)
        except Exception:
            return None
        return (row["mjd"], img) if np.isfinite(img).any() else None

    async def season(s: dict):
        got = [g for g in await asyncio.gather(*(warp(r) for r in thin_exposures(s["rows"], PS1_MAX_WARPS_PER_SEASON))) if g]
        if not got:
            return None
        img = await asyncio.to_thread(nanmedian_stack, [g[1] for g in got])
        mjd = float(np.median([g[0] for g in got]))
        meta = {"survey": "ps1", "band": s["filter"], "mjd": round(mjd, 4), "n_px": n_px,
                "pixscale_arcsec": round(scale, 6), "n_warps": len({round(g[0], 4) for g in got}),
                "label": f"Pan-STARRS {s['filter']} {astro.mjd_to_date(mjd)[:4]}"}
        # A warp has chip gaps and masked cells, and a season often has only one to four warps in
        # the reddest filter, so a large part of the frame can be empty. Fill those holes (and only
        # those) from the season's other filters. Sky is zero in every warp, so the join is clean;
        # sources inside a filled patch are shown at that other filter's brightness.
        others = thin_exposures(s.get("others") or [], PS1_MAX_FILL_WARPS)
        if others and np.isfinite(img).mean() < PS1_FILL_BELOW:
            rows2 = [(r, g) for r, g in zip(others, await asyncio.gather(*(warp(r) for r in others))) if g]
            if rows2:
                fill = await asyncio.to_thread(nanmedian_stack, [g[1] for _, g in rows2])
                hole = ~np.isfinite(img) & np.isfinite(fill)
                if hole.any():
                    img = img.copy()
                    img[hole] = fill[hole]
                    meta["filled_frac"] = round(float(hole.mean()), 3)
                    meta["filled_bands"] = "".join(f for f in PS1_ORDER if any(r["filter"] == f for r, _ in rows2))
        return meta, img

    got = await asyncio.gather(*(season(s) for s in seasons))
    frames = [g for g in got if g]
    if not frames:
        raise UpstreamError("no Pan-STARRS cutouts came back")
    return frames, None


# ---------- route body ----------

def _key(ra: float, dec: float, arcsec: float) -> str:
    return f"v{CACHE_VERSION}:{ra:.5f}:{dec:.5f}:{arcsec:.1f}"


async def history(ra: float, dec: float, arcsec: float) -> bytes:
    key = _key(ra, dec, arcsec)
    hit = cache.get_bytes(CACHE_NS, key)
    if hit is not None:
        return hit
    # a result with a failed survey is kept only briefly, so the next request retries it
    partial = cache.get_bytes(CACHE_NS + "-partial", key, 120)
    if partial is not None:
        return partial

    jobs = {"WISE": wise_frames(ra, dec, arcsec)}
    notes: list[str] = []
    if dec > PS1_MIN_DEC:
        jobs["Pan-STARRS"] = ps1_frames(ra, dec, arcsec)
    else:
        notes.append(PS1_NOTE)
    results = await asyncio.gather(*jobs.values(), return_exceptions=True)

    frames, failed = [], False
    for name, res in zip(jobs, results):
        if isinstance(res, BaseException):
            failed = True
            notes.append(f"{name} unavailable: {res}"[:200])
            continue
        fr, note = res
        frames += fr
        if note:
            notes.append(note)
            failed = failed or name == "WISE"
    frames.sort(key=lambda f: (f[0]["mjd"], f[0]["survey"], f[0]["band"]))
    header = {"ra": ra, "dec": dec, "arcsec": arcsec, "frames": [f[0] for f in frames], "notes": notes,
              "units": {"wise": "unWISE coadd counts (Vega zero point 22.5 mag), sky roughly subtracted: stretch by percentiles",
                        "ps1": "counts per second scaled to zero point 25 mag (AB), median sky subtracted"}}
    blob = await asyncio.to_thread(astro.encode_skyb, header, [f[1] for f in frames])
    cache.put_bytes(CACHE_NS + "-partial" if failed else CACHE_NS, key, blob)
    return blob


__all__ = ["history", "DAY"]
