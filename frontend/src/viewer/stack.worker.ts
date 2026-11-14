// SkyDive viewer — stacking worker. Holds every exposure; does flag-masked medians and
// aperture photometry off the main thread. Written with AI coding assistance (Claude Code).
/// <reference lib="webworker" />

let nPx = 0;
let maskWord = 0;
const images: Float32Array[] = [];
const flags: Uint32Array[] = [];

export type WorkerRequest =
  | { t: 'reset'; nPx: number; maskWord: number }
  | { t: 'mask'; maskWord: number }
  | { t: 'add'; items: { idx: number; image: Float32Array; flags: Uint32Array }[] }
  | { t: 'stack'; req: number; sets: number[][] }
  | { t: 'phot'; req: number; x: number; y: number; ids: number[]; haloWord?: number }
  | { t: 'apcor'; req: number; sets: number[][]; stars: number[][] }
  | { t: 'flagsAt'; req: number; ids: number[]; px: number }
  | { t: 'bitFrac'; req: number; ids: number[]; pixels: number[]; word: number };

function median(buf: Float32Array, n: number): number {
  if (n === 0) return NaN;
  if (n === 1) return buf[0];
  if (n <= 48) {
    // insertion sort
    for (let i = 1; i < n; i++) {
      const v = buf[i];
      let j = i - 1;
      while (j >= 0 && buf[j] > v) {
        buf[j + 1] = buf[j];
        j--;
      }
      buf[j + 1] = v;
    }
  } else {
    buf.subarray(0, n).sort();
  }
  const h = n >> 1;
  return n & 1 ? buf[h] : 0.5 * (buf[h - 1] + buf[h]);
}

function stackSet(ids: number[]): { img: Float32Array; tint: Uint8Array } {
  const np = nPx * nPx;
  const img = new Float32Array(np);
  const tint = new Uint8Array(np);
  const k = ids.length;
  if (k === 0) {
    img.fill(NaN);
    return { img, tint };
  }
  const ims = ids.map((i) => images[i]);
  const fls = ids.map((i) => flags[i]);
  const buf = new Float32Array(k);
  for (let p = 0; p < np; p++) {
    let n = 0;
    let masked = 0;
    let seen = 0;
    for (let e = 0; e < k; e++) {
      const v = ims[e][p];
      if (v !== v) continue; // NaN: outside the footprint
      seen++;
      if (fls[e][p] & maskWord) {
        masked++;
        continue;
      }
      buf[n++] = v;
    }
    img[p] = median(buf, n);
    tint[p] = seen ? Math.round((255 * masked) / seen) : 0;
  }
  return { img, tint };
}

/** A sorted subsample of finite values across several images, for percentile lookups. */
function pooledSample(imgs: Float32Array[]): Float32Array {
  let total = 0;
  for (const im of imgs) total += im.length;
  const step = Math.max(1, Math.floor(total / 200000));
  const out = new Float32Array(Math.ceil(total / step) + imgs.length);
  let n = 0;
  for (const im of imgs) {
    for (let i = 0; i < im.length; i += step) {
      const v = im[i];
      if (v === v) out[n++] = v;
    }
  }
  return out.slice(0, n).sort();
}

const R_AP = 1.6; // aperture radius, pixels (about one PSF FWHM across)
const R_IN = 4;
const R_OUT = 7;
const R_TOTAL = 4.5; // "total flux" aperture for the aperture correction (27.7 arcsec)
const R_TOTAL_IN = 7;
const R_TOTAL_OUT = 10;

interface Aperture {
  /** Pixel indices and soft-edge weights (0..1) inside the aperture. */
  px: number[];
  w: number[];
  area: number;
  ann: number[];
}

/** Circular aperture with a one-pixel-wide linear edge, so sub-pixel centring changes the sum smoothly. */
function aperture(x: number, y: number, r: number, rIn: number, rOut: number): Aperture {
  const px: number[] = [], w: number[] = [], ann: number[] = [];
  let area = 0;
  const x0 = Math.max(0, Math.floor(x - rOut)), x1 = Math.min(nPx - 1, Math.ceil(x + rOut));
  const y0 = Math.max(0, Math.floor(y - rOut)), y1 = Math.min(nPx - 1, Math.ceil(y + rOut));
  for (let row = y0; row <= y1; row++)
    for (let c = x0; c <= x1; c++) {
      const d = Math.hypot(c - x, row - y);
      const wt = Math.min(1, Math.max(0, r + 0.5 - d));
      if (wt > 0) {
        px.push(row * nPx + c);
        w.push(wt);
        area += wt;
      } else if (d >= rIn && d <= rOut) ann.push(row * nPx + c);
    }
  return { px, w, area, ann };
}

