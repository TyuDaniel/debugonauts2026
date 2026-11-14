# SkyDive — build plan

NASA Space Apps 2026, challenge "Planet X and SPHEREx" (Advanced).
Challenge page: https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/

**Submission closes Sunday 15 November, 11:59 p.m. local event time.** Everything below is scoped to that.

Companion files:
- `docs/SERVICES.md` — every outside endpoint with exact URLs, response fields and gotchas, all tested live.
- `reference/spike/sx.py` — working SPHEREx byte-range cutout code, byte-exact against a full download. Start the backend from this.
- `reference/figures/` — what real per-visit stacks look like.
- `data/raw/gcns.tsv`, `data/raw/k24.tsv` — the star catalogues for the 3D map, already downloaded.

---

## 1. What we are building

**SkyDive is a web tool that shows any patch of sky changing over sixteen years: WISE from 2010 to 2024, then SPHEREx from 2025 onward in 102 infrared colours.**

Enter coordinates, get a movie. No settings needed. Everything else is one click deeper.

### The three things nobody else has (of about 25 competing entries read)

1. **A sixteen-year timeline.** WISE stopped observing in 2024; SPHEREx started in 2025. We put 23 WISE epochs, Pan-STARRS dated frames and the SPHEREx visits on one scrub bar. Motion that is 1–2 pixels in SPHEREx alone becomes 100+ arcseconds of travel. Other entries show at most a single 2010 WISE image.
2. **Every exposure in the browser.** We send the aligned individual exposures, not finished pictures. Choosing wavelengths, choosing which visits to add or subtract, excluding a bad frame and clicking for a spectrum all happen instantly with no server round trip. Other entries re-request from a server or offer fixed stacks.
3. **A 3D map of the real solar neighbourhood as the way in.** 331,312 Gaia stars within 100 parsecs plus the brown dwarfs Gaia misses, with a time slider. Click a star, dive to its SPHEREx view. Existing 3D in other entries is orbits or decoration.

### What we deliberately do not lead with

- **"Reveal by stacking along motion."** We tested it on WISE 0855. Shifting by the motion changed the result from SNR 12.8 to 13.1, because the object moves only 1.3 pixels across all SPHEREx data. The before/after is not visually convincing. Keep motion shift as a quiet option; do not pitch it.
- **Auto-tagging with an "unexplained" list.** Three entries already have it. We label known objects on the image and stop there.
- **AI chat, leaderboards, phone AR.**

### The one measured result we quote

WISE 0855, the coldest known brown dwarf, is invisible in any single SPHEREx exposure (SNR about 3). Stacking the 52 exposures between 4.1 and 4.75 µm gives 580 ± 35 µJy, SNR 16, at the position its WISE track predicts. At the 2014 catalogue position the flux is consistent with zero.

Honest caveat to state with it: a faint ordinary star sits 7" away and contributes at short wavelengths. The evidence that the detection is the brown dwarf is that the flux rises steeply toward 4.5 µm and the centroid lands on the predicted position.

---

## 2. Requirements checklist

The challenge's "potential considerations" are treated as requirements.

| # | Requirement | How we meet it | Done when |
|---|---|---|---|
| R0 | Enter RA/Dec, see a time-lapse | Coordinate box, blink viewer | Any valid coordinate plays a movie with no other input |
| R1 | Easy to update with new data | Exposures are found by live query; releases are discovered from IRSA; flag names, wavelengths and detectors are read from file headers | A new release appears with no code change |
| R2 | Use the 102 bands; stack per detector; spectra on the fly | Wavelength range bar, detector chips, molecule presets, click-for-spectrum | Detector chips change the image; a click draws a spectrum in under a second |
| R3 | Add or subtract images from different times | Visit strip with A and B trays; Blink, A+B, A−B | "Latest minus first" works in one click |
| R4 | Choose the field of view | Four sizes, each showing its load time | Changing size reloads and keeps the centre |
| R5 | Overlay Gaia or WISE | Gaia and CatWISE markers moved to each frame's date; WISE as full history | Marker follows Barnard's Star across all frames |
| R6 | Coordinates in the URL, embeddable | All state in the query string; `embed=1`; also accepts WiseView-style `#ra=&dec=` links | Pasting the URL in a new tab restores the same view |
| R7 | Show metadata such as contamination flags | Per-exposure table, flag overlay, cursor readout | Hovering a pixel names its flags |
| R8 | Use astropy and Aladin | astropy in the backend; Aladin Lite finder map with the SPHEREx all-sky layer | Finder map tracks the viewer |
| R9 | Works on all five test targets | Baked showcase fields with honest notes | Section 9 table passes |
| R10 | Partner data (Canadian Space Agency) | NEOSSat panel | Barnard's Star shows NEOSSat previews |

