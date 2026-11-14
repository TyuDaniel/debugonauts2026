// SkyDive viewer — data layer: baked files first, then the live backend; progressive cutout
// batches; side panels load in parallel and fail soft. Written with AI coding assistance (Claude Code).
import { ApiError, apiBin, apiJson, bakedBin, bakedIndex, bakedJson, findBaked, isSynthetic } from './api';
import { requestRestack } from './compute';
import { decodeCutouts, parseSkyb, type HistoryHeader } from './skyb';
import { stacker } from './stackClient';
import { emptySession, store, type Session } from './store';
import { FOV_NPX, SPHEREX_SCALE, type BakedField, type Exposure, type Frame, type HistFrame, type Neossat, type OverlaySource, type SsoObject, type Visit } from './types';
import { mjdMonth, sepArcsec } from './coords';


const BATCH = 32;
const IN_FLIGHT = 3;

interface ExposuresResponse {
  releases?: string[];
  exposures: (Partial<Exposure> & { id: string; mjd: number; detector: number })[];
  visits?: Visit[];
  capped?: boolean;
  total?: number;
}

let token = 0;
let nextIdx = 0;

export async function loadField(): Promise<void> {
  const { ra, dec, fov } = store.state;
  if (ra == null || dec == null) return;
  const t = ++token;
  const nPx = FOV_NPX[String(fov)];
  const s = (store.session = emptySession(t));
  s.status = 'loading';
  s.nPx = nPx;
  nextIdx = 0;
  stacker.reset(nPx);
  store.emit('session');
  store.emit('frames');
  const alive = () => store.session.token === t;

  const baked = findBaked(await bakedIndex(), ra, dec, nPx);
  if (!alive()) return;
  if (baked && sepArcsec(ra, dec, baked.ra, baked.dec) > 0.01) {
    // Snap to the prepared field's exact centre; the state change reloads through the normal path.
    store.set({ ra: baked.ra, dec: baked.dec });
    return;
  }
  if (baked) {
    s.bakedName = baked.name;
    s.bakedNote = baked.note;
    s.bakedBlurb = baked.blurb;
  }
  const q = `ra=${ra}&dec=${dec}`;
  const arcsec = +(nPx * SPHEREX_SCALE).toFixed(2);
  const dir = baked ? `${baked.key}/${nPx}/` : '';

  // Side data: never blocks the SPHEREx movie.
  if (nPx >= 256 && !baked) {
    // 66 MB of history at the 26' field: not worth the wait.
    s.history = { status: 'empty', data: { frames: [], notes: [] }, message: 'History is not loaded at this field size. Choose 13′ or smaller to see WISE and Pan-STARRS.' };
    store.emit('history');
  } else void loadHistory(s, baked, dir, `/api/history?${q}&arcsec=${arcsec}`);
  void loadOverlay(s, baked, dir, `/api/overlay?${q}&arcsec=${arcsec}`);
  void loadNeossat(s, baked, `/api/neossat?${q}`);

  try {
    let resp: ExposuresResponse | null = null;
    let fromBaked = false;
    if (baked) {
      try {
        resp = await bakedJson<ExposuresResponse>(dir + 'exposures.json');
        fromBaked = true;
      } catch {
        resp = null;
      }
    }
    resp ??= await apiJson<ExposuresResponse>(`/api/exposures?${q}`);
    if (!alive()) return;
    s.source = fromBaked ? 'baked' : isSynthetic ? 'demo' : 'live';
    s.releases = resp.releases ?? [];
    s.visits = (resp.visits ?? []).slice().sort((a, b) => a.mjd_start - b.mjd_start);
    s.exposures = resp.exposures
      .map((e) => normalise(e, s.visits))
      .sort((a, b) => a.mjd - b.mjd);
    if (!s.visits.length) s.visits = deriveVisits(s.exposures);
    s.totalAvailable = Math.max(s.exposures.length, resp.total ?? 0);
    rebuildFrames(s);
    if (!s.exposures.length) {
      s.status = 'empty';
      store.emit('session');
      return;
    }
    store.emit('session');

    let bakedOk = false;
    if (fromBaked) {
      try {
        s.progress.total = s.exposures.length;
        store.emit('progress');
        const buf = await bakedBin(dir + 'cutouts.bin', (f) => {
          if (!alive()) return;
          s.progress.done = Math.round(f * s.progress.total * 0.9);
          store.emit('progress');
        });
        if (!alive()) return;
        ingest(s, buf, true);
        bakedOk = true;
        s.progress.total = s.exposures.filter((e) => e.loaded).length;
        s.progress.done = s.progress.total;
        store.emit('progress');
      } catch (e) {
        if (!alive()) return;
        s.source = 'live';
      }
    }
    if (!bakedOk && !isSynthetic) {
      // A field opened before (by anyone) comes back from the backend's cache in one download.
      try {
        const buf = await apiBin(`/api/bundle?${q}&n_px=${s.nPx}`, undefined, 60000);
        if (!alive()) return;
        if (buf.byteLength) {
          ingest(s, buf);
          store.emit('progress');
          requestRestack(false);
        }
      } catch (e) {
        // No bundle only means every exposure is fetched in batches as before.
        console.warn('Cached bundle unavailable', e);
      }
    }
    if (!bakedOk) await loadBatches(s, alive, store.state.cap);
    if (!alive()) return;
    if (!s.exposures.some((e) => e.loaded && e.ok)) {
      throw new ApiError(
        s.exposures.find((e) => e.error)?.error ?? 'No exposure could be read for this position.',
        'http',
      );
    }
    s.status = 'ok';
    store.emit('session');
    requestRestack(true);
    ssoArgs = { s, baked, q, arcsec };
    ensureSso();
  } catch (e) {
    if (!alive()) return;
    s.status = 'error';
    s.errorKind = e instanceof ApiError && e.kind === 'network' ? 'network' : 'other';
    s.error = e instanceof ApiError ? e.message : 'Something went wrong while loading this field.';
    if (!(e instanceof ApiError)) console.error(e);
    store.emit('session');
  }
}