function phot(x: number, y: number, ids: number[]) {
  const flux = new Float32Array(ids.length);
  const err = new Float32Array(ids.length);
  const ok = new Uint8Array(ids.length);
  const ap = aperture(x, y, R_AP, R_IN, R_OUT);
  const buf = new Float32Array(ap.ann.length);
  const dev = new Float32Array(ap.ann.length);
  for (let e = 0; e < ids.length; e++) {
    const im = images[ids[e]],
      fl = flags[ids[e]];
    let n = 0;
    for (const p of ap.ann) {
      const v = im[p];
      if (v === v && !(fl[p] & maskWord)) buf[n++] = v;
    }
    let good = ap.px.length > 0 && n >= 8;
    const bg = n ? median(buf, n) : 0;
    for (let i = 0; i < n; i++) dev[i] = Math.abs(buf[i] - bg);
    const sigma = n ? 1.4826 * median(dev, n) : NaN;
    let sum = 0;
    for (let i = 0; i < ap.px.length; i++) {
      const p = ap.px[i];
      const v = im[p];
      if (v !== v || fl[p] & maskWord) {
        // A bad pixel that only grazes the soft edge is skipped rather than losing the exposure.
        if (ap.w[i] < 0.25) continue;
        good = false;
        break;
      }
      sum += ap.w[i] * (v - bg);
    }
    flux[e] = sum;
    err[e] = sigma * Math.sqrt(ap.area);
    ok[e] = good ? 1 : 0;
  }
  return { flux, err, ok, nAp: ap.area };
}

/**
 * For a saturated star: brightness of the unsaturated ring of the PSF (4–7 px) above the sky
 * further out (10–13 px). Relative only, but it follows the star when the core is unusable.
 */
function haloPhot(x: number, y: number, ids: number[], satWord: number) {
  const flux = new Float32Array(ids.length);
  const err = new Float32Array(ids.length);
  const ok = new Uint8Array(ids.length);
  const ring = aperture(x, y, 0, R_IN, R_OUT).ann;
  const sky = aperture(x, y, 0, 10, 13).ann;
  const a = new Float32Array(ring.length), d = new Float32Array(ring.length), b = new Float32Array(sky.length);
  for (let e = 0; e < ids.length; e++) {
    const im = images[ids[e]], fl = flags[ids[e]];
    let n = 0, m = 0;
    for (const p of ring) if (im[p] === im[p] && !(fl[p] & satWord)) a[n++] = im[p];
    for (const p of sky) if (im[p] === im[p] && !(fl[p] & satWord)) b[m++] = im[p];
    if (n < ring.length * 0.6 || m < sky.length * 0.5) continue;
    const keep = a.slice(0, n);
    const med = median(a, n);
    const bg = median(b, m);
    for (let i = 0; i < n; i++) d[i] = Math.abs(keep[i] - med);
    flux[e] = (med - bg) * ring.length;
    err[e] = ((1.4826 * median(d, n)) / Math.sqrt(n)) * ring.length;
    ok[e] = 1;
  }
  return { flux, err, ok, nAp: ring.length };
}

/** Sky-subtracted aperture sum on a stacked image; null if any pixel is missing. */
function stackSum(img: Float32Array, ap: Aperture): { sum: number; sigma: number } | null {
  const buf = new Float32Array(ap.ann.length);
  let n = 0;
  for (const p of ap.ann) if (img[p] === img[p]) buf[n++] = img[p];
  if (n < 12) return null;
  const sorted = buf.slice(0, n);
  const bg = median(sorted, n);
  const dev = new Float32Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(buf[i] - bg);
  const sigma = 1.4826 * median(dev, n);
  let sum = 0;
  for (let i = 0; i < ap.px.length; i++) {
    const v = img[ap.px[i]];
    if (v !== v) return null;
    sum += ap.w[i] * (v - bg);
  }
  return { sum, sigma: sigma * Math.sqrt(ap.area) };
}

