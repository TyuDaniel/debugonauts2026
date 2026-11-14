// SkyDive viewer — turns the view state into stacks: exposure selection, matched wavelengths,
// per-visit medians, A/B combinations, shared stretch limits, photometry.
// Written with AI coding assistance (Claude Code).
import { propagate, sepArcsec, skyToOffset } from './coords';
import { stacker } from './stackClient';
import { store } from './store';
import { DETECTORS, MJYSR_TO_UJY, SPHEREX_SCALE, type Exposure, type Frame, type HistFrame, type PhotPoint } from './types';

export const frameById = (id: string | null): Frame | undefined => store.session.frames.find((f) => f.id === id);

/** Frames that Blink steps through: the trays if anything is in them, otherwise everything. */
export function playlist(): Frame[] {
  // Blink always plays every frame; the trays only feed Stack and A − B.
  return store.session.frames;
}

/** 102-channel index: 17 equal-width channels per detector. */
export function channelOf(e: Exposure): number {
  const d = DETECTORS[e.detector - 1];
  if (!d || e.wave_um == null) return e.detector * 100;
  const k = Math.min(16, Math.max(0, Math.floor((17 * (e.wave_um - d.lo)) / (d.hi - d.lo))));
  return e.detector * 100 + k;
}

/** Coarser band used for matching visits: three neighbouring channels (36 bands in all). */
export function bandOf(e: Exposure): number {
  const ch = channelOf(e);
  return Math.floor(ch / 100) * 100 + Math.floor((ch % 100) / 3);
}

/** Above this share of flagged pixels an exposure adds almost nothing usable, so it is left out. */
const MAX_FLAGGED = 0.5;

/** Loaded exposures inside the wavelength range, minus excluded and mostly flagged ones. */
export function selectedExposures(): Exposure[] {
  const { wl, excluded } = store.state;
  const ex = new Set(excluded);
  return store.session.exposures.filter(
    (e) => e.loaded && e.ok && e.wave_um != null && e.wave_um >= wl[0] && e.wave_um <= wl[1] && !ex.has(e.id) && e.flag_frac <= MAX_FLAGGED,
  );
}

interface Plan {
  perVisit: Map<number, Exposure[]>;
  a: Exposure[];
  b: Exposure[];
  note: string;
}

