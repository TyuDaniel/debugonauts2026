// SkyDive viewer — entry point: URL state, routing between landing and viewer, coordinate box,
// keyboard shortcuts. Written with AI coding assistance (Claude Code).
import './styles.css';
import { ApiError, apiJson } from './api';
import { checkSaturation, measureApcor, requestRestack } from './compute';
import { fmtDeg, parseCoords } from './coords';
import { $, toast } from './dom';
import { initFinder } from './finder';
import { initLanding, showLanding } from './landing';
import { ensureSso, loadField } from './loader';
import { initPanels } from './panels';
import { initShare } from './share';
import { initSpectrum } from './spectrum';
import { deserialize, store } from './store';
import { initTimeline, step, togglePlay } from './timeline';
import { getPicture, getPlaced, initView } from './view';
import { initWavebar, setDetector } from './wavebar';

const app = $('#app');
const input = $<HTMLInputElement>('#coord-input');
const note = $('#coord-note');
let resolvedLabel = '';
const checked = new WeakSet<object>();

function route(): void {
  const st = store.state;
  const has = st.ra != null && st.dec != null;
  app.dataset.view = has ? 'viewer' : 'landing';
  app.dataset.embed = st.embed && has ? '1' : '0';
  $('#landing').hidden = has;
  $('#viewer').hidden = !has;
  $('#share-menu').hidden = !has;
  $<HTMLElement>('.fov').hidden = !has;
  document.title = has ? `SkyDive · ${fmtDeg(st.ra!, 4)} ${fmtDeg(st.dec!, 4)}` : 'SkyDive';
  if (has) {
    if (document.activeElement !== input) input.value = `${st.ra!.toFixed(5)} ${st.dec!.toFixed(5)}`;
    $<HTMLSelectElement>('#fov').value = String(st.fov);
  } else void showLanding();
}

function setNote(text: string, error = false): void {
  note.textContent = text;
  note.classList.toggle('error', error);
  note.title = text;
}

function goTo(ra: number, dec: number): void {
  store.set(
    { ra: +ra.toFixed(6), dec: +dec.toFixed(6), src: null, a: [], b: [], groups: {}, show: ['A', null], excluded: [], frame: null, mode: 'blink', playing: false, cap: 600 },
    { push: true },
  );
  input.value = `${ra.toFixed(5)} ${dec.toFixed(5)}`;
  input.blur();
}

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (!text) {
    setNote('Type coordinates such as 133.7577 −7.2420, or an object name.', true);
    return;
  }
  const c = parseCoords(text);
  if (c) {
    resolvedLabel = '';
    setNote('');
    goTo(c.ra, c.dec);
    return;
  }
  if (/^[-+\d.\s,:hmsd°'"]+$/i.test(text) && /\d/.test(text)) {
    setNote('Those coordinates are out of range. RA runs 0 to 360°, Dec −90 to +90°. Example: 133.7577 −7.2420', true);
    return;
  }
  setNote(`Looking up “${text}”…`);
  $('#coord-go').setAttribute('disabled', '');
  try {
    const r = await apiJson<{ name?: string; ra: number; dec: number; pmra?: number; pmdec?: number }>(`/api/resolve?q=${encodeURIComponent(text)}`, 20000);
    if (!isFinite(r.ra) || !isFinite(r.dec)) throw new ApiError('bad answer', 'http');
    const moved = Math.hypot(r.pmra ?? 0, r.pmdec ?? 0) > 50;
    resolvedLabel = `${r.name ?? text} → ${fmtDeg(r.ra, 4)} ${fmtDeg(r.dec, 4)}${moved ? ' (moved to today’s position)' : ''}`;
    setNote(resolvedLabel);
    goTo(r.ra, r.dec);
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'network') setNote('Name lookup needs the live service, which is not answering. Coordinates still work, e.g. 133.7577 −7.2420', true);
    else if (e instanceof ApiError && e.status === 404) setNote(`Nothing called “${text}” was found. Check the spelling, or enter coordinates such as 133.7577 −7.2420`, true);
    else setNote(`“${text}” could not be looked up. Try coordinates such as 133.7577 −7.2420`, true);
  } finally {
    $('#coord-go').removeAttribute('disabled');
  }
}

function boot(): void {
  store.state = deserialize(location.search, location.hash);
  initLanding();
  initView();
  initWavebar();
  initTimeline();
  initPanels();
  initSpectrum();
  initShare();
  initFinder();

  // Phone: keep the page short; the image and timeline come first.
  if (window.matchMedia('(max-width: 719px)').matches) {
    for (const id of ['p-display', 'p-notices', 'p-frame', 'p-finder', 'p-neossat']) $<HTMLDetailsElement>('#' + id).open = false;
  }

  $('#coord-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });
  $<HTMLSelectElement>('#fov').addEventListener('change', (e) => {
    store.set({ fov: parseFloat((e.target as HTMLSelectElement).value) as 4 | 6.5 | 13 | 26, cap: 600 }, { push: true });
  });
  input.addEventListener('paste', () => setTimeout(() => parseCoords(input.value) && void submit(), 0));

  store.on('state', (k) => {
    if (k.has('ra') || k.has('dec') || k.has('embed')) route();
    if (k.has('ov')) ensureSso();
    if (k.has('ra') || k.has('dec') || k.has('fov')) {
      if (store.state.ra != null) void loadField();
    } else if (['wl', 'matched', 'excluded', 'a', 'b', 'mode'].some((x) => k.has(x))) {
      requestRestack(true);
    }
  });
  store.on('session', () => {
    const s = store.session;
    if (s.status === 'ok' && !checked.has(s)) {
      checked.add(s);
      void checkSaturation();
    }
  });
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('apcor')) store.on(['overlay', 'session'], () => void measureApcor());
  document.addEventListener('skydive:reload', () => void loadField());

  window.addEventListener('popstate', () => {
    const next = deserialize(location.search, location.hash);
    store.set(next);
    route();
  });
  window.addEventListener('hashchange', () => {
    const c = parseCoords(location.hash);
    if (c) goTo(c.ra, c.dec);
  });

  document.addEventListener('keydown', (e) => {
    if (store.state.ra == null || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea, [role="slider"], [contenteditable]')) return;
    if (e.key === ' ') {
      if (t.closest('button, a, summary')) return;
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      store.set({ playing: false });
      step(e.key === 'ArrowRight' ? 1 : -1);
    } else if (/^[1-6]$/.test(e.key)) {
      setDetector(+e.key);
      toast(`Detector ${e.key}`);
    }
  });

  route();
  if (store.state.ra != null) {
    store.flushUrl(); // normalise WiseView-style #ra=&dec= links into our query string
    void loadField();
  }
}

// Dev-only handle for automated browser tests and console debugging.
if (import.meta.env.DEV) (window as any).__skydive = { store, getPicture, getPlaced };

boot();
