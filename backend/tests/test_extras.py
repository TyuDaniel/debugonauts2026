"""Offline tests for the pure parts of app.extras. Written with AI coding assistance (Claude Code)."""
import json
import struct

import numpy as np
import pytest

from app.extras import astro, catalogs, history


def test_propagate_barnard():
    # Gaia DR3 row at 2016.0 back to J2000 should land on the Simbad J2000 position
    ra, dec = astro.propagate(269.44850252544, 4.73942005111, -801.551, 10362.394, 2016.0, 2000.0)
    assert astro.separation_arcsec(ra, dec, 269.45207696, 4.69336497) < 0.05
    # 14 years of motion: about 145", almost all of it north
    ra2, dec2 = astro.propagate(269.452, 4.693, -801.551, 10362.394, 2010.0, 2024.0)
    assert (dec2 - 4.693) * 3600 == pytest.approx(145.07, abs=0.05)
    assert astro.separation_arcsec(269.452, 4.693, ra2, dec2) == pytest.approx(145.5, abs=0.1)
    assert ra2 < 269.452  # negative pmra = west = smaller RA


def test_propagate_zero_and_wrap():
    assert astro.propagate(10.0, 20.0, 0, 0, 2000.0, 2026.0) == pytest.approx((10.0, 20.0))
    ra, _ = astro.propagate(0.0001, 0.0, -3600000.0, 0, 2000.0, 2001.0)  # one degree west across RA 0
    assert ra == pytest.approx(359.0001, abs=1e-3)


def test_pixel_convention():
    # north of centre -> smaller row; east of centre -> smaller column
    n, s = 64, 6.15
    c = n / 2 - 0.5
    col, row = astro.sky_to_pixel(100.0, 10.0, 100.0, 10.0, n, s)
    assert (col, row) == pytest.approx((c, c))
    col, row = astro.sky_to_pixel(100.0, 10.0 + 61.5 / 3600, 100.0, 10.0, n, s)
    assert (col, row) == pytest.approx((c, c - 10), abs=1e-3)
    col, row = astro.sky_to_pixel(100.0 + 61.5 / 3600 / np.cos(np.radians(10)), 10.0, 100.0, 10.0, n, s)
    assert (col, row) == pytest.approx((c - 10, c), abs=1e-3)
    ra, dec = astro.grid_radec(100.0, 10.0, n, s)
    assert dec[0, 5] > dec[-1, 5] and ra[5, 0] > ra[5, -1]
    assert (dec[0, 0] - dec[-1, 0]) * 3600 == pytest.approx((n - 1) * s, rel=1e-3)


def test_reproject_flips_fits_to_north_up_east_left():
    from astropy.wcs import WCS

    # an ordinary FITS image: row 0 south, RA decreasing with x; one bright pixel north-east of centre
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [50.0, -20.0]
    w.wcs.crpix = [21.0, 21.0]  # 0-based pixel 20,20 is the centre
    w.wcs.cdelt = [-2.0 / 3600, 2.0 / 3600]
    img = np.zeros((41, 41), np.float32)
    img[30, 12] = 1.0  # y=30 (north by 10 px), x=12 (east by 8 px)
    out = astro.reproject(img, w, 50.0, -20.0, 41, 2.0)
    row, col = np.unravel_index(np.nanargmax(out), out.shape)
    assert (row, col) == (10, 12)
    # and a mirrored input (RA increasing with x) must come out the same way round
    w.wcs.cdelt = [2.0 / 3600, 2.0 / 3600]
    out = astro.reproject(img[:, ::-1].copy(), w, 50.0, -20.0, 41, 2.0)
    assert np.unravel_index(np.nanargmax(out), out.shape) == (10, 12)
    # outside the input there is no data
    assert np.isnan(astro.reproject(img, w, 50.0, -20.0, 81, 2.0)[0, 0])


def test_skyb_roundtrip():
    a = np.arange(9, dtype=np.float32).reshape(3, 3)
    a[1, 1] = np.nan
    b = np.ones((2, 2), np.float32)
    hdr = {"ra": 1.0, "dec": 2.0, "arcsec": 10.0, "frames": [{"n_px": 3, "mjd": 1.0}, {"n_px": 2, "mjd": 2.0}], "notes": ["−30°"]}
    blob = astro.encode_skyb(hdr, [a, b])
    assert blob[:4] == b"SKYB"
    (h,) = struct.unpack("<I", blob[4:8])
    assert json.loads(blob[8 : 8 + h]) == hdr
    start = 8 + h + (-(8 + h)) % 4
    assert start % 4 == 0 and len(blob) == start + 4 * (9 + 4)
    assert blob[8 + h : start] == b"\0" * (start - 8 - h)
    assert np.frombuffer(blob, "<f4", 9, start)[8] == 8.0
    hdr2, frames = astro.decode_skyb(blob)
    assert hdr2 == hdr and np.array_equal(frames[0], a, equal_nan=True) and np.array_equal(frames[1], b)


