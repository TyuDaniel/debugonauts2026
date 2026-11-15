# SkyDive

SkyDive is a web tool that shows any patch of sky changing over sixteen years: WISE from 2010 to 2024, Pan-STARRS, then SPHEREx from 2025 onward in 102 infrared colours. Enter coordinates, get a movie.

Built for NASA Space Apps 2026, challenge [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).

- **Viewer** (`/`): coordinate box, blink, or stack and subtract groups of visits, wavelength bar with detector chips, click-for-spectrum, catalogue markers moved to each frame's date, quality flags, shareable URLs and embeds.
- **3D map** (`/explore`): 331,802 stars and brown dwarfs within 100 parsecs with a ±50,000-year time slider. Click a star and dive to its SPHEREx view.

The browser holds every aligned exposure, so stacking, wavelength selection and spectra are instant with no server round trip.

## How to use SkyDive

SkyDive has two pages. The **viewer** (`/`) shows one small patch of sky as a movie built from real survey images taken between 2010 and today. The **3D map** (`/explore`) shows every known star within 100 parsecs of the Sun, and is a way to choose something to look at in the viewer.

### Some background first

A few terms appear all over the interface.

- **Exposure**: one SPHEREx photograph. Each exposure records one narrow infrared colour, given as a wavelength in micrometres (µm).
- **Detector**: SPHEREx has six detectors, D1 to D6, and each one covers a slice of the 0.75–5.0 µm range. D1 sees the shortest wavelengths (0.75–1.09 µm) and D6 the longest (4.42–5.0 µm). Neighbouring detectors overlap slightly at their edges.
- **Visit**: SPHEREx scans the whole sky every six months or so, and each pass over a field takes many exposures in different colours over a few days. SkyDive groups the exposures of one pass into a visit and shows the median of them as one frame. Fields near the poles (the SPHEREx deep fields, such as R Draconis) get a visit every month.
- **Frame**: one picture in the movie. A frame is a WISE epoch (2010–2024, one roughly every six months), a Pan-STARRS epoch, or a SPHEREx visit (2025 onwards).
- **Pixel**: one SPHEREx pixel is 6.2″ (arcseconds) across. A star has to move a good fraction of a pixel before SPHEREx alone can show it; the WISE frames give the long baseline that makes slow motion visible.

### Walkthrough: watch Barnard's Star move

This takes a minute and shows most of the viewer.

1. Open the viewer and click **Barnard's Star** under "Or try one of these". Prepared fields load from files shipped with the site, so they work even with no backend.
2. The viewer opens on the most recent SPHEREx frame, paused. Press play (or **Blink all**) to step through every frame from 2010 to now. The star crawls about 145″ (roughly 23 SPHEREx pixels) to the north across the WISE frames.
3. Press Space to pause, then use ← and → to step one frame at a time. The date of each frame is shown on the image and in the **This frame** panel.
4. Turn on **Gaia stars** in the **Overlays** panel. Gaia markers are moved to each frame's date using the star's measured motion, so the marker should follow the star. A source that moves but has no marker following it is unknown to the catalogue.
5. Click **Latest − first**. The image now shows the newest SPHEREx visit minus the oldest. A moving star leaves a bright spot where it is now and a dark spot where it was; anything that stayed still cancels to grey.

The other prepared fields show different things:

| Field | What to look for |
|---|---|
| Barnard's Star | The fastest-moving star in the sky. It is saturated in every SPHEREx band, so its spectrum comes from the halo around the core. |
| Epsilon Indi B | A nearby brown dwarf pair. Its bright neighbour, Epsilon Indi A, throws ghosts and glare that change between visits, a good example of something that looks like change but is not. |
| WISE 0855−0714 | The coldest known brown dwarf. It is only visible in SPHEREx when you stack the long wavelengths: select 4.1–4.75 µm and press **Stack all**. |
| RW Aurigae | A young variable star; click it and read the light curve. |
| R Draconis | A Mira variable with a 246-day period, in a deep field with monthly visits. The light curve shows the brightness rising and falling. |

