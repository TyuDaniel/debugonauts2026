# SkyDive API contract

This is the fixed interface between backend and frontend. `PLAN.md` section 4 says what each endpoint does; this file pins the exact shapes. `docs/SERVICES.md` describes the outside services.

## Conventions

- Angles in degrees (ICRS). Dates as MJD (float). Proper motions in mas/yr, `pmra` includes cos(dec).
- **Every image array is row-major, row 0 = north (top), column 0 = east (left).** Draw it straight to a canvas with no flip. Pixel `(col, row)` centre is at tangent-plane offset `east = (n_px/2 - 0.5 - col) * scale`, `north = (n_px/2 - 0.5 - row) * scale` from the field centre.
- All binary is little-endian.
- Errors: HTTP 4xx/5xx with `{"detail": "human readable message"}`.
- Outside services are slow and flaky: every backend route caches on disk (`app/cache.py`) and uses timeouts and retries.

### Binary frame container ("SKYB")

Used by `/api/cutouts`, `/api/history` and the baked files.

```
bytes 0..3   ASCII "SKYB"
bytes 4..7   uint32 H = length of the JSON header in bytes
bytes 8..    H bytes of UTF-8 JSON, then zero padding so the payload starts at a multiple of 4
payload      the arrays, concatenated in the order the header lists them, no padding between
```

## Field of view

