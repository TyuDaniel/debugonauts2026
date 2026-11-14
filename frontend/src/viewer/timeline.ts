// SkyDive viewer — playback (play / step / speed), modes, presets, A/B trays and the unified
// 2010→today timeline with a scale break between the WISE era and SPHEREx.
// Written with AI coding assistance (Claude Code).
import { frameById, playlist } from './compute';
import { dateToMjd, mjdIso, mjdToYear, yearToMjd } from './coords';
import { $, clear, h, rafThrottle, toast } from './dom';
import { groupPatch, store } from './store';
import type { Frame, Mode } from './types';
import { stackAllSpherex } from './wavebar';

let timer = 0;

// ---------- playback ----------

/** Frames worth stepping to: SPHEREx visits with nothing in the current wavelength range are skipped. */
function playable(): Frame[] {
  const s = store.session;
  const list = playlist();
  if (s.status !== 'ok') return list;
  const out = list.filter((f) => f.kind !== 'spherex' || s.stacks.has(f.id));
  return out.length ? out : list;
}

export function step(dir: 1 | -1): void {
  const list = playable();
  if (!list.length) return;
  if (store.state.mode !== 'blink') store.set({ mode: 'blink' });
  const i = list.findIndex((f) => f.id === store.state.frame);
  const next = list[(i + dir + list.length) % list.length] ?? list[0];
  store.set({ frame: next.id });
}

export function togglePlay(): void {
  const playing = !store.state.playing;
  store.set(playing && store.state.mode !== 'blink' ? { playing, mode: 'blink' } : { playing });
}

function schedule(): void {
  clearInterval(timer);
  timer = 0;
  const st = store.state;
  if (!st.playing || st.mode !== 'blink') return;
  timer = window.setInterval(() => {
    if (document.hidden) return;
    if (playable().length > 1) step(1);
  }, st.speed);
}

/** Make sure the shown frame exists; pick a sensible one as data arrives. */
function ensureFrame(): void {
  const list = playlist();
  const st = store.state;
  if (!list.length) return;
  // The shown visit has nothing in the chosen wavelength range: move to the nearest one that has.
  const s = store.session;
  const cur = frameById(st.frame);
  if (st.mode === 'blink' && s.status === 'ok' && cur?.kind === 'spherex' && s.stacks.size && !s.stacks.has(cur.id)) {
    const withData = list.filter((f) => f.kind === 'spherex' && s.stacks.has(f.id));
    if (withData.length) {
      const near = withData.reduce((a, b) => (Math.abs(b.mjd - cur.mjd) < Math.abs(a.mjd - cur.mjd) ? b : a));
      store.set({ frame: near.id });
      return;
    }
  }
  if (!st.frame || !list.some((f) => f.id === st.frame)) {
    if (st.mode !== 'blink' && frameById(st.frame)) return;
    // A WISE / Pan-STARRS frame named in the URL may simply not have arrived yet.
    if (st.frame && st.frame[0] !== 's' && ['idle', 'loading'].includes(store.session.history.status)) return;
    // Start on the newest SPHEREx visit: it is the first thing that has pixels.
    const spx = list.filter((f) => f.kind === 'spherex');
    // History can arrive before the exposure list: wait for SPHEREx rather than settling on WISE.
    if (!spx.length && store.session.status === 'loading' && !(st.a.length || st.b.length)) return;
    store.set({ frame: (spx[spx.length - 1] ?? list[list.length - 1]).id });
  }
}

// ---------- presets ----------

function presetBlinkAll(): void {
  store.set({ mode: 'blink', playing: true });
}

function presetLatestMinusFirst(): void {
  const s = store.session;
  const spx = s.frames.filter((f) => f.kind === 'spherex' && s.exposures.some((e) => e.ok && e.visit === f.visit));
  if (spx.length < 2) {
    toast('This needs at least two SPHEREx visits.');
    return;
  }
  pickGroup = 'A';
  store.set(groupPatch({ A: [spx[spx.length - 1].id], B: [spx[0].id] }, ['A', 'B']));
}

