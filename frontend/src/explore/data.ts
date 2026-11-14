// Written with AI assistance (Claude) for the NASA Space Apps 2026 hackathon.
// Loads stars.bin (layout documented in scripts/build_stars.py) and its sidecars.

export const FLAG_RV = 1;
export const FLAG_BD = 2;
export const FLAG_WD = 4;
export const FLAG_COL_EST = 8;
export const FLAG_MAG_EST = 16;
export const FLAG_EXTRA = 32;

export interface StarData {
  n: number;
  nGcns: number;
  /** Epoch of the stored positions, Julian year. */
  epoch: number;
  /** x,y,z per star, parsecs, ICRS axes, at `epoch`. */
  pos: Float32Array;
  /** x,y,z per star, parsecs per year. */
  vel: Float32Array;
  /** Absolute G magnitude times 1000. */
  mag: Int16Array;
  /** BP-RP colour times 1000. */
  col: Int16Array;
  flags: Uint8Array;
}

export interface NamedEntry {
  i: number;
  n: string;
  /** Spectral type. */
  s?: string;
  /** Other names. */
  a?: string;
  w1?: number;
  w2?: number;
  j?: number;
  g?: number;
  hp?: number;
}

export interface BeyondEntry {
  n: string;
  ra: number;
  dec: number;
  pmra: number;
  pmdec: number;
  epoch: number;
  d: number;
  s: string;
  note: string;
}

export interface Meta {
  epoch: number;
  count: number;
  n_gcns: number;
  counts: Record<string, number>;
  named: NamedEntry[];
  labels: { i: number; k: 'showcase' | 'famous' }[];
  showcase: { n: string; i?: number; beyond?: number }[];
  beyond: BeyondEntry[];
  regions: { n: string; ra: number; dec: number; d: number }[];
}

async function fetchWithProgress(url: string, onProgress: (fraction: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  // Content-Length is the compressed size when the server compresses, so only trust it otherwise.
  const encoded = !!res.headers.get('content-encoding');
  if (!res.body || !total || encoded) return res.arrayBuffer();
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > total) return (await fetch(url)).arrayBuffer();
    out.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return out.buffer;
}

export async function loadStars(onProgress: (fraction: number) => void): Promise<StarData> {
  const buf = await fetchWithProgress('/stars.bin', onProgress);
  const head = new DataView(buf, 0, 32);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 8));
  if (magic !== 'SKYSTAR1') throw new Error('stars.bin: unexpected file format');
  const n = head.getUint32(8, true);
  const nGcns = head.getUint32(12, true);
  const epoch = head.getFloat32(16, true);
  if (buf.byteLength !== 32 + 29 * n) throw new Error('stars.bin: truncated');
  return {
    n,
    nGcns,
    epoch,
    pos: new Float32Array(buf, 32, 3 * n),
    vel: new Float32Array(buf, 32 + 12 * n, 3 * n),
    mag: new Int16Array(buf, 32 + 24 * n, n),
    col: new Int16Array(buf, 32 + 26 * n, n),
    flags: new Uint8Array(buf, 32 + 28 * n, n),
  };
}

export async function loadMeta(): Promise<Meta> {
  const res = await fetch('/stars-meta.json');
  if (!res.ok) throw new Error(`stars-meta.json: HTTP ${res.status}`);
  return res.json();
}

/** Gaia EDR3 source ids for stars [0, nGcns). Loaded after first paint; 2.6 MB. */
export async function loadIds(): Promise<BigUint64Array> {
  const res = await fetch('/stars-ids.bin');
  if (!res.ok) throw new Error(`stars-ids.bin: HTTP ${res.status}`);
  return new BigUint64Array(await res.arrayBuffer());
}

export interface BakedField {
  key: string;
  name: string;
  ra: number;
  dec: number;
}

/** Pre-baked viewer fields, if the viewer has published any. Never throws. */
export async function loadBakedFields(): Promise<BakedField[]> {
  try {
    const res = await fetch('/baked/index.json');
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.fields) ? json.fields.filter((f: BakedField) => Number.isFinite(f?.ra) && Number.isFinite(f?.dec)) : [];
  } catch {
    return [];
  }
}
