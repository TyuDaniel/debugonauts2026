// SkyDive viewer — the image stage: canvas, overlay layer, cursor readout, click-to-measure.
// Written with AI coding assistance (Claude Code).
import { currentPicture, frameById, type Picture } from './compute';
import { fmtDeg, mjdIso, offsetToSky } from './coords';
import { $, fmt, h, rafThrottle, clear } from './dom';
import { fieldArcsec, paintImage, paintOverlay, pictureRect, type Placed } from './paint';
import { stacker } from './stackClient';
import { store } from './store';
import { SPHEREX_SCALE } from './types';

let box: HTMLElement, img: HTMLCanvasElement, ovl: HTMLCanvasElement, msg: HTMLElement, tip: HTMLElement;
let size = 0;
let dpr = 1;
let picture: Picture | null = null;
let placed: Placed[] = [];
let hoverSeq = 0;

/** Date used to place markers: the shown frame, or the newest tray-A frame for sums and differences. */
export function displayMjd(): number {
  const st = store.state;
  if (st.mode === 'blink') return frameById(st.frame)?.mjd ?? 61000;
  const ms = st.a.map((id) => frameById(id)?.mjd).filter((m): m is number => m != null);
  return ms.length ? Math.max(...ms) : 61000;
}

export function getPicture(): Picture | null {
  return picture;
}
export function getPlaced(): { placed: Placed[]; size: number } {
  return { placed, size };
}

export function initView(): void {
  box = $('#image-box');
  img = $<HTMLCanvasElement>('#img');
  ovl = $<HTMLCanvasElement>('#ovl');
  msg = $('#image-msg');
  tip = $('#marker-tip');
  new ResizeObserver(() => {
    resize();
    draw();
  }).observe(box);
  resize();

  ovl.addEventListener('pointermove', rafThrottle(onMove));
  ovl.addEventListener('pointerleave', () => {
    tip.hidden = true;
    hoverSeq++;
    store.session.cursor = null;
    store.emit('cursor');
  });
  ovl.addEventListener('click', onClick);
  ovl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && store.state.ra != null) {
      store.set({ src: { ra: store.state.ra, dec: store.state.dec! } });
    }
  });

  store.on(['stacks', 'frames', 'history', 'overlay', 'sso', 'session'], draw);
  store.on('state', (k) => {
    if (['frame', 'mode', 'a', 'b', 'stretch', 'invert', 'range', 'ov', 'marks', 'wiseBand', 'src'].some((x) => k.has(x))) draw();
  });
  store.on(['progress', 'session'], drawProgress);
  store.on('cursor', drawReadout);
}

function resize(): void {
  const r = box.getBoundingClientRect();
  dpr = Math.min(3, window.devicePixelRatio || 1);
  size = Math.max(1, Math.round(r.width * dpr));
  for (const c of [img, ovl]) {
    if (c.width !== size) {
      c.width = size;
      c.height = size;
    }
  }
}

const drawNow = (): void => {
  const s = store.session;
  const st = store.state;
  const res = currentPicture();
  const ictx = img.getContext('2d')!;
  const octx = ovl.getContext('2d')!;
  octx.clearRect(0, 0, size, size);
  let message = '';
  if ('picture' in res) {
    picture = res.picture;
    paintImage(ictx, size, picture);
  } else {
    picture = null;
    message = res.message;
    ictx.fillStyle = '#050604';
    ictx.fillRect(0, 0, size, size);
  }
  placed = paintOverlay(octx, size, picture, displayMjd(), dpr);
  syncSourceControls();
  store.emit('placed');
  renderMessage(message);
  renderTitle();
  void s;
  void st;
};
const draw = rafThrottle(drawNow);
export const redraw = draw;

function renderMessage(pictureMessage: string): void {
  const s = store.session;
  clear(msg);
  msg.className = 'image-msg';
  if (s.status === 'error') {
    msg.hidden = false;
    const network = s.errorKind === 'network';
    msg.append(
      h('h2', null, network ? 'The live data service is not answering' : 'This field could not be loaded'),
      h('p', null, network
        ? 'New coordinates need the SkyDive service to fetch SPHEREx exposures. The prepared showcase fields are stored with the site and still work.'
        : s.error ?? ''),
      h('p', null,
        h('button', { class: 'btn small', type: 'button', onclick: () => document.dispatchEvent(new CustomEvent('skydive:reload')) }, 'Try again'),
        ' ',
        h('a', { class: 'btn small', href: './' }, 'Showcase fields'),
      ),
    );
    return;
  }
  if (s.status === 'empty') {
    msg.hidden = false;
    msg.append(
      h('h2', null, 'SPHEREx has not observed this spot yet'),
      h('p', null, 'No public SPHEREx exposure covers these coordinates. New data arrives every week and will appear here with no change needed. WISE and Pan-STARRS history may still be on the timeline.'),
    );
    return;
  }
  if (s.status === 'loading' && !picture) {
    msg.hidden = false;
    msg.classList.add('skeleton');
    const p = s.progress;
    msg.append(h('p', null, p.total ? `Reading exposures: ${p.done} of ${p.total}` : 'Finding SPHEREx exposures that cover this position…'));
    return;
  }
  if (pictureMessage) {
    msg.hidden = false;
    msg.append(h('p', null, pictureMessage));
    return;
  }
  msg.hidden = true;
}

