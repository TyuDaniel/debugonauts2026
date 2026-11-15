// SkyDive viewer — landing state: the poster panel beside the live 3D map, with the baked showcase
// fields. Written with AI coding assistance (Claude Code).
import { bakedIndex } from './api';
import { fmtDeg } from './coords';
import { $, clear, h } from './dom';
import { FOV_NPX } from './types';

let done = false;

/** Hand a query to the real coordinate box in the header, so there is one code path for lookups. */
function dive(q: string): void {
  const text = q.trim();
  const input = $<HTMLInputElement>('#coord-input');
  if (!text) {
    $<HTMLInputElement>('#hero-input').focus();
    return;
  }
  input.value = text;
  $<HTMLFormElement>('#coord-form').requestSubmit();
}

interface MapTarget { name: string; ra: number; dec: number; url: string }

/**
 * Play a showcase tile's dive on the 3D map beside it; the map opens the viewer when it lands.
 * False when the map cannot play it (still loading, no WebGL, reduced motion): the link then
 * opens the viewer on its own.
 */
function diveOnMap(target: MapTarget): boolean {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const frame = document.querySelector<HTMLIFrameElement>('.mapwrap iframe');
  try {
    const dive = (frame?.contentWindow as (Window & { skydiveDive?: (t: MapTarget) => boolean }) | null | undefined)?.skydiveDive;
    if (!frame || !dive || !dive(target)) return false;
  } catch {
    return false;
  }
  // On a narrow screen the map sits below the tiles: bring it into view.
  frame.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return true;
}

export function initLanding(): void {
  // Back from the viewer: no tile is on its way any more.
  window.addEventListener('pageshow', () => {
    for (const el of document.querySelectorAll('.tile.going')) el.classList.remove('going');
  });
  $('#hero-form').addEventListener('submit', (e) => {
    e.preventDefault();
    dive($<HTMLInputElement>('#hero-input').value);
  });
  // The full example does not fit a phone's width and would be cut off mid-word.
  if (window.matchMedia('(max-width: 520px)').matches) {
    $<HTMLInputElement>('#hero-input').placeholder = window.matchMedia('(max-width: 360px)').matches ? 'RA Dec or name' : 'Coordinates or a name';
  }
  // Lookup progress and errors are written to the header note; show them next to the hero box too.
  const src = $('#coord-note');
  const dst = $('#hero-note');
  new MutationObserver(() => {
    dst.textContent = src.textContent;
    dst.classList.toggle('error', src.classList.contains('error'));
  }).observe(src, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

function arrow(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M2 8h11M8.5 3.5 13 8l-4.5 4.5');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

export async function showLanding(): Promise<void> {
  if (done) return;
  done = true;
  const tiles = $('#tiles');
  clear(tiles);
  for (let i = 0; i < 3; i++) tiles.append(h('div', { class: 'tile skeleton', 'aria-hidden': 'true' }));
  const fields = await bakedIndex();
  clear(tiles);
  if (!fields.length) {
    tiles.append(h('p', { class: 'tiles-empty' }, 'No prepared fields are installed on this copy of the site. Enter any coordinates above, for example 133.7577 −7.2420.'));
    return;
  }
  for (const f of fields) {
    const npx = f.n_px.includes(64) ? 64 : f.n_px[0];
    const fov = Object.entries(FOV_NPX).find(([, n]) => n === npx)?.[0] ?? '6.5';
    const tile = h('a', { class: 'tile', href: `?ra=${f.ra}&dec=${f.dec}&fov=${fov}`, title: f.note ? `Honest note: ${f.note}` : undefined },
      h('span', { class: 'tile-name' }, f.name, h('small', null, `${fmtDeg(f.ra, 4)} ${fmtDeg(f.dec, 4)}`)),
      h('span', { class: 'tile-blurb' }, f.blurb ?? ''),
      h('span', { class: 'tile-go' }, arrow()),
    );
    tile.addEventListener('click', (ev) => {
      // A modified click opens a new tab or window, as any link does.
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      if (!diveOnMap({ name: f.name, ra: f.ra, dec: f.dec, url: tile.href })) return;
      ev.preventDefault();
      tile.classList.add('going');
    });
    tiles.append(tile);
  }
}
