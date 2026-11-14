// SkyDive viewer — pure drawing: pixels with a stretch, and the overlay layer (markers moved to
// the frame's date, trails, compass, scale bar). Used by the live canvas and the GIF export.
// Written with AI coding assistance (Claude Code).
import type { Picture } from './compute';
import { mjdToYear, propagate, skyToOffset } from './coords';
import { classify } from './movers';
import { store } from './store';
import { SPHEREX_SCALE, type OverlaySource } from './types';

export const MARK = {
  gaia: '#5cc8ff',
  catwise: '#3ddbb0',
  vsx: '#f49ac8',
  sso: '#ffd23f',
  select: '#c8f53a',
  flag: '#ff5c3a',
};

const ASINH_K = 10;
const ASINH_NORM = Math.asinh(ASINH_K);

const scratch = document.createElement('canvas');
const scratchCtx = scratch.getContext('2d')!;
const tintCanvas = document.createElement('canvas');
const tintCtx = tintCanvas.getContext('2d')!;

export function fieldArcsec(): number {
  return store.session.nPx * SPHEREX_SCALE;
}

/**
 * Zoom and pan of the image box. `z` is the magnification (1 shows the whole field) and
 * (`cx`, `cy`) is the point of the field, as a fraction from its top-left, at the middle of the box.
 */
export interface Zoom {
  z: number;
  cx: number;
  cy: number;
}
export const NO_ZOOM: Zoom = { z: 1, cx: 0.5, cy: 0.5 };

/** Where a picture lands inside a square box of `size` px: all surveys share one sky box. */
export function pictureRect(pic: { nPx: number; pixscale: number }, size: number, view: Zoom = NO_ZOOM): { x: number; y: number; w: number } {
  const w0 = (size * pic.nPx * pic.pixscale) / fieldArcsec();
  const f0 = (size - w0) / 2 / size;
  return { x: size * (0.5 + (f0 - view.cx) * view.z), y: size * (0.5 + (f0 - view.cy) * view.z), w: w0 * view.z };
}

export function paintImage(ctx: CanvasRenderingContext2D, size: number, pic: Picture, view: Zoom = NO_ZOOM): void {
  const { stretch, invert } = store.state;
  const n = pic.nPx;
  if (scratch.width !== n || scratch.height !== n) {
    scratch.width = n;
    scratch.height = n;
  }
  const im = scratchCtx.createImageData(n, n);
  const px = new Uint32Array(im.data.buffer);
  const { data, lo, offset } = pic;
  const span = pic.hi - lo || 1;
  const useAsinh = stretch === 'asinh' && !pic.diverging;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) {
      px[i] = 0xff1c1612; // no data: a dark blue-grey, distinct from black sky
      continue;
    }
    let t = (v - offset - lo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (useAsinh) t = Math.asinh(t * ASINH_K) / ASINH_NORM;
    if (invert) t = 1 - t;
    const g = (t * 255 + 0.5) | 0;
    px[i] = 0xff000000 | (g << 16) | (g << 8) | g;
  }
  scratchCtx.putImageData(im, 0, 0);
  ctx.fillStyle = '#050604';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = false;
  const r = pictureRect(pic, size, view);
  ctx.drawImage(scratch, r.x, r.y, r.w, r.w);
}

function paintTint(ctx: CanvasRenderingContext2D, size: number, pic: Picture, view: Zoom): void {
  if (!pic.tint) return;
  const n = pic.nPx;
  tintCanvas.width = n;
  tintCanvas.height = n;
  const im = tintCtx.createImageData(n, n);
  const px = new Uint32Array(im.data.buffer);
  for (let i = 0; i < pic.tint.length; i++) {
    const f = pic.tint[i];
    if (f < 26) continue; // under 10% of exposures masked here
    const a = Math.min(200, 60 + f * 0.6) | 0;
    px[i] = (a << 24) | (0x3a << 16) | (0x5c << 8) | 0xff; // ABGR of MARK.flag
  }
  tintCtx.putImageData(im, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const r = pictureRect(pic, size, view);
  ctx.drawImage(tintCanvas, r.x, r.y, r.w, r.w);
}

export interface Placed {
  kind: 'gaia' | 'catwise' | 'vsx' | 'sso';
  x: number;
  y: number;
  label: string;
  detail: string;
  ra: number;
  dec: number;
}

const pmTotal = (s: OverlaySource) => Math.hypot(s.pmra ?? 0, s.pmdec ?? 0);

function shape(ctx: CanvasRenderingContext2D, kind: Placed['kind'], x: number, y: number, r: number): void {
  ctx.beginPath();
  if (kind === 'gaia') ctx.arc(x, y, r, 0, Math.PI * 2);
  else if (kind === 'catwise') {
    ctx.moveTo(x, y - r * 1.25);
    ctx.lineTo(x + r * 1.25, y);
    ctx.lineTo(x, y + r * 1.25);
    ctx.lineTo(x - r * 1.25, y);
    ctx.closePath();
  } else if (kind === 'sso') {
    ctx.moveTo(x, y - r * 1.3);
    ctx.lineTo(x + r * 1.2, y + r * 0.9);
    ctx.lineTo(x - r * 1.2, y + r * 0.9);
    ctx.closePath();
  } else {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.62 : r * 1.45;
      ctx[i ? 'lineTo' : 'moveTo'](x + rr * Math.cos(a), y + rr * Math.sin(a));
    }
    ctx.closePath();
  }
}

