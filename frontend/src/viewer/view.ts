// SkyDive viewer — the image stage: canvas, overlay layer, cursor readout, click-to-measure.
// Written with AI coding assistance (Claude Code).
import { currentPicture, frameById, type Picture } from './compute';
import { fmtDeg, mjdIso, offsetToSky } from './coords';
import { $, fmt, h, noHover, rafThrottle, clear } from './dom';
import { fieldArcsec, NO_ZOOM, paintImage, paintOverlay, pictureRect, type Placed, type Zoom } from './paint';
import { stacker } from './stackClient';
import { store } from './store';
import { SPHEREX_SCALE } from './types';

let box: HTMLElement, img: HTMLCanvasElement, ovl: HTMLCanvasElement, msg: HTMLElement, tip: HTMLElement;
let size = 0;
let dpr = 1;
let picture: Picture | null = null;
let placed: Placed[] = [];
let hoverSeq = 0;
/** Zoom and pan of the image. Not part of the shared URL: a link always opens on the whole field. */
let zoom: Zoom = { ...NO_ZOOM };

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
export function getZoom(): Zoom {
  return zoom;
}

// ---------- zoom and pan ----------

/** At full zoom about eight SPHEREx pixels span the image, whatever the field width. */
const maxZoom = (): number => Math.max(4, store.session.nPx / 8);
let zoomAnim = 0;

function applyZoom(next: Zoom): void {
  const z = Math.min(maxZoom(), Math.max(1, next.z));
  // The image never leaves the box: the centre stays at least half a view from each edge.
  const half = 0.5 / z;
  const keep = (c: number) => Math.min(1 - half, Math.max(half, c));
  const v = { z, cx: keep(next.cx), cy: keep(next.cy) };
  if (v.z === zoom.z && v.cx === zoom.cx && v.cy === zoom.cy) return;
  zoom = v;
  // A marker's note would be left pointing at where the marker used to be.
  tip.hidden = true;
  syncZoomUi();
  draw();
}

/** The view at magnification `z` that keeps the sky under (ax, ay), a fraction across the box, in place. */
function zoomedAt(z: number, ax: number, ay: number): Zoom {
  const fx = zoom.cx + (ax - 0.5) / zoom.z,
    fy = zoom.cy + (ay - 0.5) / zoom.z;
  return { z, cx: fx - (ax - 0.5) / z, cy: fy - (ay - 0.5) / z };
}

function zoomBy(factor: number, ax = 0.5, ay = 0.5): void {
  applyZoom(zoomedAt(Math.min(maxZoom(), Math.max(1, zoom.z * factor)), ax, ay));
}

function panBy(dx: number, dy: number): void {
  applyZoom({ z: zoom.z, cx: zoom.cx - dx / zoom.z, cy: zoom.cy - dy / zoom.z });
}

/** Glide to magnification `z` about (ax, ay). Used by the buttons, the keys and double-tap. */
function zoomTo(z: number, ax = 0.5, ay = 0.5): void {
  cancelAnimationFrame(zoomAnim);
  const target = Math.min(maxZoom(), Math.max(1, z));
  const from = zoom.z;
  if (target === from) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    applyZoom(zoomedAt(target, ax, ay));
    return;
  }
  const t0 = performance.now();
  const tick = (now: number) => {
    const k = Math.min(1, (now - t0) / 200);
    const e = 1 - Math.pow(1 - k, 3);
    // Interpolating the logarithm keeps the speed of the zoom even.
    applyZoom(zoomedAt(k >= 1 ? target : Math.exp(Math.log(from) + (Math.log(target) - Math.log(from)) * e), ax, ay));
    if (k < 1) zoomAnim = requestAnimationFrame(tick);
  };
  zoomAnim = requestAnimationFrame(tick);
}

/** Zoom in or out one step (a factor of two), or back to the whole field. For the buttons and keys. */
export function zoomStep(dir: 1 | -1 | 0): void {
  if (dir === 0) zoomTo(1);
  else zoomTo(dir > 0 ? zoom.z * 2 : zoom.z / 2);
}