function plan(): Plan {
  const s = store.session;
  const st = store.state;
  const sel = selectedExposures();
  s.selectedCount = sel.length;
  s.usableCount = s.exposures.filter((e) => e.loaded && e.ok).length;
  const perVisit = new Map<number, Exposure[]>();
  for (const v of s.visits) perVisit.set(v.id, []);
  for (const e of sel) perVisit.get(e.visit)?.push(e);

  const visitOf = (ids: string[]) => ids.filter((i) => i[0] === 's').map((i) => +i.slice(1));
  const aV = visitOf(st.a),
    bV = visitOf(st.b);
  let compared: number[] = [];
  if (st.mode === 'blink') compared = playlist().filter((f) => f.kind === 'spherex').map((f) => f.visit!);
  else if (st.mode === 'diff') compared = [...new Set([...aV, ...bV])];
  compared = compared.filter((v) => (perVisit.get(v)?.length ?? 0) > 0);

  let note = '';
  // Matching only makes sense once everything has arrived; partial loads would flicker.
  // Visits are always compared at matched wavelengths, so a colour difference never looks like change.
  if (compared.length >= 2 && s.status === 'ok') {
    // Visits with very few exposures would starve every other frame: they do not get a vote.
    const counts = compared.map((v) => perVisit.get(v)!.length).sort((a, b) => a - b);
    const typical = counts[counts.length >> 1];
    const core = compared.filter((v) => perVisit.get(v)!.length >= Math.max(3, 0.25 * typical));
    const voters = core.length >= 2 ? core : compared;
    // Two or three visits must share a band exactly; with many visits a band seen in most is kept.
    const need = voters.length <= 3 ? voters.length : Math.ceil(0.8 * voters.length);
    const common = (key: (e: Exposure) => number) => {
      const seen = new Map<number, number>();
      for (const v of voters) for (const k of new Set(perVisit.get(v)!.map(key))) seen.set(k, (seen.get(k) ?? 0) + 1);
      return new Set([...seen].filter(([, n]) => n >= need).map(([k]) => k));
    };
    const apply = (key: (e: Exposure) => number, keep: Set<number>) => {
      for (const v of compared) perVisit.set(v, perVisit.get(v)!.filter((e) => keep.has(key(e))));
    };
    const minCount = (key: (e: Exposure) => number, keep: Set<number>) =>
      Math.min(...voters.map((v) => perVisit.get(v)!.filter((e) => keep.has(key(e))).length));
    const who = need === voters.length ? `all ${voters.length} compared visits` : `at least ${need} of the ${voters.length} compared visits`;
    const ch = common(bandOf);
    if (ch.size && minCount(bandOf, ch) >= 3) {
      apply(bandOf, ch);
    } else {
      const det = common((e) => e.detector);
      if (det.size) {
        apply((e) => e.detector, det);
        note = `Matched by detector (D${[...det].sort().join(', D')}, seen by ${who}): too few identical colour bands`;
      } else {
        note =
          voters.length > 3
            ? `These ${voters.length} visits were observed with different detectors, so they cannot be colour-matched: frames differ in colour as well as in time. Pick one detector to compare like with like`
            : 'No wavelengths in common between these visits: showing all';
      }
    }
  }
  const gather = (vs: number[]) => vs.flatMap((v) => perVisit.get(v) ?? []);
  const a = st.mode === 'sum' ? gather([...new Set([...aV, ...bV])]) : gather(aV);
  const b = st.mode === 'diff' ? gather(bV) : [];
  return { perVisit, a, b, note };
}

let running = false;
let queued = false;
/** The settings the current group stacks were built for; differs from `stackKey()` while a restack is due. */
let stackedFor = '';
const stackKey = () => {
  const st = store.state;
  return [st.mode, st.a.join(','), st.b.join(','), st.wl.join('-'), st.excluded.join(','), store.session.token].join('|');
};
let throttle = 0;
let lastRun = 0;

/** Recompute stacks. Latest request wins; during loading, calls are throttled. */
export function requestRestack(now: boolean): void {
  if (now) {
    clearTimeout(throttle);
    throttle = 0;
    void restack();
    return;
  }
  if (throttle) return;
  const wait = Math.max(0, 350 - (performance.now() - lastRun));
  throttle = window.setTimeout(() => {
    throttle = 0;
    void restack();
  }, wait);
}

async function restack(): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    do {
      queued = false;
      const s = store.session;
      const key = stackKey();
      const p = plan();
      const visits = [...p.perVisit.keys()];
      const sets = [...visits.map((v) => p.perVisit.get(v)!), p.a, p.b].map((l) => l.map((e) => e.idx));
      const r = await stacker.stack(sets);
      if (store.session !== s) continue;
      s.stacks = new Map();
      visits.forEach((v, i) => {
        if (sets[i].length) s.stacks.set('s' + v, { ...r.out[i], n: sets[i].length, ids: sets[i] });
      });
      const nv = visits.length;
      s.comboA = sets[nv].length ? { ...r.out[nv], n: sets[nv].length, ids: sets[nv] } : null;
      s.comboB = sets[nv + 1].length ? { ...r.out[nv + 1], n: sets[nv + 1].length, ids: sets[nv + 1] } : null;
      // Shared stretch comes from the visit frames only.
      s.sample = r.sample;
      s.matchNote = p.note;
      stackedFor = key;
      lastRun = performance.now();
      store.emit('stacks');
    } while (queued);
  } finally {
    running = false;
  }
}

/** Value at a percentile (0–100) of a sorted sample. */
export function percentile(sorted: Float32Array, p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, (p / 100) * (sorted.length - 1)));
  const lo = Math.floor(i);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const histSamples = new WeakMap<Float32Array, Float32Array>();
