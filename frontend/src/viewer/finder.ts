// SkyDive viewer — Aladin Lite 3.8.2 finder map with the SPHEREx all-sky cube layer. Loaded lazily
// from the CDN; fails soft. Written with AI coding assistance (Claude Code).
import { $, clear, h, noHover } from './dom';
import { fieldArcsec } from './paint';
import { store } from './store';

const SRC = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js';
const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const C = 299792458;
const F_LO = C / 5.009e-6;
const F_HI = C / 7.43e-7;
const DEPTH = 102;

let state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let aladin: any = null;
let cube: any = null;
let box: any = null;
let A: any = null;

function fail(why: string): void {
  state = 'failed';
  aladin = cube = box = null;
  const el = $('#finder');
  clear(el);
  el.append(h('p', { class: 'quiet' }, `The finder map could not be loaded (${why}). Everything else works without it.`));
  $('#finder-note').textContent = '';
}

/** 3.8.2 ships as an ES module; older builds set window.A from a classic script. */
async function loadAladin(): Promise<any> {
  try {
    const mod = await Promise.race([
      import(/* @vite-ignore */ SRC),
      new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 20000)),
    ]);
    const a = mod?.default ?? (window as any).A;
    if (a?.init) return a;
  } catch (e) {
    if ((e as Error).message === 'timeout') throw e;
  }
  await loadScript();
  return (window as any).A;
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    const t = setTimeout(() => reject(new Error('timeout')), 20000);
    s.onload = () => {
      clearTimeout(t);
      resolve();
    };
    s.onerror = () => {
      clearTimeout(t);
      reject(new Error('network'));
    };
    document.head.append(s);
  });
}

/** Aladin Lite phones home with the page URL on start-up. We do not send analytics: drop that call. */
function muteAladinLogger(): void {
  const w = window as any;
  if (w.__skydiveMuted) return;
  w.__skydiveMuted = true;
  const isLog = (u: unknown) => /AladinLiteLogger/i.test(String((u as Request)?.url ?? u));
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => (isLog(input) ? Promise.resolve(new Response(null, { status: 204 })) : realFetch(input, init));
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    return (realOpen as any).call(this, method, isLog(url) ? 'data:text/plain,' : url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  const realBeacon = navigator.sendBeacon?.bind(navigator);
  if (realBeacon) navigator.sendBeacon = (url, data) => (isLog(url) ? true : realBeacon(url, data));
}

/** Aladin reports a failed HiPS from a detached promise; turn that into our quiet note. */
function guardAladinErrors(): void {
  const w = window as any;
  if (w.__skydiveGuard) return;
  w.__skydiveGuard = true;
  const mine = (msg: unknown) => /hips|aladin/i.test(String((msg as Error)?.message ?? msg));
  const handle = (e: Event, msg: unknown) => {
    if (!mine(msg)) return;
    e.preventDefault();
    if (state === 'ready' || state === 'loading') fail('the SPHEREx all-sky map at IRSA is not answering');
  };
  window.addEventListener('unhandledrejection', (e) => handle(e, e.reason));
  window.addEventListener('error', (e) => handle(e, e.error ?? e.message));
}

async function start(): Promise<void> {
  if (state !== 'idle' || store.state.ra == null) return;
  state = 'loading';
  const mine = () => state === 'loading';
  const el = $('#finder');
  clear(el);
  el.append(h('p', { class: 'quiet' }, 'Loading the all-sky SPHEREx map…'));
  try {
    muteAladinLogger();
    // Ask the SPHEREx map whether it is there before starting Aladin: without tiles Aladin
    // would show an empty box and throw from inside its own code.
    const probe = await Promise.race([
      fetch(HIPS + '/properties').then((r) => r.ok, () => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 12000)),
    ]);
    if (!probe) {
      fail('the SPHEREx all-sky map at IRSA is not answering');
      return;
    }
    guardAladinErrors();
    A = await loadAladin();
    if (!A?.init) throw new Error('script');
    await Promise.race([A.init, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 20000))]);
    if (!mine()) return;
    clear(el);
    aladin = A.aladin(el, {
      target: `${store.state.ra} ${store.state.dec}`,
      survey: HIPS,
      fov: finderFov(),
      cooFrame: 'ICRSd',
      showCooGridControl: false, showSimbadPointerControl: false, showCooGrid: false, showLayersControl: false,
      showFullscreenControl: false, showZoomControl: false, showProjectionControl: false, showFrame: false,
      showCooLocation: false, showContextMenu: false, showShareControl: false, showSettingsControl: false,
      showStatusBar: false, showFov: false, showReticle: false,
      // No drift after a scroll or drag: the map stops where you leave it.
      inertia: false,
    });
    // Zoom between a little closer than the viewer's field and about 30° of sky.
    aladin.setFoVRange?.(Math.max(0.02, fieldArcsec() / 3600 / 2), 30);
    cube = A.imageHiPS(HIPS, { successCallback: () => sync(), errorCallback: () => fail('the SPHEREx all-sky map at IRSA is not answering') });
    aladin.setBaseImageLayer(cube);
    if ((state as string) === 'failed') return;
    state = 'ready';
    sync();
  } catch (e) {
    fail((e as Error).message === 'timeout' ? 'it took too long' : 'the map library is unreachable');
  }
}