function syncZoomUi(): void {
  const zoomed = zoom.z > 1;
  box.classList.toggle('zoomed', zoomed);
  // Whole field: a finger scrolls the page. Zoomed in: a finger moves the image.
  ovl.style.touchAction = zoomed ? 'none' : 'pan-y';
  $<HTMLButtonElement>('#zoom-in').disabled = zoom.z >= maxZoom() - 1e-6;
  $<HTMLButtonElement>('#zoom-out').disabled = !zoomed;
  const reset = $<HTMLButtonElement>('#zoom-reset');
  reset.hidden = !zoomed;
  const level = `${zoom.z < 10 ? +zoom.z.toFixed(1) : Math.round(zoom.z)}×`;
  reset.textContent = level;
  reset.setAttribute('aria-label', `Zoomed in ${level}. Show the whole field`);
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

  initGestures();
  ovl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && store.state.ra != null) {
      store.set({ src: { ra: store.state.ra, dec: store.state.dec! } });
    }
  });
  $('#zoom-in').addEventListener('click', () => zoomStep(1));
  $('#zoom-out').addEventListener('click', () => zoomStep(-1));
  $('#zoom-reset').addEventListener('click', () => zoomStep(0));
  syncZoomUi();
  initPip();
  initSpecJump();

  store.on(['stacks', 'frames', 'history', 'overlay', 'sso', 'session'], draw);
  store.on('state', (k) => {
    // A new field starts on the whole field again.
    if (['ra', 'dec', 'fov'].some((x) => k.has(x))) {
      cancelAnimationFrame(zoomAnim);
      applyZoom({ ...NO_ZOOM });
    }
    if (['frame', 'mode', 'a', 'b', 'stretch', 'invert', 'range', 'ov', 'marks', 'wiseBand', 'src'].some((x) => k.has(x))) draw();
  });
  // The zoom limit depends on the field width, which arrives with the session.
  store.on('session', syncZoomUi);
  store.on(['progress', 'session'], drawProgress);
  store.on('cursor', drawReadout);
  drawReadout();
}

// ---------- pointer, touch and wheel on the image ----------

/**
 * One finger or the mouse: tap to measure, double-tap to zoom, drag to move a zoomed image.
 * Two fingers: pinch to zoom about the point between them. Wheel or trackpad pinch: zoom.
 */
