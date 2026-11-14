"""Pure helpers: proper motion, dates, the north-up output grid, reprojection, SKYB encoding.

Written with AI coding assistance (Claude Code); see README.
"""
import datetime as _dt
import json
import math
import struct
import time
import warnings

import numpy as np

MJD_J2000 = 51544.5
_MJD0 = _dt.datetime(1858, 11, 17)


def mjd_to_jyear(mjd: float) -> float:
    return 2000.0 + (mjd - MJD_J2000) / 365.25


def jyear_to_mjd(jyear: float) -> float:
    return MJD_J2000 + (jyear - 2000.0) * 365.25


def mjd_now() -> float:
    return time.time() / 86400.0 + 40587.0


def mjd_to_datetime(mjd: float) -> _dt.datetime:
    return _MJD0 + _dt.timedelta(days=float(mjd))


def mjd_to_iso(mjd: float) -> str:
    return mjd_to_datetime(mjd).strftime("%Y-%m-%dT%H:%M:%S")


def mjd_to_date(mjd: float) -> str:
    return mjd_to_datetime(mjd).strftime("%Y-%m-%d")


def propagate(ra: float, dec: float, pmra: float, pmdec: float, epoch_from: float, epoch_to: float):
    """Move a position by proper motion. pm in mas/yr (pmra includes cos dec), epochs in Julian years.

    Linear in the tangent plane at the start position, which is what the browser does too;
    good to well under a WISE pixel for every star over a few decades.
    """
    dt = epoch_to - epoch_from
    xi = math.radians(pmra * dt / 3.6e6)
    eta = math.radians(pmdec * dt / 3.6e6)
    r, d = tan_to_sky(xi, eta, ra, dec)
    return float(r), float(d)


def tan_to_sky(xi, eta, ra0: float, dec0: float):
    """Tangent-plane offsets (radians; xi east, eta north) about ra0/dec0 -> ra, dec in degrees."""
    a0, d0 = math.radians(ra0), math.radians(dec0)
    den = math.cos(d0) - eta * math.sin(d0)
    ra = a0 + np.arctan2(xi, den)
    dec = np.arctan2(math.sin(d0) + eta * math.cos(d0), np.hypot(xi, den))
    return np.degrees(ra) % 360.0, np.degrees(dec)


def sky_to_tan(ra, dec, ra0: float, dec0: float):
    """ra, dec (deg) -> tangent-plane offsets in arcsec (east, north) about ra0/dec0."""
    a, d = np.radians(ra), np.radians(dec)
    a0, d0 = math.radians(ra0), math.radians(dec0)
    cosc = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    xi = np.cos(d) * np.sin(a - a0) / cosc
    eta = (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / cosc
    return np.degrees(xi) * 3600.0, np.degrees(eta) * 3600.0


def sky_to_pixel(ra, dec, ra0: float, dec0: float, n_px: int, scale: float):
    """The docs/API.md convention: col 0 = east, row 0 = north. Returns (col, row)."""
    e, n = sky_to_tan(ra, dec, ra0, dec0)
    c = n_px / 2 - 0.5
    return c - e / scale, c - n / scale


def separation_arcsec(ra1, dec1, ra2, dec2) -> float:
    a1, d1, a2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    h = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((a2 - a1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(h)))) * 3600.0


def grid_radec(ra0: float, dec0: float, n_px: int, scale: float):
    """ra, dec (deg) of every output pixel centre; arrays [row, col], row 0 north, col 0 east."""
    c = n_px / 2 - 0.5
    off = np.radians((c - np.arange(n_px)) * scale / 3600.0)
    xi, eta = np.meshgrid(off, off)  # xi varies along columns, eta along rows
    return tan_to_sky(xi, eta, ra0, dec0)


def reproject(data: np.ndarray, wcs, ra0: float, dec0: float, n_px: int, scale: float) -> np.ndarray:
    """Bilinear resample of a FITS image (any orientation; its WCS decides) onto the output grid."""
    from scipy.ndimage import map_coordinates

    ra, dec = grid_radec(ra0, dec0, n_px, scale)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        x, y = wcs.all_world2pix(ra.ravel(), dec.ravel(), 0)
    out = map_coordinates(
        np.asarray(data, dtype=np.float32), [y, x], order=1, mode="constant", cval=np.nan, prefilter=False
    )
    return out.reshape(n_px, n_px).astype(np.float32)


def encode_skyb(header: dict, arrays: list[np.ndarray]) -> bytes:
    """"SKYB" + uint32 header length + JSON + zero pad to a multiple of 4 + little-endian arrays."""
    hj = json.dumps(header, separators=(",", ":"), allow_nan=False).encode()
    pad = (-(8 + len(hj))) % 4
    parts = [b"SKYB", struct.pack("<I", len(hj)), hj, b"\0" * pad]
    for a in arrays:
        parts.append(np.ascontiguousarray(a).astype(a.dtype.newbyteorder("<"), copy=False).tobytes())
    return b"".join(parts)


def decode_skyb(blob: bytes):
    """Inverse for history-shaped files (one float32 n_px*n_px per frame). Used by tests and checks."""
    assert blob[:4] == b"SKYB"
    (h,) = struct.unpack("<I", blob[4:8])
    header = json.loads(blob[8 : 8 + h])
    pos = 8 + h + ((-(8 + h)) % 4)
    frames = []
    for f in header.get("frames", []):
        n = f["n_px"]
        frames.append(np.frombuffer(blob, "<f4", n * n, pos).reshape(n, n))
        pos += n * n * 4
    return header, frames


def sexa_to_deg(s: str, hours: bool = False) -> float:
    """"10 40 7.8562" (hours) or "-00 12 3.4" (degrees) -> decimal degrees."""
    s = s.strip().replace(":", " ")
    neg = s.startswith("-")
    p = [abs(float(x)) for x in s.lstrip("+-").split()]
    p += [0.0] * (3 - len(p))
    v = p[0] + p[1] / 60.0 + p[2] / 3600.0
    if hours:
        v *= 15.0
    return -v if neg else v


def fnum(s, default=None):
    """Lenient float: blank / junk -> default."""
    try:
        v = float(str(s).strip())
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default