VIZIER = """#
#   VizieR Astronomical Server vizier.cfa.harvard.edu
#Column\tGmag\t(F9.6)\t? G-band mean magnitude

Source\tRA_ICRS\tDE_ICRS\tPlx\tpmRA\tpmDE\tGmag\tBP-RP\tRV
 \tdeg\tdeg\tmas\tmas/yr\tmas/yr\tmag\tmag\tkm/s
-------------------\t---------------\t---------------\t---------\t---------\t---------\t---------\t---------\t-------
4472832130942575872\t269.44850252544\t+04.73942005111\t 546.9759\t -801.551\t10362.394\t 8.193974\t 2.833697\t-110.47
4472832822422325632\t269.44173363136\t+04.73412550303\t         \t         \t         \t15.559026\t         \t

"""


def test_vizier_tsv():
    rows = catalogs.parse_vizier_tsv(VIZIER)
    assert len(rows) == 2 and rows[0]["Source"] == "4472832130942575872" and rows[1]["Plx"] == ""
    g = catalogs.gaia_rows(rows)
    assert g[0] == {"cat": "gaia", "id": "4472832130942575872", "ra": 269.44850252544, "dec": 4.73942005111,
                    "epoch": 2016.0, "pmra": -801.551, "pmdec": 10362.394, "plx": 546.9759, "mag": 8.193974,
                    "color": 2.833697, "rv": -110.47}
    assert g[1]["pmra"] == 0.0 and g[1]["plx"] is None and g[1]["color"] is None
    assert catalogs.parse_vizier_tsv("#INFO nothing\n\n") == []


def test_catwise_units_and_cap():
    ipac = (
        "\\fixlen = T\n"
        "|  ra|  dec| source_name| ra_pm| dec_pm| pmra| pmdec| sigpmra| sigpmdec| w1mpro_pm| w2mpro_pm|\n"
        "|double|double|char|double|double|double|double|double|double|double|double|\n"
        " 133.78 -7.24 J085507.96-071439.3 133.783924 -7.2443404 -8.0212 1.0357 0.09 0.1 18.288 14.059\n"
        " 133.70 -7.20 J000000.00+000000.0 133.70 -7.20 0.01 -0.02 0.05 0.05 null 12.0\n"
    )
    rows = catalogs.catwise_rows(catalogs.parse_ipac_table(ipac))
    bd = rows[0]
    assert bd["pmra"] == pytest.approx(-8021.2) and bd["pmdec"] == pytest.approx(1035.7)  # mas/yr
    assert bd["epoch"] == pytest.approx(2015.402, abs=0.001) and bd["mag"] == 14.059 and bd["w1"] == 18.288
    assert rows[1]["w1"] is None
    # capped to the brightest, but a significant fast mover survives however faint
    capped = catalogs.catwise_rows(catalogs.parse_ipac_table(ipac), limit=1)
    assert [r["id"] for r in capped] == ["J085507.96-071439.3"]


def test_vsx_rows():
    obj = {"VSXObjects": {"VSXObject": [{"Name": "R Dra", "RA2000": "248.19", "Declination2000": "66.75",
                                         "VariabilityType": "M", "Period": "245.6", "MaxMag": "6.7 V", "MinMag": "13.2 V"},
                                        {"Name": "x", "RA2000": "1", "Declination2000": "2"}]}}
    rows = catalogs.vsx_rows(obj)
    assert rows[0]["vtype"] == "M" and rows[0]["period"] == 245.6 and rows[0]["epoch"] == 2000.0
    assert rows[1]["period"] is None and rows[1]["vtype"] is None and rows[1]["pmra"] == 0.0
    assert catalogs.vsx_rows({"VSXObjects": []}) == []


def test_sesame():
    xml = ("<Sesame><Target option='S'><name>Barnard's Star</name><Resolver name='S'>"
           "<jradeg>269.45207696</jradeg><jdedeg>4.69336497</jdedeg>"
           "<pm><v>1</v><pmRA>-801.551</pmRA><pmDE>10362.394</pmDE></pm></Resolver></Target></Sesame>")
    got = catalogs.parse_sesame(xml)
    assert got == {"name": "Barnard's Star", "ra_j2000": 269.45207696, "dec_j2000": 4.69336497,
                   "pmra": -801.551, "pmdec": 10362.394}
    assert catalogs.parse_sesame("<Sesame><Target><name>zz</name><INFO> *** Nothing found *** </INFO></Target></Sesame>") is None
    nopm = catalogs.parse_sesame("<Sesame><Target><name>M31</name><Resolver><jradeg>10.68</jradeg><jdedeg>41.27</jdedeg></Resolver></Target></Sesame>")
    assert nopm["pmra"] == 0.0 and nopm["pmdec"] == 0.0