### Step 1: choose a patch of sky

Type into the coordinate box on the landing page and press Enter. It accepts:

- decimal degrees: `133.7577 −7.2420` (right ascension, then declination)
- sexagesimal: `08h55m01.9s −07d14m31s`
- an object name, such as `Barnard's Star` or `Vega`, which is looked up with CDS Sesame

Pasting coordinates submits them straight away. The **Field width** menu next to the box sets how much sky is shown: 4, 6.5 (the default), 13 or 26 arcminutes across (an arcminute is 1/60 of a degree). A wider field helps track fast-moving objects but reads more data, so the first load takes longer.

Any field other than the five prepared ones needs the backend, which finds the SPHEREx exposures covering that spot and cuts out the patch from each one. Exposures arrive in batches; the image fills in as they do, and the counter under the wavelength bar shows progress. Every visit gets data from the first batch on, so you can start looking before loading finishes.

### Step 2: understand the screen

- **Centre**: the sky image. North is up and east is left, as on an astronomical chart. Hover over a pixel to see its value and quality flags in **This frame**; click a source to measure it (step 6). To zoom in, scroll over the image, press **+** and **−** (or the buttons in its corner), or double-click a spot; drag to move around while zoomed, and press **0** for the whole field again. The scale bar follows the zoom.
- **Below the image**: the playback controls, the groups, the timeline and the wavelength bar.
- **Left column**: **About this field** (prepared fields only: what the field shows and anything to watch for), **Display** and **Overlays**.
- **Right column**: **Spectrum**, **This frame**, **Finder map** and **NEOSSat** (only where NEOSSat imaged the spot).

Every panel can be folded away by clicking its title. On a phone, most panels start folded so the image and timeline come first.

#### On a phone or tablet

- **Zoom**: pinch the image, or double-tap a spot. Zoomed in, one finger moves the image; showing the whole field, one finger scrolls the page as usual. The number under the zoom buttons goes back to the whole field.
- **Pixel and spectrum**: tap a pixel to see its value and flags under the image, and to measure the source there. A **Spectrum** button appears on the image and jumps down to the result.
- **Frames**: tap anywhere on a timeline row to show the nearest frame, or slide a finger along the row to scrub through them.
- **Explanations**: labels with a dotted underline show their note when tapped.
- **Keeping the image in view**: scrolled down to the display sliders or overlay toggles, a small live copy of the image stays in the corner; tap it to go back up. With the phone on its side, the image stays pinned on the left while the controls scroll beside it.

### Step 3: play, step and pick frames

| Control | What it does |
|---|---|
| Click a frame on the timeline | Shows that frame |
| Space | Play or pause |
| ← / → | Previous or next frame |
| Speed slider | Frames per second, up to 3, because fast blinking can trigger photosensitive seizures. |

The timeline runs from 2010 to today. Its scale is stretched after 2025 so the SPHEREx visits, which come much closer together than the WISE epochs, are easy to click.

### Step 4: choose a mode

The image shows either single frames or groups of frames; there is no separate switch between them.

**Single frames (Blink)**: play, the step buttons and clicking a frame on the timeline show one frame at a time. Use it to spot motion (a source that jumps from frame to frame) and variability (a source that brightens and fades). Blink always plays every frame.

**Groups**: click a group chip, **Stack** or **Subtract** to sort frames into lettered groups, A to Z, and show one group stacked or one group minus another. The **View / Add** switch at the start of the group row decides what clicking a timeline frame does: **View** shows that frame, **Add** puts it into the selected group or takes it out. Press play or a step button to go back to single frames.

