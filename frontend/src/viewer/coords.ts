// SkyDive viewer — coordinate parsing, formatting, dates and sky geometry.
// Written with AI coding assistance (Claude Code).

export interface Parsed {
  ra: number;
  dec: number;
}

const D2R = Math.PI / 180;

/** Parse decimal degrees, sexagesimal, or a WiseView-style link. Returns null if it is not coordinates. */
export function parseCoords(input: string): Parsed | null {
  let s = input.trim();
  if (!s) return null;

  // WiseView / any link carrying ra= and dec= in hash or query.
  const mra = s.match(/[#?&]ra=([-+]?[\d.]+)/i);
  const mdec = s.match(/[#?&]dec=([-+]?[\d.]+)/i);
  if (mra && mdec) return check(parseFloat(mra[1]), parseFloat(mdec[1]));

  s = s.replace(/[°º]/g, 'd').replace(/[′’']/g, 'm').replace(/[″”"]/g, 's').replace(/−/g, '-');

  // Sexagesimal with letters: 08h55m10.831s -7d14m42.53s
  const hms = s.match(
    /^(\d{1,2})\s*h\s*(\d{1,2})\s*m\s*([\d.]+)\s*s?\s*[, ]\s*([-+]?)\s*(\d{1,2})\s*d\s*(\d{1,2})\s*m\s*([\d.]+)\s*s?$/i,
  );
  if (hms) {
    const ra = (parseInt(hms[1]) + parseInt(hms[2]) / 60 + parseFloat(hms[3]) / 3600) * 15;
    const dec = (parseInt(hms[5]) + parseInt(hms[6]) / 60 + parseFloat(hms[7]) / 3600) * (hms[4] === '-' ? -1 : 1);
    return check(ra, dec);
  }

  // Sexagesimal with colons or spaces: 08:55:10.8 -07:14:42  /  08 55 10.8 -07 14 42
  const col = s.match(
    /^(\d{1,2})[:\s](\d{1,2})[:\s]([\d.]+)\s*[, ]\s*([-+]?)(\d{1,2})[:\s](\d{1,2})[:\s]([\d.]+)$/,
  );
  if (col) {
    const ra = (parseInt(col[1]) + parseInt(col[2]) / 60 + parseFloat(col[3]) / 3600) * 15;
    const dec = (parseInt(col[5]) + parseInt(col[6]) / 60 + parseFloat(col[7]) / 3600) * (col[4] === '-' ? -1 : 1);
    return check(ra, dec);
  }

  // Decimal degrees: "133.7588 -7.2418", "133.7588, -7.2418", "133.7588d -7.2418d", "ra=.. dec=.."
  const dec2 = s
    .replace(/\b(ra|dec)\s*[=:]\s*/gi, '')
    .replace(/d(eg)?\b/gi, '')
    .match(/^([-+]?\d+(?:\.\d*)?)\s*[,;\s]\s*([-+]?\d+(?:\.\d*)?)$/);
  if (dec2) return check(parseFloat(dec2[1]), parseFloat(dec2[2]));

  return null;
}

function check(ra: number, dec: number): Parsed | null {
  if (!isFinite(ra) || !isFinite(dec)) return null;
  if (ra < 0 || ra >= 360.0000001 || dec < -90 || dec > 90) return null;
  return { ra: ((ra % 360) + 360) % 360, dec };
}

export function fmtDeg(v: number, digits = 4): string {
  return v.toFixed(digits).replace('-', '−');
}

export function fmtRaHms(ra: number): string {
  const h = ra / 15;
  const hh = Math.floor(h);
  const m = (h - hh) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${p2(hh)}h${p2(mm)}m${ss.toFixed(2).padStart(5, '0')}s`;
}

export function fmtDecDms(dec: number): string {
  const sign = dec < 0 ? '−' : '+';
  const a = Math.abs(dec);
  const dd = Math.floor(a);
  const m = (a - dd) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${sign}${p2(dd)}°${p2(mm)}′${ss.toFixed(1).padStart(4, '0')}″`;
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function mjdToDate(mjd: number): Date {
  return new Date((mjd - 40587) * 86400000);
}
export function dateToMjd(d: Date): number {
  return d.getTime() / 86400000 + 40587;
}
export function mjdToYear(mjd: number): number {
  return 2000 + (mjd - 51544.5) / 365.25;
}
export function yearToMjd(y: number): number {
  return (y - 2000) * 365.25 + 51544.5;
}
export function mjdIso(mjd: number): string {
  return mjdToDate(mjd).toISOString().slice(0, 10);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function mjdMonth(mjd: number): string {
  const d = mjdToDate(mjd);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface Mover {
  ra: number;
  dec: number;
  epoch: number;
  pmra: number | null;
  pmdec: number | null;
}

/** Move a catalogue position to a Julian year using linear proper motion (pmra includes cos dec, mas/yr). */
export function propagate(s: Mover, year: number): { ra: number; dec: number } {
  const dt = year - s.epoch;
  const pmra = s.pmra ?? 0;
  const pmdec = s.pmdec ?? 0;
  const dec = s.dec + (pmdec * dt) / 3.6e6;
  const ra = s.ra + (pmra * dt) / 3.6e6 / Math.cos(s.dec * D2R);
  return { ra, dec };
}

/** Gnomonic projection: offsets in arcsec (east, north) of a point from the field centre. */
export function skyToOffset(ra: number, dec: number, ra0: number, dec0: number): { east: number; north: number } {
  const a = ra * D2R,
    d = dec * D2R,
    a0 = ra0 * D2R,
    d0 = dec0 * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  return { east: (xi / D2R) * 3600, north: (eta / D2R) * 3600 };
}

/** Inverse gnomonic projection. */
export function offsetToSky(east: number, north: number, ra0: number, dec0: number): { ra: number; dec: number } {
  const xi = (east / 3600) * D2R,
    eta = (north / 3600) * D2R;
  const a0 = ra0 * D2R,
    d0 = dec0 * D2R;
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return { ra: ra0, dec: dec0 };
  const c = Math.atan(rho);
  const d = Math.asin(Math.cos(c) * Math.sin(d0) + (eta * Math.sin(c) * Math.cos(d0)) / rho);
  const a = a0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
  return { ra: (((a / D2R) % 360) + 360) % 360, dec: d / D2R };
}

/** Angular separation in arcsec (small-angle safe). */
export function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const o = skyToOffset(ra1, dec1, ra2, dec2);
  return Math.hypot(o.east, o.north);
}