export function sortedSample(data: Float32Array[], subtractMedian = false): Float32Array {
  const key = data[0];
  if (data.length === 1 && !subtractMedian && histSamples.has(key)) return histSamples.get(key)!;
  let total = 0;
  for (const d of data) total += d.length;
  const step = Math.max(1, Math.floor(total / 150000));
  const out = new Float32Array(Math.ceil(total / step) + data.length);
  let n = 0;
  for (const d of data) {
    const off = subtractMedian ? frameMedian(d) : 0;
    for (let i = 0; i < d.length; i += step) if (d[i] === d[i]) out[n++] = d[i] - off;
  }
  const sorted = out.slice(0, n).sort();
  if (data.length === 1 && !subtractMedian) histSamples.set(key, sorted);
  return sorted;
}

const medians = new WeakMap<Float32Array, number>();
export function frameMedian(d: Float32Array): number {
  let m = medians.get(d);
  if (m === undefined) {
    m = percentile(sortedSample([d]), 50);
    if (!isFinite(m)) m = 0;
    medians.set(d, m);
  }
  return m;
}

export interface Picture {
  data: Float32Array;
  nPx: number;
  pixscale: number;
  /** Subtracted from every pixel before stretching (history frames). */
  offset: number;
  lo: number;
  hi: number;
  diverging: boolean;
  tint: Uint8Array | null;
  kind: 'spherex' | 'wise' | 'ps1';
  /** Worker indices of the exposures behind this picture (SPHEREx only). */
  ids: number[];
  title: string;
  n: number;
  unit: string;
}

export function histOf(f: Frame): HistFrame | undefined {
  if (!f.hist) return undefined;
  if (f.kind === 'wise') return f.hist[store.state.wiseBand] ?? Object.values(f.hist)[0];
  return Object.values(f.hist)[0];
}

let wiseLimitsKey = '';
let wiseSample: Float32Array | null = null;
function wisePooled(): Float32Array {
  const s = store.session;
  const key = `${s.token}:${store.state.wiseBand}:${s.frames.length}`;
  if (key !== wiseLimitsKey || !wiseSample) {
    const data = s.frames.filter((f) => f.kind === 'wise').map((f) => histOf(f)!.data);
    wiseSample = data.length ? sortedSample(data, true) : new Float32Array();
    wiseLimitsKey = key;
  }
  return wiseSample;
}