- Each group appears as a chip with its letter, frame count and survey. Click a chip to edit that group (it is outlined), and **+ New** starts the next letter.
- With **Add** on, click frames on the timeline to add them to the selected group or take them out. Each frame shows its group letter, and a frame is in one group at a time.
- **Stack** shows the group you are editing, with every exposure in its frames combined into one image. More exposures means less noise, so faint sources show up that are invisible in a single visit.
- **Subtract** shows one group minus another, picked with the two menus. Both groups must come from the same survey, so the second menu only lists matching groups, and **Subtract** is greyed out until two such groups exist. The image switches to a diverging colour scale: bright where the first group is brighter, dark where the second is brighter, grey where nothing changed.
- Each group holds frames from one survey; adding a frame from another survey starts that group again. **Clear** removes every group.

If you press **Stack** with no groups yet, group A starts with every SPHEREx visit.

#### Presets

- **Blink all** plays every frame, WISE and SPHEREx.
- **Latest − first** puts the newest SPHEREx visit in group A and the oldest in group B, and shows A minus B.
- **Stack all** puts every SPHEREx visit into group A and shows it stacked.

### Step 5: choose which infrared colours to use

The wavelength bar sits under the timeline. It decides which SPHEREx exposures go into the SPHEREx frames, stacks and differences. It has no effect on WISE or Pan-STARRS frames: those always show their own bands (pick W1 or W2 for WISE in **Display**).

Different objects shine at different wavelengths. Stars like the Sun are brightest at the short end; cold brown dwarfs are faint below 3 µm and brightest around 4–5 µm; ices and hydrogen gas show up at particular wavelengths. Narrowing the range lets you look at one kind of light.

**Reading the bar.** The grey bars behind it are a histogram of the loaded exposures: each bar is the number of exposures at that wavelength. The green bars are the ones currently selected, and the lit band between the two handles is the selected range. The labels D1–D6 under it mark where each detector sits.

**Changing the range.**

- Drag either handle, or click anywhere on the bar to move the nearer handle there.
- Click a handle (or Tab to it) and use the arrow keys: each press moves it by 0.05 µm, or 0.2 µm with Shift held.
- The range readout above the bar gives the exact values, such as `1.10–1.62 µm`.

**Detector chips.** **D1** to **D6** (or the keys 1 to 6 anywhere on the page) select one detector. A detector chip sets the range to that detector's nominal band, so it selects the exposures whose wavelength falls inside it; where neighbouring detectors overlap, a few of the neighbour's exposures are included and a few of the chosen detector's edge exposures are left out. **All** selects every SPHEREx exposure; it is the default. The chip for the current selection is highlighted.

**Molecule presets.** These narrow the range to one spectral feature:

| Chip | Wavelength | What it traces |
|---|---|---|
| H Pa-α | 1.875 µm | Hydrogen gas (Paschen-α line) |
| Water ice | 3.05 µm | Water ice on dust grains |
| Methane | 3.3 µm | Methane in cold brown dwarfs, PAH molecules in dusty clouds |
| H Br-α | 4.052 µm | Hydrogen gas (Brackett-α line) |
| CO₂ ice | 4.27 µm | Carbon dioxide ice |
| CO ice | 4.67 µm | Carbon monoxide ice |

A feature is so narrow that each visit has only one to three exposures inside it. Clicking a preset therefore also stacks every visit together, which gives enough exposures for a usable image. Only bright sources show up.

**The exposure counter** under the bar reads "*n* of *m* exposures": *m* is the number of exposures loaded for the field and *n* is how many the current range uses. If *n* is 0, the field has no data in that range.

**Matched wavelengths.** When Blink or a group difference compares frames from different visits, the viewer always matches their wavelengths. Each visit observes a field in a slightly different set of colours, and a star can look quite different at 1 µm and at 4 µm, so without matching a colour difference could look like a change over time. The viewer keeps only the colour bands that the compared visits share; SPHEREx's 102 colour channels are grouped into 36 bands of three channels each for this. If the visits share too few bands, it matches by detector instead, and a note under the bar says so, or says that the visits share nothing.

### Step 6: measure a source

Click a source in the image. SkyDive measures its brightness at that position in every loaded exposure, using a small aperture (1.6 pixels in radius) with the local sky subtracted, and fills the **Spectrum** panel:

