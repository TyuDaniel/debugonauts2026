// SkyDive viewer — spectrum (µJy vs µm) and per-visit light curve for the clicked source.
// Written with AI coding assistance (Claude Code).
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { APERTURE_FRACTION, bandOf, runPhot } from './compute';
import { fmtDeg, mjdMonth, mjdToDate } from './coords';
import { $, clear, fmt, h, rafThrottle } from './dom';
import { store } from './store';
import { FEATURES, WL_MAX, WL_MIN, type PhotPoint } from './types';

const INK3 = '#8b9280';
const GRID = '#22271e';
const ACCENT = '#c8f53a';

let measured: { session: object | null; n: number } = { session: null, n: 0 };
let spec: uPlot | null = null;
let lc: uPlot | null = null;
let bins: { x: number; y: number; e: number; n: number }[] = [];
let lcPts: { x: number; y: number; e: number; n: number; label: string }[] = [];

function med(a: number[]): number {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const h2 = s.length >> 1;
  return s.length & 1 ? s[h2] : 0.5 * (s[h2 - 1] + s[h2]);
}
/** Median and its standard error (from the scatter when there are enough points, else from the per-exposure noise). */
function summarise(pts: PhotPoint[]): { y: number; e: number; n: number } {
  const f = pts.map((p) => p.flux);
  const y = med(f);
  const n = f.length;
  let e: number;
  if (n >= 4) e = (1.4826 * med(f.map((v) => Math.abs(v - y))) * 1.2533) / Math.sqrt(n);
  else e = (med(pts.map((p) => p.err)) * (n > 1 ? 1.2533 : 1)) / Math.sqrt(Math.max(1, n));
  return { y, e, n };
}

export function initSpectrum(): void {
  store.on('state', (k) => {
    if (k.has('src')) {
      if (store.state.src) placeholder('Measuring…');
      void runPhot();
    }
    if (k.has('wl') || k.has('excluded')) render();
  });
  store.on('phot', render);
  store.on('stacks', render);
  store.on('session', () => {
    // New exposures change the measurement: refresh once loading settles.
    const s = store.session;
    const n = s.exposures.filter((e) => e.ok).length;
    if (s.status === 'ok' && store.state.src && (measured.session !== s || measured.n !== n)) {
      measured = { session: s, n };
      void runPhot();
    }
    if (s.status !== 'ok') render();
  });
  const fit = () => {
    const se = $('#spec-plot'), le = $('#lc-plot');
    if (spec && se.clientWidth) spec.setSize({ width: se.clientWidth, height: se.clientHeight });
    if (lc && le.clientWidth) lc.setSize({ width: le.clientWidth, height: le.clientHeight });
  };
  const ro = new ResizeObserver(fit);
  ro.observe($('#spec-plot'));
  ro.observe($('#lc-plot'));
  initEnlarge();
  render();
}

/** Click a plot to float it, large, over the page; Escape, the close button or a click outside closes it. */
function initEnlarge(): void {
  const backdrop = h('div', { class: 'plot-backdrop', hidden: true });
  document.body.append(backdrop);
  let open: HTMLElement | null = null;
  let close: HTMLButtonElement | null = null;
  const shut = () => {
    if (!open) return;
    open.classList.remove('plot-big');
    open.removeAttribute('role');
    open.removeAttribute('aria-modal');
    close?.remove();
    backdrop.hidden = true;
    open = null;
  };
  const enlarge = (el: HTMLElement, has: () => boolean) => {
    if (open || !has()) return;
    open = el;
    el.classList.add('plot-big');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    close = h('button', { type: 'button', class: 'plot-close', 'aria-label': 'Close', onclick: (e: Event) => { e.stopPropagation(); shut(); } }, '×') as HTMLButtonElement;
    el.append(close);
    backdrop.hidden = false;
    close.focus();
  };
  for (const [id, has] of [['#spec-plot', () => !!spec], ['#lc-plot', () => !!lc]] as const) {
    const el = $(id);
    el.title = 'Click to enlarge';
    el.addEventListener('click', () => enlarge(el, has));
  }
  backdrop.addEventListener('click', shut);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') shut();
  });
}

/** Plain statement of the aperture correction in use, for the tooltip. */
function apcorText(): string {
  const f = (d: number) => (1 / APERTURE_FRACTION[d]).toFixed(2);
  return `Corrected to total flux within 28″: ×${f(1)} (D1–D2), ×${f(3)} (D3), ×${f(4)} (D4–D5), ×${f(6)} (D6). These factors were measured on bright isolated stars in three SPHEREx fields; light in the faint wings beyond 28″ is not included.`;
}