/** Draw a marker legend glyph (used by the overlay toggles). */
export function glyph(kind: Placed['kind'] | 'flags', color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const d = Math.min(3, window.devicePixelRatio || 1);
  c.width = c.height = 16 * d;
  c.style.width = c.style.height = '16px';
  const g = c.getContext('2d')!;
  g.scale(d, d);
  if (kind === 'flags') {
    g.fillStyle = color;
    g.globalAlpha = 0.75;
    g.fillRect(3, 3, 10, 10);
  } else {
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    shape(g, kind, 8, kind === 'sso' ? 8.5 : 8, kind === 'gaia' ? 5 : 4.2);
    g.stroke();
  }
  return c;
}

const fmtPm = (masyr: number) => `${(masyr / 1000).toFixed(masyr >= 1000 ? 1 : 2)}″/yr`;

/**
 * Overlay layer. `u` is the CSS-pixel unit (device pixel ratio for the live canvas).
 * Returns the placed markers so the caller can hit-test them.
 */
/** Markers inside the image per layer, from the last overlay paint. */
export let layerCounts: Record<'gaia' | 'catwise' | 'vsx' | 'sso', number> = { gaia: 0, catwise: 0, vsx: 0, sso: 0 };

export function paintOverlay(
  ctx: CanvasRenderingContext2D,
  size: number,
  pic: Picture | null,
  mjd: number,
  u: number,
  opts: { chrome?: boolean; view?: Zoom } = {},
): Placed[] {
  const view = opts.view ?? NO_ZOOM;
  const st = store.state;
  const s = store.session;
  const on = new Set(st.ov);
  const field = fieldArcsec();
  const year = mjdToYear(mjd);
  const placed: Placed[] = [];
  if (st.ra == null || st.dec == null) return placed;
  const toXY = (ra: number, dec: number) => {
    const o = skyToOffset(ra, dec, st.ra!, st.dec!);
    // Field fraction, then the zoom and pan of the box. Markers keep their size at any zoom.
    return { x: (0.5 + (0.5 - o.east / field - view.cx) * view.z) * size, y: (0.5 + (0.5 - o.north / field - view.cy) * view.z) * size };
  };
  const inside = (p: { x: number; y: number }, m = 0) => p.x >= -m && p.y >= -m && p.x <= size + m && p.y <= size + m;

  if (pic && on.has('flags') && pic.kind === 'spherex') paintTint(ctx, size, pic, view);

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.font = `600 ${12 * u}px Geist, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  const labels: { x: number; y: number; w: number; text: string; color: string }[] = [];
  const queueLabel = (x: number, y: number, text: string, color: string) => {
    const w = ctx.measureText(text).width;
    let lx = x + 11 * u;
    if (lx + w > size - 4 * u) lx = x - 11 * u - w;
    const ly = Math.min(size - 8 * u, Math.max(8 * u, y - 10 * u));
    if (labels.some((l) => Math.abs(l.y - ly) < 13 * u && lx < l.x + l.w + 4 * u && l.x < lx + w + 4 * u)) return;
    labels.push({ x: lx, y: ly, w, text, color });
  };

  const verdicts = classify(s.overlay.data.sources);
  const all = st.marks === 'all';

  const drawCat = (cat: 'gaia' | 'catwise' | 'vsx') => {
    if (!on.has(cat)) return;
    const color = MARK[cat];
    for (const src of s.overlay.data.sources) {
      if (src.cat !== cat) continue;
      const verdict = verdicts.get(src)!;
      if (verdict.hidden) continue;
      const fast = verdict.mover;
      const pm = pmTotal(src);
      const mag = src.mag ?? 99;
      // An untrusted CatWISE motion is not applied: the source stays at its catalogue position.
      const pos = cat === 'catwise' && !fast ? { ra: src.ra, dec: src.dec } : propagate(src, year);
      const p = toXY(pos.ra, pos.dec);
      const named = cat === 'vsx' && (src.name ?? src.id).length <= 16;
      const strong = fast || named;
      if (!strong && cat !== 'vsx' && mag > (cat === 'gaia' ? 19.5 : 16.5)) continue;
      // Trail from 2010 to this frame's date for anything that visibly moves.
      if (fast) {
        const start = propagate(src, 2010.0);
        const p0 = toXY(start.ra, start.dec);
        if (inside(p, 20 * u) || inside(p0, 20 * u)) {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 1.75 * u;
          ctx.setLineDash([3 * u, 3 * u]);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(p0.x, p0.y, 1.75 * u, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
      if (!inside(p)) continue;
      const faint = cat === 'gaia' ? mag > 17 : cat === 'catwise' ? mag > 15 : false;
      // Movers and named variables get the largest marker; everything else is smaller but still clear.
      const r = (strong ? (fast ? 9 : 7) : faint ? 4 : mag < 12 ? 6.5 : 5) * u;
      ctx.globalAlpha = strong ? 1 : faint ? 0.6 : 0.85;
      shape(ctx, cat, p.x, p.y, r);
      // A dark outline under every marker keeps it readable on bright sky.
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = (strong ? 4.5 : 3) * u;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = (fast ? 2.25 : strong ? 1.75 : 1.25) * u;
      ctx.stroke();
      ctx.globalAlpha = 1;
      let label = '';
      let detail = '';
      if (cat === 'gaia') {
        detail = `Gaia DR3 ${src.id}${src.mag != null ? ` · G ${src.mag.toFixed(1)}` : ''}${pm ? ` · moves ${fmtPm(pm)}` : ''}`;
        if (fast) label = `Gaia · G ${src.mag?.toFixed(1) ?? '?'} · ${fmtPm(pm)}`;
      } else if (cat === 'catwise') {
        detail = `CatWISE ${src.id}${src.mag != null ? ` · W2 ${src.mag.toFixed(1)}` : ''}${pm ? ` · moves ${fmtPm(pm)}` : ''}`;
        if (fast) label = `CatWISE · W2 ${src.mag?.toFixed(1) ?? '?'} · ${fmtPm(pm)}`;
      } else {
        const per = src.period ? ` · ${(+src.period).toFixed(+src.period < 10 ? 2 : 0)} d` : '';
        const name = src.name ?? src.id;
        if (named || all) label = `${named ? name : 'Variable'}${src.vtype ? ` · ${src.vtype}` : ''}${per}`;
        detail = `Variable star ${name}${src.vtype ? ` · type ${src.vtype}` : ''}${per}${src.max_mag ? ` · ${src.max_mag}–${src.min_mag ?? '?'}` : ''}`;
      }
      if (label) queueLabel(p.x, p.y, label, color);
      placed.push({ kind: cat, x: p.x, y: p.y, label, detail, ra: pos.ra, dec: pos.dec });
    }
  };
  drawCat('gaia');
  drawCat('catwise');
  drawCat('vsx');

  // How many markers each layer has inside the image, whether or not the layer is switched on.
  const n = { gaia: 0, catwise: 0, vsx: 0, sso: 0 };
  for (const src of s.overlay.data.sources) {
    const cat = src.cat as 'gaia' | 'catwise' | 'vsx';
    if (!(cat in n)) continue;
    const verdict = verdicts.get(src);
    if (!verdict || verdict.hidden) continue;
    const named = cat === 'vsx' && (src.name ?? src.id).length <= 16;
    const mag = src.mag ?? 99;
    if (!verdict.mover && !named && cat !== 'vsx' && mag > (cat === 'gaia' ? 19.5 : 16.5)) continue;
    const pos = cat === 'catwise' && !verdict.mover ? { ra: src.ra, dec: src.dec } : propagate(src, year);
    if (inside(toXY(pos.ra, pos.dec))) n[cat]++;
  }
  const ssoSeen = new Set<string>();
  for (const o of s.sso.data.objects) {
    if (Math.abs(o.mjd - mjd) > 40) continue;
    if (inside(toXY(o.ra, o.dec))) ssoSeen.add(String(o.name || o.num || '?'));
  }
  n.sso = ssoSeen.size;
  layerCounts = n;

  if (on.has('sso') && s.sso.data.objects.length) {
    // Asteroids: show the positions computed nearest to this frame's date (within 40 days).
    const byName = new Map<string, typeof s.sso.data.objects>();
    for (const o of s.sso.data.objects) {
      if (Math.abs(o.mjd - mjd) > 40) continue;
      const k = o.name || o.num || '?';
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k)!.push(o);
    }
    for (const [name, list] of byName) {
      list.sort((a, b) => a.mjd - b.mjd);
      const pts = list.map((o) => toXY(o.ra, o.dec));
      if (!pts.some((p) => inside(p))) continue;
      ctx.strokeStyle = MARK.sso;
      if (pts.length > 1) {
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 1.75 * u;
        ctx.setLineDash([3 * u, 3 * u]);
        ctx.beginPath();
        pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      pts.forEach((p, i) => {
        if (!inside(p)) return;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 4.5 * u;
        shape(ctx, 'sso', p.x, p.y, 7 * u);
        ctx.stroke();
        ctx.strokeStyle = MARK.sso;
        ctx.lineWidth = 2 * u;
        ctx.stroke();
        const o = list[i];
        const label = `${o.num ? `(${o.num}) ` : ''}${name}`;
        if (i === pts.length - 1) queueLabel(p.x, p.y, label, MARK.sso);
        placed.push({
          kind: 'sso', x: p.x, y: p.y, label,
          detail: `${label}${o.class ? ` · ${o.class}` : ''}${o.vmag != null ? ` · V ${(+o.vmag).toFixed(1)}` : ''} · approximate (geocentric) position`,
          ra: o.ra, dec: o.dec,
        });
      });
    }
  }

  for (const l of labels) {
    ctx.lineWidth = 3.5 * u;
    ctx.strokeStyle = 'rgba(5,6,4,0.85)';
    ctx.strokeText(l.text, l.x, l.y);
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, l.x, l.y);
  }

  // Selected source: amber cross-hair with a gap, so the source itself stays visible.
  if (st.src) {
    const p = toXY(st.src.ra, st.src.dec);
    if (inside(p)) {
      const g = 7 * u,
        len = 9 * u;
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? MARK.select : 'rgba(0,0,0,0.6)';
        ctx.lineWidth = (pass ? 1.75 : 3.5) * u;
        ctx.beginPath();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.moveTo(p.x + dx * g, p.y + dy * g);
          ctx.lineTo(p.x + dx * (g + len), p.y + dy * (g + len));
        }
        ctx.stroke();
      }
    }
  }

  if (opts.chrome !== false) paintChrome(ctx, size, u, view.z);
  return placed;
}

/** Compass (north up, east left) and a scale bar. */
function paintChrome(ctx: CanvasRenderingContext2D, size: number, u: number, z: number): void {
  // The sky across the box: the whole field, or the part of it that is zoomed in on.
  const field = fieldArcsec() / z;
  const ink = 'rgba(236,238,241,0.92)';
  const halo = 'rgba(5,6,4,0.7)';
  ctx.font = `600 ${10 * u}px Geist, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';

  // Scale bar: a round number of arcminutes or arcseconds near a fifth of the field.
  const nice = [2, 5, 10, 20, 30, 60, 120, 300, 600];
  const bar = nice.reduce((best, v) => (Math.abs(v - field / 5) < Math.abs(best - field / 5) ? v : best), nice[0]);
  const w = (bar / field) * size;
  const x0 = 12 * u,
    y0 = size - 14 * u;
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? ink : halo;
    ctx.lineWidth = (pass ? 1.5 : 3.5) * u;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 3 * u);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + w, y0);
    ctx.lineTo(x0 + w, y0 - 3 * u);
    ctx.stroke();
  }
  const text = bar >= 60 ? `${bar / 60}′` : `${bar}″`;
  ctx.textAlign = 'left';
  ctx.lineWidth = 3 * u;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, x0 + w + 6 * u, y0 - 1 * u);
  ctx.fillStyle = ink;
  ctx.fillText(text, x0 + w + 6 * u, y0 - 1 * u);

  // Compass.
  const cx = size - 22 * u,
    cy = size - 16 * u,
    arm = 20 * u;
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? ink : halo;
    ctx.lineWidth = (pass ? 1.5 : 3.5) * u;
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy - arm);
    ctx.moveTo(cx - 3 * u, cy - arm + 4 * u);
    ctx.lineTo(cx, cy - arm);
    ctx.lineTo(cx + 3 * u, cy - arm + 4 * u);
    ctx.moveTo(cx - arm + 4 * u, cy - 3 * u);
    ctx.lineTo(cx - arm, cy);
    ctx.lineTo(cx - arm + 4 * u, cy + 3 * u);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  for (const [t, tx, ty] of [['N', cx, cy - arm - 8 * u], ['E', cx - arm - 8 * u, cy]] as [string, number, number][]) {
    ctx.strokeStyle = halo;
    ctx.lineWidth = 3 * u;
    ctx.strokeText(t, tx, ty);
    ctx.fillStyle = ink;
    ctx.fillText(t, tx, ty);
  }
  ctx.textAlign = 'left';
}