- **The header** shows the source position and its median brightness, in microjanskys (µJy), across the exposures in the selected wavelength range, with the uncertainty and signal-to-noise ratio (SNR). "Noisy" means fewer than 5 exposures went into it.
- **The spectrum** plots brightness against wavelength. Each point is the median of one 3-channel band; the shaded strip is the selected range, and the labelled lines mark the molecule features.
- **The light curve** below it plots brightness against date, one point per SPHEREx visit, using the same exposures as each visit's frame (so the wavelength range applies).

Click either plot to enlarge it over the page; press Escape, click the × or click outside it to close.

If the star is so bright that its centre is saturated in most exposures, the header says **Core saturated** and the values come from the unsaturated ring around the core instead. That brightness is not calibrated, but it rises and falls with the star, so the light curve is still useful. Pick one detector to follow such a star over time.

### Step 7: overlays

The **Overlays** panel draws markers from catalogues on top of the image:

| Overlay | Marker | Source |
|---|---|---|
| Gaia stars | Circle | ESA Gaia: precise positions and motions |
| CatWISE sources | Diamond | CatWISE2020: infrared sources, including cold brown dwarfs Gaia cannot see |
| Variable stars | Star | AAVSO VSX, with variability type and period |
| Asteroids | Triangle | IMCCE SkyBoT: known asteroids and comets near the field at each SPHEREx visit (approximate positions) |
| Flagged pixels | Tint | Pixels the SPHEREx pipeline flagged (ghosts, hot pixels, cosmic rays) in many of the exposures behind the frame |

Every marker is moved to the date of the frame on screen using the catalogue's proper motion, and a dashed trail shows its path since 2010. Full markers go only to sources that move more than about 0.4″ a year and to named variable stars; everything else is drawn as a small faint mark.

### Step 8: the other panels

- **Display**: **Shadows** darkens the background as you raise it, and lowering **Highlights** brightens faint sources. **Invert** draws dark stars on a light sky, and **Reset** restores the defaults. **WISE band** switches the WISE frames between W1 (3.4 µm) and W2 (4.6 µm); cold brown dwarfs are brightest in W2.
- **This frame**: the frame's date, detectors, wavelength range, number of exposures, data release and pixel scale, plus the value and quality flags of the pixel under the cursor. On a Pan-STARRS frame it also gives how many exposures were combined and, where that filter had gaps (chip gaps or masked cells), what share of the picture was filled from the same season's other filters; sources inside those patches show that other filter's brightness.
- **Bad exposures** are left out automatically: any exposure with more than half of its pixels flagged by the SPHEREx pipeline is dropped from every frame and stack.
- **Finder map**: the field in Aladin Lite over the SPHEREx all-sky map, with a box marking the area shown, to see what is around it. Scroll to zoom and drag to pan; changing the wavelength keeps your zoom, **Re-centre** goes back to the target and **Enlarge** floats the map over the page.
- **NEOSSat**: images of the field from the Canadian Space Agency's NEOSSat satellite, where there are any.

### Step 9: share what you found

Every setting is stored in the page address: position, field of view, wavelength range, mode, groups, the frame on screen, display settings, overlays, excluded exposures and the measured source. Copying the address bar gives someone the exact same view. The share button also offers an embed code (an `<iframe>` for another web page) and exports the current playback as an animated GIF.

### The 3D map

Open it from the mission patch on the landing page or by going to `/explore`. It shows 331,802 stars and brown dwarfs within 100 parsecs, with the Sun at the centre and rings at 10, 25, 50 and 100 pc.