function placeholder(text: string): void {
  spec?.destroy();
  lc?.destroy();
  spec = lc = null;
  const el = $('#spec-plot');
  clear(el);
  clear($('#lc-plot'));
  clear($('#spec-head'));
  clear($('#lc-head'));
  el.append(h('div', { class: 'plot-empty' }, text));
}

const axis = (label: string): uPlot.Axis => ({
  stroke: INK3,
  font: '12.5px Geist, system-ui, sans-serif',
  labelFont: '600 12.5px Geist, system-ui, sans-serif',
  label,
  labelSize: 19,
  labelGap: 2,
  size: 52,
  gap: 4,
  grid: { stroke: GRID, width: 1 },
  ticks: { stroke: GRID, width: 1, size: 4 },
});

const render = rafThrottle((): void => {
  const s = store.session;
  const st = store.state;
  if (!st.src) {
    placeholder(s.status === 'loading' ? 'Click a source once frames appear to measure its spectrum.' : 'Click a source in the image to measure its brightness in every exposure: a spectrum in under a second.');
    return;
  }
  if (!s.phot) {
    placeholder(s.status === 'loading' ? 'Measuring as exposures arrive…' : 'Measuring…');
    return;
  }
  if (s.phot.status === 'empty') {
    placeholder('That position is outside this field.');
    return;
  }
  const ex = new Set(st.excluded);
  const byIdx = new Map(s.exposures.filter((e) => e.idx >= 0).map((e) => [e.idx, e]));
  const good = s.phot.points.filter((p) => p.ok && isFinite(p.flux) && !ex.has(byIdx.get(p.idx)?.id ?? ''));
  const bad = s.phot.points.length - good.length;
  if (!good.length) {
    placeholder('Every exposure is flagged at this position (saturated or masked), so there is nothing reliable to plot.');
    return;
  }
  good.sort((a, b) => a.wave - b.wave);

  // Bin: three of the 102 channels per point.
  const groups = new Map<number, PhotPoint[]>();
  for (const p of good) {
    const e = byIdx.get(p.idx)!;
    const key = bandOf(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  bins = [...groups.values()].map((g) => ({ x: med(g.map((p) => p.wave)), ...summarise(g) })).sort((a, b) => a.x - b.x);

  const inRange = good.filter((p) => p.wave >= st.wl[0] && p.wave <= st.wl[1]);
  const head = $('#spec-head');
  clear(head);
  const sum = inRange.length ? summarise(inRange) : null;
  const halo = !!s.phot.halo;
  if (halo) {
    head.append(
      h('span', { class: 'warn', title: 'The star overflows the detector at its centre, so its true brightness cannot be measured. This is the brightness of the unsaturated ring of its image (4 to 7 pixels out) above the sky further out. It is not calibrated, but it rises and falls with the star. Different detectors see different colours: pick one detector to follow the star over time.' }, h('b', null, 'Core saturated'), ': relative brightness from the unsaturated halo'),
      sum ? h('span', null, h('b', null, `${fmt.sig(sum.y, 3)} ± ${fmt.sig(sum.e, 2)}`)) : h('span', { class: 'warn' }, 'no exposures in range'),
    );
  } else head.append(
    h('span', null, 'Source ', h('b', null, `${fmtDeg(st.src.ra, 4)} ${fmtDeg(st.src.dec, 4)}`)),
    sum
      ? h('span', { class: sum.n < 5 ? 'warn' : '', title: `Median of ${sum.n} exposures between ${fmt.wave(st.wl[0])} and ${fmt.wave(st.wl[1])} µm. Aperture 1.6 px radius, local sky removed. ${apcorText()}` },
          h('b', null, `${fmt.sig(sum.y, 3)} ± ${fmt.sig(sum.e, 2)} µJy`), sum.e > 0 ? ` · SNR ${(sum.y / sum.e).toFixed(1)}` : '', sum.n < 5 ? ' · noisy: under 5 exposures' : '')
      : h('span', { class: 'warn' }, 'no exposures in range'),
  );

  // y range: robust to wild single exposures.
  const ys = good.map((p) => p.flux).sort((a, b) => a - b);
  const q = (f: number) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(f * (ys.length - 1))))];
  let lo = Math.min(0, q(0.03), ...bins.map((b) => b.y - b.e));
  let hi = Math.max(q(0.97), ...bins.map((b) => b.y + b.e));
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad * 0.5;
  hi += pad;

  const el = $('#spec-plot');
  spec?.destroy();
  clear(el);
  const cursorNote = h('div', { class: 'plot-cursor' });
  const xs = good.map((p) => p.wave);
  const fy = good.map((p) => p.flux);
  spec = new uPlot(
    {
      width: el.clientWidth || 360,
      height: el.clientHeight || 176,
      padding: [26, 8, 0, 0],
      cursor: { y: false, points: { show: false }, drag: { x: false, y: false } },
      legend: { show: false },
      scales: { x: { time: false, range: [WL_MIN - 0.05, WL_MAX + 0.05] }, y: { range: [lo, hi] } },
      axes: [
        { ...axis('Wavelength (µm)'), size: 38, values: (_u, v) => v.map((x) => String(x)) },
        { ...axis(halo ? 'Halo brightness (relative)' : 'Brightness (µJy)'), values: (_u, v) => v.map((x) => (Math.abs(x) >= 10000 ? `${+(x / 1000).toFixed(1)}k` : String(x))) },
      ],
      series: [
        {},
        { label: 'Each exposure', stroke: 'transparent', paths: () => null, points: { show: true, size: 3.5, fill: 'rgba(185,191,176,0.45)', stroke: 'transparent', width: 0 } },
      ],
      hooks: {
        drawClear: [drawSpecBack],
        draw: [drawSpecFront],
        setCursor: [
          (u) => {
            const note = cursorNote;
            const { left } = u.cursor;
            if (left == null || left < 0 || !bins.length) {
              note.textContent = '';
              return;
            }
            const x = u.posToVal(left, 'x');
            const b = bins.reduce((best, c) => (Math.abs(c.x - x) < Math.abs(best.x - x) ? c : best), bins[0]);
            note.textContent = `${b.x.toFixed(2)} µm: ${fmt.sig(b.y, 3)} ± ${fmt.sig(b.e, 2)} µJy (${b.n} exp.)`;
          },
        ],
      },
    },
    [xs, fy],
    el,
  );
  el.append(cursorNote);

  // Light curve: one point per visit, from the exposures that make up that visit's frame.
  const okByIdx = new Map(good.map((p) => [p.idx, p]));
  lcPts = [];
  for (const v of s.visits) {
    const stack = s.stacks.get('s' + v.id);
    if (!stack) continue;
    const pts = stack.ids.map((i) => okByIdx.get(i)).filter((p): p is PhotPoint => !!p);
    if (!pts.length) continue;
    const mid = (v.mjd_start + v.mjd_end) / 2;
    lcPts.push({ x: mjdToDate(mid).getTime() / 1000, ...summarise(pts), label: mjdMonth(mid) });
  }
  const lcEl = $('#lc-plot');
  const lcHead = $('#lc-head');
  lc?.destroy();
  lc = null;
  clear(lcEl);
  clear(lcHead);
  lcHead.append(
    h('span', { title: 'Median brightness in each SPHEREx visit, using the exposures behind that visit’s frame (so the wavelength range and matched-wavelengths setting apply).' }, h('b', null, 'Light curve'), ` · ${fmt.wave(st.wl[0])}–${fmt.wave(st.wl[1])} µm per visit`),
  );
  if (bad) lcHead.append(h('span', { class: 'quiet', title: 'Exposures where the aperture touches a masked pixel, falls off the detector, or was excluded by you' }, `${bad} skipped`));
  if (lcPts.length) {
    const lx = lcPts.map((p) => p.x);
    const span = Math.max(40 * 86400, lx[lx.length - 1] - lx[0]);
    const l0 = Math.min(0, ...lcPts.map((p) => p.y - p.e)),
      l1 = Math.max(...lcPts.map((p) => p.y + p.e));
    const lp = (l1 - l0) * 0.15 || 1;
    lc = new uPlot(
      {
        width: lcEl.clientWidth || 360,
        height: lcEl.clientHeight || 112,
        padding: [10, 8, 0, 0],
        cursor: { show: false },
        legend: { show: false },
        scales: { x: { time: true, range: [lx[0] - span * 0.12, lx[lx.length - 1] + span * 0.12] }, y: { range: [l0 - lp * 0.4, l1 + lp] } },
        axes: [
          { ...axis(''), size: 26, labelSize: 0, space: 80, values: (_u, v) => v.map((t) => mjdMonthFromUnix(t)) },
          { ...axis(halo ? 'relative' : 'µJy'), values: (_u, v) => v.map((x) => (Math.abs(x) >= 10000 ? `${+(x / 1000).toFixed(1)}k` : String(x))) },
        ],
        series: [{}, { stroke: 'transparent', paths: () => null, points: { show: false } }],
        hooks: { draw: [drawLc] },
      },
      [lx, lcPts.map((p) => p.y)],
      lcEl,
    );
  } else {
    lcEl.append(h('div', { class: 'plot-empty' }, 'No usable exposures in this wavelength range for a light curve.'));
  }
});

