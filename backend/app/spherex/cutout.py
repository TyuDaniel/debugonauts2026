"""SPHEREx Level-2 byte-range cutouts: read only the rows we need from the 66 MB file on S3,
decode, and reproject onto a north-up TAN grid. Ported from reference/spike/sx.py + stk.py.
Written with AI coding assistance (Claude Code).

File layout: primary | IMAGE (float32 2040x2040, MJy/sr) | FLAGS (Rice, one tile per row) |
VARIANCE | ZODI | EPSF | WCS-WAVE. Header lengths vary between files, so they are measured.
"""
import asyncio
import logging
import math
import warnings
import zlib

import numpy as np
from astropy.io import fits
from astropy.io.fits.hdu.compressed._codecs import Rice1
from astropy.wcs import WCS
from scipy.interpolate import RegularGridInterpolator
from scipy.ndimage import map_coordinates

from .. import cache
from . import net, skyb

warnings.filterwarnings("ignore", module=r"astropy\..*")
logging.getLogger("astropy").setLevel(logging.ERROR)

N = 2040
NPIXB = N * N * 4               # IMAGE data bytes (a multiple of 2880)
IMG_HDR_GUESS = 23040           # typical IMAGE header; verified per file
FLG_HDR_GUESS = 17280
HEAD_READ = 2880 + IMG_HDR_GUESS + 2880
PIXSCALE = 6.15                 # arcsec per output pixel

MASK_BITS = (0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28)
MASK = sum(1 << b for b in MASK_BITS)
SOURCE = 1 << 21

LAYOUT_VERSION = "1"
CUTOUT_VERSION = "1"


class CutoutError(Exception):
    """Per-exposure failure with a message fit for the user."""


# ---------------------------------------------------------------- pure helpers

def hdrlen(buf: bytes, off: int = 0) -> int | None:
    """Length of the FITS header that starts at `off`, or None if END is not in the buffer."""
    n = 0
    while off + n + 2880 <= len(buf):
        blk = buf[off + n:off + n + 2880]
        n += 2880
        for i in range(0, 2880, 80):
            if blk[i:i + 8] == b"END     ":
                return n
    return None


def grid_radec(ra0: float, dec0: float, n: int, scale: float = PIXSCALE):
    """RA/Dec of every output pixel centre. Row 0 = north, column 0 = east (docs/API.md)."""
    c = n / 2 - 0.5
    east = np.radians((c - np.arange(n)) * scale / 3600.0)
    xi, eta = np.meshgrid(east, east.copy(), indexing="xy")     # xi varies with column, eta with row
    return tan_inv(xi, eta, ra0, dec0)


def tan_inv(xi, eta, ra0: float, dec0: float):
    """Tangent-plane offsets (radians; xi east, eta north) -> RA, Dec in degrees."""
    d0 = math.radians(dec0)
    den = math.cos(d0) - eta * math.sin(d0)
    ra = ra0 + np.degrees(np.arctan2(xi, den))
    dec = np.degrees(np.arctan2(math.sin(d0) + eta * math.cos(d0), np.hypot(xi, den)))
    return ra, dec


def flag_names(fhdr) -> dict[str, str]:
    """{"bit": "NAME"} from the MSKNnnnn cards of a FLAGS header."""
    out = {}
    for k in fhdr.keys():
        if k.startswith("MSKN") and k[4:].isdigit():
            out[str(int(k[4:]))] = str(fhdr[k]).strip()
    return out


class WaveTable:
    """WCS-WAVE lookup: wavelength and bandwidth (um) on a coarse detector grid, bilinear."""

    def __init__(self, raw: bytes):
        i = raw.rfind(b"XTENSION= 'BINTABLE'")
        if i < 0:
            raise ValueError("no WCS-WAVE table in the file tail")
        t = fits.BinTableHDU.fromstring(raw[i:])
        if t.header.get("EXTNAME", "").strip() != "WCS-WAVE":
            raise ValueError("last extension is not WCS-WAVE")
        x = t.data["X"][0].astype(float)
        y = t.data["Y"][0].astype(float)
        v = np.asarray(t.data["VALUES"][0], dtype=float).reshape(len(y), len(x), 2)
        # control points are 1-based FITS pixels; strictly increasing is required
        self._f = [RegularGridInterpolator((y, x), v[:, :, k], bounds_error=False, fill_value=None)
                   for k in (0, 1)]

    def at(self, x, y):
        """0-based detector pixel(s) -> (wavelength, bandwidth) arrays."""
        p = np.stack([np.atleast_1d(np.asarray(y, float)) + 1.0, np.atleast_1d(np.asarray(x, float)) + 1.0], -1)
        return self._f[0](p), self._f[1](p)