const surveyOf = (id: string) => (id[0] === 's' ? 'spherex' : id[0] === 'w' ? 'wise' : 'ps1');
const SURVEY_NAME = { spherex: 'SPHEREx', wise: 'WISE', ps1: 'Pan-STARRS' } as const;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The group that timeline clicks fill in Add mode. */
let pickGroup = 'A';
/** What a click on a timeline frame does: show that frame, or add it to (or remove it from) the selected group. */
let clickAction: 'view' | 'add' = 'view';

/** Which group a frame is in, if any. A frame belongs to one group at a time. */
function groupOf(id: string): string | null {
  for (const [k, v] of Object.entries(store.state.groups)) if (v.includes(id)) return k;
  return null;
}

function toggleInGroup(g: string, id: string): void {
  const st = store.state;
  const groups: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(st.groups)) groups[k] = v.filter((x) => x !== id);
  const had = (st.groups[g] ?? []).includes(id);
  let list = groups[g] ?? [];
  // A group holds frames from one survey: adding another survey's frame starts the group afresh.
  if (!had && list.length && surveyOf(list[0]) !== surveyOf(id)) {
    list = [];
    toast(`Group ${g} now holds ${SURVEY_NAME[surveyOf(id)]} frames`);
  }
  groups[g] = had ? list : [...list, id];
  // If this leaves the displayed difference spanning two surveys, fall back to stacking the first group.
  const kind = (k: string | null) => (k && groups[k]?.length ? surveyOf(groups[k][0]) : null);
  const [g1, g2] = st.show;
  const show: [string, string | null] = g2 && kind(g1) && kind(g2) && kind(g1) !== kind(g2) ? [g1, null] : st.show;
  store.set(groupPatch(groups, show));
}

function onFrameClick(e: MouseEvent, id: string): void {
  if (clickAction === 'add') return toggleInGroup(pickGroup, id);
  store.set({ frame: id, mode: 'blink', playing: false });
  void e;
}

/** Enter compare mode; with no groups yet, start with every SPHEREx visit in group A. */
function enterGroups(): void {
  const st = store.state;
  const groups = { ...st.groups };
  if (!Object.values(groups).some((v) => v.length)) {
    groups.A = store.session.frames.filter((f) => f.kind === 'spherex').map((f) => f.id);
  }
  if (!groups[pickGroup]) pickGroup = Object.keys(groups).sort()[0] ?? 'A';
  const show: [string, string | null] = groups[st.show[0]] ? st.show : [Object.keys(groups).sort()[0] ?? 'A', null];
  store.set(groupPatch(groups, show));
}

// ---------- time axis with a break ----------

const BREAK_YEAR = 2025.0;
const LEFT0 = 2009.75;
const SPLIT = 0.56; // share of the width given to 2010–2024
const GAP = 0.018;

function axisEnd(): number {
  const last = store.session.frames.reduce((m, f) => Math.max(m, f.mjd1), 0);
  const today = dateToMjd(new Date());
  return mjdToYear(Math.max(last, today)) + 0.08;
}

function xOf(mjd: number): number {
  const y = mjdToYear(mjd);
  if (y <= BREAK_YEAR) return Math.max(0, ((y - LEFT0) / (BREAK_YEAR - LEFT0)) * SPLIT);
  const end = axisEnd();
  return SPLIT + GAP + ((y - BREAK_YEAR) / (end - BREAK_YEAR)) * (1 - SPLIT - GAP);
}

// ---------- rendering ----------

let root: HTMLElement;

