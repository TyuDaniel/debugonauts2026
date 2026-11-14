// SkyDive viewer — side panels: display controls, overlay toggles, field notices, frame details,
// exposure table, NEOSSat. Written with AI coding assistance (Claude Code).
import { frameById, selectedExposures } from './compute';
import { mjdIso } from './coords';
import { $, clear, fmt, h, rafThrottle, toast } from './dom';
import { loadMore } from './loader';
import { glyph, layerCounts, MARK } from './paint';
import { DEFAULTS, store } from './store';
import { flagText, getPicture } from './view';

export function initPanels(): void {
  initDisplay();
  initOverlays();
  store.on(['session', 'overlay', 'history', 'sso', 'stacks'], renderNotices);
  store.on(['stacks', 'frames', 'session', 'cursor'], renderFrame);
  store.on('state', (k) => {
    if (['frame', 'mode', 'a', 'b', 'wl', 'wiseBand'].some((x) => k.has(x))) renderFrame();
  });
  store.on('neossat', renderNeossat);
  store.on('toast', () => toast('More exposures need the live data service, which is not answering.'));
  store.on(['session', 'overlay'], renderStatus);
  store.on('progress', renderStatus);
  renderNotices();
  renderFrame();
  renderNeossat();
}

// ---------- display ----------

function initDisplay(): void {
  const lo = $<HTMLInputElement>('#range-lo'),
    hi = $<HTMLInputElement>('#range-hi'),
    inv = $<HTMLInputElement>('#invert');
  lo.addEventListener('input', () => store.set({ range: [parseFloat(lo.value), store.state.range[1]] }));
  hi.addEventListener('input', () => store.set({ range: [store.state.range[0], parseFloat(hi.value)] }));
  inv.addEventListener('change', () => store.set({ invert: inv.checked }));
  for (const b of document.querySelectorAll<HTMLElement>('#wise-band button')) {
    b.addEventListener('click', () => store.set({ wiseBand: b.dataset.band as 'W1' | 'W2' }));
  }
  $('#stretch-reset').addEventListener('click', () => store.set({ range: [...DEFAULTS.range], stretch: 'asinh', invert: false }));
  const sync = () => {
    const st = store.state;
    lo.value = String(st.range[0]);
    hi.value = String(st.range[1]);
    inv.checked = st.invert;
    for (const b of document.querySelectorAll<HTMLElement>('#wise-band button')) b.setAttribute('aria-checked', String(b.dataset.band === st.wiseBand));
  };
  store.on('state', sync);
  sync();
}

// ---------- overlays ----------

const OVERLAYS: { key: string; label: string; kind: 'gaia' | 'catwise' | 'vsx' | 'sso' | 'flags'; color: string; tip: string }[] = [
  { key: 'gaia', label: 'Gaia stars', kind: 'gaia', color: MARK.gaia, tip: 'Stars measured by ESA’s Gaia satellite, with precise positions and motions. Circle.' },
  { key: 'catwise', label: 'CatWISE sources', kind: 'catwise', color: MARK.catwise, tip: 'Infrared sources from the CatWISE2020 catalogue, including cold brown dwarfs Gaia cannot see. Diamond.' },
  { key: 'vsx', label: 'Variable stars', kind: 'vsx', color: MARK.vsx, tip: 'Stars known to change brightness (AAVSO Variable Star Index), with type and period. Star.' },
  { key: 'sso', label: 'Asteroids', kind: 'sso', color: MARK.sso, tip: 'Known asteroids and comets near this spot at the time of each SPHEREx visit (IMCCE SkyBoT). Positions are approximate. Triangle.' },
  { key: 'flags', label: 'Flagged pixels', kind: 'flags', color: MARK.flag, tip: 'Tints pixels that the SPHEREx pipeline flagged (ghosts, hot pixels, cosmic rays…) in many of the exposures behind this frame.' },
];