# ---------------------------------------------------------------- wave tables (per detector, forever)

_wave: dict[int, WaveTable] = {}
_wave_locks: dict[int, asyncio.Lock] = {}


def wave_table_cached(det: int) -> WaveTable | None:
    wt = _wave.get(det)
    if wt is None:
        raw = cache.get_bytes("sxwave", f"D{det}")
        if raw:
            try:
                wt = _wave[det] = WaveTable(raw)
            except Exception:
                wt = None
    return wt


async def wave_table(det: int, key: str) -> WaveTable:
    """The table is identical for every file of a detector: fetch once from any file."""
    wt = _wave.get(det) or await net.run(wave_table_cached, det)
    if wt is not None:
        return wt
    lock = _wave_locks.setdefault(det, asyncio.Lock())
    async with lock:
        if det in _wave:
            return _wave[det]
        raw = await net.s3_range(key, None, 11520)
        wt = await net.run(WaveTable, raw)
        i = raw.rfind(b"XTENSION= 'BINTABLE'")
        cache.put_bytes("sxwave", f"D{det}", raw[i:])
        _wave[det] = wt
        return wt


# ---------------------------------------------------------------- per-file layout (header + flag row index)

def _pack_layout(lay: dict) -> bytes:
    blobs = [lay["img_hdr"], lay["flg_hdr"], lay["idx"]]
    head = {"img_data": lay["img_data"], "flg_data": lay["flg_data"], "lens": [len(b) for b in blobs]}
    return zlib.compress(skyb.encode(head, blobs), 1)


def _unpack_layout(raw: bytes) -> dict:
    head, pay = skyb.decode(zlib.decompress(raw))
    a, b, c = head["lens"]
    pay = bytes(pay)
    return {"img_data": head["img_data"], "flg_data": head["flg_data"],
            "img_hdr": pay[:a], "flg_hdr": pay[a:a + b], "idx": pay[a + b:a + b + c]}


async def get_layout(key: str) -> dict:
    """IMAGE header, FLAGS header and the 2040-entry flag row index of one file (disk cached)."""
    ck = f"{LAYOUT_VERSION}:{key}"
    raw = cache.get_bytes("sxlayout", ck)
    if raw:
        try:
            return _unpack_layout(raw)
        except Exception:
            pass
    flg_guess = 2880 + IMG_HDR_GUESS + NPIXB
    flg_len = FLG_HDR_GUESS + N * 8 + 2880
    head, fb = await asyncio.gather(net.s3_range(key, 0, HEAD_READ - 1),
                                    net.s3_range(key, flg_guess, flg_guess + flg_len - 1))
    p = hdrlen(head, 0)
    ih = hdrlen(head, p) if p else None
    if ih is None:                                   # header longer than the guess
        head = await net.s3_range(key, 0, 144000 - 1)
        p = hdrlen(head, 0)
        ih = hdrlen(head, p) if p else None
        if ih is None:
            raise CutoutError("unexpected file layout (IMAGE header not found)")
    img_data = p + ih
    flg_off = img_data + NPIXB
    if flg_off != flg_guess:
        fb = await net.s3_range(key, flg_off, flg_off + flg_len - 1)
    fh = hdrlen(fb, 0)
    if fh is None or len(fb) < fh + N * 8:
        fb = await net.s3_range(key, flg_off, flg_off + 57600 + N * 8 - 1)
        fh = hdrlen(fb, 0)
        if fh is None or len(fb) < fh + N * 8:
            raise CutoutError("unexpected file layout (FLAGS header not found)")
    lay = {"img_data": img_data, "flg_data": flg_off + fh, "img_hdr": head[p:p + ih],
           "flg_hdr": fb[:fh], "idx": fb[fh:fh + N * 8]}
    cache.put_bytes("sxlayout", ck, _pack_layout(lay))
    return lay


# ---------------------------------------------------------------- plan (which bytes) and finish (pixels)