export function initTimeline(): void {
  root = $('#timeline');

  $('#play').addEventListener('click', togglePlay);
  $('#step-back').addEventListener('click', () => {
    store.set({ playing: false });
    step(-1);
  });
  $('#step-fwd').addEventListener('click', () => {
    store.set({ playing: false });
    step(1);
  });
  const speed = $<HTMLInputElement>('#speed');
  speed.addEventListener('input', () => store.set({ speed: Math.round(1000 / parseFloat(speed.value)) }));
  // Never faster than 3 frames a second: faster blinking can trigger photosensitive seizures.
  if (store.state.speed < 333) store.set({ speed: 333 });
  $('#preset-blink').addEventListener('click', presetBlinkAll);
  $('#preset-diff').addEventListener('click', presetLatestMinusFirst);
  $('#preset-stack').addEventListener('click', stackAllSpherex);

  store.on('state', (k) => {
    if (k.has('playing') || k.has('speed') || k.has('mode')) schedule();
    if (k.has('a') || k.has('b') || k.has('mode')) ensureFrame();
    renderControls();
    if (['frame', 'a', 'b', 'mode', 'wiseBand'].some((x) => k.has(x))) render();
  });
  store.on(['frames', 'stacks', 'history', 'session'], () => {
    ensureFrame();
    render();
  });
  document.addEventListener('visibilitychange', schedule);
  schedule();
  renderControls();
  render();
}

function renderControls(): void {
  const st = store.state;
  const playing = st.playing && st.mode === 'blink';
  const play = $('#play');
  play.setAttribute('aria-pressed', String(playing));
  play.setAttribute('aria-label', playing ? 'Pause (space)' : 'Play (space)');
  $('#play-icon').setAttribute('d', playing ? 'M4 2.5h3v11H4zM9 2.5h3v11H9z' : 'M4 2.5 13 8l-9 5.5z');
  const fps = 1000 / st.speed;
  const speed = $<HTMLInputElement>('#speed');
  speed.value = String(fps);
  $('#speed-out').textContent = `${+fps.toFixed(2)} fps`;
  renderTrays();
}

