// SkyDive viewer — one typed store: URL-synced view state plus the loaded session data.
// Written with AI coding assistance (Claude Code).
import type {
  Exposure,
  Fov,
  Frame,
  HistFrame,
  Mode,
  Neossat,
  OverlaySource,
  PhotPoint,
  SsoObject,
  StackResult,
  Status,
  Visit,
} from './types';
import { MASK_WORD, WL_MAX, WL_MIN } from './types';

/** Everything that is restored from, and written to, the query string. */
export interface ViewState {
  ra: number | null;
  dec: number | null;
  fov: Fov;
  wl: [number, number];
  matched: boolean;
  mode: Mode;
  /** The frames the stacker combines (A) and subtracts (B); derived from `groups` and `show`. */
  a: string[];
  b: string[];
  /** Named frame groups, letters A to Z, each a list of frame ids from one survey. */
  groups: Record<string, string[]>;
  /** What to display: one group stacked ([g, null]) or one group minus another ([g1, g2]). */
  show: [string, string | null];
  frame: string | null;
  playing: boolean;
  /** Milliseconds per frame. */
  speed: number;
  stretch: 'asinh' | 'linear';
  invert: boolean;
  /** Black and white points as percentiles of the shared pixel distribution. */
  range: [number, number];
  ov: string[];
  /** Marker emphasis: only real movers at full size, or every catalogue source. */
  marks: 'movers' | 'all';
  wiseBand: 'W1' | 'W2';
  /** Excluded exposure ids. */
  excluded: string[];
  src: { ra: number; dec: number } | null;
  embed: boolean;
  /** How many exposures to load (most recent first). */
  cap: number;
}

export const DEFAULTS: ViewState = {
  ra: null,
  dec: null,
  fov: 6.5,
  wl: [WL_MIN, WL_MAX],
  matched: true,
  mode: 'blink',
  a: [],
  b: [],
  groups: {},
  show: ['A', null],
  frame: null,
  // Open on the most recent frame, still; Blink plays only when asked.
  playing: false,
  speed: 500,
  stretch: 'asinh',
  invert: false,
  range: [30, 99.7],
  ov: [],
  marks: 'movers',
  wiseBand: 'W2',
  excluded: [],
  src: null,
  embed: false,
  cap: 600,
};

export const OVERLAY_KEYS = ['gaia', 'catwise', 'vsx', 'sso', 'flags'] as const;

export interface Soft<T> {
  status: Status;
  data: T;
  message?: string;
}

/** Loaded data for the current field. Replaced wholesale on every new field. */
export interface Session {
  token: number;
  status: Status;
  error?: string;
  errorKind?: 'network' | 'empty' | 'other';
  source: 'baked' | 'live' | 'demo' | null;
  bakedName?: string;
  bakedNote?: string;
  bakedBlurb?: string;
  nPx: number;
  resolvedName?: string;
  exposures: Exposure[];
  /** Exposures the service knows about, including those beyond the cap. */
  totalAvailable: number;
  visits: Visit[];
  releases: string[];
  flagNames: Record<string, string>;
  /** Flag bits treated as bad when stacking. */
  maskWord: number;
  progress: { done: number; total: number; failed: number };
  history: Soft<{ frames: HistFrame[]; notes: string[] }>;
  overlay: Soft<{ sources: OverlaySource[]; warnings: string[]; notes: string[] }>;
  sso: Soft<{ objects: SsoObject[]; note: string }>;
  neossat: Soft<Neossat | null>;
  frames: Frame[];
  /** Per-visit stacks keyed by frame id. */
  stacks: Map<string, StackResult>;
  /** Combined A (+B) and B stacks for sum / diff. */
  comboA: StackResult | null;
  comboB: StackResult | null;
  /** Sorted pooled sample of stack pixel values, for percentiles. */
  sample: Float32Array | null;
  /** How wavelengths were matched for the current stacks. */
  matchNote: string;
  selectedCount: number;
  usableCount: number;
  /** `halo`: the core is saturated, so the values are the uncalibrated brightness of the PSF ring. */
  phot: { status: Status; points: PhotPoint[]; x: number; y: number; halo?: boolean } | null;
  saturatedFrac: number | null;
  cursor: Cursor | null;
}

export interface Cursor {
  ra: number;
  dec: number;
  value: number | null;
  unit: string;
  wave: string;
  flags: { name: string; count: number; masked: boolean }[];
  nExp: number;
}

export function emptySession(token: number): Session {
  return {
    token,
    status: 'idle',
    source: null,
    nPx: 64,
    exposures: [],
    totalAvailable: 0,
    visits: [],
    releases: [],
    flagNames: {},
    maskWord: MASK_WORD,
    progress: { done: 0, total: 0, failed: 0 },
    history: { status: 'idle', data: { frames: [], notes: [] } },
    overlay: { status: 'idle', data: { sources: [], warnings: [], notes: [] } },
    sso: { status: 'idle', data: { objects: [], note: '' } },
    neossat: { status: 'idle', data: null },
    frames: [],
    stacks: new Map(),
    comboA: null,
    comboB: null,
    sample: null,
    matchNote: '',
    selectedCount: 0,
    usableCount: 0,
    phot: null,
    saturatedFrac: null,
    cursor: null,
  };
}

