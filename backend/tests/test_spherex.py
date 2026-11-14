"""Offline tests for the pure parts of the SPHEREx pipeline (no network).
Written with AI coding assistance (Claude Code).

Run from backend/:  .venv/bin/python -m pytest tests/test_spherex.py -q
"""
import json
import struct

import numpy as np
import pytest

from app.spherex import cutout, releases, sia, skyb

HEAD = ("s_ra,s_dec,energy_bandpassname,obs_id,access_url,s_region,obs_collection,t_min,t_max,"
        "cloud_access,o_ucd,upload_row_id")


def row(obs="2025W19_1B_0116_1", det=3, rel="spherex_dr1", t0=60800.700028, ver="l2b-v27-2026-197", top="dr1"):
    key = f"{top}/level2/2025W19_1B/{ver}/{det}/level2_{obs}D{det}_spx_{ver}.fits"
    poly = "POLYGON ICRS 133.25 -6.79 136.57 -7.89 135.61 -11.25 132.23 -10.13 133.25 -6.79"
    # cloud_access is unquoted JSON with commas, exactly as IRSA sends it
    cloud = '{"aws": {"bucket_name": "nasa-irsa-spherex", "key":"%s", "region": "us-east-1"}}' % key
    return (f"134.41,-9.00,SPHEREx-D{det},{obs},https://irsa.ipac.caltech.edu/ibe/data/spherex/{key},"
            f"{poly},{rel},{t0},{t0 + 0.001333},{cloud},,1")


# ---------------------------------------------------------------- SKYB

def test_skyb_layout_and_roundtrip():
    img = np.arange(16, dtype="<f4")
    flg = np.arange(16, dtype="<u4") * 3
    for pad_probe in range(4):                      # every header length modulo 4
        head = {"n_px": 4, "items": [{"id": "x" * pad_probe, "ok": True}]}
        blob = skyb.encode(head, [img, flg])
        assert blob[:4] == b"SKYB"
        (h,) = struct.unpack("<I", blob[4:8])
        assert json.loads(blob[8:8 + h]) == head
        start = (8 + h + 3) // 4 * 4
        assert start % 4 == 0 and set(blob[8 + h:start]) <= {0}
        assert len(blob) == start + 16 * 8          # no padding between arrays
        got, pay = skyb.decode(blob)
        assert got == head
        assert np.array_equal(np.frombuffer(pay[:64], "<f4"), img)
        assert np.array_equal(np.frombuffer(pay[64:], "<u4"), flg)


def test_skyb_is_little_endian_and_rejects_nan_and_garbage():
    blob = skyb.encode({}, [np.array([1.0], dtype=">f4")])
    _, pay = skyb.decode(blob)
    assert bytes(pay) == struct.pack("<f", 1.0)
    with pytest.raises(ValueError):
        skyb.encode({"bg": float("nan")})
    with pytest.raises(ValueError):
        skyb.decode(b"nope....")


# ---------------------------------------------------------------- SIA CSV

def test_sia_parse_with_unquoted_cloud_access():
    text = HEAD + "\n" + row() + "\n" + row(det=6) + "\n"
    rows = sia.parse_sia_csv(text)
    assert [r["id"] for r in rows] == ["2025W19_1B_0116_1D3", "2025W19_1B_0116_1D6"]
    r = rows[0]
    assert r["detector"] == 3 and r["release"] == "spherex_dr1"
    assert r["key"] == "dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
    assert r["url"] == sia.S3_BASE + r["key"]
    assert r["mjd"] == pytest.approx(60800.700028 + 0.001333 / 2, abs=1e-6)   # mid-exposure
    assert r["poly"][0] == (133.25, -6.79) and len(r["poly"]) == 4


def test_sia_parse_empty_and_malformed():
    assert sia.parse_sia_csv("") == []
    assert sia.parse_sia_csv(HEAD + "\n") == []
    assert sia.parse_sia_csv(HEAD + "\nshort,row\n") == []
    with pytest.raises(ValueError):
        sia.parse_sia_csv("a,b,c\n1,2,3\n")


# ---------------------------------------------------------------- de-dup

def test_dedup_prefers_newest_processing_then_release():
    old = sia.parse_sia_csv(HEAD + "\n" + row(rel="spherex_qr3", ver="l2b-v20-2025-300", top="qr"))[0]
    new = sia.parse_sia_csv(HEAD + "\n" + row(rel="spherex_dr1"))[0]
    other = sia.parse_sia_csv(HEAD + "\n" + row(det=5, t0=60790.0))[0]
    for order in ([old, new, other], [new, old, other], [other, new, old]):
        out = sia.dedup(order)
        assert [r["id"] for r in out] == [other["id"], new["id"]]      # sorted by mjd
        assert out[1]["release"] == "spherex_dr1" and "v27" in out[1]["key"]
    # same processing in two releases: the data release wins over the quick release
    a = dict(new, release="spherex_qr3")
    assert sia.dedup([a, new])[0]["release"] == "spherex_dr1"
    assert sia.dedup([new, a])[0]["release"] == "spherex_dr1"


def test_rank_helpers():
    assert sia.processing_rank("dr1/level2/x/l2b-v27-2026-197/3/f.fits") == (27, 2026, 197)
    assert sia.processing_rank("nothing") == (0, 0, 0)
    assert sia.release_rank("spherex_dr1") > sia.release_rank("spherex_qr3") > sia.release_rank("weird")
    assert sia.release_rank("spherex_dr2_deep") > sia.release_rank("spherex_dr1")