function renderTitle(): void {
  const s = store.session;
  const st = store.state;
  const title = $('#frame-title');
  const sub = $('#frame-sub');
  if (!picture) {
    title.textContent = s.status === 'loading' ? 'Loading' : s.status === 'ok' ? 'No image' : '–';
    sub.textContent = '';
    return;
  }
  title.textContent = picture.title;
  const f = st.mode === 'blink' ? frameById(st.frame) : undefined;
  const bits: string[] = [];
  if (f) bits.push(f.kind === 'spherex' ? `${mjdIso(f.mjd0)} to ${mjdIso(f.mjd1)}` : mjdIso(f.mjd));
  if (picture.kind === 'spherex') {
    bits.push(`${fmt.wave(st.wl[0])}–${fmt.wave(st.wl[1])} µm`);
    bits.push(`${picture.n} exposure${picture.n === 1 ? '' : 's'}${picture.n < 5 ? ' (noisy)' : ''}`);
  } else if (f?.kind === 'wise') bits.push(`${st.wiseBand} ${st.wiseBand === 'W1' ? '3.4' : '4.6'} µm`);
  sub.textContent = bits.join(' · ');
}

function drawProgress(): void {
  const s = store.session;
  const el = $('#progress');
  const show = s.status === 'loading' && s.progress.total > 0;
  el.hidden = !show;
  if (show) $('#progress-bar').style.width = `${(100 * s.progress.done) / s.progress.total}%`;
  if (s.status === 'loading' && !picture) renderMessage('');
}

interface Hit {
  ra: number;
  dec: number;
  /** Fraction across the box. */
  fx: number;
  fy: number;
  /** Pixel in the displayed picture, or -1. */
  col: number;
  row: number;
}

function locate(e: { clientX: number; clientY: number }): Hit | null {
  const st = store.state;
  if (st.ra == null || st.dec == null) return null;
  const r = ovl.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  const field = fieldArcsec();
  const sky = offsetToSky((0.5 - fx) * field, (0.5 - fy) * field, st.ra, st.dec);
  let col = -1,
    row = -1;
  if (picture) {
    const pr = pictureRect(picture, 1);
    col = Math.floor(((fx - pr.x) / pr.w) * picture.nPx);
    row = Math.floor(((fy - pr.x) / pr.w) * picture.nPx);
    if (col < 0 || row < 0 || col >= picture.nPx || row >= picture.nPx) col = row = -1;
  }
  return { ...sky, fx, fy, col, row };
}

function onMove(e: PointerEvent): void {
  const hit = locate(e);
  if (!hit) return;
  const s = store.session;
  const st = store.state;
  // Marker tooltip.
  const mx = hit.fx * size,
    my = hit.fy * size;
  let near: Placed | null = null;
  let best = 12 * dpr;
  for (const p of placed) {
    const d = Math.hypot(p.x - mx, p.y - my);
    if (d < best) {
      best = d;
      near = p;
    }
  }
  if (near) {
    tip.hidden = false;
    tip.textContent = near.detail;
    const flipX = hit.fx > 0.6,
      flipY = hit.fy > 0.8;
    tip.style.left = `${hit.fx * 100}%`;
    tip.style.top = `${hit.fy * 100}%`;
    tip.style.transform = `translate(${flipX ? 'calc(-100% - 12px)' : '12px'}, ${flipY ? 'calc(-100% - 12px)' : '12px'})`;
  } else tip.hidden = true;

  let value: number | null = null;
  let wave = '';
  let unit = '';
  const pic = picture;
  if (pic && hit.col >= 0) {
    const v = pic.data[hit.row * pic.nPx + hit.col];
    value = v === v ? v - pic.offset : null;
    unit = pic.unit;
    if (pic.kind === 'wise') wave = st.wiseBand === 'W1' ? '3.4 µm (W1)' : '4.6 µm (W2)';
    else if (pic.kind === 'ps1') wave = pic.title.replace(/^Pan-STARRS (\w).*/, '$1 band');
    else {
      const ids = new Set(pic.ids);
      let lo = Infinity,
        hi = -Infinity;
      for (const ex of s.exposures) {
        if (ex.idx >= 0 && ids.has(ex.idx) && ex.wave_um != null) {
          const c = s.nPx / 2 - 0.5;
          const w = ex.wave_um + ex.dwave_dx * (hit.col - c) + ex.dwave_dy * (hit.row - c);
          if (w < lo) lo = w;
          if (w > hi) hi = w;
        }
      }
      wave = isFinite(lo) ? (hi - lo < 0.005 ? `${lo.toFixed(3)} µm` : `${lo.toFixed(2)}–${hi.toFixed(2)} µm`) : '';
    }
  }
  s.cursor = { ra: hit.ra, dec: hit.dec, value, unit, wave, flags: s.cursor?.flags ?? [], nExp: s.cursor?.nExp ?? 0 };
  if (pic && pic.kind === 'spherex' && hit.col >= 0) {
    const seq = ++hoverSeq;
    void stacker.flagsAt(pic.ids, hit.row * pic.nPx + hit.col).then((r) => {
      if (seq !== hoverSeq || !store.session.cursor) return;
      const flags: { name: string; count: number; masked: boolean }[] = [];
      for (let b = 0; b < 32; b++) {
        if (r.counts[b]) flags.push({ name: s.flagNames[String(b)] ?? `BIT ${b}`, count: r.counts[b], masked: ((s.maskWord >>> b) & 1) === 1 });
      }
      flags.sort((a, b) => Number(b.masked) - Number(a.masked) || b.count - a.count);
      store.session.cursor.flags = flags;
      store.session.cursor.nExp = r.n;
      store.emit('cursor');
    });
  } else {
    hoverSeq++;
    s.cursor.flags = [];
    s.cursor.nExp = 0;
  }
  store.emit('cursor');
}

