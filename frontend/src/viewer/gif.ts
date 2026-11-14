// SkyDive viewer — a small GIF89a encoder (LZW, fixed palette: 240 greys + 16 marker colours).
// Written with AI coding assistance (Claude Code).

const ACCENTS: [number, number, number][] = [
  [0x5c, 0xc8, 0xff], [0x3d, 0xdb, 0xb0], [0xf4, 0x9a, 0xc8], [0xf4, 0xf1, 0xe8], [0xff, 0xb4, 0x54], [0xff, 0x5c, 0x3a],
  [0x2e, 0x64, 0x80], [0x1f, 0x6e, 0x58], [0x7a, 0x4d, 0x64], [0x80, 0x5a, 0x2a], [0x80, 0x2e, 0x1d], [0x12, 0x16, 0x1c],
  [0xc0, 0x86, 0x60], [0x9a, 0x70, 0x80], [0x60, 0x90, 0xa0], [0x90, 0xb0, 0x90],
];
const GREYS = 240;

function palette(): Uint8Array {
  const p = new Uint8Array(256 * 3);
  for (let i = 0; i < GREYS; i++) p[i * 3] = p[i * 3 + 1] = p[i * 3 + 2] = Math.round((i * 255) / (GREYS - 1));
  ACCENTS.forEach((c, i) => p.set(c, (GREYS + i) * 3));
  return p;
}

/** Map RGBA pixels to palette indices. */
export function quantise(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && Math.abs(r - b) < 14) {
      out[j] = Math.round(((r + g + b) / 3 / 255) * (GREYS - 1));
    } else {
      let best = 0, bd = Infinity;
      for (let k = 0; k < ACCENTS.length; k++) {
        const c = ACCENTS[k];
        const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      out[j] = GREYS + best;
    }
  }
  return out;
}

function lzw(indices: Uint8Array): Uint8Array {
  const MIN = 8;
  const CLEAR = 1 << MIN, END = CLEAR + 1;
  const out: number[] = [];
  let cur = 0, bits = 0;
  let size = MIN + 1;
  let next = END + 1;
  let dict = new Map<number, number>();
  const emit = (code: number) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; }
  };
  emit(CLEAR);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(CLEAR);
      dict = new Map();
      next = END + 1;
      size = MIN + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(END);
  if (bits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}

export function encodeGif(frames: Uint8Array[], width: number, height: number, delayMs: number): Blob {
  const parts: (Uint8Array | number[])[] = [];
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  parts.push([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], [...u16(width), ...u16(height), 0xf7, 0, 0], palette());
  if (frames.length > 1) parts.push([0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0]);
  const delay = Math.max(2, Math.round(delayMs / 10));
  for (const f of frames) {
    parts.push([0x21, 0xf9, 4, 0, ...u16(delay), 0, 0]);
    parts.push([0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0]);
    parts.push([8]);
    const data = lzw(f);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.subarray(i, i + 255);
      parts.push([chunk.length], chunk);
    }
    parts.push([0]);
  }
  parts.push([0x3b]);
  return new Blob(parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)) as BlobPart), { type: 'image/gif' });
}
