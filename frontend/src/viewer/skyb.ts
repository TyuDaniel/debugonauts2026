// SkyDive viewer — parser for the "SKYB" binary frame container (docs/API.md).
// Written with AI coding assistance (Claude Code).

export interface Skyb<H> {
  header: H;
  /** Byte offset of the payload inside `buf`. Always a multiple of 4. */
  offset: number;
  buf: ArrayBuffer;
}

export function parseSkyb<H = unknown>(buf: ArrayBuffer): Skyb<H> {
  if (buf.byteLength < 8) throw new Error('Response too short to be a SkyDive data file');
  const u8 = new Uint8Array(buf, 0, 4);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'SKYB') {
    throw new Error('Unexpected data format (missing SKYB signature)');
  }
  const h = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, h))) as H;
  const offset = Math.ceil((8 + h) / 4) * 4;
  return { header, offset, buf };
}

export interface CutoutItem {
  id: string;
  ok: boolean;
  error?: string;
  mjd?: number;
  detector?: number;
  wave_um?: number;
  bw_um?: number;
  dwave_dx?: number;
  dwave_dy?: number;
  bg?: number;
  flag_frac?: number;
}

export interface CutoutHeader {
  ra: number;
  dec: number;
  n_px: number;
  pixscale_arcsec: number;
  flag_names: Record<string, string>;
  mask_bits?: number[];
  items: CutoutItem[];
}

export interface DecodedCutout {
  item: CutoutItem;
  image: Float32Array;
  flags: Uint32Array;
}

/** Split a cutouts SKYB into per-exposure arrays (copies, so each can be transferred to the worker). */
export function decodeCutouts(buf: ArrayBuffer): { header: CutoutHeader; ok: DecodedCutout[]; failed: CutoutItem[] } {
  const { header, offset } = parseSkyb<CutoutHeader>(buf);
  const n = header.n_px * header.n_px;
  const ok: DecodedCutout[] = [];
  const failed: CutoutItem[] = [];
  let off = offset;
  for (const item of header.items) {
    if (!item.ok) {
      failed.push(item);
      continue;
    }
    if (off + n * 8 > buf.byteLength) throw new Error('Data file is truncated');
    const image = new Float32Array(buf.slice(off, off + n * 4));
    off += n * 4;
    const flags = new Uint32Array(buf.slice(off, off + n * 4));
    off += n * 4;
    ok.push({ item, image, flags });
  }
  return { header, ok, failed };
}

export interface HistoryHeader {
  ra: number;
  dec: number;
  arcsec: number;
  frames: { survey: 'wise' | 'ps1'; band: string; mjd: number; n_px: number; pixscale_arcsec: number; label: string }[];
  notes?: string[];
}