export function flagText(c: NonNullable<typeof store.session.cursor>): string {
  if (!c.nExp) return picture && picture.kind !== 'spherex' ? 'SPHEREx frames only' : '–';
  if (!c.flags.length) return `none in ${c.nExp} exposure${c.nExp === 1 ? '' : 's'}`;
  return c.flags.map((f) => `${f.name} ${f.count}/${c.nExp}`).join(', ');
}

function drawReadout(): void {
  const c = store.session.cursor;
  $('#ro-ra').textContent = c ? fmtDeg(c.ra, 5) + '°' : '–';
  $('#ro-dec').textContent = c ? fmtDeg(c.dec, 5) + '°' : '–';
  $('#ro-val').textContent = c && c.value != null ? `${fmt.sig(c.value, 3)} ${c.unit}` : '–';
  $('#ro-wave').textContent = c?.wave || '–';
  const fl = $('#ro-flags');
  fl.textContent = c ? flagText(c) : 'hover the image';
  fl.title = c ? fl.textContent ?? '' : '';
}

function onClick(e: MouseEvent): void {
  const hit = locate(e);
  if (!hit) return;
  const st = store.state;
  let { ra, dec } = hit;
  // Snap to the brightest pixel next to the click when looking at SPHEREx pixels.
  const pic = picture;
  if (pic && pic.kind === 'spherex' && !pic.diverging && hit.col >= 0) {
    let bc = hit.col,
      br = hit.row,
      bv = -Infinity;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const c = hit.col + dc,
          r = hit.row + dr;
        if (c < 0 || r < 0 || c >= pic.nPx || r >= pic.nPx) continue;
        const v = pic.data[r * pic.nPx + c];
        if (v > bv) {
          bv = v;
          bc = c;
          br = r;
        }
      }
    // Flux-weighted centroid of the 3x3 around the peak, for sub-pixel placement.
    let sw = 0,
      sx = 0,
      sy = 0;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const c = bc + dc,
          r = br + dr;
        if (c < 0 || r < 0 || c >= pic.nPx || r >= pic.nPx) continue;
        const v = Math.max(0, pic.data[r * pic.nPx + c] - pic.lo);
        if (v === v) {
          sw += v;
          sx += v * c;
          sy += v * r;
        }
      }
    const cx = sw > 0 ? sx / sw : bc,
      cy = sw > 0 ? sy / sw : br;
    const c0 = pic.nPx / 2 - 0.5;
    const sky = offsetToSky((c0 - cx) * SPHEREX_SCALE, (c0 - cy) * SPHEREX_SCALE, st.ra!, st.dec!);
    ra = sky.ra;
    dec = sky.dec;
  }
  store.set({ src: { ra: +ra.toFixed(5), dec: +dec.toFixed(5) } });
}

/** Controls that only apply to one survey are hidden on other surveys' frames. */
function syncSourceControls(): void {
  const kind = picture?.kind ?? null;
  const notSpherex = kind === 'wise' || kind === 'ps1';
  $('.wavebar').hidden = notSpherex;
  $('#wise-band-row').hidden = kind !== 'wise';
}