/**
 * Aperture correction from the data: on each detector's all-visit stack, the ratio of the small
 * measurement aperture to a large one, for the given (isolated, unsaturated) stars.
 */
function apcor(sets: number[][], stars: number[][]): number[][] {
  return sets.map((ids) => {
    const ratios: number[] = [];
    if (ids.length < 3) return ratios;
    const { img, tint } = stackSet(ids);
    for (const [sx, sy] of stars) {
      // Centre on the star as the viewer does on a click: peak of the 3x3, then its centroid.
      let bc = Math.round(sx), br = Math.round(sy), bv = -Infinity;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const c = Math.round(sx) + dc, r = Math.round(sy) + dr;
          if (c < 0 || r < 0 || c >= nPx || r >= nPx) continue;
          const v = img[r * nPx + c];
          if (v > bv) { bv = v; bc = c; br = r; }
        }
      if (bc < R_TOTAL_OUT + 1 || br < R_TOTAL_OUT + 1 || bc > nPx - R_TOTAL_OUT - 2 || br > nPx - R_TOTAL_OUT - 2) continue;
      let sw = 0, cx = 0, cy = 0, masked = false;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const p = (br + dr) * nPx + bc + dc;
          if (tint[p] > 64) masked = true; // core flagged in many exposures: saturated or bad
          const v = Math.max(0, img[p]);
          if (v === v) { sw += v; cx += v * (bc + dc); cy += v * (br + dr); }
        }
      if (masked || sw <= 0) continue;
      cx /= sw;
      cy /= sw;
      const small = stackSum(img, aperture(cx, cy, R_AP, R_IN, R_OUT));
      const big = stackSum(img, aperture(cx, cy, R_TOTAL, R_TOTAL_IN, R_TOTAL_OUT));
      if (!small || !big || big.sum <= 0 || big.sum < 25 * big.sigma) continue;
      const ratio = small.sum / big.sum;
      if (ratio > 0.3 && ratio < 1.05) ratios.push(ratio);
    }
    return ratios;
  });
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data;
  switch (m.t) {
    case 'reset':
      nPx = m.nPx;
      maskWord = m.maskWord;
      images.length = 0;
      flags.length = 0;
      break;
    case 'mask':
      maskWord = m.maskWord;
      break;
    case 'add':
      for (const it of m.items) {
        images[it.idx] = it.image;
        flags[it.idx] = it.flags;
      }
      break;
    case 'stack': {
      const out = m.sets.map(stackSet);
      const sample = pooledSample(out.map((o) => o.img));
      const transfer: Transferable[] = [sample.buffer];
      for (const o of out) transfer.push(o.img.buffer, o.tint.buffer);
      (self as unknown as Worker).postMessage({ req: m.req, out, sample }, transfer);
      break;
    }
    case 'phot': {
      const r = m.haloWord ? haloPhot(m.x, m.y, m.ids, m.haloWord) : phot(m.x, m.y, m.ids);
      (self as unknown as Worker).postMessage({ req: m.req, ...r }, [r.flux.buffer, r.err.buffer, r.ok.buffer]);
      break;
    }
    case 'apcor':
      (self as unknown as Worker).postMessage({ req: m.req, ratios: apcor(m.sets, m.stars) });
      break;
    case 'flagsAt': {
      const counts = new Uint16Array(32);
      let n = 0;
      for (const i of m.ids) {
        const im = images[i];
        if (!im || im[m.px] !== im[m.px]) continue;
        n++;
        const f = flags[i][m.px];
        if (!f) continue;
        for (let b = 0; b < 32; b++) if (f & (1 << b)) counts[b]++;
      }
      (self as unknown as Worker).postMessage({ req: m.req, counts, n });
      break;
    }
    case 'bitFrac': {
      // Fraction of exposures where any of `pixels` carries any bit of `word`.
      let hit = 0,
        n = 0;
      for (const i of m.ids) {
        const fl = flags[i];
        if (!fl) continue;
        n++;
        for (const p of m.pixels)
          if (fl[p] & m.word) {
            hit++;
            break;
          }
      }
      (self as unknown as Worker).postMessage({ req: m.req, frac: n ? hit / n : 0, n });
      break;
    }
  }
};