def make_plan(lay: dict, ra: float, dec: float, n_px: int) -> dict:
    """CPU step 1: WCS, detector coordinates of the output grid, byte ranges to read."""
    hdr = fits.Header.fromstring(lay["img_hdr"].decode("ascii", "replace"))
    fhdr = fits.Header.fromstring(lay["flg_hdr"].decode("ascii", "replace"))
    if not (fhdr.get("ZCMPTYPE") == "RICE_1" and fhdr.get("ZTILE1") == N and fhdr.get("ZTILE2") == 1
            and fhdr.get("NAXIS1") == 8 and hdr.get("NAXIS1") == N and hdr.get("NAXIS2") == N
            and hdr.get("BITPIX") == -32):
        raise CutoutError("unexpected file layout")
    w = WCS(hdr)
    gra, gdec = grid_radec(ra, dec, n_px)
    s = math.radians(PIXSCALE / 3600.0)
    # centre, then one output pixel east, west, north, south (for the wavelength gradient)
    era, edec = tan_inv(np.array([0, s, -s, 0, 0]), np.array([0, 0, 0, s, -s]), ra, dec)
    x, y = w.all_world2pix(np.concatenate([gra.ravel(), era]), np.concatenate([gdec.ravel(), edec]), 0,
                           quiet=True)
    ex, ey = x[-5:], y[-5:]
    xg = x[:-5].reshape(n_px, n_px)
    yg = y[:-5].reshape(n_px, n_px)
    if not (np.isfinite(ex[0]) and -0.5 <= ex[0] < N - 0.5 and -0.5 <= ey[0] < N - 0.5):
        raise CutoutError("target off detector")
    fin = np.isfinite(xg) & np.isfinite(yg)
    y0 = max(int(math.floor(np.min(yg[fin]))) - 1, 0)
    y1 = min(int(math.ceil(np.max(yg[fin]))) + 2, N)
    x0 = max(int(math.floor(np.min(xg[fin]))) - 1, 0)
    x1 = min(int(math.ceil(np.max(xg[fin]))) + 2, N)
    if y1 <= y0 or x1 <= x0:
        raise CutoutError("target off detector")
    idx = np.frombuffer(lay["idx"], dtype=">i4").reshape(N, 2)[y0:y1].astype(np.int64)   # (nbytes, heap offset)
    heap = lay["flg_data"] + int(fhdr.get("THEAP", N * 8))
    nz = idx[:, 0] > 0
    if nz.any():
        fa = int(idx[nz, 1].min())
        fb = int((idx[nz, 1] + idx[nz, 0]).max())
    else:
        fa = fb = 0
    return {
        "xg": xg, "yg": yg, "ex": ex, "ey": ey, "box": (y0, y1, x0, x1), "idx": idx,
        "img_range": (lay["img_data"] + y0 * N * 4, lay["img_data"] + y1 * N * 4 - 1),
        "flg_range": (heap + fa, heap + fb - 1) if fb > fa else None, "flg_base": fa,
        "rice": (int(fhdr.get("ZVAL1", 32)), int(fhdr.get("ZVAL2", 4))),
        "mjd": float(hdr.get("MJD-AVG", hdr.get("MJD-OBS", float("nan")))),
        "detector": int(hdr.get("DETECTOR", 0)), "flag_names": flag_names(fhdr), "n_px": n_px,
    }


def decode_flags(plan: dict, raw: bytes | None) -> np.ndarray:
    """Rice-decode the fetched rows -> int32 (rows, cols) for the plan's box."""
    y0, y1, x0, x1 = plan["box"]
    out = np.zeros((y1 - y0, x1 - x0), dtype=np.int32)
    if raw is None:
        return out
    blocksize, bytepix = plan["rice"]
    codec = Rice1(blocksize=blocksize, bytepix=bytepix, tilesize=N)
    buf = np.frombuffer(raw, dtype=np.uint8)
    dt = {4: "i4", 2: "i2", 1: "i1"}[bytepix]
    for j, (nb, off) in enumerate(plan["idx"]):
        if nb:
            a = int(off) - plan["flg_base"]
            row = np.frombuffer(codec.decode(buf[a:a + int(nb)]), dtype=dt)
            out[j] = row[x0:x1]
    return out