export type Topic =
  | 'state'
  | 'session'
  | 'progress'
  | 'frames'
  | 'stacks'
  | 'history'
  | 'overlay'
  | 'sso'
  | 'neossat'
  | 'phot'
  | 'cursor'
  | 'placed'
  | 'toast';

type Listener = (keys: Set<string>) => void;

class Store {
  state: ViewState = { ...DEFAULTS };
  session: Session = emptySession(0);
  private listeners = new Map<Topic, Listener[]>();
  private urlTimer = 0;

  on(topic: Topic | Topic[], fn: Listener): void {
    for (const t of Array.isArray(topic) ? topic : [topic]) {
      if (!this.listeners.has(t)) this.listeners.set(t, []);
      this.listeners.get(t)!.push(fn);
    }
  }

  emit(topic: Topic, keys: Set<string> = new Set()): void {
    for (const fn of this.listeners.get(topic) ?? []) fn(keys);
  }

  set(patch: Partial<ViewState>, opts: { push?: boolean } = {}): void {
    const keys = new Set<string>();
    for (const k of Object.keys(patch) as (keyof ViewState)[]) {
      if (!same(this.state[k], patch[k])) {
        (this.state as unknown as Record<string, unknown>)[k] = patch[k];
        keys.add(k);
      }
    }
    if (!keys.size) return;
    this.emit('state', keys);
    this.scheduleUrl(opts.push === true);
  }

  private pendingPush = false;
  private scheduleUrl(push: boolean): void {
    this.pendingPush ||= push;
    clearTimeout(this.urlTimer);
    this.urlTimer = window.setTimeout(() => this.flushUrl(), push ? 0 : 150);
  }

  flushUrl(): void {
    clearTimeout(this.urlTimer);
    const qs = serialize(this.state);
    const url = location.pathname + (qs ? '?' + qs : '');
    if (url !== location.pathname + location.search || location.hash) {
      if (this.pendingPush) history.pushState(null, '', url);
      else history.replaceState(null, '', url);
    }
    this.pendingPush = false;
  }