function renderTrays(): void {
  const st = store.state;
  const el = $('#trays');
  clear(el);
  // Play, the step buttons and clicking a frame show single frames (Blink); choosing a group or
  // Stack / Subtract shows groups. There is no separate mode switch.
  const grouping = st.mode !== 'blink';
  const letters = [...new Set([...Object.keys(st.groups), pickGroup])].sort();
  const surveyOfGroup = (g: string) => {
    const first = (st.groups[g] ?? [])[0];
    return first ? surveyOf(first) : null;
  };
  const filled = letters.filter((g) => (st.groups[g] ?? []).length);
  // A difference is only allowed between two groups from the same survey.
  const partnersOf = (g: string) => filled.filter((x) => x !== g && surveyOfGroup(x) === surveyOfGroup(g));
  const subtracting = grouping && !!st.show[1];
  const setShow = (show: [string, string | null]) => store.set(groupPatch(st.groups, show));
  const select = (g: string) => {
    pickGroup = g;
    // While stacking, the group being edited is the one on screen.
    if (!subtracting) setShow([g, null]);
    renderTrays();
    render();
  };

  // 1. What clicking a timeline frame does, then the groups.
  const setAction = (a: 'view' | 'add') => {
    clickAction = a;
    renderTrays();
    render();
  };
  const row = h('div', { class: 'groups', role: 'group', 'aria-label': 'Groups' },
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Clicking a frame on the timeline' },
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(clickAction === 'view'), title: 'Clicking a frame shows it', onclick: () => setAction('view') }, 'View'),
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(clickAction === 'add'), title: 'Clicking a frame adds it to the selected group, or takes it out', onclick: () => setAction('add') }, 'Add'),
    ),
  );
  for (const g of letters) {
    const n = (st.groups[g] ?? []).length;
    const k = surveyOfGroup(g);
    row.append(
      h('button', {
        type: 'button',
        class: `gchip${(grouping || clickAction === 'add') && g === pickGroup ? ' picking' : ''}`,
        'aria-pressed': String((grouping || clickAction === 'add') && g === pickGroup),
        title: `Select group ${g}: shows it, and Add puts timeline clicks into it`,
        onclick: () => select(g),
      },
        h('span', { class: 'gchip-letter' }, g),
        h('span', { class: 'gchip-text' }, n ? `${n} ${k ? SURVEY_NAME[k] : ''}` : 'empty'),
      ),
    );
  }
  const next = [...LETTERS].find((c) => !letters.includes(c));
  if (next) row.append(h('button', { type: 'button', class: 'gchip add', title: 'Start a new group', onclick: () => select(next) }, '+ New'));
  el.append(row);

  // 2. Display: stack the group being edited, or subtract one group from another.
  const canSubtract = filled.some((g) => partnersOf(g).length);
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Display' },
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(grouping && !subtracting), onclick: () => (filled.length ? setShow([pickGroup, null]) : enterGroups()) }, 'Stack'),
    h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(subtracting), disabled: !canSubtract,
      title: canSubtract ? 'Show one group minus another' : 'Needs two groups from the same survey',
      onclick: () => {
        const first = partnersOf(pickGroup).length ? pickGroup : filled.find((g) => partnersOf(g).length)!;
        setShow([first, partnersOf(first)[0]]);
      },
    }, 'Subtract'),
  );
  const show = h('div', { class: 'show' }, seg);
  // The subtract menus and Clear always take their space (hidden when unused), so switching
  // between Stack and Subtract never moves the buttons.
  {
    const menu = (value: string, options: string[], aria: string, onChange: (v: string) => void) => {
      const sel = h('select', { 'aria-label': aria, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
        ...options.map((g) => h('option', { value: g }, g))) as HTMLSelectElement;
      sel.value = value;
      return sel;
    };
    const g1 = subtracting ? st.show[0] : pickGroup;
    const g2 = subtracting ? (st.show[1] as string) : partnersOf(pickGroup)[0] ?? '';
    const pair = h('span', { class: 'pair', hidden: null, style: subtracting ? '' : 'visibility:hidden', 'aria-hidden': subtracting ? null : 'true' },
      menu(g1, filled.length ? filled : [pickGroup], 'Group to show', (v) => setShow([v, partnersOf(v).includes(g2) ? g2 : partnersOf(v)[0] ?? null])),
      h('span', { class: 'minus', 'aria-hidden': 'true' }, '−'),
      menu(g2, partnersOf(g1).length ? partnersOf(g1) : [g2 || '–'], 'Group to subtract', (v) => setShow([g1, v])),
    );
    show.append(pair);
  }
  show.append(h('button', {
    type: 'button', class: 'btn small ghost', title: 'Remove every group',
    style: filled.length ? '' : 'visibility:hidden',
    onclick: () => {
      pickGroup = 'A';
      store.set(groupPatch({}, ['A', null]));
    },
  }, 'Clear'));
  el.append(show);
}

const TRACKS: { kind: Frame['kind']; label: string; color: string; tip: string }[] = [
  { kind: 'wise', label: 'WISE', color: 'var(--wise)', tip: 'NASA WISE / NEOWISE infrared sky survey, one image every six months, 2010–2024 (via WiseView)' },
  { kind: 'ps1', label: 'Pan-STARRS', color: 'var(--ps1)', tip: 'Pan-STARRS optical survey from Hawaii, 2010–2014, one image per observing season' },
  { kind: 'spherex', label: 'SPHEREx', color: 'var(--spx)', tip: 'NASA SPHEREx, 102 infrared colours. Each block is one visit: the weeks in which the telescope scanned across this spot.' },
];