let ssoArgs: { s: Session; baked: BakedField | null; q: string; arcsec: number } | null = null;
/** Asteroid lookups run in the background once the field has loaded, so the overlay count is always known. */
export function ensureSso(): void {
  const a = ssoArgs;
  if (!a || a.s !== store.session || a.s.sso.status !== 'idle') return;
  void loadSso(a.s, a.baked, a.q, a.arcsec);
}

/** Load the next block of older exposures (deep fields). */
export async function loadMore(): Promise<void> {
  const s = store.session;
  if (s.status !== 'ok') return;
  const t = s.token;
  s.status = 'loading';
  store.emit('session');
  let failed = false;
  try {
    if (s.totalAvailable > s.exposures.length) {
      // A prepared deep field lists only what was baked: ask the live service for the rest.
      const { ra, dec } = store.state;
      const resp = await apiJson<ExposuresResponse>(`/api/exposures?ra=${ra}&dec=${dec}`);
      if (store.session.token !== t) return;
      const known = new Set(s.exposures.map((e) => e.id));
      const visits = (resp.visits ?? []).slice().sort((a, b) => a.mjd_start - b.mjd_start);
      const extra = resp.exposures.filter((e) => !known.has(e.id)).map((e) => normalise(e, visits));
      if (visits.length) s.visits = visits;
      s.exposures = [...s.exposures, ...extra].sort((a, b) => a.mjd - b.mjd);
      s.totalAvailable = s.exposures.length;
      rebuildFrames(s);
    }
    store.set({ cap: s.exposures.filter((e) => e.loaded).length + 600 });
    await loadBatches(s, () => store.session.token === t, 600);
  } catch {
    failed = true; // keep what we have
  }
  if (failed) store.emit('toast');
  if (store.session.token !== t) return;
  s.status = 'ok';
  store.emit('session');
  requestRestack(true);
}

function normalise(e: ExposuresResponse['exposures'][number], visits: Visit[]): Exposure {
  let visit = typeof e.visit === 'number' ? e.visit : -1;
  if (visit < 0) {
    const v = visits.find((v) => e.mjd >= v.mjd_start - 1e-6 && e.mjd <= v.mjd_end + 1e-6);
    visit = v ? v.id : 0;
  }
  return {
    id: e.id,
    mjd: e.mjd,
    detector: e.detector,
    wave_um: e.wave_um ?? null,
    bw_um: e.bw_um ?? null,
    release: e.release ?? '',
    url: e.url,
    key: e.key,
    visit,
    loaded: false,
    ok: false,
    dwave_dx: 0,
    dwave_dy: 0,
    bg: 0,
    flag_frac: 0,
    idx: -1,
  };
}