# ---------------------------------------------------------------- visits

def test_visits_split_on_gaps_over_30_days():
    mjds = [60800.7, 60801.5, 60979.7, 60993.9, 61020.8, 61022.4, 61151.2, 61174.3]   # 26.9 d gap stays inside
    visits, assign = sia.cluster_visits(mjds)
    assert [v["n"] for v in visits] == [2, 4, 2]
    assert assign == [0, 0, 1, 1, 1, 1, 2, 2]
    assert visits[1]["mjd_start"] == 60979.7 and visits[1]["mjd_end"] == 61022.4
    assert [v["id"] for v in visits] == [0, 1, 2]


def test_visits_deep_field_gets_monthly_bins():
    mjds = [60800 + 0.5 * i for i in range(400)]            # 200 days of continuous coverage
    visits, assign = sia.cluster_visits(mjds)
    assert len(visits) == 7 and sum(v["n"] for v in visits) == 400
    assert all(v["mjd_end"] - v["mjd_start"] < 30 for v in visits)
    assert assign == sorted(assign)


def test_visits_deep_field_bins_every_long_run():
    # one 200-day run makes the field deep, so the separate 80-day run is binned too
    mjds = [60000 + i for i in range(81)] + [60200 + i for i in range(201)]
    visits, _ = sia.cluster_visits(mjds)
    assert all(v["mjd_end"] - v["mjd_start"] < 30 for v in visits)
    assert [v["n"] for v in visits[:3]] == [30, 30, 21]
    # the same 80-day run alone is an ordinary visit
    assert len(sia.cluster_visits(mjds[:81])[0]) == 1


def test_visits_edge_cases():
    assert sia.cluster_visits([]) == ([], [])
    visits, assign = sia.cluster_visits([60000.0])
    assert visits == [{"id": 0, "mjd_start": 60000.0, "mjd_end": 60000.0, "n": 1}] and assign == [0]


def test_build_response_shape():
    text = HEAD + "\n" + row() + "\n" + row(rel="spherex_qr3", ver="l2b-v20-2025-300", top="qr") + "\n"
    out = sia.build_response(sia.parse_sia_csv(text), 134.4, -9.0, lambda det, x, y: (2.0 + x * 0, 0.05))
    assert out["releases"] == ["spherex_dr1", "spherex_qr3"]
    assert len(out["exposures"]) == 1
    e = out["exposures"][0]
    assert set(e) == {"id", "mjd", "detector", "wave_um", "bw_um", "release", "key", "url", "visit"}
    assert e["wave_um"] == 2.0 and e["visit"] == 0 and out["visits"][0]["n"] == 1
    assert sia.build_response([], 1, 2) == {"releases": [], "exposures": [], "visits": []}


def test_estimate_xy_recovers_corners_and_centre():
    poly = [(133.2499, -6.7924), (136.5737, -7.8939), (135.6087, -11.2523), (132.2300, -10.1273)]
    e = sia.N_DET - 0.5
    for (ra, dec), (x, y) in zip(poly, [(-0.5, -0.5), (e, -0.5), (e, e), (-0.5, e)]):
        gx, gy = sia.estimate_xy(poly, ra, dec)
        assert gx == pytest.approx(x, abs=1e-3) and gy == pytest.approx(y, abs=1e-3)
    cx, cy = sia.estimate_xy(poly, 134.4147, -9.0063)        # CRVAL of that exposure
    assert abs(cx - 1019.5) < 15 and abs(cy - 1019.5) < 15
    assert sia.estimate_xy(None, 1, 2) is None


# ---------------------------------------------------------------- grid orientation and small helpers

def test_grid_is_north_up_east_left():
    ra0, dec0, n = 133.78, -7.24, 64
    ra, dec = cutout.grid_radec(ra0, dec0, n)
    assert ra.shape == dec.shape == (n, n)
    assert dec[0, 32] > dec[-1, 32]                 # row 0 = north
    assert ra[32, 0] > ra[32, -1]                   # column 0 = east (RA increases to the east)
    step = cutout.PIXSCALE / 3600
    assert dec[31, 31] - dec[32, 31] == pytest.approx(step, rel=1e-4)
    assert (ra[31, 31] - ra[31, 32]) * np.cos(np.radians(dec0)) == pytest.approx(step, rel=1e-4)
    # the field centre falls between the four middle pixels
    assert ra[31:33, 31:33].mean() == pytest.approx(ra0, abs=1e-7)
    assert dec[31:33, 31:33].mean() == pytest.approx(dec0, abs=1e-7)


def test_hdrlen_and_mask():
    card = b"END".ljust(80)
    assert cutout.hdrlen(b" " * 2880 + (b" " * 80 + card).ljust(2880), 0) == 5760
    assert cutout.hdrlen(b" " * 2880, 0) is None
    assert not cutout.MASK & (1 << 21) and not cutout.MASK & (1 << 1) and not cutout.MASK & (1 << 19)
    assert all(cutout.MASK & (1 << b) for b in (0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 28))


def test_release_filter():
    text = "collection,count\nspherex_dr1,10\nspherex_dr1_cal,2\nspherex_qr3_deep,3\nspherex_x_cube,1\nother,5\n"
    assert releases.parse_tap_csv(text) == ["spherex_dr1", "spherex_qr3_deep"]