const render = rafThrottle((): void => {
  const s = store.session;
  const st = store.state;
  clear(root);
  const end = axisEnd();
  const breakX = SPLIT + GAP / 2;

  // Many monthly visits (deep fields) need slimmer blocks so they do not overlap.
  const spxMin = s.frames.filter((f) => f.kind === 'spherex').length > 8 ? 8 : 14;
  for (const tr of TRACKS) {
    const frames = s.frames.filter((f) => f.kind === tr.kind);
    root.append(
      h('div', { class: 'tl-label', title: tr.tip }, h('i', { style: `background:${tr.color};${tr.kind === 'wise' ? 'border-radius:50%' : tr.kind === 'ps1' ? 'transform:rotate(45deg) scale(.85)' : 'border-radius:2px'}` }), tr.label, frames.length ? h('span', { class: 'n' }, String(frames.length)) : null),
    );
    const track = h('div', { class: 'tl-track', role: 'group', 'aria-label': `${tr.label} frames` });
    track.append(h('span', { class: 'tl-break', style: `left:${breakX * 100}%` }));
    if (!frames.length) track.append(quietNote(tr.kind));
    for (const f of frames) {
      const x0 = xOf(f.mjd0),
        x1 = xOf(f.mjd1);
      const grp = groupOf(f.id);
      const empty = f.kind === 'spherex' && !s.stacks.has(f.id);
      const current = st.mode === 'blink' && st.frame === f.id;
      const b = h('button', {
        type: 'button',
        class: `tl-f ${f.kind}${empty ? ' empty' : ''}`,
        style: f.kind === 'spherex' ? `left:${x0 * 100}%;width:max(${spxMin}px, calc(${(x1 - x0) * 100}% - 2px))` : `left:${x0 * 100}%`,
        'aria-current': current ? 'true' : null,
        'aria-label': `${f.label}${grp ? `, in group ${grp}` : ''}`,
        title: `${f.label} · ${f.kind === 'spherex' ? `${mjdIso(f.mjd0)} to ${mjdIso(f.mjd1)}` : mjdIso(f.mjd)}${empty && s.status === 'ok' ? ' · no exposures in this wavelength range' : ''}`,
        onclick: (e: MouseEvent) => onFrameClick(e, f.id),
      }, h('i'), grp ? h('span', { class: `tag ${grp === st.show[1] ? 'b' : 'a'}` }, grp) : null);
      track.append(b);
    }
    root.append(track);
  }

  // Axis.
  root.append(h('div', { class: 'tl-label' }));
  const axis = h('div', { class: 'tl-track axis', 'aria-hidden': 'true' });
  for (let y = 2010; y <= 2024; y += 2) axis.append(h('span', { class: `tl-tick${y % 4 === 2 ? '' : ' minor'}`, style: `left:${xOf(yearToMjd(y)) * 100}%` }, String(y)));
  for (let y = BREAK_YEAR; y < end; y += 0.5) {
    const whole = Math.abs(y - Math.round(y)) < 1e-6;
    if (y === BREAK_YEAR) {
      axis.append(h('span', { class: 'tl-tick', style: `left:${(SPLIT + GAP) * 100}%;transform:none` }, '2025'));
      continue;
    }
    axis.append(h('span', { class: `tl-tick${whole ? '' : ' minor'}`, style: `left:${xOf(yearToMjd(y)) * 100}%` }, whole ? String(Math.round(y)) : 'Jul'));
  }
  root.append(axis);
});


function quietNote(kind: Frame['kind']): HTMLElement {
  const s = store.session;
  if (kind === 'spherex') {
    return h('span', { class: `tl-quiet${s.status === 'loading' ? ' skel' : ''}`, style: `left:${(SPLIT + GAP) * 100}%` }, s.status === 'loading' ? '' : s.status === 'empty' ? 'No SPHEREx exposures here yet' : '');
  }
  const hs = s.history;
  if (hs.status === 'loading' || hs.status === 'idle') return h('span', { class: 'tl-quiet skel' });
  if (hs.status === 'empty' && hs.message) return h('span', { class: 'tl-quiet' }, kind === 'wise' ? hs.message : '');
  // An archive that did not answer leaves its track empty, without a message.
  if (hs.status === 'error') return h('span', { class: 'tl-quiet' });
  const note = hs.data.notes.find((n) => (kind === 'ps1' ? /pan-?starrs|ps1/i.test(n) : /wise/i.test(n)));
  if (note && /unavailable/i.test(note)) return h('span', { class: 'tl-quiet' });
  if (kind === 'ps1' && !note && (store.state.dec ?? 0) < -30) return h('span', { class: 'tl-quiet' }, 'No Pan-STARRS coverage south of −30°');
  return h('span', { class: 'tl-quiet' }, note ?? (kind === 'ps1' ? 'No Pan-STARRS frames for this field' : 'No WISE frames for this field'));
}