const finderFov = () => Math.max(0.3, (fieldArcsec() / 3600) * 5);

/** Frame of the 102-channel cube nearest the middle of the selected range. Frames 50 and 51 are blank. */
function frameFor(um: number): number {
  let i = Math.round(((C / (um * 1e-6) - F_LO) / (F_HI - F_LO)) * DEPTH - 0.5);
  i = Math.min(DEPTH - 1, Math.max(0, i));
  if (i === 50) i = 49;
  if (i === 51) i = 52;
  return i;
}

/** Float the map, large, over the page; Escape, the close button or a click outside closes it. */
function enlarge(): void {
  const el = $('#finder');
  if (el.classList.contains('finder-big')) return;
  const backdrop = h('div', { class: 'plot-backdrop' });
  const close = h('button', { type: 'button', class: 'plot-close', 'aria-label': 'Close' }, '×');
  const relayout = () => requestAnimationFrame(() => {
    aladin?.view?.fixLayoutDimensions?.();
    window.dispatchEvent(new Event('resize'));
  });
  const shut = () => {
    el.classList.remove('finder-big');
    el.removeAttribute('role');
    backdrop.remove();
    close.remove();
    document.removeEventListener('keydown', onKey);
    relayout();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') shut();
  };
  backdrop.addEventListener('click', shut);
  close.addEventListener('click', shut);
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  el.classList.add('finder-big');
  el.setAttribute('role', 'dialog');
  el.append(close);
  close.focus();
  relayout();
}

/** Centre the map on the target at the default zoom. */
function recentre(): void {
  const st = store.state;
  if (state !== 'ready' || st.ra == null || st.dec == null) return;
  aladin.gotoRaDec(st.ra, st.dec);
  aladin.setFoV(finderFov());
}

/** Wavelength layer, field outline and note. Leaves the user's zoom and pan alone unless `centre`. */
function sync(centre = true): void {
  const st = store.state;
  if (state !== 'ready' || st.ra == null || st.dec == null) return;
  try {
    if (centre) recentre();
    const um = (st.wl[0] + st.wl[1]) / 2;
    const i = frameFor(um);
    cube?.setFrequency?.({ value: F_LO + ((i + 0.5) / DEPTH) * (F_HI - F_LO), unit: 'Hz' });
    // Outline of the viewer's field.
    const half = fieldArcsec() / 7200;
    const cd = Math.cos((st.dec * Math.PI) / 180);
    if (box) aladin.removeOverlay?.(box);
    box = A.graphicOverlay({ color: '#c8f53a', lineWidth: 1.5 });
    aladin.addOverlay(box);
    box.add(A.polygon([[st.ra - half / cd, st.dec - half], [st.ra + half / cd, st.dec - half], [st.ra + half / cd, st.dec + half], [st.ra - half / cd, st.dec + half]]));
    const note = $('#finder-note');
    clear(note);
    note.append(
      `SPHEREx all-sky map near ${um.toFixed(2)} µm. The square is the viewer's field. ${noHover() ? 'Pinch' : 'Scroll'} to zoom, drag to pan. `,
      h('button', { type: 'button', class: 'btn small ghost', onclick: recentre }, 'Re-centre'),
      ' ',
      h('button', { type: 'button', class: 'btn small ghost', onclick: enlarge }, 'Enlarge'),
    );
  } catch (e) {
    console.warn('finder sync failed', e);
  }
}

export function initFinder(): void {
  if (store.state.embed) return;
  const panel = $<HTMLDetailsElement>('#p-finder');
  const maybe = () => {
    if (panel.open && store.state.ra != null && visible) void start();
  };
  let visible = false;
  new IntersectionObserver((es) => {
    visible = es.some((e) => e.isIntersecting);
    maybe();
  }).observe(panel);
  panel.addEventListener('toggle', maybe);
  // Scrolling over the map zooms it and never scrolls the page.
  $('#finder').addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  store.on('state', (k) => {
    const moved = ['ra', 'dec', 'fov'].some((x) => k.has(x));
    if (moved || k.has('wl')) {
      // A new position recentres the map; a new wavelength only changes the layer.
      if (state === 'ready') sync(moved);
      else maybe();
    }
  });
}