  shareUrl(extra: Record<string, string> = {}): string {
    const p = new URLSearchParams(serialize(this.state));
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `${location.origin}${location.pathname}?${p.toString().replace(/%2C/g, ',')}`;
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

const num = (v: number, d: number) => String(+v.toFixed(d));

/** Frame ids in the URL: bare numbers are SPHEREx visits (PLAN.md), w3 / p1 are WISE / Pan-STARRS. */
const idOut = (id: string) => (id[0] === 's' ? id.slice(1) : id);
const idIn = (s: string) => (/^\d+$/.test(s) ? 's' + s : s);

/**
 * State patch for a set of groups and a display choice: fills the stacker's A and B from the
 * chosen groups and picks the matching mode (stack for one group, difference for two).
 */
export function groupPatch(groups: Record<string, string[]>, show: [string, string | null]): Partial<ViewState> {
  const clean: Record<string, string[]> = {};
  for (const k of Object.keys(groups).sort()) clean[k] = [...groups[k]];
  const g1 = show[0], g2 = show[1] && show[1] !== show[0] ? show[1] : null;
  return { groups: clean, show: [g1, g2], a: clean[g1] ?? [], b: g2 ? clean[g2] ?? [] : [], mode: g2 ? 'diff' : 'sum', playing: false };
}

export function serialize(s: ViewState): string {
  if (s.ra == null || s.dec == null) return '';
  const p: string[] = [];
  const add = (k: string, v: string) => p.push(`${k}=${encodeURIComponent(v).replace(/%2C/g, ',')}`);
  add('ra', num(s.ra, 6));
  add('dec', num(s.dec, 6));
  add('fov', String(s.fov));
  if (s.wl[0] !== DEFAULTS.wl[0] || s.wl[1] !== DEFAULTS.wl[1]) add('wl', `${num(s.wl[0], 3)}-${num(s.wl[1], 3)}`);
  if (!s.matched) add('mw', '0');
  if (s.mode !== 'blink') add('mode', s.mode);
  const gs = Object.entries(s.groups).filter(([, v]) => v.length);
  if (gs.length) {
    add('g', gs.map(([k, v]) => `${k}:${v.map(idOut).join('.')}`).join(','));
    add('show', s.show[1] ? `${s.show[0]}-${s.show[1]}` : s.show[0]);
  }
  if (s.frame && !s.playing) add('f', idOut(s.frame));
  if (s.playing) add('play', '1');
  if (s.speed !== DEFAULTS.speed) add('speed', String(Math.round(s.speed)));
  if (s.stretch !== 'asinh') add('stretch', s.stretch);
  if (s.invert) add('inv', '1');
  if (!same(s.range, DEFAULTS.range)) add('range', `${num(s.range[0], 1)}-${num(s.range[1], 2)}`);
  if (!same(s.ov, DEFAULTS.ov)) add('ov', s.ov.join(',') || 'none');
  if (s.marks === 'all') add('mk', 'all');
  if (s.wiseBand !== 'W2') add('band', s.wiseBand.toLowerCase());
  if (s.excluded.length) add('x', s.excluded.join(','));
  if (s.src) add('src', `${num(s.src.ra, 5)},${num(s.src.dec, 5)}`);
  if (s.cap !== DEFAULTS.cap) add('cap', String(s.cap));
  if (s.embed) add('embed', '1');
  return p.join('&');
}

export function deserialize(search: string, hash: string): ViewState {
  const s: ViewState = { ...DEFAULTS, a: [], b: [], groups: {}, show: ['A', null], excluded: [], ov: [...DEFAULTS.ov] };
  const p = new URLSearchParams(search);
  // WiseView-style #ra=&dec= links.
  if (!p.has('ra') && /ra=/.test(hash)) {
    const h = new URLSearchParams(hash.replace(/^#\/?\??/, ''));
    if (h.has('ra') && h.has('dec')) {
      p.set('ra', h.get('ra')!);
      p.set('dec', h.get('dec')!);
    }
  }
  const f = (k: string) => {
    const v = parseFloat(p.get(k) ?? '');
    return isFinite(v) ? v : null;
  };
  const ra = f('ra'),
    dec = f('dec');
  if (ra != null && dec != null && ra >= 0 && ra <= 360 && dec >= -90 && dec <= 90) {
    s.ra = ra % 360;
    s.dec = dec;
  }
  const fov = f('fov');
  if (fov === 4 || fov === 6.5 || fov === 13 || fov === 26) s.fov = fov;
  const pair = (k: string): [number, number] | null => {
    const m = (p.get(k) ?? '').match(/^([\d.]+)-([\d.]+)$/);
    if (!m) return null;
    const a = parseFloat(m[1]),
      b = parseFloat(m[2]);
    return isFinite(a) && isFinite(b) && a < b ? [a, b] : null;
  };
  const wl = pair('wl');
  if (wl) s.wl = [Math.max(WL_MIN, wl[0]), Math.min(WL_MAX, wl[1])];
  if (p.get('mw') === '0') s.matched = false;
  const mode = p.get('mode');
  if (mode === 'sum' || mode === 'diff' || mode === 'blink') s.mode = mode;
  const list = (k: string) => (p.get(k) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  // Groups: g=A:3.4.5,B:w1.w2 and show=A or show=A-B. Older links carry a= and b= instead.
  const groups: Record<string, string[]> = {};
  for (const part of list('g')) {
    const m = part.match(/^([A-Z]):(.+)$/);
    if (m) groups[m[1]] = m[2].split('.').filter(Boolean).map(idIn);
  }
  if (!Object.keys(groups).length) {
    if (list('a').length) groups.A = list('a').map(idIn);
    if (list('b').length) groups.B = list('b').map(idIn);
  }
  const sh = (p.get('show') ?? '').match(/^([A-Z])(?:-([A-Z]))?$/);
  const show: [string, string | null] = sh ? [sh[1], sh[2] ?? null] : s.mode === 'diff' ? ['A', 'B'] : ['A', null];
  if (Object.keys(groups).length) {
    const g = groupPatch(groups, show);
    s.groups = g.groups!;
    s.show = g.show!;
    s.a = g.a!;
    s.b = g.b!;
    if (s.mode !== 'blink') s.mode = g.mode!;
  } else if (s.mode !== 'blink') s.mode = 'blink';
  if (p.get('f')) s.frame = idIn(p.get('f')!);
  if (p.get('play') === '1') s.playing = true;
  const speed = f('speed');
  if (speed != null) s.speed = Math.min(4000, Math.max(100, speed));
  if (p.get('stretch') === 'linear') s.stretch = 'linear';
  if (p.get('inv') === '1') s.invert = true;
  const range = pair('range');
  if (range) s.range = [Math.max(0, range[0]), Math.min(100, range[1])];
  if (p.has('ov')) s.ov = list('ov').filter((x) => (OVERLAY_KEYS as readonly string[]).includes(x));
  if (p.get('mk') === 'all') s.marks = 'all';
  if (p.get('band') === 'w1') s.wiseBand = 'W1';
  s.excluded = list('x');
  const src = (p.get('src') ?? '').split(',').map(parseFloat);
  if (src.length === 2 && src.every(isFinite)) s.src = { ra: src[0], dec: src[1] };
  const cap = f('cap');
  if (cap != null && cap >= 1) s.cap = Math.min(6000, Math.round(cap));
  if (p.get('embed') === '1') s.embed = true;
  return s;
}

export const store = new Store();