---

## 3. Architecture

```
BROWSER (static site)                 BACKEND (FastAPI, us-east-1)          PUBLIC SERVICES
  Viewer  ── /api/exposures ───────►  SIA proxy + release list  ─────────►  IRSA SIA / TAP
          ── /api/cutouts (batches) ► range reads, decode, align ────────►  SPHEREx S3 bucket
  Timeline ─ /api/history ─────────►  WISE FITS, PS1 FITS ───────────────►  byw.tools, STScI
  Overlays ─ /api/overlay ─────────►  Gaia, CatWISE, VSX, SkyBoT ────────►  VizieR, IRSA, AAVSO, IMCCE
  NEOSSat ── /api/neossat ─────────►  CADC query ────────────────────────►  CADC
  Finder ─────────────────────────────────────────────────────────────────► IRSA HiPS (direct)
  3D map ─── /stars.bin (static)
  Showcase ─ /baked/*.bin (static)   ◄── bake script writes these ahead of time
```

### The key design decision: the browser holds the exposures

The backend's only heavy job is turning a 66 MB file into a small aligned cutout. It sends every exposure separately. The browser then does all combining:

- **Stack** = per-pixel median over the selected exposures (258 exposures of 90x90 pixels is well under 50 ms in a worker).
- **Wavelength selection, A/B trays, exclude-a-frame** = changing which exposures are in the set.
- **Spectrum** = aperture sum on each exposure at the clicked pixel, plotted against that exposure's wavelength.
- **Light curve** = the same sums grouped by visit.

Consequences: interaction is instant, the backend stays simple and cacheable per exposure, and new instruments or releases need no UI change.

### Resilience rule

The frontend first looks for `/baked/{key}.bin` on the static host. Only if that is missing does it call the backend. The five test targets and the showcase fields are baked, so the demo works even if the backend or an outside service is down.

### Hosting

- **Backend:** one small container in AWS `us-east-1` (same region as the SPHEREx bucket), or Fly.io region `iad`. Avoid free tiers that sleep.
- **Frontend + baked data:** any static host (Cloudflare Pages, Vercel, GitHub Pages).
- **Public URL, no login.** Test in a private window. New domains can be blocked by event filters; prefer a well-known host domain.

---

## 4. Backend

Python 3.11+, FastAPI, httpx or aiohttp, astropy, numpy. Disk cache (a directory of files keyed by hash).

### Endpoints

**`GET /api/resolve?q=`** — optional path, only called when the input does not parse as coordinates.
Calls Sesame, then moves the position to today using the returned proper motion. Returns `{ra, dec, pmra, pmdec, name}`.

**`GET /api/exposures?ra=&dec=`** — which SPHEREx exposures cover this point.
Queries SIA across every discovered collection, de-duplicates by observation ID preferring the newest release, and adds per-exposure wavelength from the cached detector tables.
```json
{
  "releases": ["spherex_dr1", "spherex_qr3"],
  "exposures": [
    {"id": "…", "mjd": 60800.12, "detector": 5, "wave_um": 4.21, "bw_um": 0.038,
     "dwave_dx": 0.0, "dwave_dy": 0.0011, "release": "spherex_dr1", "key": "…s3 key…"}
  ],
  "visits": [{"id": 0, "mjd_start": 60795.0, "mjd_end": 60833.0, "n": 30}]
}
```
Visits are found by clustering exposure dates with a gap of more than 30 days. Deep fields near the ecliptic poles get monthly bins instead.

**`POST /api/cutouts`** — body `{ra, dec, n_px, ids:[…up to 32…]}`.
For each exposure: range-read IMAGE and FLAGS rows (1.4x the output size), decode, subtract the per-exposure median, reproject onto a north-up grid of `n_px` at 6.15"/px centred on `ra, dec`, and return:
- `image`: float32, MJy/sr, NaN outside the footprint
- `flags`: uint32, nearest-neighbour reprojected
Response is one binary blob: a JSON header line, then the arrays. Cache per `(exposure id, ra, dec, n_px)`.

