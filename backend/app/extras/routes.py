"""Routes for the "extras" half: resolve, history, overlay, sso, neossat. Shapes per docs/API.md.

Written with AI coding assistance (Claude Code); see README.
"""
from fastapi import APIRouter, HTTPException, Query, Response

from app import cache

from . import catalogs, history as hist
from .http import WEEK, UpstreamError

router = APIRouter(prefix="/api")

Ra = Query(..., ge=0.0, le=360.0)
Dec = Query(..., ge=-90.0, le=90.0)
Arcsec = Query(393.6, gt=5.0, le=3600.0)


def _bad_gateway(what: str, e: Exception):
    return HTTPException(502, f"{what} is not answering right now ({e}). Try again in a moment.")


@router.get("/resolve")
async def resolve(q: str = Query(..., min_length=1, max_length=120)):
    try:
        got = await catalogs.resolve(q)
    except UpstreamError as e:
        raise _bad_gateway("The name service (Sesame)", e)
    if got is None:
        raise HTTPException(404, f'No object named "{q.strip()}" was found. Try another name or enter coordinates.')
    return got


@router.get("/history")
async def history(ra: float = Ra, dec: float = Dec, arcsec: float = Arcsec):
    blob = await hist.history(ra % 360.0, dec, arcsec)
    return Response(blob, media_type="application/octet-stream", headers={"Cache-Control": "public, max-age=3600"})


@router.get("/overlay")
async def overlay(ra: float = Ra, dec: float = Dec, arcsec: float = Arcsec):
    key = f"v2:{ra:.5f}:{dec:.5f}:{arcsec:.1f}"
    hit = cache.get_json("overlay", key, WEEK)
    if hit is not None:
        return hit
    out = await catalogs.overlay(ra % 360.0, dec, arcsec)
    if not out["notes"]:  # an answer with a missing catalogue is not kept
        cache.put_json("overlay", key, out)
    return out


@router.get("/sso")
async def sso(ra: float = Ra, dec: float = Dec, arcsec: float = Arcsec, mjds: str = Query("", max_length=20000)):
    try:
        times = [float(x) for x in mjds.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(422, "mjds must be a comma-separated list of MJD numbers")
    if any(not (30000 < t < 90000) for t in times):
        raise HTTPException(422, "mjds must be Modified Julian Dates")
    if not times:
        return {"objects": [], "note": catalogs.SSO_NOTE, "epochs": []}
    try:
        return await catalogs.sso(ra % 360.0, dec, arcsec, times)
    except UpstreamError as e:
        raise _bad_gateway("The asteroid service (SkyBoT)", e)


@router.get("/neossat")
async def neossat(ra: float = Ra, dec: float = Dec):
    try:
        return await catalogs.neossat(ra % 360.0, dec)
    except UpstreamError as e:
        raise _bad_gateway("The NEOSSat archive (CADC)", e)