function initGestures(): void {
  const pts = new Map<number, { x: number; y: number }>();
  let down = { x: 0, y: 0, t: 0 };
  let moved = false;
  let multi = false;
  let pinch: { x: number; y: number; d: number } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let tapTimer = 0;
  const hover = rafThrottle(onMove);

  const pinchNow = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const leaveHover = () => {
    tip.hidden = true;
    hoverSeq++;
    store.session.cursor = null;
    store.emit('cursor');
  };

  ovl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancelAnimationFrame(zoomAnim);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      moved = false;
      multi = false;
    } else {
      multi = true;
      clearTimeout(tapTimer);
      tip.hidden = true;
      pinch = pts.size === 2 ? pinchNow() : null;
      for (const id of pts.keys()) {
        try {
          ovl.setPointerCapture(id);
        } catch {
          /* the pointer is already gone */
        }
      }
    }
  });

  ovl.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') hover(e);
      return;
    }
    const dx = e.clientX - p.x,
      dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const r = ovl.getBoundingClientRect();
    if (pts.size === 2) {
      const now = pinchNow();
      if (pinch && pinch.d > 0 && now.d > 0) {
        zoomBy(now.d / pinch.d, (pinch.x - r.left) / r.width, (pinch.y - r.top) / r.height);
        panBy((now.x - pinch.x) / r.width, (now.y - pinch.y) / r.height);
      }
      pinch = now;
      return;
    }
    if (pts.size > 2) return;
    if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > (e.pointerType === 'mouse' ? 4 : 8)) {
      moved = true;
      if (zoom.z > 1) {
        try {
          ovl.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is already gone */
        }
        box.classList.add('panning');
        tip.hidden = true;
      }
    }
    if ((moved || multi) && zoom.z > 1) panBy(dx / r.width, dy / r.height);
  });

  const lift = (e: PointerEvent, cancelled: boolean) => {
    if (!pts.delete(e.pointerId)) return;
    pinch = pts.size === 2 ? pinchNow() : null;
    if (pts.size) return;
    box.classList.remove('panning');
    // A pinch that ends a hair above the whole field settles on it.
    if (zoom.z < 1.04) applyZoom({ ...NO_ZOOM });
    if (!cancelled && !moved && !multi && performance.now() - down.t < 600) onTap(e);
  };
  ovl.addEventListener('pointerup', (e) => lift(e, false));
  ovl.addEventListener('pointercancel', (e) => lift(e, true));
  // A finger lifting is not the pointer leaving: the readout keeps the pixel that was tapped.
  ovl.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') leaveHover();
  });

  function onTap(e: PointerEvent): void {
    const now = performance.now();
    const r = ovl.getBoundingClientRect();
    const double = now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 28;
    lastTap = double ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
    if (double) {
      // Double-tap or double-click: zoom in on that point; at full zoom, back to the whole field.
      clearTimeout(tapTimer);
      const ax = (e.clientX - r.left) / r.width,
        ay = (e.clientY - r.top) / r.height;
      if (zoom.z >= maxZoom() - 1e-6) zoomTo(1);
      else zoomTo(zoom.z * 2, ax, ay);
      return;
    }
    const at = { clientX: e.clientX, clientY: e.clientY };
    if (e.pointerType === 'mouse') {
      measureAt(at);
      return;
    }
    // Touch: show the pixel under the finger at once, and measure only once it is clear this
    // is not the first half of a double-tap.
    onMove(at);
    tapTimer = window.setTimeout(() => measureAt(at), 300);
  }

  // Wheel and trackpad pinch (which arrives as ctrl + wheel). Where the page itself scrolls,
  // a plain wheel over an image showing the whole field is left to the page.
  ovl.addEventListener('wheel', (e) => {
    if (store.state.ra == null) return;
    const pageScrolls = document.documentElement.scrollHeight > window.innerHeight + 1;
    if (!(e.ctrlKey || e.metaKey || !pageScrolls || zoom.z > 1)) return;
    e.preventDefault();
    cancelAnimationFrame(zoomAnim);
    const r = ovl.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-240, Math.min(240, e.deltaY * unit));
    zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.003)), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });

  // Two fingers on the image zoom the image, never the page; while zoomed, neither does one.
  ovl.addEventListener('touchmove', (e) => {
    if (e.cancelable && (e.touches.length > 1 || multi || zoom.z > 1)) e.preventDefault();
  }, { passive: false });

  // Safari reports a trackpad pinch as gesture events rather than ctrl + wheel. On iOS the same
  // events arrive alongside the touches handled above, so there they are only swallowed.
  let gestureZ = 1;
  ovl.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gestureZ = zoom.z;
  });
  ovl.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (pts.size) return;
    const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
    if (!g.scale) return;
    const r = ovl.getBoundingClientRect();
    applyZoom(zoomedAt(gestureZ * g.scale, ((g.clientX ?? r.left + r.width / 2) - r.left) / r.width, ((g.clientY ?? r.top + r.height / 2) - r.top) / r.height));
  });
  ovl.addEventListener('gestureend', (e) => e.preventDefault());
}

// ---------- small view pinned to the corner while the image is scrolled away ----------

/**
 * On a phone the display sliders, overlay toggles and wavelength chips sit below the image.
 * While the image is off screen a small live copy stays in the corner, so a change can be seen
 * as it is made. Tapping it goes back to the image.
 */
