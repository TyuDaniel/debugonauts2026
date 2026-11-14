# Service reference

Every endpoint below was called live on 2026-11-13 or 2026-11-14 unless marked otherwise. "CORS yes" means the response carried `Access-Control-Allow-Origin: *`. Anything without CORS goes through our backend.

Never send personal details to these services. Where a client name is wanted, use `sky-viewer`.

## 1. SPHEREx (NASA / IRSA) — the core

### Find exposures covering a position
```
GET https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&COLLECTION=spherex_qr3&POS=circle+{ra}+{dec}+0.0003&RESPONSEFORMAT=CSV
```
- 2–3 s. No CORS. No auth.
- Useful columns: `t_min` (MJD), `energy_bandpassname` (D1..D6), `access_url`, `cloud_access` (JSON with the S3 key).
- Gotcha: `cloud_access` is unquoted JSON and shifts the trailing CSV columns. Parse `access_url` and derive the key, or request VOTable.
- SIA lags TAP by about a day after each weekly ingest.

### Discover releases (so new data needs no code change)
```
POST https://irsa.ipac.caltech.edu/TAP/sync   FORMAT=CSV
QUERY=SELECT collection, COUNT(*) FROM spherex.observation GROUP BY collection
```
- 13–37 s, so run at startup and once a day; cache the answer.
- Returned today: `spherex_dr1`, `spherex_dr1_cal`, `spherex_dr1_deep`, `spherex_qr3`, `spherex_qr3_deep`. Drop anything ending `_cal` or `_cube`.
- Query every remaining collection; `qr3` holds newer epochs than `dr1`.

### Pixels: public S3, byte ranges
```
https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/{key}      key = uri minus "ibe/data/spherex/"
```
- Anonymous, CORS yes, single `Range` requests work. Multi-range requests are ignored (returns the whole 66 MB file).
- File layout: primary, IMAGE (float32, 2040x2040, MJy/sr), FLAGS (Rice-compressed, one tile per row), VARIANCE, ZODI, EPSF, WCS-WAVE.
- IMAGE header length varies between files; read the first ~40 KB, fall back to one more request if the header is longer.
- Pixel (x, y) is at `data_start + (y*2040 + x)*4`, big-endian. Ranges are whole rows, so cost scales with cutout height.
- FLAGS needs its own header plus a 2040-entry row index, then a Rice decode per row. `reference/spike/sx.py` does this and is byte-exact against a full download.
- WCS-WAVE (wavelength and bandwidth on an 11x11 grid, interpolate bilinearly) is identical for every file of a detector. Fetch six tables once and cache them forever.
- WCS has SIP distortion without the `-SIP` suffix. Astropy applies it. For the spectral WCS (key `W`) set `sip=None`.
- Detector is rotated about 17 degrees from north: fetch 1.4x the displayed size.
- Do not use IRSA's own cutout service (`?center=..&size=..`): 4 MB and 5.5–7.7 s per image regardless of size.

### Measured load time (258 exposures, IMAGE + FLAGS only, home broadband)
| Cutout | Concurrency | Data | Time |
|---|---|---|---|
| 16 px | 64 | 78 MB | 3.9 s |
| 64 px | 32–64 | 251 MB | 12 s |
| 128 px | 64 | 479 MB | 16 s |
| 256 px | 64 | 923 MB | 40 s |

Zero failed files, no throttling. Above concurrency 32 the home link was the limit, so a backend in `us-east-1` should be faster (not measured). Decode + mask + reproject + median for 258 cutouts is about 2 s on one core.

### Instrument facts
- 6.15"/px. PSF FWHM about 8.6" (D5). Exposure 113.6 s.
- Detectors: D1 0.75–1.09, D2 1.10–1.62, D3 1.63–2.41, D4 2.42–3.82, D5 3.83–4.41, D6 4.42–5.00 µm. 17 channels each.
- Each of the ~102 channels is sampled about once per visit at a given position.
- Saturation near AB 11.5 (D1–D4), 10.2 (D5), 9.75 (D6). Single-exposure 5-sigma limit about AB 16–17.
- MJy/sr to µJy per pixel: multiply by about 889 (nominal pixel scale).

### Flags
Bit names are in each file's header (`MSKNnnnn`), so read them, do not hard-code. Bits to mask when stacking: 0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22–28. Never mask bit 21 (SOURCE: it covers half the image). Leave 19 (OUTLIER) and 1 (OVERFLOW) unmasked, but report them.