function initOverlays(): void {
  const list = $('#ov-list');
  for (const o of OVERLAYS) {
    const box = h('input', { type: 'checkbox', 'data-ov': o.key }) as HTMLInputElement;
    box.addEventListener('change', () => {
      const cur = new Set(store.state.ov);
      if (box.checked) cur.add(o.key);
      else cur.delete(o.key);
      store.set({ ov: OVERLAYS.map((x) => x.key).filter((k) => cur.has(k)) });
    });
    list.append(h('label', { class: 'ov-item', title: o.tip }, box, glyph(o.kind, o.color), h('span', null, o.label), h('span', { class: 'n num', 'data-ov-n': o.key })));
  }
  const sync = () => {
    const on = new Set(store.state.ov);
    const s = store.session;
    for (const box of list.querySelectorAll<HTMLInputElement>('input')) box.checked = on.has(box.dataset.ov!);
    for (const n of list.querySelectorAll<HTMLElement>('[data-ov-n]')) {
      const k = n.dataset.ovN!;
      let text = '';
      if (k === 'flags') text = '';
      // Counts are the markers actually drawn on the image, not every source the catalogue returned.
      else if (k === 'sso' && (s.sso.status === 'loading' || (s.sso.status === 'idle' && s.status === 'loading'))) text = '…';
      else if (k === 'sso' && s.sso.status !== 'ok') text = '0';
      else if (k !== 'sso' && s.overlay.status === 'loading') text = '…';
      else if (k === 'sso' ? s.sso.status === 'ok' || s.sso.status === 'empty' : s.overlay.status === 'ok' || s.overlay.status === 'empty') {
        text = String(layerCounts[k as keyof typeof layerCounts] ?? '');
      }
      n.textContent = text;
    }
    const notes = $('#ov-notes');
    clear(notes);
    // Outages of the outside catalogues are not shown: a layer with nothing simply counts 0.
    for (const n of s.overlay.data.notes) if (!/unavailable/i.test(n)) notes.append(h('p', { class: 'notice' }, n));
  };
  store.on(['state', 'overlay', 'sso', 'session', 'placed'], sync);
  sync();
}

// ---------- notices ----------

// Shown only for prepared fields: what the field is and anything to know about it.
const renderNotices = rafThrottle((): void => {
  const s = store.session;
  const el = $('#notices');
  clear(el);
  if (s.bakedBlurb) el.append(h('p', { class: 'notice' }, s.bakedBlurb));
  if (s.bakedNote) el.append(h('p', { class: 'notice' }, s.bakedNote));
  $('#p-notices').hidden = !el.childElementCount;
});

function renderStatus(): void {
  const s = store.session;
  const el = $('#stage-status');
  clear(el);
  if (s.status === 'loading') {
    const p = s.progress;
    el.append(p.total ? `Reading exposures ${p.done} / ${p.total}` : 'Finding exposures…');
  } else if (s.status === 'ok' && store.state.embed) {
    el.append(h('a', { class: 'embed-link', href: store.shareUrl({ embed: '0' }).replace(/[?&]embed=0/, ''), target: '_blank', rel: 'noopener' }, 'Open in SkyDive ↗'));
  } else if (s.status === 'ok') {
    const remaining = s.totalAvailable - s.exposures.filter((e) => e.loaded).length;
    if (remaining > 0) {
      el.append(
        `${fmt.int(s.exposures.filter((e) => e.loaded).length)} of ${fmt.int(s.totalAvailable)} exposures, spread over all visits `,
        h('button', { type: 'button', class: 'btn small', onclick: () => void loadMore(), title: 'Deep fields have thousands of exposures. To keep the browser fast, a sample spread evenly over every visit and wavelength is loaded. This adds more of them.' }, `Load ${Math.min(600, remaining)} more`),
      );
    }
    if (s.saturatedFrac != null && s.saturatedFrac > 0.5) el.append(h('span', { class: 'badge warn', title: `The centre is flagged as overflowing in ${Math.round(s.saturatedFrac * 100)}% of SPHEREx exposures. Brightness there is unreliable.` }, 'Saturated in SPHEREx'));
    if (s.overlay.data.warnings.some((w) => /bright star/i.test(w))) el.append(h('span', { class: 'badge warn', title: 'A star brighter than about magnitude 6 is within 10′. Expect ghosts and glare that change between visits.' }, 'Bright star nearby'));
  }
}

// ---------- this frame ----------

