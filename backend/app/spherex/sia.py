"""Pure helpers for the exposure list: SIA CSV parsing, de-duplication, visit clustering,
pre-read wavelength estimate. No network here, so it is all unit-testable offline.
Written with AI coding assistance (Claude Code).
"""
import csv
import io
import math
import re

import numpy as np

S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
KEY_MARKER = "ibe/data/spherex/"
N_DET = 2040

_NEEDED = ("obs_id", "energy_bandpassname", "access_url", "obs_collection", "t_min")


def parse_sia_csv(text: str) -> list[dict]:
    """SIA CSV -> rows with id, obs_id, detector, mjd, release, key, url, poly.

    Gotcha: the `cloud_access` column is unquoted JSON containing commas, so every column
    after it is shifted. We read by position only for columns that sit before it and take
    the S3 key from `access_url`.
    """
    rd = csv.reader(io.StringIO(text))
    try:
        head = next(rd)
    except StopIteration:
        return []
    col = {n.strip(): i for i, n in enumerate(head)}
    missing = [n for n in _NEEDED if n not in col]
    if missing:
        raise ValueError(f"SIA response lacks columns {missing}")
    limit = col.get("cloud_access", len(head))
    for n in _NEEDED:
        if col[n] >= limit:
            raise ValueError(f"SIA column {n} sits after cloud_access; cannot parse safely")

    def opt(row, name):
        i = col.get(name)
        return row[i] if i is not None and i < limit and i < len(row) else ""

    out = []
    for row in rd:
        if len(row) <= max(col[n] for n in _NEEDED):
            continue
        url = row[col["access_url"]].strip()
        m = re.search(r"D(\d)\s*$", row[col["energy_bandpassname"]])
        if KEY_MARKER not in url or not m:
            continue
        try:
            t0 = float(row[col["t_min"]])
        except ValueError:
            continue
        try:
            t1 = float(opt(row, "t_max"))
        except ValueError:
            t1 = t0
        det = int(m.group(1))
        obs = row[col["obs_id"]].strip()
        key = url.split(KEY_MARKER, 1)[1]
        poly = None
        nums = re.findall(r"[-+]?\d+\.?\d*(?:[eE][-+]?\d+)?", opt(row, "s_region"))
        if len(nums) >= 8:
            poly = [(float(nums[2 * i]), float(nums[2 * i + 1])) for i in range(4)]
        out.append({
            "id": f"{obs}D{det}", "obs_id": obs, "detector": det, "mjd": round((t0 + t1) / 2, 6),
            "release": row[col["obs_collection"]].strip(), "key": key, "url": S3_BASE + key, "poly": poly,
        })
    return out


def release_rank(release: str) -> tuple:
    """Tie-breaker between releases: data releases beat quick releases, then the higher number."""
    m = re.match(r"spherex_([a-z]+)(\d+)", release or "")
    if not m:
        return (0, 0)
    return ({"qr": 1, "dr": 2}.get(m.group(1), 0), int(m.group(2)))


def processing_rank(key: str) -> tuple:
    """(pipeline version, year, day-of-year) from a key like .../l2b-v27-2026-197/..."""
    m = re.search(r"-v(\d+)-(\d{4})-(\d{1,3})", key or "")
    return tuple(int(g) for g in m.groups()) if m else (0, 0, 0)


def newest_first_key(row: dict) -> tuple:
    return (processing_rank(row["key"]), release_rank(row["release"]), row["key"])


def dedup(rows: list[dict]) -> list[dict]:
    """One row per observation id + detector, keeping the newest processing (then newest release).
    Result is sorted by mjd, then id."""
    best: dict[str, dict] = {}
    for r in rows:
        cur = best.get(r["id"])
        if cur is None or newest_first_key(r) > newest_first_key(cur):
            best[r["id"]] = r
    return sorted(best.values(), key=lambda r: (r["mjd"], r["id"]))


