// Written with AI assistance (Claude) for the NASA Space Apps 2026 hackathon.
// Small astronomy helpers for the 3D map. Axes are ICRS: +x RA 0, +y RA 90, +z north pole.

export const PC_TO_LY = 3.261563777;
export const KMS_PER_PCYR = 977792.2216807891; // 1 pc/yr in km/s
export const RAD_TO_ARCSEC = 206264.80624709636;
/** One SPHEREx pixel, arcseconds. */
export const SPHEREX_PIXEL = 6.2;

export type Vec3 = [number, number, number];

export function unitFromRaDec(raDeg: number, decDeg: number): Vec3 {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
}

export function raDecFromVec(x: number, y: number, z: number): { ra: number; dec: number; dist: number } {
  const dist = Math.hypot(x, y, z);
  let ra = (Math.atan2(y, x) * 180) / Math.PI;
  if (ra < 0) ra += 360;
  const dec = (Math.asin(Math.max(-1, Math.min(1, z / dist))) * 180) / Math.PI;
  return { ra, dec, dist };
}

/** North Galactic pole and Galactic centre directions in ICRS. */
export const GALACTIC_NORTH = unitFromRaDec(192.85948, 27.12825);
export const GALACTIC_CENTRE = unitFromRaDec(266.40499, -28.93617);

/** Today's date as a Julian-style decimal year. */
export function yearNow(): number {
  const d = new Date();
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const end = Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  return d.getUTCFullYear() + (d.getTime() - start) / (end - start);
}

export function angularSepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a = unitFromRaDec(ra1, dec1);
  const b = unitFromRaDec(ra2, dec2);
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * RAD_TO_ARCSEC;
}

const MINUS = '−';

export function signed(v: number, digits: number): string {
  const s = Math.abs(v).toFixed(digits);
  return (v < 0 ? MINUS : '+') + s;
}

export function fmtInt(v: number): string {
  return Math.round(Math.abs(v)).toLocaleString('en-US');
}

export function fmtRa(raDeg: number): string {
  const h = raDeg / 15;
  const hh = Math.floor(h);
  const m = (h - hh) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${ss.toFixed(1).padStart(4, '0')}s`;
}

export function fmtDec(decDeg: number): string {
  const a = Math.abs(decDeg);
  const dd = Math.floor(a);
  const m = (a - dd) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${decDeg < 0 ? MINUS : '+'}${String(dd).padStart(2, '0')}° ${String(mm).padStart(2, '0')}′ ${ss.toFixed(0).padStart(2, '0')}″`;
}

/** Lower-case, accent-free, punctuation-light form used for name search. */
export function normaliseName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[−–—]/g, '-')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
