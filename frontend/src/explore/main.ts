// Written with AI assistance (Claude) for the NASA Space Apps 2026 hackathon.
// SkyDive 3D map (/explore): the Sun's neighbourhood out to 100 pc, with a time slider.
// This page talks to the viewer only by navigating to /?ra=<deg>&dec=<deg>&fov=6.5.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  KMS_PER_PCYR, PC_TO_LY, RAD_TO_ARCSEC, angularSepArcsec, fmtInt,
  normaliseName, raDecFromVec, signed, unitFromRaDec, yearNow,
} from './astro';
import {
  FLAG_BD, FLAG_MAG_EST, FLAG_RV, FLAG_WD, loadBakedFields, loadIds, loadMeta, loadStars,
  type BakedField, type BeyondEntry, type Meta, type NamedEntry, type StarData,
} from './data';
import { LabelLayer } from './labels';
import { BEYOND_OUTER, Furniture, RING_RADII, galacticNorth, planePoint } from './scene';
import { StarField } from './stars';

// Embedded on the viewer's landing page: chrome is trimmed by CSS and a dive navigates the parent page.
const EMBED = new URLSearchParams(window.location.search).has('embed');
if (EMBED) document.body.classList.add('embed');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointer = window.matchMedia('(pointer: coarse)');
const phone = window.matchMedia('(max-width: 720px)');

const VIEWER_FOV = 6.5;
const TIME_RANGE = 50000;
const PLAY_SPEED = 5000; // years per second
const BASE_FOV = 50;

type Selection = { kind: 'star'; i: number } | { kind: 'beyond'; b: BeyondEntry };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);