let pipOn = false;
function initPip(): void {
  const pip = $<HTMLButtonElement>('#pip');
  const show = (on: boolean) => {
    pipOn = on && store.state.ra != null && !store.state.embed && box.offsetParent !== null;
    pip.hidden = !pipOn;
    if (pipOn) paintPip();
  };
  new IntersectionObserver((es) => show(es[es.length - 1].intersectionRatio < 0.12), { threshold: [0, 0.12] }).observe(box);
  store.on('state', (k) => {
    if (k.has('ra') || k.has('embed')) show(false);
  });
  pip.addEventListener('click', () => scrollToEl($('.stage')));
}

function paintPip(): void {
  const c = $<HTMLCanvasElement>('#pip-canvas');
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.drawImage(img, 0, 0, c.width, c.height);
  g.drawImage(ovl, 0, 0, c.width, c.height);
}

function scrollToEl(el: HTMLElement): void {
  el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// ---------- after a tap: a way down to the spectrum it produced ----------

let specVisible = true;
let jumpTimer = 0;
function initSpecJump(): void {
  const jump = $<HTMLButtonElement>('#spec-jump');
  const panel = $<HTMLDetailsElement>('#p-spectrum');
  new IntersectionObserver((es) => {
    specVisible = es[es.length - 1].isIntersecting;
    if (specVisible) jump.hidden = true;
  }).observe(panel);
  jump.addEventListener('click', () => {
    jump.hidden = true;
    panel.open = true;
    scrollToEl(panel);
  });
}

/** Where the stacked layout puts the spectrum below the fold, offer a way to it for a few seconds. */
function offerSpectrum(): void {
  if (specVisible || store.state.embed) return;
  const jump = $<HTMLButtonElement>('#spec-jump');
  jump.hidden = false;
  clearTimeout(jumpTimer);
  jumpTimer = window.setTimeout(() => (jump.hidden = true), 7000);
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
    paintImage(ictx, size, picture, zoom);
  } else {
    picture = null;
    message = res.message;
    ictx.fillStyle = '#050604';
    ictx.fillRect(0, 0, size, size);
  }
  placed = paintOverlay(octx, size, picture, displayMjd(), dpr, { view: zoom });
  if (pipOn) paintPip();
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
  // From the box to the field: undo the zoom and pan.
  const sx = zoom.cx + (fx - 0.5) / zoom.z;
  const sy = zoom.cy + (fy - 0.5) / zoom.z;
  const field = fieldArcsec();
  const sky = offsetToSky((0.5 - sx) * field, (0.5 - sy) * field, st.ra, st.dec);
  let col = -1,
    row = -1;
  if (picture) {
    const pr = pictureRect(picture, 1);
    col = Math.floor(((sx - pr.x) / pr.w) * picture.nPx);
    row = Math.floor(((sy - pr.y) / pr.w) * picture.nPx);
    if (col < 0 || row < 0 || col >= picture.nPx || row >= picture.nPx) col = row = -1;
  }
  return { ...sky, fx, fy, col, row };
}

function onMove(e: { clientX: number; clientY: number }): void {
  const hit = locate(e);
  if (!hit) return;
  const s = store.session;
  const st = store.state;
  // Marker tooltip.
  const mx = hit.fx * size,
    my = hit.fy * size;
  let near: Placed | null = null;
  let best = (noHover() ? 20 : 12) * dpr;
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
  fl.textContent = c ? flagText(c) : `${noHover() ? 'tap' : 'hover'} the image`;
  fl.title = c ? fl.textContent ?? '' : '';
}

function measureAt(e: { clientX: number; clientY: number }): void {
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
  offerSpectrum();
}

/** Controls that only apply to one survey are hidden on other surveys' frames. */
function syncSourceControls(): void {
  const kind = picture?.kind ?? null;
  const notSpherex = kind === 'wise' || kind === 'ps1';
  $('.wavebar').hidden = notSpherex;
  $('#wise-band-row').hidden = kind !== 'wise';
}

