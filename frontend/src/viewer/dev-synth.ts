// SkyDive viewer — DEV ONLY synthetic backend (`?synth=1`). Fake stars so the UI could be built
// before the real pipeline existed. Never used in production builds; never shown as real data.
// Written with AI coding assistance (Claude Code).
import { DETECTORS, MASK_BITS } from './types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
}

function skyb(header: unknown, arrays: (Float32Array | Uint32Array)[]): ArrayBuffer {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const off = Math.ceil((8 + h.length) / 4) * 4;
  const len = arrays.reduce((n, a) => n + a.byteLength, 0);
  const out = new Uint8Array(off + len);
  out.set([83, 75, 89, 66]);
  new DataView(out.buffer).setUint32(4, h.length, true);
  out.set(h, 8);
  let o = off;
  for (const a of arrays) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
    o += a.byteLength;
  }
  return out.buffer;
}

const STARS = (() => {
  const r = rng(7);
  return Array.from({ length: 40 }, () => ({ e: (r() - 0.5) * 800, n: (r() - 0.5) * 800, f: 0.05 + r() * r() * 2, c: r() }));
})();
const MOVER = { pme: -8.1, pmn: 0.7, f: 0.25 }; // arcsec / yr

function render(nPx: number, scale: number, year: number, wave: number, noise: number, seed: number): Float32Array {
  const r = rng(seed);
  const img = new Float32Array(nPx * nPx);
  for (let i = 0; i < img.length; i++) img[i] = gauss(r) * noise;
  const c = nPx / 2 - 0.5;
  const sig = Math.max(0.6, 3.6 / scale);
  const put = (e: number, n: number, f: number) => {
    const x = c - e / scale,
      y = c - n / scale;
    for (let yy = Math.max(0, Math.floor(y - 4 * sig)); yy <= Math.min(nPx - 1, y + 4 * sig); yy++)
      for (let xx = Math.max(0, Math.floor(x - 4 * sig)); xx <= Math.min(nPx - 1, x + 4 * sig); xx++)
        img[yy * nPx + xx] += (f / (sig * sig)) * Math.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sig * sig));
  };
  for (const s of STARS) put(s.e, s.n, s.f * (0.4 + s.c * (5 - wave) * 0.3));
  const dt = year - 2026.87;
  put(MOVER.pme * dt, MOVER.pmn * dt, MOVER.f * (wave > 4 ? 3 : 0.2));
  return img;
}

const exposures = (() => {
  const r = rng(3);
  const out: any[] = [];
  const visits = [60830, 60930, 61050, 61150];
  visits.forEach((m0, v) => {
    for (const d of DETECTORS)
      for (let k = 0; k < (v === 2 ? 4 : 10); k++) {
        const wave = d.lo + ((k + r()) / 10) * (d.hi - d.lo);
        out.push({
          id: `SYN_${v}_${d.n}_${k}`, mjd: m0 + r() * 20, detector: d.n, wave_um: wave, bw_um: wave / 40,
          release: 'synthetic', key: 'synthetic.fits', url: 'about:blank', visit: v,
        });
      }
  });
  out.sort((a, b) => a.mjd - b.mjd);
  return out;
})();