function deriveVisits(exps: Exposure[]): Visit[] {
  const out: Visit[] = [];
  for (const e of exps) {
    const last = out[out.length - 1];
    if (!last || e.mjd - last.mjd_end > 30) out.push({ id: out.length, mjd_start: e.mjd, mjd_end: e.mjd, n: 1 });
    else {
      last.mjd_end = e.mjd;
      last.n++;
    }
    e.visit = out.length - 1;
  }
  return out;
}

function ingest(s: Session, buf: ArrayBuffer, fromBaked = false): void {
  const { header, ok, failed } = decodeCutouts(buf);
  if (header.n_px !== s.nPx) throw new ApiError('The data file has an unexpected image size.', 'http');
  if (header.flag_names) Object.assign(s.flagNames, header.flag_names);
  // The backend says which bits it counts as bad; use that rather than our built-in list.
  if (Array.isArray(header.mask_bits) && header.mask_bits.length) {
    const word = header.mask_bits.reduce((m, b) => (b === 21 ? m : (m | (1 << b)) >>> 0), 0);
    if (word !== s.maskWord) {
      s.maskWord = word;
      stacker.setMask(word);
    }
  }
  const byId = new Map(s.exposures.map((e) => [e.id, e]));
  const items: { idx: number; image: Float32Array; flags: Uint32Array }[] = [];
  for (const d of ok) {
    const e = byId.get(d.item.id);
    if (!e || e.loaded) continue;
    e.loaded = true;
    e.ok = true;
    e.idx = nextIdx++;
    if (d.item.mjd != null) e.mjd = d.item.mjd;
    if (d.item.detector != null) e.detector = d.item.detector;
    if (d.item.wave_um != null) e.wave_um = d.item.wave_um;
    if (d.item.bw_um != null) e.bw_um = d.item.bw_um;
    e.dwave_dx = d.item.dwave_dx ?? 0;
    e.dwave_dy = d.item.dwave_dy ?? 0;
    e.bg = d.item.bg ?? 0;
    e.flag_frac = d.item.flag_frac ?? 0;
    items.push({ idx: e.idx, image: d.image, flags: d.flags });
  }
  for (const f of failed) {
    const e = byId.get(f.id);
    if (!e || e.loaded) continue;
    e.loaded = true;
    e.ok = false;
    e.error = f.error ?? 'could not be read';
    if (!fromBaked) s.progress.failed++;
  }
  if (items.length) stacker.add(items);
}

/**
 * Which exposures to fetch next, at most `budget` of those not yet loaded. Deep fields have
 * thousands: rather than the newest N (which can be two months of two detectors), every visit
 * gets an equal share, sampled evenly along wavelength. The result is ordered round-robin over
 * visits so every frame of the movie fills in from the first batch on.
 */
function loadOrder(s: Session, budget: number): Exposure[] {
  const perVisit = new Map<number, Exposure[]>();
  for (const e of s.exposures) {
    if (e.loaded) continue;
    if (!perVisit.has(e.visit)) perVisit.set(e.visit, []);
    perVisit.get(e.visit)!.push(e);
  }
  const lists = [...perVisit.values()].sort((a, b) => a.length - b.length);
  const picked: Exposure[][] = [];
  let left = Math.max(0, budget);
  lists.forEach((l, i) => {
    // Smallest visits first, so what they cannot use is passed on to the larger ones.
    const share = Math.min(l.length, Math.ceil(left / (lists.length - i)));
    left -= share;
    l.sort((a, b) => (a.wave_um ?? a.detector) - (b.wave_um ?? b.detector) || a.mjd - b.mjd);
    const take: Exposure[] = [];
    for (let k = 0; k < share; k++) take.push(l[Math.min(l.length - 1, Math.floor(((k + 0.5) * l.length) / share))]);
    // Spread wavelengths over the load order too, so early frames are not one colour.
    const mixed: Exposure[] = [];
    const stride = 7;
    for (let o = 0; o < stride; o++) for (let j = o; j < take.length; j += stride) mixed.push(take[j]);
    picked.push(mixed);
  });
  picked.sort((a, b) => (b[0]?.mjd ?? 0) - (a[0]?.mjd ?? 0));
  const out: Exposure[] = [];
  for (let i = 0; picked.some((l) => i < l.length); i++) for (const l of picked) if (i < l.length) out.push(l[i]);
  return [...new Set(out)];
}