| `fov` (arcmin) | `n_px` (SPHEREx, 6.15"/px) |
|---|---|
| 4 | 39 |
| 6.5 | 64 |
| 13 | 128 |
| 26 | 256 |

Field width in arcsec = `n_px * 6.15`. History frames cover the same sky box.

## Endpoints

### `GET /api/health` → `{"ok": true}`

### `GET /api/releases`
```json
{"releases": ["spherex_dr1", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"], "updated": "2026-11-14T02:00:00Z"}
```
Never blocks on the slow TAP query: returns the cached or built-in list and refreshes in the background.

### `GET /api/resolve?q=`
```json
{"name": "Barnard's Star", "ra": 269.44, "dec": 4.74, "ra_j2000": 269.452, "dec_j2000": 4.693, "pmra": -802.8, "pmdec": 10362.5}
```
`ra, dec` are propagated to today. 404 with a message if the name is unknown.

### `GET /api/exposures?ra=&dec=`
```json
{
  "releases": ["spherex_dr1", "spherex_qr3"],
  "exposures": [
    {"id": "2025W23_1B_0123_1D5", "mjd": 60800.12, "detector": 5, "wave_um": 4.21, "bw_um": 0.038,
     "release": "spherex_dr1", "key": "qr/level2/…fits", "url": "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/…fits"}
  ],
  "visits": [{"id": 0, "mjd_start": 60795.0, "mjd_end": 60833.0, "n": 30}]
}
```
- `id` is unique per exposure+detector and stable across calls. Sorted by `mjd`.
- `wave_um`/`bw_um` here are the best estimate available before reading the file (may be `null`); the value in the cutout header is authoritative and the frontend overwrites with it.
- Each exposure carries `"visit": <visit id>`.
- The route returns everything; the frontend caps what it loads (600, most recent first).

### `POST /api/cutouts`
Body: `{"ra": 133.78, "dec": -7.24, "n_px": 64, "ids": ["…", up to 32]}` → SKYB.

Header:
```json
{
  "ra": 133.78, "dec": -7.24, "n_px": 64, "pixscale_arcsec": 6.15,
  "flag_names": {"0": "TRANSIENT", "1": "OVERFLOW", "21": "SOURCE"},
  "items": [
    {"id": "…", "ok": true, "mjd": 60800.12, "detector": 5, "wave_um": 4.213, "bw_um": 0.038,
     "dwave_dx": 0.0001, "dwave_dy": 0.0011, "bg": 0.412, "flag_frac": 0.03},
    {"id": "…", "ok": false, "error": "target off detector"}
  ]
}
```
Payload: for each item with `ok: true`, in order: `float32[n_px*n_px]` image (MJy/sr, per-exposure median already subtracted, NaN outside the footprint; flagged pixels are NOT blanked, the browser masks using the flags) then `uint32[n_px*n_px]` flags.

- `wave_um`, `bw_um`: at the field centre. `dwave_dx`, `dwave_dy`: change in µm per output pixel toward +col (west) and +row (south), so wavelength at `(col,row)` ≈ `wave_um + dwave_dx*(col-c) + dwave_dy*(row-c)`, `c = n_px/2 - 0.5`.
- `bg`: the median that was subtracted. `flag_frac`: fraction of in-footprint pixels with any masked bit set.
- `flag_names` is read from the file headers (`MSKNnnnn`), not hard-coded.
- The backend needs the S3 key for an id; it keeps an id→key map from `/api/exposures` (memory + disk cache), so ids alone are enough.

### `GET /api/history?ra=&dec=&arcsec=` → SKYB
Header:
```json
{
  "ra": 133.78, "dec": -7.24, "arcsec": 393.6,
  "frames": [
    {"survey": "wise", "band": "W2", "mjd": 55320.5, "n_px": 143, "pixscale_arcsec": 2.75, "label": "WISE W2 2010-05"},
    {"survey": "ps1", "band": "y", "mjd": 56012.3, "n_px": 480, "pixscale_arcsec": 0.82, "label": "Pan-STARRS y 2012"}
  ],
  "notes": ["No Pan-STARRS coverage south of -30°"]
}
```
Payload: one `float32[n_px*n_px]` per frame in order, NaN where there is no data. Each frame covers `arcsec` on a side centred on `ra, dec`. Pan-STARRS frames are binned so `n_px` ≤ 512. A survey that fails is dropped and named in `notes`; the route still returns the others.

### `GET /api/overlay?ra=&dec=&arcsec=`
```json
{
  "sources": [
    {"cat": "gaia", "id": "4472832130942575872", "ra": 269.448, "dec": 4.739, "epoch": 2016.0,
     "pmra": -801.5, "pmdec": 10362.4, "plx": 546.9, "mag": 8.19, "color": 2.83},
    {"cat": "catwise", "id": "J085510.74-071442.5", "ra": 133.79, "dec": -7.24, "epoch": 2015.4,
     "pmra": -8100.0, "pmdec": 680.0, "mag": 13.9, "w1": 17.8, "w2": 13.9},
    {"cat": "vsx", "id": "RW Aur", "name": "RW Aur", "ra": 76.95, "dec": 30.40, "epoch": 2000.0,
     "pmra": 0, "pmdec": 0, "vtype": "TTS/CTTS", "period": 2.77, "max_mag": "9.6 V", "min_mag": "13.6 V"}
  ],
  "warnings": ["Bright star nearby: expect ghosts and glare"],
  "notes": []
}
```
`epoch` is a Julian year. `mag` is G for Gaia, W2 for CatWISE. A catalogue that fails is dropped and named in `notes`.

### `GET /api/sso?ra=&dec=&arcsec=&mjds=60800.1,60801.3`
```json
{"objects": [{"mjd": 60800.1, "num": "433", "name": "Eros", "ra": 133.7, "dec": -7.2, "class": "NEA>Amor",
              "vmag": 12.1, "dra": -30.2, "ddec": 4.1}],
 "note": "Geocentric positions, approximate; near-Earth objects can be off by arcminutes"}
```
`dra`, `ddec` in arcsec/hour. The backend clusters `mjds` within one hour and queries at most 12 distinct times.

### `GET /api/neossat?ra=&dec=`
```json
{"count": 619, "date_min": "2019-10-13", "date_max": "2019-12-03",
 "previews": [{"obs_id": "2019286…", "date": "2019-10-13", "url": "https://…png", "exposure_s": 10.0}]}
```
`url` must load directly in an `<img>` (public https). Up to 12, spread across the date range.

## Baked fields (static, checked before the backend)

```
frontend/public/baked/index.json
frontend/public/baked/{key}/{n_px}/exposures.json   same shape as /api/exposures
frontend/public/baked/{key}/{n_px}/cutouts.bin      one SKYB with every loaded exposure
frontend/public/baked/{key}/{n_px}/history.bin
frontend/public/baked/{key}/{n_px}/overlay.json
frontend/public/baked/{key}/neossat.json
frontend/public/baked/{key}/sso.json                 (optional)
```
`index.json`:
```json
{"fields": [{"key": "wise0855", "name": "WISE 0855−0714", "ra": 133.7588, "dec": -7.2418,
             "n_px": [64], "blurb": "The coldest known brown dwarf", "note": "Invisible in single frames; faint star 7\" away"}]}
```
The frontend uses a baked field when the requested centre is within 3" of `ra, dec` and the `n_px` is listed. The showcase tiles on the landing state come from this file.

## Ports

- Canonical dev backend: `127.0.0.1:8000` (Vite proxies `/api` to it). Frontend dev server: `5173`.
- Agents testing their own backend code use their own port (pipeline 8001, extras 8002) so they never fight over 8000.
