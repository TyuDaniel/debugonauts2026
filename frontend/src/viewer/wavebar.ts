// SkyDive viewer — wavelength bar: two handles over an exposure histogram, detector chips,
// molecule presets, live count, matched-wavelengths toggle. Written with AI coding assistance (Claude Code).
import { $, clear, fmt, h, rafThrottle } from './dom';
import { store, groupPatch, type ViewState } from './store';
import { DETECTORS, FEATURES, WL_MAX, WL_MIN } from './types';

const STEP = 0.01;
const frac = (um: number) => (um - WL_MIN) / (WL_MAX - WL_MIN);
const snap = (um: number) => Math.round(um / STEP) * STEP;

let track: HTMLElement, hist: HTMLCanvasElement, sel: HTMLElement, lo: HTMLElement, hi: HTMLElement;

/** A molecule preset stacks every visit; leaving it for a wider range goes back to single visits. */
function leavePreset(): Partial<ViewState> {
  const [a, b] = store.state.wl;
  const onPreset = FEATURES.some((f) => Math.abs(a - f.lo) < 0.006 && Math.abs(b - f.hi) < 0.006);
  return onPreset ? { groups: {}, show: ['A', null], a: [], b: [], mode: 'blink', playing: false } : {};
}

export function setRange(lo: number, hi: number): void {
  store.set({ ...leavePreset(), wl: [lo, hi] });
}

export function setDetector(n: number): void {
  const d = DETECTORS[n - 1];
  if (d) setRange(d.lo, d.hi);
}

export function stackAllSpherex(): void {
  const visits = store.session.frames.filter((f) => f.kind === 'spherex').map((f) => f.id);
  if (visits.length) store.set(groupPatch({ A: visits }, ['A', null]));
}