const renderFrame = rafThrottle((): void => {
  const s = store.session;
  const st = store.state;
  const dl = $('#frame-kv');
  clear(dl);
  const row = (k: string, v: string | Node, cls = '', tip = '') => dl.append(h('dt', tip ? { title: tip } : null, k), h('dd', { class: cls }, v));
  const pic = getPicture();
  if (!pic) {
    if (s.status === 'loading') dl.append(h('dt', null, h('div', { class: 'skel-line', style: 'width:60px' })), h('dd', null, h('div', { class: 'skel-line', style: 'width:140px' })));
    else row('Frame', 'Nothing shown yet');
    return;
  }
  const f = st.mode === 'blink' ? frameById(st.frame) : undefined;
  row('Frame', pic.title);
  if (f) row('Date', f.kind === 'spherex' ? `${mjdIso(f.mjd0)} to ${mjdIso(f.mjd1)}` : mjdIso(f.mjd));
  if (pic.kind === 'spherex') {
    const ids = new Set(pic.ids);
    const exps = s.exposures.filter((e) => e.idx >= 0 && ids.has(e.idx));
    const dets = [...new Set(exps.map((e) => e.detector))].sort();
    const waves = exps.map((e) => e.wave_um!).filter((w) => w != null);
    const rel = [...new Set(exps.map((e) => e.release))].filter(Boolean);
    row('Detectors', dets.map((d) => `D${d}`).join(' ') || '–');
    row('Wavelength', waves.length ? `${Math.min(...waves).toFixed(2)}–${Math.max(...waves).toFixed(2)} µm` : '–');
    row('Exposures', `${pic.n}${pic.n < 5 ? ' — fewer than 5: noisy, treat with care' : ''}`, '', 'Number of 113-second SPHEREx exposures combined (per-pixel median) into this picture');
    if (st.mode === 'diff' && s.comboA && s.comboB) row(`${st.show[0]} − ${st.show[1]}`, `${s.comboA.n} minus ${s.comboB.n} exposures`);
    row('Release', rel.map((r) => r.replace('spherex_', '').toUpperCase()).join(', ') || '–', '', 'Which public SPHEREx data release these exposures come from');
    row('Pixel scale', '6.15″ per pixel');
  } else if (pic.kind === 'wise') {
    row('Band', `${st.wiseBand} (${st.wiseBand === 'W1' ? '3.4' : '4.6'} µm)`);
    row('Source', 'unWISE time-resolved coadd via WiseView');
    row('Pixel scale', `${pic.pixscale.toFixed(2)}″ per pixel`);
  } else {
    row('Source', 'Pan-STARRS1 warps (STScI), season median');
    const hf = Object.values(s.frames.find((f) => f.id === st.frame && f.kind === 'ps1')?.hist ?? {})[0];
    if (hf?.n_warps) row('Exposures', String(hf.n_warps), '', 'Number of Pan-STARRS exposures combined (per-pixel median) into this picture');
    if (hf?.filled_frac && hf.filled_frac >= 0.005) {
      row('Gaps filled', `${Math.round(hf.filled_frac * 100)}% of the picture, from the ${hf.filled_bands} filters`, '',
        `This filter had no data there (chip gaps and masked cells), so those patches use the same season's ${hf.filled_bands} exposures. Sources inside them are shown at that filter's brightness.`);
    }
    row('Pixel scale', `${pic.pixscale.toFixed(2)}″ per pixel`);
  }
  const c = s.cursor;
  row('Under cursor', c ? flagText(c) : 'Hover the image to list quality flags', 'flagline', 'Quality flags set by the SPHEREx pipeline on the pixel under the cursor');
});

// ---------- NEOSSat ----------

function renderNeossat(): void {
  const n = store.session.neossat;
  const el = $('#neossat');
  const sum = $('#neo-summary');
  clear(el);
  sum.textContent = '';
  // The panel only appears once NEOSSat frames are known to exist for this spot.
  const panel = $('#p-neossat');
  panel.hidden = !(n.status === 'ok' && n.data?.count);
  if (panel.hidden) return;
  if (n.status === 'loading' || n.status === 'idle') {
    el.append(h('div', { class: 'skel-line', style: 'width:70%' }), h('div', { class: 'skel-line', style: 'width:45%' }));
    return;
  }
  if (n.status === 'error') {
    el.append(h('p', { class: 'hint' }, n.message ?? 'NEOSSat frames could not be loaded.'));
    return;
  }
  const d = n.data;
  if (!d || !d.count) {
    el.append(h('p', { class: 'hint' }, 'The Canadian Space Agency’s NEOSSat telescope has not imaged this spot.'));
    return;
  }
  sum.textContent = `${fmt.int(d.count)} frames`;
  el.append(
    h('p', { class: 'hint' }, `Canada’s NEOSSat space telescope took ${fmt.int(d.count)} visible-light frames here${d.date_min ? `, ${d.date_min} to ${d.date_max}` : ''}. Previews are raw and not aligned to the image above.`),
  );
  if (d.previews.length) {
    const strip = h('div', { class: 'neo-strip' });
    for (const p of d.previews.slice(0, 12)) {
      const img = h('img', { src: p.url, alt: `NEOSSat frame ${p.date}`, loading: 'lazy', referrerpolicy: 'no-referrer' });
      const a = h('a', { href: p.url, target: '_blank', rel: 'noopener', title: `NEOSSat ${p.obs_id} · ${p.date}${p.exposure_s ? ` · ${p.exposure_s} s` : ''}` }, img, h('span', null, p.date));
      img.addEventListener('error', () => {
        a.remove();
        if (!strip.childElementCount) strip.replaceWith(h('p', { class: 'hint' }, 'The preview images are not reachable right now (they are served by the Canadian Astronomy Data Centre).'));
      });
      strip.append(a);
    }
    el.append(strip);
  }
  el.append(h('p', { class: 'hint' }, 'Partner data: NEOSSat, Canadian Space Agency, via the Canadian Astronomy Data Centre.'));
}
