// SkyDive viewer — sharing: copy link, copy embed snippet, GIF export.
// Written with AI coding assistance (Claude Code).
import { currentPicture, frameById, playlist } from './compute';
import { fmtDeg, mjdIso } from './coords';
import { $, toast } from './dom';
import { encodeGif, quantise } from './gif';
import { paintImage, paintOverlay } from './paint';
import { store } from './store';
import { displayMjd } from './view';

async function copy(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    // Clipboard blocked (insecure context or permissions): fall back to a prompt the user can copy from.
    window.prompt('Copy this:', text);
  }
}

export function embedSnippet(): string {
  const url = store.shareUrl({ embed: '1' });
  return `<iframe src="${url}" width="480" height="620" style="border:0" loading="lazy" title="SkyDive sky movie"></iframe>`;
}

async function exportGif(): Promise<void> {
  const st = store.state;
  const size = 480;
  const cap = 28;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size + cap;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const ids = st.mode === 'blink' ? playlist().map((f) => f.id) : [st.frame];
  const frames: Uint8Array[] = [];
  toast('Building GIF…');
  await new Promise((r) => setTimeout(r, 30));
  for (const id of ids) {
    const res = currentPicture(id);
    if (!('picture' in res)) continue;
    const f = st.mode === 'blink' ? frameById(id) : undefined;
    g.fillStyle = '#0a0c09';
    g.fillRect(0, 0, c.width, c.height);
    paintImage(g, size, res.picture);
    paintOverlay(g, size, res.picture, f ? f.mjd : displayMjd(), 1);
    g.fillStyle = '#eff2e9';
    g.font = '600 12px Geist, system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(`${res.picture.title}${f ? '  ' + mjdIso(f.mjd) : ''}`, 10, size + cap / 2);
    g.textAlign = 'right';
    g.fillStyle = '#b9bfb0';
    g.font = '500 11px Geist, system-ui, sans-serif';
    g.fillText(`SkyDive  ${fmtDeg(st.ra!, 4)} ${fmtDeg(st.dec!, 4)}`, size - 10, size + cap / 2);
    frames.push(quantise(g.getImageData(0, 0, c.width, c.height).data));
  }
  if (!frames.length) {
    toast('Nothing to export yet.');
    return;
  }
  const blob = encodeGif(frames, c.width, c.height, st.speed);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `skydive_${st.ra!.toFixed(4)}_${st.dec!.toFixed(4)}.gif`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  if (import.meta.env.DEV) (window as any).__lastGif = { frames: frames.length, bytes: blob.size };
  toast(`GIF saved: ${frames.length} frame${frames.length === 1 ? '' : 's'}, ${(blob.size / 1024).toFixed(0)} kB`);
}

export function initShare(): void {
  const btn = $('#share-btn');
  const pop = $('#share-pop');
  const close = () => {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', String(!pop.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      close();
      btn.focus();
    }
  });
  $('#copy-link').addEventListener('click', () => {
    store.flushUrl();
    void copy(store.shareUrl(), 'Link copied');
    close();
  });
  $('#copy-embed').addEventListener('click', () => {
    void copy(embedSnippet(), 'Embed snippet copied');
    close();
  });
  $('#export-gif').addEventListener('click', () => {
    close();
    void exportGif();
  });
}