function subtract(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

function medianOf(frames: Float32Array[]): Float32Array {
  if (frames.length === 1) return frames[0];
  const n = frames[0].length;
  const out = new Float32Array(n);
  const buf = new Float32Array(frames.length);
  const offs = frames.map(frameMedian);
  for (let p = 0; p < n; p++) {
    let k = 0;
    for (let f = 0; f < frames.length; f++) {
      const v = frames[f][p];
      if (v === v) buf[k++] = v - offs[f];
    }
    if (!k) {
      out[p] = NaN;
      continue;
    }
    const s = buf.subarray(0, k).sort();
    out[p] = k & 1 ? s[k >> 1] : 0.5 * (s[k / 2 - 1] + s[k / 2]);
  }
  return out;
}

export type PictureResult = { picture: Picture } | { message: string };

const comboCache = new Map<string, Float32Array>();

/** The image the canvas should show for the current mode and frame. */
export function currentPicture(frameId: string | null = store.state.frame): PictureResult {
  const s = store.session;
  const st = store.state;
  const [pLo, pHi] = st.range;

  const histPicture = (h: HistFrame, f: Frame): Picture => {
    const offset = frameMedian(h.data);
    const sample = f.kind === 'wise' ? wisePooled() : null;
    const own = sortedSample([h.data]);
    const lo = sample ? percentile(sample, pLo) : percentile(own, pLo) - offset;
    const hi = sample ? percentile(sample, pHi) : percentile(own, pHi) - offset;
    return {
      data: h.data, nPx: h.n_px, pixscale: h.pixscale_arcsec, offset, lo, hi, diverging: false, tint: null,
      kind: h.survey, ids: [], title: f.label, n: 1, unit: h.survey === 'wise' ? 'DN' : 'counts',
    };
  };

  if (st.mode === 'blink') {
    const f = frameById(frameId);
    if (!f) return { message: s.status === 'loading' ? '' : 'No frame selected.' };
    if (f.kind !== 'spherex') return { picture: histPicture(histOf(f)!, f) };
    const stack = s.stacks.get(f.id);
    if (!stack || !s.sample) {
      return { message: s.status === 'loading' ? '' : 'No exposures in this wavelength range for this visit.' };
    }
    return {
      picture: {
        data: stack.img, nPx: s.nPx, pixscale: SPHEREX_SCALE, offset: 0, lo: percentile(s.sample, pLo), hi: percentile(s.sample, pHi),
        diverging: false, tint: stack.tint, kind: 'spherex', ids: stack.ids, title: f.label, n: stack.n, unit: 'MJy/sr',
      },
    };
  }

  // Sum / difference.
  const picked = [...st.a, ...st.b];
  // The group stacks for these settings are still being computed: say so rather than show an error.
  const pending = stackedFor !== stackKey();
  if (!st.a.length) return { message: `Group ${st.show[0]} is empty. Click frames on the timeline to add them.` };
  if (st.mode === 'diff' && !st.b.length) return { message: `Group ${st.show[1]} is empty. Pick it under Add to, then click the frames to subtract.` };
  const kinds = new Set(picked.map((id) => (id[0] === 's' ? 'spherex' : id[0] === 'w' ? 'wise' : 'ps1')));
  if (kinds.size > 1) {
    return { message: `Groups ${st.show[0]} and ${st.show[1]} hold frames from different surveys, which cannot be subtracted. Use Blink to compare across surveys.` };
  }
  const kind = [...kinds][0];
  if (kind === 'spherex') {
    if (pending || s.status === 'loading') return { message: 'Loading…' };
    if (!s.comboA || !s.sample) return { message: `No exposures in this wavelength range for group ${st.show[0]}.` };
    if (st.mode === 'sum') {
      return {
        picture: {
          data: s.comboA.img, nPx: s.nPx, pixscale: SPHEREX_SCALE, offset: 0, lo: percentile(s.sample, pLo), hi: percentile(s.sample, pHi),
          diverging: false, tint: s.comboA.tint, kind: 'spherex', ids: s.comboA.ids, title: `Group ${st.show[0]}: stack of ${picked.length} visit${picked.length === 1 ? '' : 's'}`, n: s.comboA.n, unit: 'MJy/sr',
        },
      };
    }
    if (!s.comboB) return { message: `No exposures in this wavelength range for group ${st.show[1]}.` };
    let diff: Float32Array;
    const tag = s.comboA.img as Float32Array & { __b?: Float32Array; __d?: Float32Array };
    if (tag.__b === s.comboB.img && tag.__d) diff = tag.__d;
    else {
      diff = subtract(s.comboA.img, s.comboB.img);
      tag.__b = s.comboB.img;
      tag.__d = diff;
    }
    const lim = percentile(sortedSample([diff]).map(Math.abs).sort(), Math.min(99.9, Math.max(50, pHi)));
    return {
      picture: {
        data: diff, nPx: s.nPx, pixscale: SPHEREX_SCALE, offset: 0, lo: -lim, hi: lim, diverging: true, tint: s.comboA.tint,
        kind: 'spherex', ids: [...s.comboA.ids, ...s.comboB.ids], title: `Group ${st.show[0]} − group ${st.show[1]}`, n: s.comboA.n + s.comboB.n, unit: 'MJy/sr',
      },
    };
  }
  // History surveys: combine on the main thread (few, small frames).
  const get = (ids: string[]) => ids.map((id) => frameById(id)).filter((f): f is Frame => !!f).map((f) => histOf(f)!);
  const hA = get(st.mode === 'sum' ? picked : st.a),
    hB = get(st.b);
  if (!hA.length) return { message: 'Those frames are still loading.' };
  if (new Set([...hA, ...hB].map((h) => h.n_px)).size > 1) return { message: 'These frames have different sizes and cannot be combined.' };
  const ck = `${s.token}|${st.mode}|${st.wiseBand}|${st.a.join()}|${st.b.join()}`;
  let data = comboCache.get(ck);
  if (!data) {
    data = st.mode === 'sum' ? medianOf(hA.map((h) => h.data)) : subtract(medianOf(hA.map((h) => h.data)), medianOf(hB.map((h) => h.data)));
    if (hA.length === 1 && st.mode === 'sum') data = subtract(data, new Float32Array(data.length).fill(frameMedian(data)));
    if (comboCache.size > 8) comboCache.clear();
    comboCache.set(ck, data);
  }
  const sample = sortedSample([data]);
  const diverging = st.mode === 'diff';
  const lim = diverging ? percentile(sample.map(Math.abs).sort(), Math.min(99.9, Math.max(50, pHi))) : 0;
  return {
    picture: {
      data, nPx: hA[0].n_px, pixscale: hA[0].pixscale_arcsec, offset: 0,
      lo: diverging ? -lim : percentile(sample, pLo), hi: diverging ? lim : percentile(sample, pHi), diverging, tint: null,
      kind: kind as 'wise' | 'ps1', ids: [], title: diverging ? `Group ${st.show[0]} − group ${st.show[1]}` : `Group ${st.show[0]}: stack of ${picked.length} frames`, n: picked.length, unit: kind === 'wise' ? 'DN' : 'counts',
    },
  };
}

/** Pixel (fractional col, row) on the SPHEREx grid for a sky position. */
export function skyToPixel(ra: number, dec: number): { x: number; y: number } {
  const s = store.session;
  const o = skyToOffset(ra, dec, store.state.ra!, store.state.dec!);
  const c = s.nPx / 2 - 0.5;
  return { x: c - o.east / SPHEREX_SCALE, y: c - o.north / SPHEREX_SCALE };
}

/**
 * Share of a point source's light that falls inside the 1.6 px measurement aperture, relative to
 * a 4.5 px (28 arcsec) aperture, per detector (index 1–6). Measured with `measureApcor` below on
 * the five brightest isolated, unsaturated Gaia stars in each of three SPHEREx 13 arcmin fields
 * (WISE 0855, RW Aur, Barnard's Star; 2026-11-14). Star-to-star scatter is about 0.02. Light
 * beyond 28 arcsec (the faint PSF wings) is not included.
 */
export const APERTURE_FRACTION = [1, 0.89, 0.89, 0.88, 0.84, 0.84, 0.81];
export function apFraction(detector: number): number {
  return APERTURE_FRACTION[detector] ?? 1;
}

const apcorDone = new WeakMap<object, string>();
/**
 * Development tool: measure the aperture fraction on this field's own isolated, unsaturated Gaia
 * stars (small aperture over a 4.5 px one, on each detector's all-visit stack) and log it. A single
 * 6.5 arcmin field rarely has three clean stars, which is why the shipped values are a fixed table.
 */
export async function measureApcor(): Promise<void> {
  const s = store.session;
  if (s.status !== 'ok' || s.overlay.status !== 'ok') return;
  const exps = s.exposures.filter((e) => e.ok);
  const key = `${exps.length}:${s.overlay.data.sources.length}`;
  if (apcorDone.get(s) === key) return;
  apcorDone.set(s, key);
  const year = 2000 + (exps.reduce((m, e) => m + e.mjd, 0) / exps.length - 51544.5) / 365.25;
  const gaia = s.overlay.data.sources.filter((g) => g.cat === 'gaia' && g.mag != null);
  const at = gaia.map((g) => ({ g, ...propagate(g, year) }));
  const stars: number[][] = [];
  for (const a of at) {
    const mag = a.g.mag!;
    if (mag < 10.5 || mag > 18) continue;
    // Isolated: nothing within 34 arcsec (the outer aperture plus a margin) that is less than 2.5 magnitudes fainter.
    if (at.some((b) => b !== a && b.g.mag! < mag + 2.5 && sepArcsec(a.ra, a.dec, b.ra, b.dec) < 34)) continue;
    const p = skyToPixel(a.ra, a.dec);
    if (p.x > 11 && p.y > 11 && p.x < s.nPx - 12 && p.y < s.nPx - 12) stars.push([p.x, p.y]);
  }
  console.debug('apcor candidate stars', stars.length, 'of', gaia.length);
  if (stars.length < 3) return;
  const sets = [1, 2, 3, 4, 5, 6].map((d) => exps.filter((e) => e.detector === d).map((e) => e.idx));
  const { ratios } = await stacker.apcor(sets, stars);
  if (store.session !== s) return;
  console.debug('apcor ratios per detector, brightest star first', JSON.stringify(ratios.map((r) => r.map((x) => +x.toFixed(2)))));
}

let photSeq = 0;
/** Aperture photometry on every loaded exposure at the selected source. */
export async function runPhot(): Promise<void> {
  const s = store.session;
  const src = store.state.src;
  const seq = ++photSeq;
  if (!src || !s.exposures.some((e) => e.ok)) {
    s.phot = null;
    store.emit('phot');
    return;
  }
  const { x, y } = skyToPixel(src.ra, src.dec);
  if (x < 0 || y < 0 || x > s.nPx - 1 || y > s.nPx - 1) {
    s.phot = { status: 'empty', points: [], x, y };
    store.emit('phot');
    return;
  }
  const exps = s.exposures.filter((e) => e.ok);
  const ids = exps.map((e) => e.idx);
  let r = await stacker.phot(x, y, ids);
  if (store.session !== s || seq !== photSeq) return;
  // Saturated star: nearly every core measurement is flagged. Fall back to the unsaturated ring.
  let halo = false;
  const nGood = r.ok.reduce((n, v) => n + v, 0);
  const word = saturationWord();
  if (word && nGood < 0.1 * ids.length) {
    const c0 = [Math.round(y) * s.nPx + Math.round(x)];
    const sat = await stacker.bitFrac(ids, c0, word);
    if (store.session !== s || seq !== photSeq) return;
    if (sat.frac > 0.5) {
      r = await stacker.phot(x, y, ids, word);
      if (store.session !== s || seq !== photSeq) return;
      halo = true;
    }
  }
  const c = s.nPx / 2 - 0.5;
  const points: PhotPoint[] = exps.map((e, i) => {
    const k = halo ? MJYSR_TO_UJY : MJYSR_TO_UJY / apFraction(e.detector);
    return {
      idx: e.idx,
      wave: (e.wave_um ?? 0) + e.dwave_dx * (x - c) + e.dwave_dy * (y - c),
      flux: r.flux[i] * k,
      err: r.err[i] * k,
      ok: r.ok[i] === 1,
    };
  });
  s.phot = { status: 'ok', points, x, y, halo };
  store.emit('phot');
}

/** Flag bits that mean a pixel overflowed, looked up by name from the file headers. */
function saturationWord(): number {
  let word = 0;
  for (const [bit, name] of Object.entries(store.session.flagNames)) {
    if (/^(OVERFLOW|NONLINEAR|BLOOM)$/i.test(name)) word |= 1 << Number(bit);
  }
  return word >>> 0;
}

/** Fraction of exposures whose central 3×3 pixels are flagged as overflow / nonlinear / bloom. */
export async function checkSaturation(): Promise<void> {
  const s = store.session;
  const word = saturationWord();
  const ids = s.exposures.filter((e) => e.ok).map((e) => e.idx);
  if (!word || !ids.length) return;
  const c = Math.floor(s.nPx / 2);
  const pixels: number[] = [];
  for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) pixels.push((c + dy) * s.nPx + c + dx);
  const r = await stacker.bitFrac(ids, pixels, word);
  if (store.session !== s) return;
  s.saturatedFrac = r.frac;
  store.emit('session');
}