- Drag to orbit, scroll or pinch to zoom, and double-click to centre on the selected star. W A S D or the arrow keys fly; Q and E move down and up. The target button resets the view.
- On a touch screen, one finger slides the map. Two fingers pinch to zoom towards the pinch, and slide together to turn the map. In the small map on the landing page of a phone, one finger scrolls the page instead, so the map never traps the scroll; two fingers still move the map.
- **Star colour** colours stars by temperature, from hot and blue to cool and red. **Motion** colours them by how far they move across our sky in a decade; bright stars are the fast movers, the best places to look for motion in the viewer.
- Brown dwarfs are drawn as rings. Dashed markers point towards prepared targets that lie beyond the map.
- The time slider at the bottom moves every star along its real motion up to 50,000 years into the past or the future. Press play to animate it, or drag the slider back to the middle to return to today.
- Search for a star by name in the box at the top, or click any star to open its card with distance, motion and position. **Dive** flies back to the Sun, turns to face the star and opens the viewer at its position today.


## Run it locally

Requirements: Python 3.11+, Node 20+.

```sh
# backend (terminal 1)
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000

# frontend (terminal 2)
cd frontend
npm install
npm run dev          # http://localhost:5173  (proxies /api to :8000)
```

The five test targets are baked under `frontend/public/baked/` and load with no backend at all. Any other coordinate goes through the backend, which reads SPHEREx exposures straight from the public S3 bucket by byte range.

A field someone has opened before loads faster the second time. The backend keeps every cutout it has made on disk. `GET /api/bundle?ra=…&dec=…&n_px=…` returns all of a field's cached cutouts in one gzip-compressed response, or 204 when none are cached, so a field anyone has opened before loads without asking the SPHEREx archive again. The viewer asks for the bundle first and then fetches only the exposures it lacks.

### Checks

| Check | Tool | Command |
|---|---|---|
| Backend unit tests (offline) | pytest | `cd backend && .venv/bin/python -m pytest -q` |
| Type check | TypeScript (`strict`) | `cd frontend && npm run typecheck` |
| Production build | Vite | `cd frontend && npm run build` |

## Layout

| Path | What |
|---|---|
| `backend/app/spherex/` | Exposure discovery (IRSA SIA), byte-range cutouts, reprojection, release discovery |
| `backend/app/extras/` | WISE and Pan-STARRS history, Gaia / CatWISE / VSX overlays, SkyBoT, NEOSSat, name lookup |
| `frontend/src/viewer/` | The viewer |
| `frontend/src/explore/` | The 3D map |
| `scripts/bake.py` | Writes the static showcase fields from a running backend |
| `scripts/build_stars.py` | Builds `stars.bin` for the 3D map from `data/raw/` |
| `docs/API.md` | Backend ↔ frontend contract, binary format, baked-file layout |
| `docs/SERVICES.md` | Every outside service used, with URLs and gotchas |
| `PLAN.md` | The build plan and requirements checklist |

Re-bake the showcase fields (backend running on port 8000):

```sh
backend/.venv/bin/python scripts/bake.py scripts/targets.json --api http://127.0.0.1:8000
```

## Deploying

- **Backend:** `backend/Dockerfile` (uvicorn on port 8080). Host it in AWS `us-east-1`, next to the SPHEREx bucket.
- **Frontend:** `frontend/dist/` on any static host. Point `/api/*` at the backend, and serve `explore.html` at `/explore`.

## Data and credits

- **NASA:** SPHEREx Level 2 spectral images and all-sky cube (IRSA); WISE / unWISE time-resolved coadds via WiseView (Caselden et al., ASCL 1806.004); CatWISE2020.
- **Canadian Space Agency (partner):** NEOSSat via CADC.
- **Other:** Gaia DR3 and the Gaia Catalogue of Nearby Stars (ESA); Hipparcos; Pan-STARRS (STScI); Kirkpatrick et al. 2024 20-pc census; AAVSO VSX; IMCCE SkyBoT; CDS Sesame, VizieR and Aladin Lite.
- **Libraries:** astropy, numpy, scipy, FastAPI, three.js, uPlot, Vite.

## AI disclosure

The code in this repository was written with AI coding assistance (Claude Code, Anthropic). Source files carry a header comment saying so. No AI-generated images or video are used; every image in the tool is real survey data.
