"""SPHEREx routes: /api/releases, /api/exposures, /api/cutouts (shapes fixed by docs/API.md).
Written with AI coding assistance (Claude Code).
"""
import asyncio
from http import HTTPStatus
import math
import time

from fastapi import APIRouter, HTTPException, Request, Response

from .. import cache
from . import cutout as cut
from . import net, releases, sia, skyb

router = APIRouter()

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
SIA_RADIUS = 0.0003
SIA_MAX_AGE_S = 86400
MAX_IDS = 32
MIN_PX, MAX_PX = 8, 512

# id -> {"key", "detector"}; filled by every exposure listing (the SIA disk cache is the durable copy)
_ids: dict[str, dict] = {}
_listing: dict[str, tuple[float, dict]] = {}      # short-lived memory copy of built responses
_sia_locks: dict[str, asyncio.Lock] = {}


def _startup():
    releases.kick()


async def _shutdown():
    await net.close()


router.add_event_handler("startup", _startup)
router.add_event_handler("shutdown", _shutdown)


def _check_pos(ra, dec) -> tuple[float, float]:
    try:
        ra, dec = float(ra), float(dec)
    except (TypeError, ValueError):
        raise HTTPException(400, "ra and dec are required, in decimal degrees")
    if not (math.isfinite(ra) and math.isfinite(dec) and -90 <= dec <= 90):
        raise HTTPException(400, "ra and dec must be finite, with dec between -90 and 90")
    return ra % 360.0, dec


@router.get("/api/releases")
async def get_releases():
    return releases.info()


def _wave_fn(det: int, x: float, y: float):
    wt = cut._wave.get(det)
    if wt is None:
        return None
    wl, bw = wt.at(x, y)
    return float(wl[0]), float(bw[0])


async def _sia_text(ra: float, dec: float, rels: list[str]) -> str:
    ck = f"{ra:.5f}:{dec:.5f}:{','.join(rels)}"
    text = cache.get_bytes("sxsia", ck, SIA_MAX_AGE_S)
    if text is not None:
        return text.decode()
    async with _sia_locks.setdefault(ck, asyncio.Lock()):
        text = cache.get_bytes("sxsia", ck, SIA_MAX_AGE_S)
        if text is not None:
            return text.decode()
        q = "&".join("COLLECTION=" + c for c in rels)
        url = f"{SIA_URL}?{q}&POS=circle+{ra:.6f}+{dec:.6f}+{SIA_RADIUS}&RESPONSEFORMAT=CSV"
        try:
            body = await net.get_text(url, timeout=90)
            if "obs_id" not in body.split("\n", 1)[0]:
                raise net.FetchError("IRSA SIA returned an unexpected response")
        except net.FetchError as e:
            stale = cache.get_bytes("sxsia", ck)          # an old answer beats no answer
            if stale is not None:
                return stale.decode()
            raise HTTPException(502, f"SPHEREx archive search failed: {e}")
        cache.put_bytes("sxsia", ck, body.encode())
        return body


async def list_exposures(ra: float, dec: float) -> dict:
    rels = releases.current()
    mk = f"{ra:.5f}:{dec:.5f}:{','.join(rels)}"
    hit = _listing.get(mk)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    text = await _sia_text(ra, dec, rels)
    rows = await net.run(sia.parse_sia_csv, text)
    # one wave table per detector, fetched once ever; a failure only costs the pre-read estimate
    need = {}
    for r in rows:
        if r["detector"] not in cut._wave:
            need.setdefault(r["detector"], r["key"])
    complete = True
    if need:
        res = await asyncio.gather(*[asyncio.wait_for(cut.wave_table(d, k), 15) for d, k in need.items()],
                                   return_exceptions=True)
        complete = not any(isinstance(r, BaseException) for r in res)
    out = await net.run(sia.build_response, rows, ra, dec, _wave_fn)
    for e in out["exposures"]:
        _ids[e["id"]] = {"key": e["key"], "detector": e["detector"]}
    if complete:
        if len(_listing) > 200:
            _listing.clear()
        _listing[mk] = (time.time(), out)
    return out


@router.get("/api/exposures")
async def get_exposures(ra=None, dec=None):
    ra, dec = _check_pos(ra, dec)
    return await list_exposures(ra, dec)