export async function synth(path: string, body?: any): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
  const u = new URL(path, 'http://x');
  const q = u.searchParams;
  switch (u.pathname) {
    case '/api/exposures':
      return {
        releases: ['synthetic'], exposures,
        visits: [0, 1, 2, 3].map((v) => {
          const e = exposures.filter((x) => x.visit === v);
          return { id: v, mjd_start: e[0].mjd, mjd_end: e[e.length - 1].mjd, n: e.length };
        }),
      };
    case '/api/cutouts': {
      const n = body.n_px as number;
      const arrays: (Float32Array | Uint32Array)[] = [];
      const items = (body.ids as string[]).map((id, i) => {
        const e = exposures.find((x) => x.id === id);
        const seed = id.split('').reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
        const img = render(n, 6.15, 2000 + (e.mjd - 51544.5) / 365.25, e.wave_um, 0.03, seed);
        const fl = new Uint32Array(n * n);
        const r = rng(seed + 1);
        for (let p = 0; p < fl.length; p++) {
          if (img[p] > 0.08) fl[p] |= 1 << 21;
          if (r() < 0.01) { fl[p] |= 1 << MASK_BITS[Math.floor(r() * MASK_BITS.length)]; img[p] += 2; }
        }
        arrays.push(img, fl);
        return { id, ok: true, mjd: e.mjd, detector: e.detector, wave_um: e.wave_um, bw_um: e.bw_um, dwave_dx: 0.0001, dwave_dy: 0.001, bg: 0.4, flag_frac: 0.01 + (i % 5) * 0.004 };
      });
      return skyb({ ra: body.ra, dec: body.dec, n_px: n, pixscale_arcsec: 6.15,
        flag_names: { 0: 'TRANSIENT', 1: 'OVERFLOW', 2: 'SUR_ERROR', 6: 'NONFUNC', 10: 'HOT', 15: 'NONLINEAR', 21: 'SOURCE', 22: 'GHOST', 26: 'BLOOM' }, items }, arrays);
    }
    case '/api/history': {
      const arcsec = parseFloat(q.get('arcsec')!);
      const frames: any[] = [], arrays: Float32Array[] = [];
      for (let e = 0; e < 23; e++) {
        const mjd = 55320 + e * 182.6 + (e > 1 ? 1000 : 0);
        for (const band of ['W1', 'W2']) {
          const n = Math.round(arcsec / 2.75);
          frames.push({ survey: 'wise', band, mjd, n_px: n, pixscale_arcsec: 2.75, label: `WISE ${band}` });
          arrays.push(render(n, 2.75, 2000 + (mjd - 51544.5) / 365.25, band === 'W1' ? 3.4 : 4.6, 0.02, e * 2 + 1));
        }
      }
      for (let k = 0; k < 3; k++) {
        const n = Math.min(512, Math.round(arcsec / 1));
        const mjd = 55900 + k * 365;
        frames.push({ survey: 'ps1', band: 'y', mjd, n_px: n, pixscale_arcsec: arcsec / n, label: 'Pan-STARRS y' });
        arrays.push(render(n, arcsec / n, 2000 + (mjd - 51544.5) / 365.25, 1, 0.01, 99 + k));
      }
      return skyb({ ra: 0, dec: 0, arcsec, frames, notes: [] }, arrays);
    }
    case '/api/overlay': {
      const ra = parseFloat(q.get('ra')!), dec = parseFloat(q.get('dec')!);
      const cd = Math.cos((dec * Math.PI) / 180);
      const sources: any[] = STARS.slice(0, 25).map((s, i) => ({ cat: 'gaia', id: 'syn' + i, ra: ra + s.e / 3600 / cd, dec: dec + s.n / 3600, epoch: 2016, pmra: 3, pmdec: -2, mag: 18 - s.f * 4 }));
      const dt = 2015.4 - 2026.87;
      sources.push({ cat: 'catwise', id: 'J-mover', ra: ra + (MOVER.pme * dt) / 3600 / cd, dec: dec + (MOVER.pmn * dt) / 3600, epoch: 2015.4, pmra: MOVER.pme * 1000, pmdec: MOVER.pmn * 1000, mag: 13.9 });
      sources.push({ cat: 'vsx', id: 'V1', name: 'V* Synth', ra: ra + STARS[3].e / 3600 / cd, dec: dec + STARS[3].n / 3600, epoch: 2000, pmra: 0, pmdec: 0, vtype: 'M', period: 246 });
      return { sources, warnings: [], notes: [] };
    }
    case '/api/neossat':
      return { count: 0, date_min: null, date_max: null, previews: [] };
    case '/api/sso':
      return { objects: [], note: 'synthetic' };
    case '/api/resolve':
      return { name: q.get('q'), ra: 133.78, dec: -7.24, pmra: 0, pmdec: 0 };
  }
  throw new Error('synthetic backend: unknown path ' + path);
}
