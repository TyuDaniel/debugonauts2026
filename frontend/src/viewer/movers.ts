// SkyDive viewer — decides which catalogue sources are real movers (full marker, label, trail),
// which are ordinary (small faint mark) and which are artefacts or duplicates (hidden).
// Written with AI coding assistance (Claude Code).
import { propagate, sepArcsec } from './coords';
import type { OverlaySource } from './types';

export interface Verdict {
  mover: boolean;
  hidden: boolean;
}

/** Under about one SPHEREx pixel of travel over the 16-year span counts as not moving. */
export const MOVER_MASYR = 400;
const TRACK_SEP = 15; // arcsec: closer tracks are treated as the same object
const cache = new WeakMap<OverlaySource[], Map<OverlaySource, Verdict>>();

const pm = (s: OverlaySource) => Math.hypot(s.pmra ?? 0, s.pmdec ?? 0);
const sigmaOf = (s: OverlaySource) => (s as OverlaySource & { pm_sigma?: number }).pm_sigma;
/** How many sigma the motion is; Gaia motions are effectively exact at this scale. */
const significance = (s: OverlaySource) => (s.cat === 'gaia' ? 1e6 : pm(s) / Math.max(1, sigmaOf(s) ?? 1e9));

function track(s: OverlaySource): { ra: number; dec: number }[] {
  const out = [];
  for (let y = 2010; y <= 2027.01; y += 17 / 16) out.push(propagate(s, y));
  return out;
}

function tracksTouch(a: { ra: number; dec: number }[], b: { ra: number; dec: number }[]): boolean {
  for (const p of a) for (const q of b) if (sepArcsec(p.ra, p.dec, q.ra, q.dec) < TRACK_SEP) return true;
  return false;
}

export function classify(sources: OverlaySource[]): Map<OverlaySource, Verdict> {
  const hit = cache.get(sources);
  if (hit) return hit;
  const out = new Map<OverlaySource, Verdict>();
  // CatWISE near a bright star is mostly diffraction-spike and halo artefacts with wild "motions".
  const bright = sources
    .filter((g) => g.cat === 'gaia' && (g.mag ?? 99) < 11)
    .map((g) => ({ ...propagate(g, 2015.4), r: g.mag! < 9 ? 240 : g.mag! < 10 ? 90 : 40 }));
  const candidates: OverlaySource[] = [];
  for (const s of sources) {
    const v: Verdict = { mover: false, hidden: false };
    out.set(s, v);
    const m = pm(s);
    const mag = s.mag ?? 99;
    if (s.cat === 'gaia') {
      v.mover = m >= MOVER_MASYR;
    } else if (s.cat === 'catwise') {
      for (const b of bright) {
        const d = sepArcsec(s.ra, s.dec, b.ra, b.dec);
        if (d < b.r && d > 12) v.hidden = true;
      }
      const sg = sigmaOf(s);
      // CatWISE motions of faint sources are noisy: only trust well-measured ones.
      v.mover = !v.hidden && sg != null && ((m >= 1000 && m > 10 * sg && mag < 15.5) || (m >= MOVER_MASYR && m > 20 * sg && mag < 14.5));
    }
    if (v.mover) candidates.push(s);
  }
  // The same fast object often appears several times along its own track (and with a bogus
  // motion where it blended with a background star): keep one. Gaia beats CatWISE; among CatWISE
  // the brightest entry wins, because blends with a background star are fainter and their formal
  // motion errors are misleadingly small. Significance breaks ties.
  const rank = (s: OverlaySource) => (s.cat === 'gaia' ? -100 : Math.round((s.mag ?? 99) * 4) / 4);
  candidates.sort((a, b) => rank(a) - rank(b) || significance(b) - significance(a));
  const kept: { s: OverlaySource; t: { ra: number; dec: number }[] }[] = [];
  for (const s of candidates) {
    const t = track(s);
    if (kept.some((k) => tracksTouch(k.t, t))) {
      const v = out.get(s)!;
      v.mover = false;
      v.hidden = true;
    } else kept.push({ s, t });
  }
  cache.set(sources, out);
  return out;
}