def cluster_visits(mjds, gap_days: float = 30.0, deep_span_days: float = 90.0, bin_days: float = 30.0):
    """mjds must be sorted ascending. Returns (visits, visit index per exposure).

    A visit is a run of exposures with no gap above `gap_days`. If any run is longer than
    `deep_span_days` the field is a deep field (observed continuously near the ecliptic
    poles): every run longer than `bin_days` is then cut into `bin_days` bins, empty bins dropped.
    """
    mjds = [float(m) for m in mjds]
    if not mjds:
        return [], []
    runs = [[0, 0]]
    for i in range(1, len(mjds)):
        if mjds[i] - mjds[i - 1] > gap_days:
            runs.append([i, i])
        else:
            runs[-1][1] = i
    # the field is "deep" if any run is long; then every run longer than a bin is cut monthly
    deep = any(mjds[b] - mjds[a] > deep_span_days for a, b in runs)
    groups: list[list[int]] = []
    for a, b in runs:
        span = mjds[b] - mjds[a]
        if deep and span > bin_days:
            bins: dict[int, list[int]] = {}
            for i in range(a, b + 1):
                bins.setdefault(int((mjds[i] - mjds[a]) // bin_days), []).append(i)
            groups.extend(bins[k] for k in sorted(bins))
        else:
            groups.append(list(range(a, b + 1)))
    visits, assign = [], [0] * len(mjds)
    for vid, g in enumerate(groups):
        visits.append({"id": vid, "mjd_start": mjds[g[0]], "mjd_end": mjds[g[-1]], "n": len(g)})
        for i in g:
            assign[i] = vid
    return visits, assign


def _tan(ra, dec, ra0, dec0):
    """Gnomonic projection (degrees in, radians out) about ra0, dec0."""
    a, d, a0, d0 = (math.radians(v) for v in (ra, dec, ra0, dec0))
    c = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(a - a0)
    return (math.cos(d) * math.sin(a - a0) / c,
            (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(a - a0)) / c)


def estimate_xy(poly, ra: float, dec: float):
    """Approximate 0-based detector pixel of (ra, dec) from the SIA footprint polygon.

    The four vertices are the detector corners in the order (0,0), (N,0), (N,N), (0,N).
    Two gnomonic planes are related by a homography, so four corners fix it exactly apart
    from optical distortion (a few pixels).
    """
    if not poly or len(poly) < 4:
        return None
    src = [_tan(p[0], p[1], ra, dec) for p in poly[:4]]
    e = N_DET - 0.5
    dst = [(-0.5, -0.5), (e, -0.5), (e, e), (-0.5, e)]
    a, b = [], []
    for (u, v), (x, y) in zip(src, dst):
        a.append([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.append(x)
        a.append([0, 0, 0, u, v, 1, -u * y, -v * y]); b.append(y)
    try:
        h = np.linalg.solve(np.array(a), np.array(b))
    except np.linalg.LinAlgError:
        return None
    return float(h[2]), float(h[5])   # target is the projection origin (u = v = 0)


def build_response(rows: list[dict], ra: float, dec: float, wave_fn=None) -> dict:
    """rows: output of parse_sia_csv. wave_fn(detector, x, y) -> (wave, bw) or None."""
    releases = sorted({r["release"] for r in rows})
    rows = dedup(rows)
    visits, assign = cluster_visits([r["mjd"] for r in rows])
    exps = []
    for r, v in zip(rows, assign):
        wave = bw = None
        if wave_fn is not None:
            xy = estimate_xy(r.get("poly"), ra, dec)
            if xy is not None:
                wb = wave_fn(r["detector"], xy[0], xy[1])
                if wb is not None and all(math.isfinite(t) for t in wb):
                    wave, bw = round(wb[0], 4), round(wb[1], 4)
        exps.append({"id": r["id"], "mjd": r["mjd"], "detector": r["detector"], "wave_um": wave, "bw_um": bw,
                     "release": r["release"], "key": r["key"], "url": r["url"], "visit": v})
    return {"releases": releases, "exposures": exps, "visits": visits}