@router.post("/api/cutouts")
async def post_cutouts(request: Request):
    try:
        body = await request.json()
        assert isinstance(body, dict)
    except Exception:
        raise HTTPException(400, "body must be JSON: {ra, dec, n_px, ids}")
    ra, dec = _check_pos(body.get("ra"), body.get("dec"))
    n_px = body.get("n_px", 64)
    if not isinstance(n_px, int) or isinstance(n_px, bool) or not MIN_PX <= n_px <= MAX_PX:
        raise HTTPException(400, f"n_px must be an integer from {MIN_PX} to {MAX_PX}")
    ids = body.get("ids")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
        raise HTTPException(400, "ids must be a non-empty list of exposure ids")
    if len(ids) > MAX_IDS:
        raise HTTPException(400, f"at most {MAX_IDS} ids per request")

    if any(i not in _ids for i in ids):          # e.g. after a restart: rebuild the id -> key map
        try:
            await list_exposures(ra, dec)
        except HTTPException:
            pass
    specs = [(i, _ids[i]["key"]) if i in _ids else None for i in ids]
    known = [s for s in specs if s]
    cached = iter(await net.run(cut.load_cached_many, known, ra, dec, n_px)) if known else iter(())

    async def one(spec, hit):
        if spec is None:
            return CutoutFail("unknown exposure id for this position")
        if hit is not None:
            return hit
        try:
            return await cut.cutout(spec[0], spec[1], _ids[spec[0]]["detector"], ra, dec, n_px)
        except (cut.CutoutError, net.FetchError) as e:
            return CutoutFail(str(e))
        except Exception as e:  # one bad file must not sink the batch
            net.log.exception("cutout failed for %s", spec[0])
            return CutoutFail(f"cutout failed ({type(e).__name__})")

    results = await asyncio.gather(*[one(s, next(cached) if s else None) for s in specs])
    return await _pack_cutouts(ra, dec, n_px, ids, results)


async def _pack_cutouts(ra: float, dec: float, n_px: int, ids: list[str], results: list) -> Response:
    """One binary response (skyb) holding each exposure's meta, image and flags, or its failure."""
    names: dict[str, str] = {}
    items, arrays = [], []
    for i, r in zip(ids, results):
        if isinstance(r, CutoutFail):
            items.append({"id": i, "ok": False, "error": r.msg})
            continue
        meta, ib, fb = r
        meta = dict(meta)
        names.update(meta.pop("flag_names", {}))
        items.append({"id": i, **meta})
        arrays += [ib, fb]
    header = {"ra": ra, "dec": dec, "n_px": n_px, "pixscale_arcsec": cut.PIXSCALE,
              "flag_names": dict(sorted(names.items(), key=lambda kv: int(kv[0]))),
              "mask_bits": list(cut.MASK_BITS), "items": items}
    blob = await net.run(skyb.encode, header, arrays)
    return Response(blob, media_type="application/octet-stream")


@router.get("/api/bundle")
async def get_bundle(ra=None, dec=None, n_px=None):
    """Every cutout already cached for this field, in one response (gzip-compressed in transit).
    A field someone has opened before then loads with no requests to the SPHEREx archive;
    204 when nothing is cached yet."""
    ra, dec = _check_pos(ra, dec)
    try:
        n = int(n_px)
    except (TypeError, ValueError):
        raise HTTPException(400, f"n_px must be an integer from {MIN_PX} to {MAX_PX}")
    if not MIN_PX <= n <= MAX_PX:
        raise HTTPException(400, f"n_px must be an integer from {MIN_PX} to {MAX_PX}")
    listing = await list_exposures(ra, dec)
    specs = [(e["id"], e["key"]) for e in listing["exposures"]]
    cached = await net.run(cut.load_cached_many, specs, ra, dec, n)
    hits = [(i, r) for (i, _), r in zip(specs, cached) if r is not None]
    if not hits:
        return Response(status_code=HTTPStatus.NO_CONTENT)
    return await _pack_cutouts(ra, dec, n, [i for i, _ in hits], [r for _, r in hits])


class CutoutFail:
    def __init__(self, msg: str):
        self.msg = msg