export function initWavebar(): void {
  track = $('#wave-track');
  hist = $<HTMLCanvasElement>('#wave-hist');
  sel = $('#wave-sel');
  lo = $('#wave-lo');
  hi = $('#wave-hi');

  const dets = $('#det-chips');
  for (const d of DETECTORS) {
    dets.append(
      h('button', {
        type: 'button', class: 'chip', 'data-det': d.n, 'aria-pressed': 'false',
        title: `Detector ${d.n}: ${d.lo}–${d.hi} µm (key ${d.n})`,
        onclick: () => setDetector(d.n),
      }, `D${d.n}`),
    );
  }
  dets.append(h('button', { type: 'button', class: 'chip', 'data-det': 'all', 'aria-pressed': 'false', title: 'All 102 colours, 0.75–5.0 µm', onclick: () => setRange(WL_MIN, WL_MAX) }, 'All'));

  const mols = $('#mol-chips');
  for (const f of FEATURES.filter((f) => !f.contaminant)) {
    mols.append(
      h('button', {
        type: 'button', class: 'chip', 'data-mol': f.key, 'aria-pressed': 'false',
        title: `${f.label}, ${f.um} µm. Narrow range: stacks every visit together.`,
        onclick: () => {
          store.set({ wl: [f.lo, f.hi] });
          stackAllSpherex();
        },
      }, f.chip, h('small', null, f.um.toString())),
    );
  }

  const setFromPointer = (which: 'lo' | 'hi' | 'near', clientX: number) => {
    const r = track.getBoundingClientRect();
    const um = snap(Math.min(WL_MAX, Math.max(WL_MIN, WL_MIN + ((clientX - r.left) / r.width) * (WL_MAX - WL_MIN))));
    const [a, b] = store.state.wl;
    if (which === 'near') which = Math.abs(um - a) <= Math.abs(um - b) ? 'lo' : 'hi';
    if (which === 'lo') store.set({ wl: [Math.min(um, b - 0.02), b] });
    else store.set({ wl: [a, Math.max(um, a + 0.02)] });
    return which;
  };
  let dragging: 'lo' | 'hi' | null = null;
  /** A finger that has touched the bar but not yet shown whether it is dragging a handle or scrolling the page. */
  let pending: { which: 'lo' | 'hi' | 'near'; x: number; y: number; id: number } | null = null;
  const begin = (which: 'lo' | 'hi' | 'near', e: PointerEvent) => {
    dragging = setFromPointer(which, e.clientX) as 'lo' | 'hi';
    (dragging === 'lo' ? lo : hi).focus({ preventScroll: true });
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
  };
  const start = (which: 'lo' | 'hi' | 'near') => (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    if (e.pointerType === 'mouse') {
      e.preventDefault();
      begin(which, e);
      return;
    }
    // Touch: the range changes on a tap or a sideways drag, never while the page is being scrolled.
    pending = { which, x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  lo.addEventListener('pointerdown', start('lo'));
  hi.addEventListener('pointerdown', start('hi'));
  track.addEventListener('pointerdown', start('near'));
  track.addEventListener('pointermove', (e) => {
    if (pending && e.pointerId === pending.id) {
      const dx = Math.abs(e.clientX - pending.x),
        dy = Math.abs(e.clientY - pending.y);
      if (dx > 6 && dx > dy) {
        const which = pending.which;
        pending = null;
        begin(which, e);
      }
      return;
    }
    if (dragging) setFromPointer(dragging, e.clientX);
  });
  track.addEventListener('pointerup', (e) => {
    if (pending && e.pointerId === pending.id) setFromPointer(pending.which, pending.x);
    pending = null;
    dragging = null;
  });
  track.addEventListener('pointercancel', () => {
    pending = null;
    dragging = null;
  });

  const keys = (which: 'lo' | 'hi') => (e: KeyboardEvent) => {
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.shiftKey ? 0.2 : 0.05) * d;
    const [a, b] = store.state.wl;
    if (which === 'lo') store.set({ wl: [snap(Math.min(b - 0.02, Math.max(WL_MIN, a + step))), b] });
    else store.set({ wl: [a, snap(Math.max(a + 0.02, Math.min(WL_MAX, b + step)))] });
  };
  lo.addEventListener('keydown', keys('lo'));
  hi.addEventListener('keydown', keys('hi'));


  new ResizeObserver(drawHist).observe(track);
  store.on('state', (k) => {
    if (k.has('wl') || k.has('matched') || k.has('mode')) render();
  });
  store.on(['stacks', 'progress', 'session'], render);
  render();
}

const render = rafThrottle((): void => {
  const st = store.state;
  const s = store.session;
  const [a, b] = st.wl;
  lo.style.left = `${frac(a) * 100}%`;
  hi.style.left = `${frac(b) * 100}%`;
  sel.style.left = `${frac(a) * 100}%`;
  sel.style.width = `${(frac(b) - frac(a)) * 100}%`;
  for (const [el, v] of [[lo, a], [hi, b]] as [HTMLElement, number][]) {
    el.setAttribute('aria-valuenow', v.toFixed(2));
    el.setAttribute('aria-valuetext', `${v.toFixed(2)} micrometres`);
  }
  $('#wave-out').textContent = `${fmt.wave(a)}–${fmt.wave(b)} µm`;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.006;
  for (const c of document.querySelectorAll<HTMLElement>('#det-chips .chip')) {
    const k = c.dataset.det!;
    const d = DETECTORS[+k - 1];
    const on = k === 'all' ? near(a, WL_MIN) && near(b, WL_MAX) : near(a, d.lo) && near(b, d.hi);
    c.setAttribute('aria-pressed', String(on));
  }
  let preset = false;
  for (const c of document.querySelectorAll<HTMLElement>('#mol-chips .chip')) {
    const f = FEATURES.find((f) => f.key === c.dataset.mol)!;
    const on = near(a, f.lo) && near(b, f.hi);
    preset ||= on;
    c.setAttribute('aria-pressed', String(on));
  }

  const count = $('#wave-count');
  clear(count);
  if (s.usableCount || s.status === 'ok') {
    count.append(h('b', null, fmt.int(s.selectedCount)), ` of ${fmt.int(s.usableCount)} exposures`);
  } else count.textContent = s.status === 'loading' ? 'loading…' : '–';

  const notes: string[] = [];
  if (preset) notes.push('Narrow preset: only 1–3 exposures per visit, so all visits are stacked together. Bright sources only.');
  if (s.matchNote) notes.push(s.matchNote + '.');
  const note = $('#wave-note');
  note.hidden = !notes.length;
  note.textContent = notes.join(' ');
  note.title = note.textContent;
  drawHist();
});

function drawHist(): void {
  const r = track.getBoundingClientRect();
  if (!r.width) return;
  const d = Math.min(3, window.devicePixelRatio || 1);
  const W = Math.round(r.width * d),
    H = Math.round(r.height * d);
  if (hist.width !== W || hist.height !== H) {
    hist.width = W;
    hist.height = H;
  }
  const g = hist.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const axisH = 14 * d;
  const plotH = H - axisH;
  const [a, b] = store.state.wl;
  const ex = new Set(store.state.excluded);

  // Histogram of where the exposures fall.
  const BIN = 0.05;
  const nb = Math.round((WL_MAX - WL_MIN) / BIN);
  const bins = new Float32Array(nb);
  let max = 0;
  for (const e of store.session.exposures) {
    if (!e.loaded || !e.ok || e.wave_um == null || ex.has(e.id)) continue;
    const i = Math.min(nb - 1, Math.max(0, Math.floor((e.wave_um - WL_MIN) / BIN)));
    max = Math.max(max, ++bins[i]);
  }
  const bw = W / nb;
  for (let i = 0; i < nb; i++) {
    const um = WL_MIN + (i + 0.5) * BIN;
    const inside = um >= a && um <= b;
    if (!bins[i]) continue;
    const hgt = Math.max(1.5 * d, (bins[i] / max) * (plotH - 5 * d));
    g.fillStyle = inside ? 'rgba(200,245,58,0.6)' : 'rgba(139,146,128,0.4)';
    g.fillRect(i * bw + 0.5 * d, plotH - hgt, Math.max(1, bw - d), hgt);
  }
  // Baseline, detector boundaries and labels.
  g.fillStyle = '#343b2d';
  g.fillRect(0, plotH, W, d);
  g.font = `600 ${9.5 * d}px Geist, system-ui, sans-serif`;
  g.textBaseline = 'middle';
  for (const det of DETECTORS) {
    const x0 = frac(det.lo) * W,
      x1 = frac(det.hi) * W;
    g.fillStyle = '#343b2d';
    if (det.n > 1) g.fillRect(Math.round(x0), 0, d, plotH + 4 * d);
    g.fillStyle = '#8b9280';
    g.textAlign = 'center';
    g.fillText(`D${det.n}`, (x0 + x1) / 2, plotH + axisH / 2 + d);
  }
  g.font = `500 ${9.5 * d}px Geist, system-ui, sans-serif`;
  g.fillStyle = '#6f7566';
  for (const um of [1, 2, 3, 4]) {
    const x = frac(um) * W;
    g.fillRect(Math.round(x), plotH, d, 3 * d);
  }
}