def test_season_grouping():
    rows = [{"filter": f, "mjd": m, "filename": f"{f}{m}"} for f, m in
            [("g", 55358.4), ("i", 55360.1), ("i", 55361.2), ("y", 55700.0), ("z", 55701.0), ("y", 55730.0),
             ("r", 56100.0), ("w", 56101.0)]]
    s = history.group_seasons(rows)
    assert [(x["filter"], len(x["rows"])) for x in s] == [("i", 2), ("y", 2), ("r", 1)]
    assert s[0]["mjd"] == pytest.approx(55360.65) and s[1]["mjd"] == pytest.approx(55715.0)
    assert history.group_seasons([]) == []


def test_ps1_list_and_grids():
    text = ("projcell subcell ra dec filter mjd type filename shortname badflag\n"
            "1479 18 269.448 4.74 g 55358.48782 warp /rings/a.fits a.fits 0\n"
            "broken line\n")
    assert history.parse_ps1_list(text) == [{"filter": "g", "mjd": 55358.48782, "filename": "/rings/a.fits"}]
    assert history.parse_ps1_list("<html>error</html>") == []
    assert history.wise_grid(393.6) == (143, pytest.approx(2.7524, abs=1e-3))
    for arcsec in (60.0, 239.85, 393.6, 1574.4):
        n, sc = history.ps1_grid(arcsec)
        assert n <= 512 and n * sc == pytest.approx(arcsec)
    assert history.ps1_grid(60.0)[0] == 240
    assert history.thin(list(range(100)), 10)[0] == 0 and history.thin(list(range(100)), 10)[-1] == 99


def test_nanmedian_stack():
    a = np.array([[1.0, np.nan]], np.float32)
    b = np.array([[3.0, np.nan]], np.float32)
    c = np.array([[100.0, 5.0]], np.float32)
    out = history.nanmedian_stack([a, b, c])
    assert out[0, 0] == 3.0 and out[0, 1] == 5.0
    assert np.isnan(history.nanmedian_stack([a, b])[0, 1])


def test_sso_helpers():
    assert astro.sexa_to_deg("10 40 7.8562", hours=True) == pytest.approx(160.0327342, abs=1e-6)
    assert astro.sexa_to_deg("-00 30 0.0") == pytest.approx(-0.5)
    assert astro.sexa_to_deg("+08 00 8.749") == pytest.approx(8.0024303, abs=1e-6)
    t = catalogs.cluster_times([60800.10, 60800.12, 60800.13, 60801.3, 60800.20])
    assert t == [pytest.approx(60800.11667, abs=1e-4), 60800.2, 60801.3]
    assert len(catalogs.cluster_times([60000 + i for i in range(40)])) == 12
    body = json.dumps([{"Num": 433, "Name": "Eros", "RA (hms)": "08 55 10.0", "DEC (dms)": "-07 14 42.0",
                        "Class": "NEA>Amor", "VMag (mag)": 12.1, "dRA (arcsec/h)": -30.2, "dDEC (arcsec/h)": 4.1}]).encode()
    (o,) = catalogs.sso_rows(body, 60800.1)
    assert o["num"] == "433" and o["ra"] == pytest.approx(133.791667, abs=1e-5) and o["dec"] == pytest.approx(-7.245)
    assert o["class"] == "NEA>Amor" and o["dra"] == -30.2
    assert catalogs.sso_rows(b"", 60800.1) == []


def test_neossat_summary():
    lines = ["observationID,target_name,time_bounds_lower,time_exposure"]
    lines += [f"2019{i:09d},BarnardStar,{58769.0 + i * 0.5},1.1" for i in range(100)]
    lines.append("bad id/../x,foo,58800,1")
    summary, cands = catalogs.neossat_summary("\n".join(lines))
    assert summary == {"count": 100, "date_min": "2019-10-13", "date_max": "2019-12-01"}
    assert len(cands) == 12 and cands[0]["date"] == "2019-10-13" and cands[-1]["date"] == "2019-12-01"
    assert cands[0]["url"] == "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/raven/files/cadc:NEOSSAT/2019000000000_raw_prev_256.png"
    assert len({c["obs_id"] for c in cands}) == 12
    assert catalogs.neossat_summary("observationID,target_name,time_bounds_lower,time_exposure\n")[0]["count"] == 0


def test_dates():
    assert astro.mjd_to_date(58769.05) == "2019-10-13"
    assert astro.mjd_to_iso(61100.0) == "2026-03-01T00:00:00"
    assert astro.mjd_to_jyear(57170.0) == pytest.approx(2015.402, abs=1e-3)