def finish(plan: dict, img_raw: bytes, flg_raw: bytes | None, wt: WaveTable | None) -> tuple[dict, np.ndarray, np.ndarray]:
    """CPU step 2: decode, reproject (bilinear image, nearest flags), background, metadata."""
    y0, y1, x0, x1 = plan["box"]
    n = plan["n_px"]
    xg, yg = plan["xg"], plan["yg"]
    if len(img_raw) != (y1 - y0) * N * 4:
        raise CutoutError("short read of image rows")
    sub = np.frombuffer(img_raw, dtype=">f4").reshape(y1 - y0, N)[:, x0:x1].astype(np.float32)
    img = map_coordinates(sub, [yg - y0, xg - x0], order=1, mode="constant", cval=np.nan,
                          output=np.float32, prefilter=False)
    fsub = decode_flags(plan, flg_raw)
    xi = np.rint(xg).astype(np.int64)
    yi = np.rint(yg).astype(np.int64)
    inside = (xi >= 0) & (xi < N) & (yi >= 0) & (yi < N) & np.isfinite(xg) & np.isfinite(yg)
    flags = np.zeros((n, n), dtype=np.uint32)
    flags[inside] = fsub[yi[inside] - y0, xi[inside] - x0].astype(np.uint32)

    fin = np.isfinite(img)
    good = fin & ((flags & (MASK | SOURCE)) == 0)
    if good.sum() < 50:
        good = fin & ((flags & MASK) == 0)
    if good.sum() < 10:
        good = fin
    bg = float(np.median(img[good])) if good.any() else None
    if bg is not None:
        img -= np.float32(bg)
    n_in = int(inside.sum())
    flag_frac = float(((flags & MASK) != 0)[inside].sum() / n_in) if n_in else 0.0

    meta = {"ok": True, "mjd": round(plan["mjd"], 6) if math.isfinite(plan["mjd"]) else None, "detector": plan["detector"],
            "wave_um": None, "bw_um": None, "dwave_dx": None, "dwave_dy": None,
            "bg": None if bg is None else round(bg, 6), "flag_frac": round(flag_frac, 4)}
    if wt is not None:
        wl, bw = wt.at(plan["ex"], plan["ey"])      # centre, east, west, north, south
        if np.isfinite(wl[0]):
            meta["wave_um"] = round(float(wl[0]), 5)
            meta["bw_um"] = round(float(bw[0]), 5)
            meta["dwave_dx"] = round(float(wl[2] - wl[1]) / 2, 7)    # +col = west
            meta["dwave_dy"] = round(float(wl[4] - wl[3]) / 2, 7)    # +row = south
    return meta, img, flags


# ---------------------------------------------------------------- one exposure, with the finished-cutout cache

def _ckey(exp_id: str, key: str, ra: float, dec: float, n_px: int) -> str:
    return f"{CUTOUT_VERSION}:{exp_id}:{key}:{ra:.7f}:{dec:.7f}:{n_px}"


def _load_cached(ck: str, n_px: int):
    raw = cache.get_bytes("sxcut", ck)
    if not raw:
        return None
    try:
        meta, pay = skyb.decode(raw)
        npx = n_px * n_px * 4
        if len(pay) != 2 * npx:
            return None
        return meta, bytes(pay[:npx]), bytes(pay[npx:])
    except Exception:
        return None


def load_cached_many(specs: list[tuple[str, str]], ra: float, dec: float, n_px: int) -> list:
    """Disk lookups for a whole batch in one thread hop."""
    return [_load_cached(_ckey(i, k, ra, dec, n_px), n_px) for i, k in specs]


async def cutout(exp_id: str, key: str, det_hint: int | None, ra: float, dec: float, n_px: int):
    """-> (meta, image bytes float32 LE, flags bytes uint32 LE). meta includes "flag_names".
    Raises CutoutError / FetchError."""
    lay = await get_layout(key)
    plan = await net.run(make_plan, lay, ra, dec, n_px)
    jobs = [net.s3_range(key, *plan["img_range"])]
    if plan["flg_range"]:
        jobs.append(net.s3_range(key, *plan["flg_range"]))
    det = plan["detector"] or det_hint or 0
    jobs_w = wave_table(det, key)
    res = await asyncio.gather(*jobs, jobs_w, return_exceptions=True)
    wt = res[-1] if isinstance(res[-1], WaveTable) else None
    for r in res[:-1]:
        if isinstance(r, BaseException):
            raise r
    img_raw = res[0]
    flg_raw = res[1] if plan["flg_range"] else None
    meta, img, flags = await net.run(finish, plan, img_raw, flg_raw, wt)
    meta["flag_names"] = plan["flag_names"]
    ib, fb = img.astype("<f4", copy=False).tobytes(), flags.astype("<u4", copy=False).tobytes()
    if wt is not None:                       # do not freeze a result that lacks its wavelength
        await net.run(cache.put_bytes, "sxcut", _ckey(exp_id, key, ra, dec, n_px), skyb.encode(meta, [ib, fb]))
    return meta, ib, fb