async function loadBatches(s: Session, alive: () => boolean, budget: number): Promise<void> {
  const { ra, dec } = store.state;
  const queue = loadOrder(s, budget);
  const already = s.exposures.filter((e) => e.loaded).length;
  s.progress.total = already + queue.length;
  s.progress.done = already;
  store.emit('progress');
  const batches: Exposure[][] = [];
  // Small batches first so the first frames appear within a second or two, then full-size ones.
  for (let i = 0, k = 0; i < queue.length; k++) {
    const n = k === 0 ? 4 : k < 3 ? 12 : BATCH;
    batches.push(queue.slice(i, i + n));
    i += n;
  }
  let next = 0;
  let networkFailures = 0;
  let firstError: ApiError | null = null;

  const worker = async () => {
    while (alive() && next < batches.length) {
      const batch = batches[next++];
      const body = { ra, dec, n_px: s.nPx, ids: batch.map((e) => e.id) };
      let done = false;
      for (let attempt = 0; attempt < 2 && !done && alive(); attempt++) {
        try {
          const buf = await apiBin('/api/cutouts', body, 120000);
          if (!alive()) return;
          ingest(s, buf);
          done = true;
        } catch (e) {
          if (e instanceof ApiError) firstError ??= e;
          if (e instanceof ApiError && e.kind === 'network') networkFailures++;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (!alive()) return;
      for (const e of batch) {
        if (!e.loaded) {
          e.loaded = true;
          e.ok = false;
          e.error = 'could not be fetched';
          s.progress.failed++;
        }
      }
      s.progress.done += batch.length;
      store.emit('progress');
      requestRestack(false);
      // The service is plainly down: stop hammering it.
      if (networkFailures >= 4 && !s.exposures.some((e) => e.ok)) {
        next = batches.length;
        throw firstError ?? new ApiError('The data service cannot be reached.', 'network');
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: IN_FLIGHT }, worker));
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (rejected && !s.exposures.some((e) => e.ok)) throw rejected.reason;
}

function softMessage(e: unknown, what: string): string {
  if (e instanceof ApiError && e.kind === 'network') return `${what} unavailable (data service unreachable).`;
  if (e instanceof ApiError && e.status === 404) return `${what} is not available for this field.`;
  return `${what} could not be loaded.`;
}

async function loadHistory(s: Session, baked: BakedField | null, dir: string, path: string): Promise<void> {
  s.history.status = 'loading';
  store.emit('history');
  try {
    let buf: ArrayBuffer | null = null;
    if (baked) buf = await bakedBin(dir + 'history.bin').catch(() => null);
    buf ??= await apiBin(path, undefined, 120000);
    if (store.session !== s) return;
    const { header, offset } = parseSkyb<HistoryHeader>(buf);
    const frames: HistFrame[] = [];
    let off = offset;
    for (const f of header.frames) {
      const n = f.n_px * f.n_px;
      if (off + n * 4 > buf.byteLength) break;
      frames.push({ ...f, data: new Float32Array(buf, off, n) });
      off += n * 4;
    }
    s.history = { status: frames.length ? 'ok' : 'empty', data: { frames, notes: header.notes ?? [] } };
  } catch (e) {
    if (store.session !== s) return;
    s.history = { status: 'error', data: { frames: [], notes: [] }, message: softMessage(e, 'WISE and Pan-STARRS history') };
  }
  rebuildFrames(s);
  store.emit('history');
}

async function loadOverlay(s: Session, baked: BakedField | null, dir: string, path: string): Promise<void> {
  s.overlay.status = 'loading';
  store.emit('overlay');
  type R = { sources: OverlaySource[]; warnings?: string[]; notes?: string[] };
  try {
    let r: R | null = null;
    if (baked) r = await bakedJson<R>(dir + 'overlay.json').catch(() => null);
    const fromBaked = !!r;
    r ??= await apiJson<R>(path, 60000);
    if (store.session !== s) return;
    const apply = (r: R) => {
      s.overlay = {
        status: r.sources?.length ? 'ok' : 'empty',
        data: { sources: r.sources ?? [], warnings: r.warnings ?? [], notes: r.notes ?? [] },
      };
    };
    apply(r);
    // A catalogue was down when this field was prepared: quietly try the live service for it.
    if (fromBaked && r.notes?.some((n) => /unavailable/i.test(n))) {
      const before = r.notes.length;
      void apiJson<R>(path, 60000)
        .then((live) => {
          if (store.session === s && (live.notes?.length ?? 0) < before) {
            apply(live);
            store.emit('overlay');
          }
        })
        .catch(() => {});
    }
  } catch (e) {
    if (store.session !== s) return;
    s.overlay = { status: 'error', data: { sources: [], warnings: [], notes: [] }, message: softMessage(e, 'Catalogue overlays') };
  }
  store.emit('overlay');
}

async function loadNeossat(s: Session, baked: BakedField | null, path: string): Promise<void> {
  s.neossat.status = 'loading';
  store.emit('neossat');
  try {
    let r: Neossat | null = null;
    if (baked) r = await bakedJson<Neossat>(`${baked.key}/neossat.json`).catch(() => null);
    r ??= await apiJson<Neossat>(path, 120000);
    if (store.session !== s) return;
    s.neossat = { status: r.count > 0 ? 'ok' : 'empty', data: { ...r, previews: r.previews ?? [] } };
  } catch (e) {
    if (store.session !== s) return;
    s.neossat = { status: 'error', data: null, message: softMessage(e, 'NEOSSat frames') };
  }
  store.emit('neossat');
}

async function loadSso(s: Session, baked: BakedField | null, q: string, arcsec: number): Promise<void> {
  s.sso.status = 'loading';
  store.emit('sso');
  type R = { objects: SsoObject[]; note?: string };
  try {
    let r: R | null = null;
    if (baked) r = await bakedJson<R>(`${baked.key}/sso.json`).catch(() => null);
    if (!r) {
      // The backend takes at most 12 times. With more than 12 visits, spread them evenly over all
      // visits (taking the first 12 would leave every later visit with no asteroid positions).
      const times: number[] = [];
      const per = Math.max(1, Math.floor(12 / Math.max(1, s.visits.length)));
      const step = Math.max(1, s.visits.length / 12);
      const visits = s.visits.length > 12 ? Array.from({ length: 12 }, (_, i) => s.visits[Math.floor(i * step)]) : s.visits;
      for (const v of visits) {
        const ex = s.exposures.filter((e) => e.visit === v.id && e.ok);
        for (let k = 0; k < per && ex.length; k++) times.push(ex[Math.floor(((k + 0.5) / per) * ex.length)].mjd);
      }
      if (!times.length) throw new ApiError('no times', 'http');
      r = await apiJson<R>(`/api/sso?${q}&arcsec=${arcsec}&mjds=${times.slice(0, 12).map((m) => m.toFixed(4)).join(',')}`, 90000);
    }
    if (store.session !== s) return;
    s.sso = { status: r.objects?.length ? 'ok' : 'empty', data: { objects: r.objects ?? [], note: r.note ?? '' } };
  } catch (e) {
    if (store.session !== s) return;
    s.sso = { status: 'error', data: { objects: [], note: '' }, message: softMessage(e, 'Asteroid positions') };
  }
  store.emit('sso');
}

/** Merge SPHEREx visits and history frames into the one chronological frame list. */
export function rebuildFrames(s: Session): void {
  const frames: Frame[] = [];
  for (const v of s.visits) {
    const mid = (v.mjd_start + v.mjd_end) / 2;
    frames.push({ id: 's' + v.id, kind: 'spherex', mjd: mid, mjd0: v.mjd_start, mjd1: v.mjd_end, label: `SPHEREx ${mjdMonth(mid)}`, visit: v.id });
  }
  const wise = s.history.data.frames.filter((f) => f.survey === 'wise').sort((a, b) => a.mjd - b.mjd);
  let group: Frame | null = null;
  let nW = 0;
  for (const f of wise) {
    if (!group || f.mjd - group.mjd0 > 60 || group.hist![f.band]) {
      group = { id: 'w' + nW++, kind: 'wise', mjd: f.mjd, mjd0: f.mjd, mjd1: f.mjd, label: `WISE ${mjdMonth(f.mjd)}`, hist: {} };
      frames.push(group);
    }
    group.hist![f.band] = f;
    group.mjd1 = f.mjd;
  }
  let nP = 0;
  for (const f of s.history.data.frames.filter((f) => f.survey === 'ps1').sort((a, b) => a.mjd - b.mjd)) {
    frames.push({ id: 'p' + nP++, kind: 'ps1', mjd: f.mjd, mjd0: f.mjd, mjd1: f.mjd, label: `Pan-STARRS ${f.band} ${mjdMonth(f.mjd)}`, hist: { [f.band]: f } });
  }
  frames.sort((a, b) => a.mjd - b.mjd);
  s.frames = frames;
  store.emit('frames');
}