async function start(): Promise<void> {
  const canvas = $<HTMLCanvasElement>('sky');
  const loading = $('loading');
  const loadingBar = $('loading-bar');
  const loadingText = $('loading-text');
  const loadingLabel = loadingText.textContent ?? 'Loading stars';

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch {
    $('loading-text').textContent = 'This map needs WebGL, which this browser does not provide.';
    return;
  }
  renderer.setClearColor(0x04060a, 1);

  let data: StarData;
  let meta: Meta;
  try {
    [data, meta] = await Promise.all([
      loadStars((f) => {
        loadingBar.style.setProperty("--p", `${(f * 100).toFixed(1)}%`);
        loadingText.textContent = `${loadingLabel} · ${Math.round(f * 100)}%`;
      }),
      loadMeta(),
    ]);
  } catch (err) {
    $('loading-text').textContent = 'The star catalogue could not be loaded. Run scripts/build_stars.py, then reload.';
    console.error(err);
    return;
  }

  const nowYear = yearNow();
  const nowOffset = nowYear - data.epoch; // years from the catalogue epoch to today
  let tYears = 0; // slider: years from today

  // ---- scene --------------------------------------------------------------------------------
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.0005, 6000);
  camera.up.copy(galacticNorth());
  const stars = new StarField(data);
  stars.time = nowOffset;
  const furniture = new Furniture(meta.beyond);
  scene.add(furniture.group, stars.points);

  let width = 1;
  let height = 1;
  let hazeScale = 1;
  const homeDistance = () => 172 * Math.max(1, 1.12 / camera.aspect);
  const homeDir = planePoint(1, 205).multiplyScalar(Math.cos(0.42)).addScaledVector(galacticNorth(), Math.sin(0.42)).normalize();

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  // Zoom towards the cursor, or towards the middle of a pinch.
  controls.zoomToCursor = true;
  // Touch works like a 3D map app: one finger drags the map, two fingers pinch to zoom and slide together to orbit.
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.zoomToCursor = !coarsePointer.matches; // desktop: zoom towards the cursor
  controls.panSpeed = 0.6;
  controls.minDistance = 0.3;
  controls.maxDistance = 900;
  controls.autoRotateSpeed = 0.32;
  controls.autoRotate = !reducedMotion.matches;

  function resize(): void {
    width = window.innerWidth;
    height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    stars.scale = dpr * THREE.MathUtils.clamp(height / 900, 0.72, 1.35);
    // On dense screens a 1.5 px minimum covers 9 device pixels and the faint haze turns grainy.
    hazeScale = dpr >= 1.5 ? 0.7 : 1;
    stars.minSize = dpr >= 1.5 ? 1.0 : 1.5;
    document.documentElement.style.setProperty('--bottom-h', `${$('bottom').offsetHeight}px`);
    labels?.measure();
    obstaclesDirty = true;
  }

  // Labels keep clear of the interface panels.
  let obstaclesDirty = true;
  const obstacleEls = () => [
    document.querySelector<HTMLElement>('#top .brand'), document.querySelector<HTMLElement>('#top .top-actions'),
    $('panel'), $('time'), $('honesty'), $('card'),
  ];
  function refreshObstacles(): void {
    obstaclesDirty = false;
    labels?.setObstacles(obstacleEls().filter((el): el is HTMLElement => !!el && !el.hidden).map((el) => el.getBoundingClientRect()));
  }

  // ---- names, labels, search index -----------------------------------------------------------
  const named = new Map<number, NamedEntry>();
  for (const e of meta.named) named.set(e.i, e);
  const showcaseIdx = new Set(meta.showcase.filter((s) => s.i !== undefined).map((s) => s.i!));
  let gaiaIds: BigUint64Array | null = null;
  let baked: BakedField[] = [];
  loadIds().then((ids) => { gaiaIds = ids; if (selection) renderCard(); }).catch(() => {});
  loadBakedFields().then((f) => { baked = f; });

  const starName = (i: number): string => {
    const e = named.get(i);
    if (e) return e.n;
    if (i < data.nGcns) return gaiaIds ? `Gaia EDR3 ${gaiaIds[i]}` : 'Gaia EDR3 star';
    return 'Unnamed object';
  };

  const beyondPoint = (b: BeyondEntry, radius: number, out: THREE.Vector3) => {
    const u = unitFromRaDec(b.ra, b.dec);
    return out.set(u[0] * radius, u[1] * radius, u[2] * radius);
  };

  const starDistanceNow = (i: number) => Math.hypot(data.pos[3 * i], data.pos[3 * i + 1], data.pos[3 * i + 2]);
  let labels: LabelLayer | null = new LabelLayer($('labels'));
  labels.add({ text: 'Sun', kind: 'sun', position: (o) => o.set(0, 0, 0), minCamDist: 0.6 });
  for (const s of meta.showcase) {
    if (s.i !== undefined) {
      const i = s.i;
      labels.add({ text: named.get(i)?.n ?? s.n, kind: 'showcase', position: (o) => stars.positionAt(i, o), onSelect: () => select({ kind: 'star', i }, false) });
    } else if (s.beyond !== undefined) {
      const b = meta.beyond[s.beyond];
      labels.add({ text: `${b.n} · ${fmtInt(b.d)} pc, beyond the map`, kind: 'beyond', position: (o) => beyondPoint(b, BEYOND_OUTER, o), onSelect: () => select({ kind: 'beyond', b }, false) });
    }
  }
  for (const l of meta.labels) {
    if (l.k !== 'famous') continue;
    const i = l.i;
    // A star close to the Sun gets its label only once the view is zoomed in enough to separate them.
    labels.add({ text: named.get(i)?.n ?? '', kind: 'famous', position: (o) => stars.positionAt(i, o), onSelect: () => select({ kind: 'star', i }, false), maxCamDist: Math.max(40, starDistanceNow(i) * 13) });
  }
  for (const r of RING_RADII) {
    labels.add({ text: `${r} pc`, kind: 'ring', position: (o) => o.copy(planePoint(r, 318)), minCamDist: r * 0.35 });
  }
  labels.add({ text: 'toward the Galactic centre', kind: 'ring', position: (o) => o.copy(planePoint(112, 0)), minCamDist: 60 });
  for (const r of meta.regions) {
    const u = unitFromRaDec(r.ra, r.dec);
    labels.add({ text: r.n, kind: 'region', position: (o) => o.set(u[0] * r.d, u[1] * r.d, u[2] * r.d), minCamDist: 12 });
  }

  interface SearchItem { key: string; alt: string; label: string; sub: string; dist: number; sel: Selection }
  const starDistance = (i: number) => Math.hypot(data.pos[3 * i], data.pos[3 * i + 1], data.pos[3 * i + 2]);
  const searchItems: SearchItem[] = meta.named.map((e) => {
    const d = starDistance(e.i);
    return {
      key: normaliseName(e.n), alt: normaliseName(e.a ?? ''), label: e.n,
      sub: [e.s, `${d.toFixed(d < 10 ? 2 : 1)} pc`].filter(Boolean).join(' · '), dist: d, sel: { kind: 'star', i: e.i },
    };
  });
  for (const b of meta.beyond) {
    searchItems.push({ key: normaliseName(b.n), alt: '', label: b.n, sub: `${fmtInt(b.d)} pc · beyond the map`, dist: b.d, sel: { kind: 'beyond', b } });
  }
  const showcaseItems: SearchItem[] = meta.showcase
    .map((s) => searchItems.find((it) => (s.i !== undefined ? it.sel.kind === 'star' && it.sel.i === s.i : it.sel.kind === 'beyond' && it.sel.b === meta.beyond[s.beyond!])))
    .filter((x): x is SearchItem => !!x);

  function search(query: string): SearchItem[] {
    const q = normaliseName(query);
    if (!q) return showcaseItems;
    const scored: { it: SearchItem; rank: number }[] = [];
    for (const it of searchItems) {
      let rank = -1;
      if (it.key === q) rank = 0;
      else if (it.key.startsWith(q)) rank = 1;
      else if (it.key.includes(' ' + q)) rank = 2;
      else if (it.key.includes(q)) rank = 3;
      else if (it.alt.includes(q)) rank = 4;
      if (rank >= 0) scored.push({ it, rank });
    }
    scored.sort((a, b) => a.rank - b.rank || a.it.dist - b.it.dist);
    return scored.slice(0, 8).map((s) => s.it);
  }

  // ---- camera animation ----------------------------------------------------------------------
  type Tween = { t0: number; dur: number; step: (k: number) => void; done?: () => void };
  let tween: Tween | null = null;
  let diving = false;
  let exposureOverride: number | null = null;

  function runTween(dur: number, step: (k: number) => void, done?: () => void): void {
    if (reducedMotion.matches || dur <= 0) {
      tween = null;
      step(1);
      done?.();
      return;
    }
    tween = { t0: performance.now(), dur, step, done };
  }

  function stopAutoRotate(): void {
    controls.autoRotate = false;
  }

  function flyTo(target: THREE.Vector3, distance: number, dur = 1400): void {
    stopAutoRotate();
    const fromTarget = controls.target.clone();
    const offset = camera.position.clone().sub(controls.target);
    const fromDist = offset.length();
    const dir = offset.normalize();
    runTween(dur, (k) => {
      const e = easeInOut(k);
      controls.target.lerpVectors(fromTarget, target, e);
      const d = Math.exp(THREE.MathUtils.lerp(Math.log(fromDist), Math.log(distance), e));
      camera.position.copy(controls.target).addScaledVector(dir, d);
    });
  }

  function resetView(animate = true): void {
    followIdx = -1;
    const fromTarget = controls.target.clone();
    const fromPos = camera.position.clone();
    const toPos = homeDir.clone().multiplyScalar(homeDistance());
    stopAutoRotate();
    runTween(animate ? 1200 : 0, (k) => {
      const e = easeInOut(k);
      controls.target.lerpVectors(fromTarget, new THREE.Vector3(), e);
      camera.position.lerpVectors(fromPos, toPos, e);
    });
  }

  // ---- time ----------------------------------------------------------------------------------
  const slider = $<HTMLInputElement>('t');
  const tOut = $<HTMLOutputElement>('t-out');
  const playBtn = $<HTMLButtonElement>('play');
  const playIcon = document.getElementById('play-icon')!;
  let playing = false;

  function setTime(years: number, fromSlider = false): void {
    tYears = THREE.MathUtils.clamp(years, -TIME_RANGE, TIME_RANGE);
    stars.time = nowOffset + tYears;
    if (!fromSlider) slider.value = String(Math.round(tYears));
    const rounded = Math.round(tYears / 50) * 50;
    tOut.textContent = rounded === 0 ? 'Now' : `${signed(rounded, 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} yr`;
    slider.setAttribute('aria-valuetext', rounded === 0 ? 'Now' : `${rounded} years from now`);
    slider.style.setProperty('--fill', `${((tYears + TIME_RANGE) / (2 * TIME_RANGE)) * 100}%`);
    updateCardTime();
  }

  function setPlaying(on: boolean): void {
    playing = on;
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    playBtn.classList.toggle('active', on);
    playIcon.setAttribute('d', on ? 'M4 2.5h3v11H4zM9 2.5h3v11H9z' : 'M4 2.5v11l9-5.5z');
    if (on && tYears >= TIME_RANGE) setTime(-TIME_RANGE);
  }

  slider.addEventListener('input', () => { setPlaying(false); setTime(Number(slider.value), true); });
  playBtn.addEventListener('click', () => setPlaying(!playing));
  let timeTween: { t0: number; dur: number; from: number; to: number } | null = null;
  function runTimeTween(from: number, to: number, dur: number): void {
    if (reducedMotion.matches || dur <= 0 || from === to) { timeTween = null; setTime(to); return; }
    timeTween = { t0: performance.now(), dur, from, to };
  }

  // ---- colour mode ---------------------------------------------------------------------------
  let motionMode = false;
  let motionTarget = 0;
  function setMode(motion: boolean): void {
    motionMode = motion;
    motionTarget = motion ? 1 : 0;
    if (reducedMotion.matches) stars.motion = motionTarget;
    $('mode-colour').setAttribute('aria-pressed', String(!motion));
    $('mode-motion').setAttribute('aria-pressed', String(motion));
    $('legend-colour').hidden = motion;
    $('legend-motion').hidden = !motion;
  }
  $('mode-colour').addEventListener('click', () => setMode(false));
  $('mode-motion').addEventListener('click', () => setMode(true));

  // ---- selection and info card ----------------------------------------------------------------
  const card = $('card');
  const ringSel = $('ring-sel');
  const ringHover = $('ring-hover');
  const tip = $('tip');
  let selection: Selection | null = null;
  let hoverIdx = -1;
  let cardTimeRow: HTMLElement | null = null;
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  function selectionPoint(sel: Selection, out: THREE.Vector3): THREE.Vector3 {
    return sel.kind === 'star' ? stars.positionAt(sel.i, out) : beyondPoint(sel.b, BEYOND_OUTER, out);
  }

  /** Present-day sky position: the catalogue position moved along its velocity to today. */
  function presentDay(sel: Selection): { ra: number; dec: number; dist: number } {
    if (sel.kind === 'star') {
      const k = 3 * sel.i;
      return raDecFromVec(
        data.pos[k] + data.vel[k] * nowOffset,
        data.pos[k + 1] + data.vel[k + 1] * nowOffset,
        data.pos[k + 2] + data.vel[k + 2] * nowOffset,
      );
    }
    const b = sel.b;
    const dt = nowYear - b.epoch;
    const dec = b.dec + (b.pmdec * dt) / 3.6e6;
    const ra = (b.ra + (b.pmra * dt) / 3.6e6 / Math.cos((b.dec * Math.PI) / 180) + 360) % 360;
    return { ra, dec, dist: b.d };
  }

  function diveUrl(sel: Selection): string {
    let { ra, dec } = presentDay(sel);
    // If the viewer has a pre-baked field centred on this object, use its exact centre so it loads instantly.
    for (const f of baked) {
      if (angularSepArcsec(ra, dec, f.ra, f.dec) < 15) { ra = f.ra; dec = f.dec; break; }
    }
    return `/?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&fov=${VIEWER_FOV}`;
  }

  function row(label: string, value: string, note?: string): HTMLElement {
    const r = h('div', 'row');
    r.append(h('dt', undefined, label));
    const dd = h('dd', undefined, value);
    if (note) dd.append(h('small', undefined, note));
    r.append(dd);
    return r;
  }

  function updateCardTime(): void {
    if (!cardTimeRow || !selection || selection.kind !== 'star') return;
    const rounded = Math.round(tYears / 50) * 50;
    cardTimeRow.hidden = rounded === 0;
    if (rounded === 0) return;
    const d = stars.positionAt(selection.i, tmp).length();
    cardTimeRow.querySelector('dt')!.textContent = `At ${tOut.textContent}`;
    cardTimeRow.querySelector('dd')!.textContent = `${d.toFixed(2)} pc from the Sun`;
  }

  function renderCard(): void {
    card.replaceChildren();
    cardTimeRow = null;
    if (!selection) { card.hidden = true; obstaclesDirty = true; return; }
    const sel = selection;
    const head = h('div', 'card-head');
    const titles = h('div', 'card-titles');
    const close = h('button', 'icon-btn card-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    close.addEventListener('click', () => select(null, false));
    head.append(titles, close);
    const dl = h('dl', 'facts');
    const now = presentDay(sel);

    if (sel.kind === 'star') {
      const i = sel.i;
      const e = named.get(i);
      const fl = data.flags[i];
      titles.append(h('h2', undefined, starName(i)));
      const tags: string[] = [];
      if (e?.s) tags.push(e.s);
      if (fl & FLAG_BD) tags.push('brown dwarf');
      else if (fl & FLAG_WD) tags.push('white dwarf');
      if (showcaseIdx.has(i)) tags.push('showcase target');
      if (tags.length) titles.append(h('p', 'card-sub', tags.join(' · ')));
      if (e?.a) titles.append(h('p', 'card-alt', e.a));
      else if (e && i < data.nGcns && gaiaIds) titles.append(h('p', 'card-alt', `Gaia EDR3 ${gaiaIds[i]}`));

      // Motion across the sky at the catalogue epoch: this reproduces the catalogue's own proper motion.
      const k = 3 * i;
      const px = data.pos[k], py = data.pos[k + 1], pz = data.pos[k + 2];
      const vx = data.vel[k], vy = data.vel[k + 1], vz = data.vel[k + 2];
      const r = Math.hypot(px, py, pz);
      const vr = (vx * px + vy * py + vz * pz) / r;
      const speed = Math.hypot(vx, vy, vz);
      const pm = (Math.sqrt(Math.max(0, speed * speed - vr * vr)) / r) * RAD_TO_ARCSEC;

      dl.append(row('Distance', `${r.toFixed(r < 10 ? 3 : 2)} pc`, `${(r * PC_TO_LY).toFixed(r < 10 ? 2 : 1)} light-years`));
      cardTimeRow = row('At', '');
      cardTimeRow.classList.add('row-time');
      dl.append(cardTimeRow);
      dl.append(row('Proper motion', `${(pm * 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} mas per year`));
      const appG = data.mag[i] * 0.001 + 5 * Math.log10(r / 10);
      if (e?.hp !== undefined) dl.append(row('Magnitude', `Hp ${e.hp.toFixed(2).replace('-', '−')}`, 'Hipparcos; too bright for Gaia'));
      else if (fl & FLAG_MAG_EST) {
        if (e?.w2 !== undefined) dl.append(row('Magnitude', `W2 ${e.w2.toFixed(2)}`, 'infrared (WISE); not measured by Gaia'));
        else if (e?.j !== undefined) dl.append(row('Magnitude', `J ${e.j.toFixed(2)}`, 'near-infrared; not measured by Gaia'));
        else dl.append(row('Magnitude', `G ≈ ${appG.toFixed(1)}`, 'estimated'));
      } else dl.append(row('Magnitude', `G ${appG.toFixed(2)}`, e?.w2 !== undefined ? `W2 ${e.w2.toFixed(2)} in the infrared` : undefined));
      if (fl & FLAG_RV) {
        const kms = vr * KMS_PER_PCYR;
        dl.append(row('Radial velocity', `${signed(kms, 1)} km/s`, `${(speed * KMS_PER_PCYR).toFixed(0)} km/s through space`));
      } else dl.append(row('Radial velocity', 'not measured', 'drawn with zero line-of-sight speed'));
      dl.append(row('Position today', `${now.ra.toFixed(4)}°, ${signed(now.dec, 4)}°`));
    } else {
      const b = sel.b;
      titles.append(h('h2', undefined, b.n));
      titles.append(h('p', 'card-sub', `${b.s} · showcase target`));
      dl.append(row('Distance', `about ${fmtInt(b.d)} pc`, `${fmtInt(b.d * PC_TO_LY)} light-years`));
      dl.append(row('Proper motion', `${Math.hypot(b.pmra, b.pmdec).toFixed(1)} mas per year`, 'far too small to see moving'));
      dl.append(row('Position today', `${now.ra.toFixed(4)}°, ${signed(now.dec, 4)}°`));
    }

    card.append(head, dl);
    if (sel.kind === 'beyond') card.append(h('p', 'card-note', `${sel.b.note} The marker shows its direction only.`));
    const actions = h('div', 'card-actions');
    const dive = h('button', 'btn-primary', 'Dive');
    dive.type = 'button';
    dive.id = 'dive';
    dive.title = 'Fly back to the Sun, face this object and open its SPHEREx view';
    dive.addEventListener('click', () => startDive(sel));
    const centre = h('button', 'text-btn', 'Centre view');
    centre.type = 'button';
    centre.addEventListener('click', () => focusOn(sel));
    actions.append(dive, centre);
    card.append(actions);
    card.hidden = false;
    obstaclesDirty = true;
    updateCardTime();
  }

  // After centring on a star the view rides along with it while time is scrubbed.
  let followIdx = -1;
  const followPrev = new THREE.Vector3();
  function focusOn(sel: Selection): void {
    const p = selectionPoint(sel, new THREE.Vector3());
    const d = p.length();
    if (sel.kind === 'beyond') { followIdx = -1; flyTo(new THREE.Vector3(), homeDistance(), 1200); return; }
    flyTo(p, THREE.MathUtils.clamp(d * 1.5, 4, 150));
    followIdx = sel.i;
    followPrev.copy(p);
  }

  function select(sel: Selection | null, fly: boolean): void {
    selection = sel;
    if (!sel || sel.kind !== 'star' || sel.i !== followIdx) followIdx = -1;
    renderCard();
    ringSel.hidden = !sel;
    if (!sel) furniture.setSelection(null);
    if (sel && fly) focusOn(sel);
    if (sel) stopAutoRotate();
  }

  // ---- dive ----------------------------------------------------------------------------------
  const fade = $('fade');
  function startDive(sel: Selection): void {
    if (diving) return;
    diving = true;
    setPlaying(false);
    stopAutoRotate();
    controls.enabled = false;
    document.body.classList.add('diving');
    const url = diveUrl(sel);
    // Ask the backend for the exposure list now, so it is cached by the time the viewer opens.
    const q = new URL(url, location.href).searchParams;
    if (!baked.some((f) => f.ra === +q.get('ra')! && f.dec === +q.get('dec')!)) {
      void fetch(`/api/exposures?ra=${q.get('ra')}&dec=${q.get('dec')}`, { keepalive: true }).catch(() => undefined);
    }
    const leave = () => {
      fade.classList.add('on');
      window.setTimeout(() => (EMBED && window.top ? window.top : window).location.assign(url), reducedMotion.matches ? 120 : 520);
    };
    if (tYears !== 0) runTimeTween(tYears, 0, 900);
    const fromPos = camera.position.clone();
    const fromLook = controls.target.clone();
    const fromFov = camera.fov;
    const fromExp = exposureDistance();
    // The view from the Sun: stand a hair behind the origin and face the object as it is today.
    const now = presentDay(sel);
    const u = new THREE.Vector3(...unitFromRaDec(now.ra, now.dec));
    const toPos = u.clone().multiplyScalar(-0.002);
    const toLook = u.clone().multiplyScalar(Math.max(1, sel.kind === 'star' ? now.dist : 100));
    const look = new THREE.Vector3();
    runTween(2600, (k) => {
      const e = easeInOut(k);
      camera.position.lerpVectors(fromPos, toPos, e);
      look.lerpVectors(fromLook, toLook, easeOut(Math.min(1, k * 1.5)));
      camera.lookAt(look);
      camera.fov = THREE.MathUtils.lerp(fromFov, 26, e);
      camera.updateProjectionMatrix();
      exposureOverride = Math.exp(THREE.MathUtils.lerp(Math.log(fromExp), Math.log(45), e));
    }, leave);
  }

  // Coming back with the browser's back button restores a usable map.
  window.addEventListener('pageshow', (ev) => {
    if (!ev.persisted || !diving) return;
    diving = false;
    exposureOverride = null;
    tween = null;
    controls.enabled = true;
    document.body.classList.remove('diving');
    fade.classList.remove('on');
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();
    resetView(false);
  });

  // ---- pointer: click to pick, hover to preview -------------------------------------------------
  let downX = 0, downY = 0, downT = 0, dragging = false;
  let pointerX = -1, pointerY = -1, pointerMoved = false;
  canvas.addEventListener('pointerdown', (ev) => {
    downX = ev.clientX; downY = ev.clientY; downT = performance.now();
    dragging = true;
    stopAutoRotate();
    tween = null;
    hideHover();
  });
  canvas.addEventListener('pointerup', (ev) => {
    dragging = false;
    if (diving) return;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6 || performance.now() - downT > 500) return;
    const radius = ev.pointerType === 'touch' || coarsePointer.matches ? 24 : 13;
    const i = stars.pick(camera, ev.clientX, ev.clientY, width, height, radius);
    if (i >= 0) select({ kind: 'star', i }, false);
    else if (selection) select(null, false);
  });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('pointermove', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    pointerX = ev.clientX; pointerY = ev.clientY; pointerMoved = true;
  });
  canvas.addEventListener('pointerleave', () => { pointerX = -1; hideHover(); });
  canvas.addEventListener('wheel', () => { stopAutoRotate(); tween = null; }, { passive: true });
  // A wheel or trackpad pinch that lands on a star label, or arrives while the controls are off
  // during a dive, would otherwise scroll or zoom the page. Pinch arrives as ctrl+wheel; labels pass
  // their wheel on to the canvas so the map zooms wherever the pointer is.
  window.addEventListener('wheel', (ev) => {
    const t = ev.target as Element | null;
    const onLabel = t !== canvas && !!t?.closest('#labels');
    if (ev.ctrlKey || onLabel || t === canvas) ev.preventDefault();
    if (onLabel) canvas.dispatchEvent(new WheelEvent('wheel', ev));
  }, { passive: false, capture: true });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });
  }
  canvas.addEventListener('dblclick', () => { if (selection) focusOn(selection); });

  function hideHover(): void {
    hoverIdx = -1;
    ringHover.hidden = true;
    tip.hidden = true;
    canvas.style.cursor = '';
  }

  function updateHover(): void {
    if (!pointerMoved || dragging || diving || pointerX < 0) return;
    pointerMoved = false;
    const i = stars.pick(camera, pointerX, pointerY, width, height, 11);
    if (i === hoverIdx) return;
    hoverIdx = i;
    if (i < 0) { hideHover(); return; }
    canvas.style.cursor = 'pointer';
    const e = named.get(i);
    const d = stars.positionAt(i, tmp).length();
    tip.textContent = `${e ? e.n : i < data.nGcns ? 'Gaia star' : 'Object'} · ${d.toFixed(d < 10 ? 2 : 1)} pc`;
    tip.hidden = false;
    ringHover.hidden = false;
  }

  function placeAt(el: HTMLElement, world: THREE.Vector3, dx = 0, dy = 0): boolean {
    tmp2.copy(world).project(camera);
    if (tmp2.z < -1 || tmp2.z > 1) { el.style.opacity = '0'; return false; }
    el.style.opacity = '';
    el.style.transform = `translate3d(${((tmp2.x * 0.5 + 0.5) * width + dx).toFixed(1)}px,${((0.5 - tmp2.y * 0.5) * height + dy).toFixed(1)}px,0)`;
    return true;
  }

  // ---- search UI -----------------------------------------------------------------------------
  const q = $<HTMLInputElement>('q');
  const results = $<HTMLUListElement>('results');
  let resultItems: SearchItem[] = [];
  let active = -1;

  function renderResults(): void {
    resultItems = search(q.value);
    results.replaceChildren();
    if (!q.value.trim()) results.append(h('li', 'results-head', 'Showcase targets'));
    if (!resultItems.length) results.append(h('li', 'results-empty', 'No named object matches. Unnamed Gaia stars can be picked by clicking them.'));
    resultItems.forEach((it, n) => {
      const li = h('li', 'result');
      li.setAttribute('role', 'option');
      li.id = `result-${n}`;
      li.append(h('span', 'result-name', it.label), h('span', 'result-sub', it.sub));
      li.addEventListener('pointerdown', (ev) => { ev.preventDefault(); choose(n); });
      results.append(li);
    });
    active = resultItems.length && q.value.trim() ? 0 : -1;
    markActive();
    results.hidden = false;
    q.setAttribute('aria-expanded', 'true');
  }
  function markActive(): void {
    results.querySelectorAll('.result').forEach((el, n) => el.classList.toggle('active', n === active));
    if (active >= 0) q.setAttribute('aria-activedescendant', `result-${active}`);
    else q.removeAttribute('aria-activedescendant');
  }
  function closeResults(): void {
    results.hidden = true;
    q.setAttribute('aria-expanded', 'false');
  }
  function choose(n: number): void {
    const it = resultItems[n];
    if (!it) return;
    q.value = it.label;
    closeResults();
    q.blur();
    select(it.sel, true);
  }
  q.addEventListener('focus', renderResults);
  q.addEventListener('input', renderResults);
  q.addEventListener('blur', () => window.setTimeout(closeResults, 120));
  q.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!resultItems.length) return;
      active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + resultItems.length) % resultItems.length;
      markActive();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      choose(active >= 0 ? active : 0);
    } else if (ev.key === 'Escape') {
      q.blur();
    }
  });

  // Fly: W/S along the view, A/D sideways, Q/E down/up. Moves camera and orbit centre together,
  // so orbiting and zooming keep working exactly as before.
  const FLY_KEYS: Record<string, [number, number, number]> = {
    w: [0, 0, 1], s: [0, 0, -1], a: [-1, 0, 0], d: [1, 0, 0], q: [0, -1, 0], e: [0, 1, 0],
    arrowup: [0, 0, 1], arrowdown: [0, 0, -1], arrowleft: [-1, 0, 0], arrowright: [1, 0, 0],
  };
  const flyDown = new Set<string>();
  window.addEventListener('keydown', (ev) => {
    const k = ev.key.toLowerCase();
    if (!(k in FLY_KEYS) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLButtonElement && k.startsWith('arrow')) return;
    ev.preventDefault();
    flyDown.add(k);
  });
  window.addEventListener('keyup', (ev) => flyDown.delete(ev.key.toLowerCase()));
  window.addEventListener('blur', () => flyDown.clear());
  const flyDir = new THREE.Vector3();
  const flyRight = new THREE.Vector3();
  const flyMove = new THREE.Vector3();
  function updateFly(dt: number): void {
    if (!flyDown.size || diving) return;
    let x = 0, y = 0, z = 0;
    for (const k of flyDown) { const v = FLY_KEYS[k]; x += v[0]; y += v[1]; z += v[2]; }
    if (!x && !y && !z) return;
    stopAutoRotate();
    tween = null;
    followIdx = -1;
    camera.getWorldDirection(flyDir);
    flyRight.crossVectors(flyDir, camera.up).normalize();
    const speed = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target), 2, 400) * 0.9 * dt;
    flyMove.set(0, 0, 0).addScaledVector(flyRight, x).addScaledVector(camera.up, y).addScaledVector(flyDir, z);
    if (flyMove.lengthSq() === 0) return;
    flyMove.normalize().multiplyScalar(speed);
    camera.position.add(flyMove);
    controls.target.add(flyMove);
  }

  window.addEventListener('keydown', (ev) => {
    const typing = ev.target instanceof HTMLInputElement && ev.target.type !== 'range';
    if (ev.key === '/' && !typing) { ev.preventDefault(); q.focus(); q.select(); }
    else if (ev.key === ' ' && !typing && !(ev.target instanceof HTMLButtonElement)) { ev.preventDefault(); setPlaying(!playing); }
    else if (ev.key === 'Escape' && !typing && selection) select(null, false);
  });
  $('home').addEventListener('click', () => resetView());

  // ---- frame loop ------------------------------------------------------------------------------
  const exposureDistance = () => exposureOverride ?? camera.position.distanceTo(controls.target);
  let last = performance.now();
  let frames = 0;

  function frame(now: number): void {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (playing) {
      const next = tYears + PLAY_SPEED * dt;
      if (next >= TIME_RANGE) { setTime(TIME_RANGE); setPlaying(false); }
      else setTime(next);
    }
    if (timeTween) {
      const k = Math.min(1, (now - timeTween.t0) / timeTween.dur);
      setTime(THREE.MathUtils.lerp(timeTween.from, timeTween.to, easeInOut(k)));
      if (k >= 1) timeTween = null;
    }
    if (stars.motion !== motionTarget) {
      const step = dt / 0.45;
      stars.motion = motionTarget > stars.motion ? Math.min(motionTarget, stars.motion + step) : Math.max(motionTarget, stars.motion - step);
    }
    if (tween) {
      const tw = tween;
      const k = Math.min(1, (now - tw.t0) / tw.dur);
      tw.step(k);
      if (k >= 1) {
        if (tween === tw) tween = null;
        tw.done?.();
      }
    }
    if (followIdx >= 0 && !diving) {
      const p = stars.positionAt(followIdx, tmp);
      if (!tween) {
        tmp2.subVectors(p, followPrev);
        controls.target.add(tmp2);
        camera.position.add(tmp2);
      }
      followPrev.copy(p);
    }
    updateFly(dt);
    if (!diving) controls.update();

    // Exposure: zooming in shows fainter stars, the way a longer look at a smaller field would.
    const r = THREE.MathUtils.clamp(exposureDistance(), 2, 600);
    stars.magRef = 9.3 - 2.1 * Math.log10(r / 150);
    // From far away the faint stars pile up on few pixels, so their haze is turned down.
    stars.haze = 0.13 * hazeScale * THREE.MathUtils.clamp(190 / r, 0.3, 1);
    furniture.setCameraDistance(camera.position.length());

    if (selection) {
      const p = selectionPoint(selection, tmp);
      furniture.setSelection(selection.kind === 'star' ? p : null);
      placeAt(ringSel, p);
    }
    updateHover();
    if (hoverIdx >= 0) {
      const p = stars.positionAt(hoverIdx, tmp);
      placeAt(ringHover, p);
      placeAt(tip, p, 14, -26);
    }

    if (obstaclesDirty) refreshObstacles();
    renderer.render(scene, camera);
    labels?.update(camera, width, height);
    frames++;
    requestAnimationFrame(frame);
  }

  // ---- go --------------------------------------------------------------------------------------
  const c = meta.counts;
  $('counts').textContent = `${fmtInt(meta.count)} objects: ${fmtInt(c.gcns)} Gaia stars, ${fmtInt(c.brown_dwarfs)} brown dwarfs, ${fmtInt(c.hipparcos_added)} bright stars from Hipparcos.`;
  if (phone.matches) $<HTMLDetailsElement>('legend').open = false;
  window.addEventListener('resize', resize);
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--bottom-h', `${$('bottom').offsetHeight}px`);
    obstaclesDirty = true;
  }).observe($('bottom'));
  if (phone.matches) $<HTMLInputElement>('q').placeholder = 'Find a star';
  resize();
  setTime(0);
  setMode(false);

  const d0 = homeDistance();
  camera.position.copy(homeDir).multiplyScalar(d0);
  controls.update();
  if (!reducedMotion.matches) {
    // Opening move: a slow push in from farther out.
    const far = d0 * 1.55;
    camera.position.copy(homeDir).multiplyScalar(far);
    const t0 = performance.now();
    tween = {
      t0, dur: 3200,
      step: (k) => {
        const d = THREE.MathUtils.lerp(far, d0, easeOut(k));
        camera.position.sub(controls.target).setLength(d).add(controls.target);
      },
    };
  }

  const params = new URLSearchParams(window.location.search);
  const wanted = params.get('q');
  if (wanted) {
    const hit = search(wanted)[0];
    if (hit) { tween = null; camera.position.copy(homeDir).multiplyScalar(d0); select(hit.sel, true); }
  }

  requestAnimationFrame((t) => {
    last = t;
    frame(t);
    loading.classList.add('done');
    window.setTimeout(() => { loading.hidden = true; }, 700);
  });

  // Hooks for automated checks (Playwright); harmless otherwise.
  (window as unknown as Record<string, unknown>).__explore = {
    get frames() { return frames; },
    get time() { return tYears; },
    get selection() { return selection; },
    screenOf(i: number) {
      const p = stars.positionAt(i, new THREE.Vector3()).project(camera);
      return { x: (p.x * 0.5 + 0.5) * width, y: (0.5 - p.y * 0.5) * height };
    },
    indexOf(name: string) { return meta.named.find((e) => e.n === name)?.i ?? -1; },
    diveUrl: () => (selection ? diveUrl(selection) : null),
  };
}

start();
