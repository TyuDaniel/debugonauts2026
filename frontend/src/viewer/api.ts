// SkyDive viewer — thin HTTP layer for the backend and the baked static files.
// Written with AI coding assistance (Claude Code).
import type { BakedField } from './types';
import { sepArcsec } from './coords';

export class ApiError extends Error {
  constructor(
    message: string,
    public kind: 'network' | 'http' | 'missing',
    public status = 0,
  ) {
    super(message);
  }
}

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const BAKED = `${import.meta.env.BASE_URL}baked/`;

/** Dev-only synthetic backend (`?synth=1`), so the UI can be built before real data exists. */
const SYNTH = import.meta.env.DEV && new URLSearchParams(location.search).get('synth') === '1';
type Synth = (path: string, body?: unknown) => Promise<unknown>;
let synthMod: Promise<{ synth: Synth }> | null = null;
function synth(path: string, body?: unknown): Promise<unknown> {
  synthMod ??= import('./dev-synth');
  return synthMod.then((m) => m.synth(path, body));
}
export const isSynthetic = SYNTH;

async function request(url: string, init?: RequestInit, timeoutMs = 90000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new ApiError(
      ctl.signal.aborted ? 'The data service took too long to answer.' : 'The data service cannot be reached.',
      'network',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.clone().json();
      if (typeof j?.detail === 'string') detail = j.detail;
      else if (Array.isArray(j?.detail)) detail = 'The request was not understood by the data service.';
    } catch {
      /* not JSON */
    }
    // A dev proxy or gateway answering 5xx without our JSON shape means the backend itself is down.
    if (!detail && res.status >= 500) throw new ApiError('The data service cannot be reached.', 'network', res.status);
    throw new ApiError(detail || `The data service answered with an error (${res.status}).`, 'http', res.status);
  }
  return res;
}

export async function apiJson<T>(path: string, timeoutMs?: number): Promise<T> {
  if (SYNTH) return (await synth(path)) as T;
  const res = await request(BASE + path, undefined, timeoutMs);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('The data service sent an unreadable answer.', 'http', res.status);
  }
}

export async function apiBin(path: string, body?: unknown, timeoutMs?: number): Promise<ArrayBuffer> {
  if (SYNTH) return (await synth(path, body)) as ArrayBuffer;
  const res = await request(
    BASE + path,
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    timeoutMs,
  );
  return res.arrayBuffer();
}

/** Static baked file. A missing file (or an SPA fallback page) is reported as `missing`. */
async function bakedFetch(rel: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BAKED + rel);
  } catch {
    throw new ApiError('Baked file unreachable', 'network');
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || type.includes('text/html')) throw new ApiError('Baked file missing', 'missing', res.status);
  return res;
}

export async function bakedJson<T>(rel: string): Promise<T> {
  const res = await bakedFetch(rel);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('Baked file unreadable', 'missing');
  }
}

/** Fetch a baked binary, reporting download progress as a fraction when the size is known. */
export async function bakedBin(rel: string, onProgress?: (frac: number) => void): Promise<ArrayBuffer> {
  const res = await bakedFetch(rel);
  const total = Number(res.headers.get('content-length') ?? 0);
  const encoded = res.headers.get('content-encoding');
  if (!res.body || !onProgress || !total || encoded) return res.arrayBuffer();
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > total) return concat(out.subarray(0, got), value, reader);
    out.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return out.buffer.slice(0, got);
}

async function concat(head: Uint8Array, next: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ArrayBuffer> {
  const parts = [head, next];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
}

let indexPromise: Promise<BakedField[]> | null = null;
export function bakedIndex(): Promise<BakedField[]> {
  if (SYNTH) return Promise.resolve([]);
  indexPromise ??= bakedJson<{ fields: BakedField[] }>('index.json')
    .then((j) => (Array.isArray(j.fields) ? j.fields : []))
    .catch(() => []);
  return indexPromise;
}

/**
 * A baked field matches when the centre is within 20" and the pixel size is listed; the caller
 * then snaps the view to the baked centre (so slightly different published coordinates still
 * get the prepared field).
 */
export function findBaked(fields: BakedField[], ra: number, dec: number, nPx: number): BakedField | null {
  let best: BakedField | null = null;
  let bestSep = 20;
  for (const f of fields) {
    if (!f.n_px?.includes(nPx)) continue;
    const sep = sepArcsec(ra, dec, f.ra, f.dec);
    if (sep <= bestSep) {
      best = f;
      bestSep = sep;
    }
  }
  return best;
}
