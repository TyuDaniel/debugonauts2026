// SkyDive viewer — promise wrapper around the stacking worker.
// Written with AI coding assistance (Claude Code).
import { MASK_WORD } from './types';

type Resolver = (v: any) => void;

class StackClient {
  private worker: Worker;
  private req = 0;
  private pending = new Map<number, Resolver>();

  constructor() {
    this.worker = new Worker(new URL('./stack.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      const r = this.pending.get(ev.data.req);
      if (r) {
        this.pending.delete(ev.data.req);
        r(ev.data);
      }
    };
  }

  reset(nPx: number): void {
    this.pending.clear();
    this.worker.postMessage({ t: 'reset', nPx, maskWord: MASK_WORD });
  }

  setMask(maskWord: number): void {
    this.worker.postMessage({ t: 'mask', maskWord });
  }

  add(items: { idx: number; image: Float32Array; flags: Uint32Array }[]): void {
    const transfer: Transferable[] = [];
    for (const it of items) transfer.push(it.image.buffer, it.flags.buffer);
    this.worker.postMessage({ t: 'add', items }, transfer);
  }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    const req = ++this.req;
    return new Promise<T>((resolve) => {
      this.pending.set(req, resolve);
      this.worker.postMessage({ ...msg, req });
    });
  }

  stack(sets: number[][]): Promise<{ out: { img: Float32Array; tint: Uint8Array }[]; sample: Float32Array }> {
    return this.call({ t: 'stack', sets });
  }

  phot(x: number, y: number, ids: number[], haloWord?: number): Promise<{ flux: Float32Array; err: Float32Array; ok: Uint8Array; nAp: number }> {
    return this.call({ t: 'phot', x, y, ids, haloWord });
  }

  apcor(sets: number[][], stars: number[][]): Promise<{ ratios: number[][] }> {
    return this.call({ t: 'apcor', sets, stars });
  }

  flagsAt(ids: number[], px: number): Promise<{ counts: Uint16Array; n: number }> {
    return this.call({ t: 'flagsAt', ids, px });
  }

  bitFrac(ids: number[], pixels: number[], word: number): Promise<{ frac: number; n: number }> {
    return this.call({ t: 'bitFrac', ids, pixels, word });
  }
}

export const stacker = new StackClient();
