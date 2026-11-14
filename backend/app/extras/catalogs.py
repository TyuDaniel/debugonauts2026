"""/api/resolve, /api/overlay, /api/sso, /api/neossat: catalogue and name services.

Written with AI coding assistance (Claude Code); see README.
"""
import asyncio
import csv
import io
import json
import math
import re
import urllib.parse
import xml.etree.ElementTree as ET

from . import astro
from .http import DAY, WEEK, UpstreamError, client, fetch

VIZIER = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv"
SESAME = "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-ox/SNV?"
BRIGHT_WARNING = "Bright star nearby: expect ghosts and glare"
PS1_WARNING = "No Pan-STARRS coverage south of −30°"
SSO_NOTE = "Geocentric positions, approximate; near-Earth objects can be off by arcminutes"
GAIA_MAX, CATWISE_MAX, VSX_MAX = 300, 200, 200
CATWISE_EPOCH = round(astro.mjd_to_jyear(57170.0), 3)  # 2015.402
CADC = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca"


# ---------- resolve ----------

def parse_sesame(xml_text: str) -> dict | None:
    """Sesame XML -> {name, ra_j2000, dec_j2000, pmra, pmdec} or None when nothing was found."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None
    name = (root.findtext(".//Target/name") or "").strip()
    for res in root.iter("Resolver"):
        ra, dec = astro.fnum(res.findtext("jradeg")), astro.fnum(res.findtext("jdedeg"))
        if ra is None or dec is None:
            continue
        return {"name": name, "ra_j2000": ra, "dec_j2000": dec,
                "pmra": astro.fnum(res.findtext("pm/pmRA"), 0.0), "pmdec": astro.fnum(res.findtext("pm/pmDE"), 0.0)}
    return None


async def resolve(q: str) -> dict | None:
    body = await fetch(SESAME + urllib.parse.quote(q.strip()), ns="sesame", ttl=WEEK, timeout=15)
    got = parse_sesame(body.decode("utf-8", "replace"))
    if got is None:
        return None
    ra, dec = astro.propagate(got["ra_j2000"], got["dec_j2000"], got["pmra"], got["pmdec"],
                              2000.0, astro.mjd_to_jyear(astro.mjd_now()))
    return {"name": got["name"] or q.strip(), "ra": round(ra, 7), "dec": round(dec, 7), **got}


# ---------- overlay ----------

def parse_vizier_tsv(text: str) -> list[dict]:
    """VizieR asu-tsv: '#' comments, header, units, dashes, rows. Values stripped; may be ''.
    Several tables in one answer are concatenated."""
    rows, header, state = [], None, 0
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            header, state = (None, 0) if not line.strip() else (header, state)
            continue
        cells = [c.strip() for c in line.split("\t")]
        if header is None:
            header, state = cells, 1
        elif state == 1:  # units line
            state = 2
        elif state == 2:  # dashes
            state = 3
        elif len(cells) == len(header):
            rows.append(dict(zip(header, cells)))
    return rows


def gaia_rows(parsed: list[dict]) -> list[dict]:
    out = []
    for r in parsed:
        ra, dec = astro.fnum(r.get("RA_ICRS")), astro.fnum(r.get("DE_ICRS"))
        if ra is None or dec is None or not r.get("Source"):
            continue
        out.append({"cat": "gaia", "id": r["Source"], "ra": ra, "dec": dec, "epoch": 2016.0,
                    "pmra": astro.fnum(r.get("pmRA"), 0.0), "pmdec": astro.fnum(r.get("pmDE"), 0.0),
                    "plx": astro.fnum(r.get("Plx")), "mag": astro.fnum(r.get("Gmag")),
                    "color": astro.fnum(r.get("BP-RP")), "rv": astro.fnum(r.get("RV"))})
    return out


def parse_ipac_table(text: str) -> list[dict]:
    """IPAC ASCII table (IRSA Gator outfmt=1): '\\' comments, '|' header lines, whitespace rows."""
    names, rows = None, []
    for line in text.splitlines():
        if not line.strip() or line.startswith("\\"):
            continue
        if line.startswith("|"):
            if names is None:
                names = [c.strip() for c in line.strip().strip("|").split("|")]
            continue
        cells = line.split()
        if names and len(cells) == len(names):
            rows.append({k: ("" if v == "null" else v) for k, v in zip(names, cells)})
    return rows


def catwise_rows(records, limit: int = CATWISE_MAX) -> list[dict]:
    """records: dicts with the CatWISE column names (from Gator or the SCS CSV)."""
    out = []
    for r in records:
        ra, dec = astro.fnum(r.get("ra_pm")), astro.fnum(r.get("dec_pm"))
        if ra is None or dec is None:
            ra, dec = astro.fnum(r.get("ra")), astro.fnum(r.get("dec"))
        if ra is None or dec is None:
            continue
        w1 = astro.fnum(r.get("w1mpro_pm"), astro.fnum(r.get("w1mpro")))
        w2 = astro.fnum(r.get("w2mpro_pm"), astro.fnum(r.get("w2mpro")))
        pmra, pmdec = astro.fnum(r.get("pmra"), 0.0), astro.fnum(r.get("pmdec"), 0.0)
        out.append({"cat": "catwise", "id": (r.get("source_name") or "").strip(), "ra": ra, "dec": dec,
                    "epoch": CATWISE_EPOCH,
                    "pmra": round(pmra * 1000.0, 2), "pmdec": round(pmdec * 1000.0, 2),  # arcsec/yr -> mas/yr
                    "pm_sigma": _pm_sigma(pmra, pmdec, astro.fnum(r.get("sigpmra")), astro.fnum(r.get("sigpmdec"))),
                    "mag": w2, "w1": w1, "w2": w2})
    if len(out) > limit:
        # keep the significant movers whatever their brightness, then the brightest
        movers = [s for s in out if (s["pm_sigma"] or 0) >= 5 and math.hypot(s["pmra"], s["pmdec"]) >= 300]
        rest = sorted((s for s in out if s not in movers), key=lambda s: s["mag"] if s["mag"] is not None else 99)
        out = movers[:limit] + rest[: max(0, limit - len(movers))]
    return out


def _pm_sigma(pmra, pmdec, sra, sdec):
    if not sra or not sdec:
        return None
    return round(math.hypot(pmra / sra, pmdec / sdec), 1)


def vsx_rows(obj: dict, limit: int = VSX_MAX) -> list[dict]:
    lst = (obj.get("VSXObjects") or {})
    lst = lst.get("VSXObject", []) if isinstance(lst, dict) else []
    if isinstance(lst, dict):
        lst = [lst]
    out = []
    for o in lst:
        ra, dec = astro.fnum(o.get("RA2000")), astro.fnum(o.get("Declination2000"))
        if ra is None or dec is None:
            continue
        out.append({"cat": "vsx", "id": o.get("Name", ""), "name": o.get("Name", ""), "ra": ra, "dec": dec,
                    "epoch": 2000.0, "pmra": astro.fnum(o.get("ProperMotionRA"), 0.0),
                    "pmdec": astro.fnum(o.get("ProperMotionDec"), 0.0),
                    "vtype": o.get("VariabilityType") or None, "period": astro.fnum(o.get("Period")),
                    "max_mag": o.get("MaxMag") or None, "min_mag": o.get("MinMag") or None})
    return out[:limit]


GAIA_OUT = "Source,RA_ICRS,DE_ICRS,Plx,pmRA,pmDE,Gmag,BP-RP,RV"


async def _gaia(ra, dec, half_diag):
    base = {"-source": "I/355/gaiadr3", "-c": f"{ra:.6f} {dec:+.6f}", "-sort": "Gmag", "-out": GAIA_OUT}
    # 1) the brightest stars in the field itself; 2) fast movers from a wider cone, because the
    # cone is matched at 2016 positions and a star like Barnard's has since travelled 100"+.
    field = fetch(VIZIER, {**base, "-c.rs": f"{half_diag + 20:.1f}", "-out.max": GAIA_MAX},
                  ns="gaia", ttl=WEEK, timeout=25)
    movers = fetch(VIZIER, {**base, "-c.rs": f"{half_diag + 240:.1f}", "-out.max": 60, "PM": ">150"},
                   ns="gaia", ttl=WEEK, timeout=25)
    a, b = await asyncio.gather(field, movers, return_exceptions=True)
    if isinstance(a, BaseException):
        raise a
    rows = gaia_rows(parse_vizier_tsv(a.decode("utf-8", "replace")))
    if not isinstance(b, BaseException):
        seen = {r["id"] for r in rows}
        rows += [r for r in gaia_rows(parse_vizier_tsv(b.decode("utf-8", "replace"))) if r["id"] not in seen]
    return rows


async def _bright(ra, dec):
    """True when a star brighter than about magnitude 6 lies within 10'. Gaia misses the very
    brightest stars, so the Bright Star Catalogue is asked as well."""
    c = {"-c": f"{ra:.6f} {dec:+.6f}", "-c.rs": "600", "-out.max": 5}
    gaia = fetch(VIZIER, {**c, "-source": "I/355/gaiadr3", "-out": "Source,Gmag", "Gmag": "<6.2"},
                 ns="gaia", ttl=WEEK, timeout=25)
    bsc = fetch(VIZIER, {**c, "-source": "V/50/catalog", "-out": "HR,Vmag", "Vmag": "<6.2"},
                ns="gaia", ttl=WEEK, timeout=25)
    res = await asyncio.gather(gaia, bsc, return_exceptions=True)
    if all(isinstance(r, BaseException) for r in res):
        raise res[0]
    return any(parse_vizier_tsv(r.decode("utf-8", "replace")) for r in res if not isinstance(r, BaseException))


async def _catwise(ra, dec, half_diag):
    radius = half_diag + 120  # room for fast movers: positions are for 2015.4
    # Gator lets us pick columns (3-4 s); the plain cone search sends all 190 (10-25 s), so it is the fallback.
    try:
        body = await fetch("https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query",
                           {"catalog": "catwise_2020", "spatial": "cone", "objstr": f"{ra:.6f} {dec:+.6f}",
                            "radius": f"{radius:.1f}", "radunits": "arcsec", "outfmt": 1,
                            "selcols": "source_name,ra_pm,dec_pm,pmra,pmdec,sigpmra,sigpmdec,w1mpro_pm,w2mpro_pm"},
                           ns="catwise", ttl=WEEK, timeout=30, retries=0)
        text = body.decode("utf-8", "replace")
        if "source_name" not in text:
            raise UpstreamError("CatWISE (Gator) answered without a table")
        return catwise_rows(parse_ipac_table(text))
    except UpstreamError:
        body = await fetch("https://irsa.ipac.caltech.edu/SCS",
                           {"table": "catwise_2020", "RA": f"{ra:.6f}", "DEC": f"{dec:.6f}",
                            "SR": f"{radius / 3600:.6f}", "format": "csv"},
                           ns="catwise", ttl=WEEK, timeout=60)
        text = body.decode("utf-8", "replace")
        if "source_name" not in text[:2000]:
            raise UpstreamError("CatWISE answered without a table")
        return catwise_rows(csv.DictReader(io.StringIO(text)))


async def _vsx(ra, dec, half_diag):
    body = await fetch("https://vsx.aavso.org/index.php",
                       {"view": "api.list", "ra": f"{ra:.6f}", "dec": f"{dec:.6f}",
                        "radius": f"{half_diag / 3600:.6f}", "format": "json"},
                       ns="vsx", ttl=WEEK, timeout=20)
    try:
        return vsx_rows(json.loads(body))
    except json.JSONDecodeError:
        raise UpstreamError("VSX answered with something that is not JSON")


async def overlay(ra: float, dec: float, arcsec: float) -> dict:
    half_diag = arcsec / 2 * math.sqrt(2)
    jobs = {"Gaia": _gaia(ra, dec, half_diag), "CatWISE": _catwise(ra, dec, half_diag),
            "VSX": _vsx(ra, dec, half_diag), "bright": _bright(ra, dec)}
    res = dict(zip(jobs, await asyncio.gather(*jobs.values(), return_exceptions=True)))
    sources, warnings, notes = [], [], []
    for name in ("Gaia", "CatWISE", "VSX"):
        if isinstance(res[name], BaseException):
            notes.append(f"{name} unavailable: {res[name]}"[:200])
        else:
            sources += res[name]
    bright = res["bright"]
    if isinstance(bright, BaseException):
        notes.append("Bright-star check unavailable")
        bright = False
    if not bright and not isinstance(res["Gaia"], BaseException):
        bright = any(s["mag"] is not None and s["mag"] < 6.2 and
                     astro.separation_arcsec(ra, dec, s["ra"], s["dec"]) <= 600 for s in res["Gaia"])
    if bright:
        warnings.append(BRIGHT_WARNING)
    if dec <= -30:
        warnings.append(PS1_WARNING)
    return {"sources": sources, "warnings": warnings, "notes": notes}


# ---------- sso ----------

def cluster_times(mjds: list[float], window_days: float = 1 / 24, max_n: int = 12) -> list[float]:
    """Group times lying within one hour of the group's first member; return the group means,
    thinned evenly to at most max_n."""
    groups: list[list[float]] = []
    for t in sorted(mjds):
        if groups and t - groups[-1][0] <= window_days:
            groups[-1].append(t)
        else:
            groups.append([t])
    means = [sum(g) / len(g) for g in groups]
    if len(means) > max_n:
        idx = sorted({round(i * (len(means) - 1) / (max_n - 1)) for i in range(max_n)})
        means = [means[i] for i in idx]
    return [round(m, 5) for m in means]


def sso_rows(body: bytes, mjd: float) -> list[dict]:
    if not body.strip():
        return []
    data = json.loads(body)
    if not isinstance(data, list):
        raise UpstreamError("SkyBoT answered without a list")
    out = []
    for o in data:
        try:
            ra = astro.sexa_to_deg(o["RA (hms)"], hours=True)
            dec = astro.sexa_to_deg(o["DEC (dms)"])
        except (KeyError, ValueError, IndexError):
            continue
        num = o.get("Num")
        out.append({"mjd": mjd, "num": str(num) if num not in (None, "", "-") else "", "name": o.get("Name", ""),
                    "ra": round(ra, 6), "dec": round(dec, 6), "class": o.get("Class", ""),
                    "vmag": astro.fnum(o.get("VMag (mag)")), "dra": astro.fnum(o.get("dRA (arcsec/h)")),
                    "ddec": astro.fnum(o.get("dDEC (arcsec/h)"))})
    return out


async def sso(ra: float, dec: float, arcsec: float, mjds: list[float]) -> dict:
    epochs = cluster_times(mjds)
    rd = max(arcsec / 2 * math.sqrt(2) / 3600, 0.01)

    async def one(mjd):
        body = await fetch("https://ssp.imcce.fr/webservices/skybot/api/conesearch.php",
                           {"-ep": astro.mjd_to_iso(mjd), "-ra": f"{ra:.5f}", "-dec": f"{dec:.5f}", "-rd": f"{rd:.5f}",
                            "-mime": "json", "-output": "basic", "-observer": "500", "-from": "sky-viewer"},
                           ns="skybot", ttl=WEEK, timeout=30, concurrency=12, empty_status=(204,))
        return sso_rows(body, mjd)

    res = await asyncio.gather(*(one(m) for m in epochs), return_exceptions=True)
    ok = [r for r in res if not isinstance(r, BaseException)]
    if epochs and not ok:
        raise res[0]
    out = {"objects": [o for r in ok for o in r], "note": SSO_NOTE, "epochs": epochs}
    if len(ok) < len(res):
        out["note"] += f". SkyBoT failed for {len(res) - len(ok)} of {len(res)} times"
    return out


# ---------- neossat ----------

def preview_url(obs_id: str) -> str:
    """Public https; answers 303 to a signed storage URL that serves image/png inline, which an
    <img> follows without help."""
    return f"{CADC}/raven/files/cadc:NEOSSAT/{obs_id}_raw_prev_256.png"


def neossat_summary(csv_text: str, max_previews: int = 12) -> tuple[dict, list[dict]]:
    """CADC CSV -> (summary without previews, candidate preview frames spread over the date range)."""
    rows = []
    for r in csv.DictReader(io.StringIO(csv_text)):
        t = astro.fnum(r.get("time_bounds_lower"))
        oid = (r.get("observationID") or "").strip()
        if t is None or not re.fullmatch(r"[\w.\-]+", oid):
            continue
        rows.append((t, oid, astro.fnum(r.get("time_exposure"))))
    rows = sorted(set(rows))
    if not rows:
        return {"count": 0, "date_min": None, "date_max": None, "previews": []}, []
    t0, t1 = rows[0][0], rows[-1][0]
    picked, used = [], set()
    n = min(max_previews, len(rows))
    for i in range(n):
        target = t0 + (t1 - t0) * (i / (n - 1) if n > 1 else 0)
        free = [k for k in range(len(rows)) if k not in used]
        k = min(free, key=lambda k: abs(rows[k][0] - target))
        used.add(k)
        picked.append(rows[k])
    picked.sort()
    cands = [{"obs_id": oid, "date": astro.mjd_to_date(t), "url": preview_url(oid), "exposure_s": exp, "mjd": round(t, 5)}
             for t, oid, exp in picked]
    return {"count": len(rows), "date_min": astro.mjd_to_date(t0), "date_max": astro.mjd_to_date(t1)}, cands


async def _preview_exists(url: str) -> bool:
    """raven answers 303 when the file exists and 404 when not; no body is downloaded."""
    try:
        r = await client().head(url, follow_redirects=False, timeout=10)
        return r.status_code != 404
    except Exception:
        return True  # cannot tell: leave it to the browser


async def neossat(ra: float, dec: float) -> dict:
    from app import cache

    key = f"v2:{ra:.4f}:{dec:.4f}"
    hit = cache.get_json("neossat-result", key, DAY)
    if hit is not None:
        return hit
    q = ("SELECT o.observationID, o.target_name, p.time_bounds_lower, p.time_exposure "
         "FROM caom2.Observation o JOIN caom2.Plane p ON o.obsID=p.obsID "
         "WHERE o.collection='NEOSSAT' AND o.type='object' "
         f"AND INTERSECTS(POINT('ICRS',{ra:.5f},{dec:.5f}), p.position_bounds)=1")
    body = await fetch(f"{CADC}/argus/sync", {"LANG": "ADQL", "FORMAT": "csv", "QUERY": q},
                       ns="neossat", ttl=DAY, timeout=60)
    text = body.decode("utf-8", "replace")
    if "observationID" not in text[:200]:
        raise UpstreamError("CADC answered without a table")
    summary, cands = neossat_summary(text)
    ok = await asyncio.gather(*(_preview_exists(c["url"]) for c in cands))
    summary["previews"] = [c for c, good in zip(cands, ok) if good]
    cache.put_json("neossat-result", key, summary)
    return summary