function mjdMonthFromUnix(t: number): string {
  const d = new Date(t * 1000);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}

function drawSpecBack(u: uPlot): void {
  const { ctx, bbox } = u;
  const d = uPlot.pxRatio;
  const [a, b] = store.state.wl;
  ctx.save();
  // Selected wavelength range.
  const x0 = Math.max(bbox.left, u.valToPos(a, 'x', true)),
    x1 = Math.min(bbox.left + bbox.width, u.valToPos(b, 'x', true));
  ctx.fillStyle = 'rgba(200,245,58,0.07)';
  ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
  // Feature markers.
  ctx.font = `500 ${11.5 * d}px Geist, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let lastX = -1e9;
  let row = 0;
  for (const f of FEATURES.slice().sort((p, q) => p.um - q.um)) {
    const x = Math.round(u.valToPos(f.um, 'x', true));
    ctx.strokeStyle = f.contaminant ? 'rgba(255,122,107,0.45)' : 'rgba(185,191,176,0.3)';
    ctx.lineWidth = d;
    ctx.setLineDash([2 * d, 3 * d]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, bbox.top);
    ctx.lineTo(x + 0.5, bbox.top + bbox.height);
    ctx.stroke();
    row = x - lastX < 26 * d ? (row + 1) % 2 : 0;
    lastX = x;
    ctx.fillStyle = f.contaminant ? '#ff7a6b' : '#b9bfb0';
    ctx.fillText(f.short, x, bbox.top - 24 * d + row * 11 * d);
  }
  ctx.restore();
}

function drawSpecFront(u: uPlot): void {
  const { ctx, bbox } = u;
  const d = uPlot.pxRatio;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  // Zero line.
  const y0 = Math.round(u.valToPos(0, 'y', true)) + 0.5;
  ctx.strokeStyle = '#343b2d';
  ctx.lineWidth = d;
  ctx.beginPath();
  ctx.moveTo(bbox.left, y0);
  ctx.lineTo(bbox.left + bbox.width, y0);
  ctx.stroke();
  // Binned medians: line within a detector, error bars, points.
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = 1.25 * d;
  ctx.beginPath();
  let prev: number | null = null;
  for (const b of bins) {
    const x = u.valToPos(b.x, 'x', true),
      y = u.valToPos(b.y, 'y', true);
    if (prev != null && b.x - prev < 0.25) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    prev = b.x;
  }
  ctx.globalAlpha = 0.55;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = d;
  for (const b of bins) {
    const x = Math.round(u.valToPos(b.x, 'x', true)) + 0.5;
    const y = u.valToPos(b.y, 'y', true);
    ctx.beginPath();
    ctx.moveTo(x, u.valToPos(b.y - b.e, 'y', true));
    ctx.lineTo(x, u.valToPos(b.y + b.e, 'y', true));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2.25 * d, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawLc(u: uPlot): void {
  const { ctx, bbox } = u;
  const d = uPlot.pxRatio;
  ctx.save();
  const y0 = Math.round(u.valToPos(0, 'y', true)) + 0.5;
  if (y0 > bbox.top && y0 < bbox.top + bbox.height) {
    ctx.strokeStyle = '#343b2d';
    ctx.lineWidth = d;
    ctx.beginPath();
    ctx.moveTo(bbox.left, y0);
    ctx.lineTo(bbox.left + bbox.width, y0);
    ctx.stroke();
  }
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.font = `500 ${11.5 * d}px Geist, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const p of lcPts) {
    const x = Math.round(u.valToPos(p.x, 'x', true)) + 0.5,
      y = u.valToPos(p.y, 'y', true);
    const ya = u.valToPos(p.y + p.e, 'y', true),
      yb = u.valToPos(p.y - p.e, 'y', true);
    ctx.lineWidth = 1.25 * d;
    ctx.beginPath();
    ctx.moveTo(x, ya);
    ctx.lineTo(x, yb);
    ctx.moveTo(x - 3 * d, ya);
    ctx.lineTo(x + 3 * d, ya);
    ctx.moveTo(x - 3 * d, yb);
    ctx.lineTo(x + 3 * d, yb);
    ctx.stroke();
    if (p.n < 5) {
      // Hollow point: fewer than five exposures, noisy.
      ctx.fillStyle = '#0a0c09';
      ctx.beginPath();
      ctx.arc(x, y, 3.5 * d, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = ACCENT;
    } else {
      ctx.beginPath();
      ctx.arc(x, y, 3.5 * d, 0, Math.PI * 2);
      ctx.fill();
    }
    if (lcPts.length <= 8) {
      ctx.fillStyle = '#b9bfb0';
      ctx.fillText(`n=${p.n}`, x, Math.min(ya, y) - 3 * d);
    }
    ctx.fillStyle = ACCENT;
  }
  ctx.restore();
}