| Bit | Name | Bit | Name |
|---|---|---|---|
| 0 | TRANSIENT | 17 | PERSIST |
| 1 | OVERFLOW | 19 | OUTLIER |
| 2 | SUR_ERROR | 20 | CROSSTALK |
| 6 | NONFUNC | 21 | SOURCE |
| 7 | DICHROIC | 22 | GHOST |
| 9 | MISSING_DATA | 23 | GHOST_FPA |
| 10 | HOT | 24 | GHOST_EXT |
| 11 | COLD | 25 | STREAK |
| 12 | FULLSAMPLE | 26 | BLOOM |
| 14 | PHANMISS | 27 | SNOWBALL |
| 15 | NONLINEAR | 28 | HALO |

### Background
The ZODI layer alone leaves residuals, and D1 has a bright helium airglow band near 1.083 µm. Subtract a per-exposure median instead; ZODI and VARIANCE need not be fetched.

### All-sky SPHEREx layer for the finder map
```
https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube
```
Cube HiPS, 102 frames, PNG tiles, CORS yes. Aladin Lite 3.8.2 (the version IRSA's own page pins). Not run in a browser by us yet.
```html
<script src="https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js"></script>
<script>
A.init.then(() => {
  const aladin = A.aladin('#al', {target: '133.786245 -7.244372', fov: 1});
  const url = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
  const c = 299792458, fLo = c/5.009e-6, fHi = c/7.43e-7, depth = 102;
  const cube = A.imageHiPS(url, {successCallback: h => setFrame(h, 1)});
  aladin.setBaseImageLayer(cube);
  window.setFrame = (h, i) => h.setFrequency({value: fLo + (i + 0.5)/depth*(fHi - fLo), unit: 'Hz'});
});
</script>
```
`setSliceNumber` does not map frames correctly; use `setFrequency`. Frames 50 and 51 are blank.

## 2. WISE history 2010–2024 (WiseView / unWISE, volunteer-hosted)

### FITS route (primary: we can restretch)
```
GET http://byw.tools/tiles?ra={ra}&dec={dec}
GET http://byw.tools/cutout?ra={ra}&dec={dec}&size={px}&band={1|2}&epoch={0..22}
```
- http only, no CORS, so backend only. `size` is pixels at 2.75"/px.
- `tiles` returns `{tiles:[{coadd_id, px, py, epochs:[{band, epoch, mjdmean, forward}]}]}`.
- `cutout` returns float32 FITS with full WCS, `MAGZP=22.5`, `MJDMIN/MJDMAX`. North up.
- 23 parallel cutouts returned in 3.7 s. An out-of-range epoch returns an error page.

### PNG route (fallback)
```
GET https://moo23y1au0.execute-api.us-west-2.amazonaws.com/default/png-animation
```
- Required: `ra, dec, band, size, window, diff, minbright, maxbright, invert, stretch, scandir, neowise, outer, unique, smooth_scan, shift, max_dyr`.
- `band` 1 = W1, 2 = W2, 3 = colour. `invert=0` for white-on-black. `window=0` for one frame per epoch.
- Returns `ims[]`, `mjds[][]`, `CRPIX/CRVAL/NAXIS`. PNGs at `https://amnh-citsci-public.s3-us-west-2.amazonaws.com/{ims[i]}`. CORS yes. 3–5 s.
- WCS: TAN, 2.75"/px, no rotation. PNG is the FITS array flipped vertically.

Both test targets return 23 epochs, MJD 55320 to about 60400. There is no official per-epoch fallback, so cache every response and bake the showcase fields. Credit WiseView (Caselden et al., ASCL 1806.004).

## 3. Pan-STARRS (STScI) — dated optical frames 2010–2014, Dec > -30 only
```
GET https://ps1images.stsci.edu/cgi-bin/ps1filenames.py?ra={ra}&dec={dec}&filters=grizy&type=warp
GET https://ps1images.stsci.edu/cgi-bin/fitscut.cgi?ra={ra}&dec={dec}&size={px}&format=fits&red={filename}
```
- List: space-separated `projcell subcell ra dec filter mjd type filename shortname badflag`. 1–1.5 s.
- Cutout: 0.25"/px, FITS carries WCS and `MJD-OBS`, NaN masks. 0.9 s. CORS yes.
- WISE 0855: 90 warps. Barnard's Star: 103 warps.

## 4. Catalogue overlays

### Gaia DR3 (VizieR, Harvard mirror)
```
GET https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=I/355/gaiadr3&-c={ra}+{dec}&-c.rs={arcsec}&-out.max=500&-sort=Gmag&-out=Source,RA_ICRS,DE_ICRS,Plx,pmRA,pmDE,Gmag,BP-RP,RV
```
- deg, mas, mas/yr (pmRA includes cos dec), epoch 2016.0. 1.3–1.7 s. CORS yes.
- The cone is matched at 2016 positions. Barnard's Star is 168" from its J2000 position, so use radius = half the field + 240".
- TSV: `#` comment lines, then header, units, dashes.
- The Harvard mirror has no TAP. The main CDS hosts were down on both probe days.

### CatWISE2020 (IRSA) — motions for brown dwarfs Gaia cannot see
```
GET https://irsa.ipac.caltech.edu/SCS?table=catwise_2020&RA={ra}&DEC={dec}&SR={deg}&format=csv
```
- 1.6 s, no CORS. Use `ra_pm, dec_pm` (epoch MJD 57170) with `pmra, pmdec` in **arcsec/yr**.
- Do not use IRSA TAP for this (15–32 s per cone).

### Name lookup (optional path only)
```
GET https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-ox/S?{urlencoded name}
```
- XML only: `jradeg, jdedeg, pm/pmRA, pm/pmDE` (mas/yr), `plx/v`. 0.3 s. CORS yes.
- Positions are J2000. Always propagate by proper motion to today before centring. WISE 0855 is about 2' off otherwise.
- Unknown name: `<INFO> *** Nothing found *** </INFO>`.

### Variable stars (AAVSO VSX)
```
GET https://vsx.aavso.org/index.php?view=api.list&ra={ra}&dec={dec}&radius={deg}&format=json
```
- `{"VSXObjects":{"VSXObject":[{Name, RA2000, Declination2000, VariabilityType, Period, MaxMag, MinMag, ...}]}}`. All strings. Empty result is `{"VSXObjects":[]}`. 0.5–0.9 s. CORS yes.
- RW Aur and R Dra are both found.

### Known asteroids and comets (IMCCE SkyBoT)
```
GET https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?-ep={ISO time}&-ra={ra}&-dec={dec}&-rd={deg}&-mime=json&-output=basic&-observer=500&-from=sky-viewer
```
- The parameter is `-observer`; `-loc` is silently ignored.
- JSON array: `Num, Name, "RA (hms)", "DEC (dms)", Class, "VMag (mag)", "dRA (arcsec/h)", "dDEC (arcsec/h)"`. Empty cone is HTTP 204. 1.5–4 s. CORS yes.
- Geocentric positions are good to under one SPHEREx pixel for main-belt objects and wrong by arcminutes for near-Earth objects. Say so in the label.
- IRSA MOST goes the other way (object to SPHEREx frames): `https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most?catalog=spherex&input_type=naifid_input&obj_naifid={id}&obs_begin=..&obs_end=..&output_mode=Brief`.

## 5. 3D star map data (already downloaded to `data/raw/`)

### Gaia Catalogue of Nearby Stars — `data/raw/gcns.tsv`
```
https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=J/A+A/649/A6/table1c&-out.max=unlimited&-out=GaiaEDR3,RA_ICRS,DE_ICRS,Plx,pmRA,pmDE,RV,Gmag,BPmag,RPmag,Dist50,WDprob,GCNSprob
```
331,312 rows, 45 MB. Epoch 2016.0. `Dist50` in kpc. `RV` often blank (treat as 0 and say so). Colour = `BPmag - RPmag`.

### Brown dwarfs Gaia misses — `data/raw/k24.tsv`
Kirkpatrick et al. 2024 20-pc census, `J/ApJS/271/55/table4`, 4,407 rows: `Name, RAPdeg, DEPdeg, NoteEpoch, Plx, pmRA, pmDE, SpTOpt, SpTNIR, W1mag, W2mag`. Position epoch varies per row. Some rows have blank coordinates.

## 6. NEOSSat (Canadian Space Agency, via CADC) — partner data
```
GET https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync?LANG=ADQL&FORMAT=csv&QUERY=
  SELECT o.observationID, o.target_name, p.time_bounds_lower, p.time_exposure
  FROM caom2.Observation o JOIN caom2.Plane p ON o.obsID=p.obsID
  WHERE o.collection='NEOSSAT' AND o.type='object'
  AND INTERSECTS(POINT('ICRS',{ra},{dec}), p.position_bounds)=1
```
- 2–16 s, no CORS. Without `o.type='object'` dark frames match.
- Previews: `cadc:NEOSSAT/{obsid}_raw_prev_256.png`. Full file: `https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/raven/files/cadc:NEOSSAT/NEOS_SCI_{obsid}.fits`.
- Of the five test targets only Barnard's Star has frames: 619, 2019-10-13 to 2019-12-03.
- Frames are raw, 256x256 px of sky at 3"/px, with no sky-coordinate solution. The CADC cutout service returned an all-zero image. Use the preview images; do not try to align them.

## 7. Spectral features to mark
| Feature | Wavelength (µm) |
|---|---|
| Water ice | 3.05 |
| Methane (brown dwarfs) / PAH | 3.3 |
| Brackett-alpha (hydrogen) | 4.052 |
| CO2 ice | 4.27 |
| CO ice | 4.67 |
| Paschen-alpha (hydrogen) | 1.875 |
| Helium airglow (contaminant, D1) | 1.083 |