The browser calls this in batches and draws frames as they arrive. Concurrency against S3: 32–64.

**`GET /api/history?ra=&dec=&arcsec=`** — WISE and Pan-STARRS frames.
WISE: `byw.tools/tiles` then 23 x 2 FITS cutouts (W1, W2). Pan-STARRS (Dec > −30): list warps, keep the reddest available filter per observing season, fetch FITS cutouts, median per season. Returns float32 frames with dates and pixel scales. All three surveys are north-up, so the browser draws each to the same sky box with no regridding.

**`GET /api/overlay?ra=&dec=&arcsec=`** — Gaia DR3 (radius = half field + 240"), CatWISE2020, VSX. Returns rows with position, epoch, proper motion, parallax, magnitude, type. The browser moves each source to each frame's date.

**`GET /api/sso?ra=&dec=&arcsec=&mjds=`** — SkyBoT at each distinct exposure time (cluster times within one hour). Lazy, called after frames have loaded. Results carry a "geocentric position, approximate" note.

**`GET /api/neossat?ra=&dec=`** — CADC count, date range, and up to 12 preview image URLs.

**`GET /api/releases`** — the cached list of collections, refreshed daily.

### Bake script

`scripts/bake.py targets.json` runs the same code paths and writes `/baked/{key}.bin` plus history and overlay JSON for each showcase field. Run it for the five test targets first, then the scouted showcase list.

### Processing rules (all from the spike)

- Combine with median or sigma-clip, never a plain mean.
- Mask bits 0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22–28. Never bit 21.
- Subtract a per-exposure median background.
- A stack of fewer than 5 exposures is flagged as noisy in the UI.
- Blink frames share one stretch (asinh, 30th to 99.7th percentile over all frames).

---

## 5. Frontend

Vite + TypeScript. No framework required; React is fine if the team prefers it. WebGL2 or 2D canvas for the image, uPlot for the spectrum, three.js for the 3D map, Aladin Lite 3.8.2 for the finder.

### Layout (desktop)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ SkyDive   [ 133.7588 -7.2418  or a name ........ ] [Go]   Field 6.5' ▾   │
├───────────────────────────────────────────┬──────────────────────────────┤
│                                           │ Spectrum (click a source)    │
│                                           │  ▁▂▃▅▂▁▁▂▇█▅   µJy vs µm     │
│              IMAGE                        │  H2O  CH4  CO2  CO markers   │
│        (blink / A+B / A−B)                ├──────────────────────────────┤
│                                           │ This frame                   │
│   ○ Gaia   ◇ CatWISE   △ asteroid         │  2026-04-28 · D6 · 4.52 µm   │
│                                           │  21 exposures · DR1          │
│                                           │  Flags under cursor: GHOST   │
├───────────────────────────────────────────┤  [exposure table ▾]          │
│ Wavelength  0.75 ├──■━━━━━━━━■──┤ 5.0 µm  ├──────────────────────────────┤
│ [D1][D2][D3][D4][D5][D6]  [Water][CH4]…   │ Finder map (Aladin)          │
│ 52 of 258 exposures                       │ NEOSSat: 619 frames ▸        │
├───────────────────────────────────────────┴──────────────────────────────┤
│ ▶ ◀ ▶  speed ▬▬   Mode: Blink | A+B | A−B     [Latest − first] [Stack all]│
│ 2010 ─ WISE ●●●●●●●●●●●●●●●●●●●●●●● ─ PS1 ▪▪▪▪ ─ 2025 SPHEREx ▣ ▣ ▣ ▣ 2026 │
└──────────────────────────────────────────────────────────────────────────┘
```
On a phone: image on top, timeline under it, everything else in collapsible sections.

### Controls

**Coordinate box.** Parses decimal degrees and sexagesimal (`08h55m10.831s -7d14m42.53s`, `08:55:10.8 -07:14:42`). If it parses, no outside call is made. If not, it tries the name lookup and shows the resolved coordinates. Also accepts a pasted WiseView link.

**Wavelength bar.** Two handles on 0.75–5.0 µm, drawn over a faint histogram of where the exposures fall.
- Six detector chips snap the handles to a detector. This is the usable granularity: about 18 exposures per detector per visit.
- Molecule presets (water ice 3.05, methane 3.3, CO2 4.27, CO 4.67, hydrogen 1.875 and 4.052 µm) snap to a narrow range. A preset selects only 1–3 exposures per visit, so presets stack across all visits and show a "few exposures, bright sources only" note.
- A live count: "52 of 258 exposures".
- **Matched wavelengths** (on by default): when comparing visits, only wavelength channels present in every compared visit are used. This prevents a colour difference being mistaken for a change over time.

**Timeline and trays.** One date axis from 2010 to today with three tracks. Click a frame to view it. Click to add to tray A, shift-click for tray B. Modes: Blink (plays the selected frames), A+B, A−B. Presets: "Blink all", "Latest minus first", "Stack all".

**Field of view.** Four sizes with load times from a home connection (258 exposures; the 4' figure is interpolated, the others measured):

| Field | Pixels | First load |
|---|---|---|
| 4' | 39 | about 8 s |
| 6.5' (default) | 64 | about 12 s |
| 13' | 128 | about 16 s |
| 26' | 256 | about 40 s |

**Stretch.** Brightness range slider, linear/asinh toggle, invert. Shared across frames.

**Overlays.** Toggles for Gaia, CatWISE, variable stars, asteroids, and the flag tint. Each marker is drawn where the source should be on that frame's date, with a short trail showing its motion.

**Metadata.** Three levels:
1. Cursor readout: RA/Dec, value, wavelength, flag names.
2. Frame panel: date, detector, wavelength range, number of exposures, release.
3. Exposure table: every exposure with date, detector, wavelength, fraction of flagged pixels, a checkbox to exclude it, and a link to the original file.

**Warnings shown automatically.**
- "Saturated in SPHEREx" when most exposures flag the target pixel as overflow, nonlinear or bloom.
- "Bright star nearby: expect ghosts and glare" when a Gaia star brighter than about magnitude 6 is within 10'.
- "No Pan-STARRS coverage south of −30°".

**Sharing.** Copy link, copy embed snippet, export GIF.

**Keyboard and accessibility.** Space to play, arrow keys to step, `1`–`6` for detectors. Blink speed capped at 3 frames per second by default with a flashing-content note. Colour is never the only signal. Works at phone width.

### URL scheme

```
/?ra=133.7588&dec=-7.2418&fov=6.5&wl=4.1-4.75&mode=blink&a=0,1&b=3&speed=500&stretch=asinh&ov=gaia,catwise&embed=1
```
The URL always stores coordinates, never a name.

### 3D map (`/explore`)

Separate page; talks to the viewer only by navigating to a viewer URL. It cannot break the core.

- **Data:** `scripts/build_stars.py` reads `data/raw/gcns.tsv` and `data/raw/k24.tsv`, converts to Cartesian positions and velocities, and writes `stars.bin` (position, velocity, magnitude, colour as float32; about 10 MB). Missing radial velocity is set to zero; say so on the page.
- **Rendering:** three.js `Points` with a shader computing `position + velocity * time`. Time slider ±50,000 years.
- **Encoding:** star colour from Gaia colour; brown dwarfs drawn distinctly. A toggle colours stars by how far they move across the sky in ten years, which shows where to look.
- **Interaction:** orbit and fly controls, search by name for the showcase objects, click a star to see name, distance and motion, then "Dive" animates the camera back to the Sun facing the star and opens the viewer at its present-day coordinates.
- **Honesty label:** "Positions and distances from Gaia, not from SPHEREx."

---

## 6. Work plan

Assume up to six people working with AI coding tools. Tracks are independent after the first hour because the API contract in section 4 is fixed.

| Track | Owns |
|---|---|
| A. Pipeline | `/api/exposures`, `/api/cutouts`, releases, cache, bake script, deployment |
| B. Viewer | Image canvas, stacking worker, wavelength bar, trays, stretch, URL state, metadata |
| C. History and overlays | `/api/history`, `/api/overlay`, `/api/sso`, `/api/neossat`, timeline tracks, markers |
| D. 3D map | `build_stars.py`, `/explore`, dive transition |
| E. Story and QA | Showcase scouting, five-target testing, project page, demo video, slides, references |

With fewer people: merge C into A and B first, then E into whoever finishes first. D is the first track to drop.

### Phase 1 — a movie from a coordinate (first 6 hours)

- **A:** Port `reference/spike/sx.py` into the backend. `/api/exposures` and `/api/cutouts` working locally. Bake WISE 0855 and Barnard's Star.
- **B:** Build against a baked file from hour 1 (A produces one immediately from the spike pickles). Canvas, median stack per visit, blink, stretch, coordinate parsing, URL state.
- **C:** `/api/history` WISE route returning frames; `/api/overlay` Gaia route.
- **D:** `stars.bin` built; points rendering with orbit controls.
- **E:** Scout showcase fields (see section 8). Start the project page draft.

**Gate 1:** typing the challenge's WISE 0855 coordinates on the deployed site plays a SPHEREx blink. If this is not true at hour 6, everyone helps A and B.

### Phase 2 — the differentiators (next 8 hours)

- **A:** Deploy to `us-east-1`. Release discovery. Bake all five test targets. Progressive batches.
- **B:** Wavelength bar, detector chips, matched wavelengths, A/B trays, click-for-spectrum, exposure table, flag overlay and cursor readout.
- **C:** Timeline with WISE and SPHEREx on one axis; Gaia and CatWISE markers moved per frame; Pan-STARRS track.
- **D:** Time slider, click-to-select, dive into the viewer.
- **E:** Test each target as features land; file problems directly to the owner.

**Gate 2:** WISE 0855 scrubs from 2010 to 2026 with a marker following it, and clicking it draws a spectrum. R0–R7 pass on at least three test targets.

### Phase 3 — complete and harden (next 8 hours)

- **A:** Field-of-view sizes, exposure cap for deep fields, error states, bake the showcase list.
- **B:** Embed mode, GIF export, warnings, keyboard, phone layout.
- **C:** Variable-star labels, asteroid labels, NEOSSat panel, Aladin finder.
- **D:** Brown dwarf markers, motion colouring, polish. Stop adding features.
- **E:** Record screen captures as soon as Gate 2 passes. Draft video and slides.

**Gate 3 (feature freeze):** all of R0–R10 pass. After this, only fixes.

### Phase 4 — submission (final 6 hours, protected)

- Full test of the five targets on the public URL in a private window, on a phone, on a second network.
- Project page complete. Demo uploaded and tested without login.
- Submit at least one hour before the deadline. Edits after that are improvements, not rescues.

### Cut order if behind

1. Asteroid labels
2. Pan-STARRS track
3. GIF export
4. NEOSSat panel (keep a text line with the frame count)
5. 3D map polish, then the 3D map itself
6. Molecule presets (keep detector chips)

Never cut: baked test targets, URL state, the WISE track, metadata, the wavelength bar with detector chips.

---

## 7. Submission

### Rules that can disqualify

- Demo is **a video of 30 seconds or less, or a deck of up to seven slides**. Exceeding either removes the project from global judging.
- All links public with no login. English, or English subtitles.
- No one under 18 may appear in the video.
- AI-generated images or video need a visible watermark. AI-written code must be acknowledged in descriptive text and metadata. No NASA branding in generated content.
- Every outside dataset, code library and image goes in the references field.
- At most six team members.

### AI disclosure

The rules allow AI tools but say they "should not be used to come up with your idea". The team should describe its AI use accurately in the dedicated field: which tools, for what (research, code, drafting), and what the team decided itself. Add a line to the repository README and a comment header in generated source files.

### Project page fields

- **Summary:** open with "SkyDive is a web tool that …", then the challenge link, then why it matters.
- **Detailed description (500–1,700 words):** what it does, how it works, what it uses, one measured result (WISE 0855, SNR 16), limitations, what comes next.
- **NASA data:** SPHEREx Level 2 spectral images and all-sky cube (IRSA); IRSA SPHEREx tutorials; WISE / unWISE time-resolved coadds via WiseView; CatWISE2020.
- **Partner data:** NEOSSat via CADC (Canadian Space Agency). List separately.
- **Other references:** Gaia DR3 and the Gaia Catalogue of Nearby Stars (ESA); Pan-STARRS (STScI); Kirkpatrick et al. 2024; AAVSO VSX; IMCCE SkyBoT; CDS Sesame and Aladin Lite; astropy; three.js; uPlot.

### Awards to aim at

Best Use of Data ("best makes space data accessible or leverages it to a unique application") and Best Use of Science. Scoring is on Impact, Creativity, Validity, Relevance and Presentation, each 1 to 5; Validity explicitly includes usability.

### 30-second video

| Time | On screen | Words |
|---|---|---|
| 0:00–0:05 | The 3D star map, time slider moving | "A billion objects in NASA's SPHEREx sky. Which ones are moving?" |
| 0:05–0:10 | Dive from the map into a field | "SkyDive lets anyone look." |
| 0:10–0:20 | WISE 0855 scrubbed 2010 → 2026, then the wavelength bar dragged red and the source appearing, then a click and the spectrum | "Sixteen years of sky. A hundred and two colours. One click for a spectrum." |
| 0:20–0:30 | The URL, an embedded view, the five targets as tiles | "Any coordinate, any release, shareable by link. Find what nobody has seen yet." |

Real screen capture only. Host on YouTube or Drive and open it in a private window before submitting.

### Who is likely judging

The challenge text points to the Backyard Worlds: Planet 9 team (this is inferred, not confirmed). They will value: WiseView-like simplicity, links that drop into their workflow, positions correctly moved to each date, like-for-like wavelengths, visible flags and saturation, and speed. They will dislike: discovery claims, simulated data, artefacts presented as movers, and the out-of-date WISE 0855 coordinate.

---

## 8. Showcase scouting (track E, first hours)

WISE 0855 is the story but is faint and has a contaminating star. We want two or three fields that look good with no explanation. Use `data/raw/k24.tsv`:

- Proper motion above 1"/yr, bright in W2, no Gaia star brighter than magnitude 6 within 10', away from the Galactic plane.
- Load each candidate in the viewer and keep those where the SPHEREx frames are clean and the WISE track is obvious.
- Also wanted: one comet or bright asteroid field with a known object in a single exposure (use IRSA MOST to find frames), and one extended region where water ice or CO2 shows in on-band minus off-band.

None of these candidates has been checked yet.

---

## 9. Test targets: what to expect

| Target | Exposures | What works | What to say honestly |
|---|---|---|---|
| Barnard's Star | 358, 3 visits | WISE track of about 145" over 14 years; SPHEREx shift of 1.7 px; Gaia marker tracks it; 619 NEOSSat frames | Saturated in every SPHEREx band |
| Epsilon Indi B | 458, 4 visits | Well detected; moves under 1 px across SPHEREx visits; WISE track | Epsilon Indi A, 6.7' away, throws ghosts and glare that change between visits; no Pan-STARRS |
| WISE 0855 | 258, 3–4 visits | 16-year track; detected at SNR 16 by stacking 4.1–4.75 µm; spectrum rises to the red | Invisible in single frames; faint star 7" away; the challenge coordinate is its old position, so move it by proper motion and use at least a 4' field |
| RW Aurigae | 335, 3 visits | Variable-star label with type and period; per-visit brightness | Likely saturated; brightness unreliable |
| R Draconis | 2,493 (deep field) | Monthly coverage, the best time sampling of any target; variable-star label (period 246 days) | Saturated; cap the number of exposures loaded |

---

## 10. Risks

| Risk | Likelihood | Response |
|---|---|---|
| Backend or an outside service down during judging | Medium | Baked fields served statically; frontend checks them first |
| WiseView servers (volunteer-run) unavailable | Medium | Cache every response; baked history for showcase fields; PNG route as fallback |
| First load too slow for a new coordinate | Medium | Backend in `us-east-1`; 64 px default; progressive frames; load-time shown per field size |
| Mixed-wavelength frames look like variability | High if ignored | Matched wavelengths on by default |
| Glare and ghosts near bright stars look like transients | High near bright stars | Automatic warning; flag tint; median stacking |
| Deep fields overwhelm the browser | Low | Cap at about 600 exposures, most recent first, with "load more" |
| 3D map eats the schedule | Medium | Separate page, separate owner, first to cut |
| Disqualification on format | Low | Section 7 checklist owned by track E |

### Not yet verified

- Backend speed from inside `us-east-1` (expected faster than the measured home-connection numbers).
- The Aladin Lite snippet in a real browser.
- Browser performance of a median over 600 exposures.
- Any showcase field other than the five test targets.
