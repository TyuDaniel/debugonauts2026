// SkyDive viewer — tiny DOM helpers. Written with AI coding assistance (Claude Code).

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && k !== 'list' && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let toastTimer = 0;
/** Brief status message, announced to screen readers. */
export function toast(msg: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

export function rafThrottle<T extends unknown[]>(fn: (...a: T) => void): (...a: T) => void {
  let pending = false;
  let last: T;
  return (...a: T) => {
    last = a;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...last);
    });
  };
}

export const fmt = {
  wave: (v: number) => v.toFixed(2),
  int: (v: number) => v.toLocaleString('en-US'),
  sig: (v: number, n = 3) => {
    if (!isFinite(v)) return '–';
    const a = Math.abs(v);
    const s = a !== 0 && (a < 0.001 || a >= 1e5) ? v.toExponential(n - 1) : v.toPrecision(n);
    return s.replace('-', '−');
  },
};
