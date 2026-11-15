// SkyDive viewer — end-to-end checks of False colour, run in a real browser against the dev server.
// Written with AI coding assistance (Claude Code).
//
// Usage: start the dev server (`npm run dev`), then `npm run test:fc`.
//   SKYDIVE_URL    address of the dev server (default http://localhost:5173)
//   SKYDIVE_SHOTS  optional folder: screenshots of WISE 0855−0714 stacked in false colour go there
// It needs the dev server rather than a production build, because it reads the viewer's state through
// `window.__skydive`, which only exists in dev. The five prepared fields load from baked files, so no
// backend is needed. Prints one PASS or FAIL line per check and exits non-zero if any check failed.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = (process.env.SKYDIVE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const SHOTS = process.env.SKYDIVE_SHOTS;
const FIELDS = [
  ['WISE 0855-0714', 133.757714, -7.242018],
  ["Barnard's Star", 269.446066, 4.770816],
  ['Epsilon Indi B', 331.098475, -56.80128],
  ['RW Aurigae', 76.95609, 30.401122],
  ['R Draconis', 248.16722, 66.755025],
];
const WISE0855 = FIELDS[0];
const WL_ALL = [0.7, 5.05];
const D6 = [4.41, 5.05];
const SLOW_MS = 3000;

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
/** Run one block of checks; anything it throws is a failure of that block, not of the whole script. */
async function group(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

const until = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const colourOn = (page) => until(page, () => !!window.__skydive.getPicture()?.rgb);
const colourOff = (page) => until(page, () => !!window.__skydive.getPicture() && !window.__skydive.getPicture().rgb);
// The title is checked too: right after the click the picture on screen is still the single frame.
const stackOn = (page) => until(page, () => window.__skydive.store.state.mode === 'sum' && !!window.__skydive.getPicture()?.rgb && /stack of/.test(window.__skydive.getPicture().title));

/** The painted image: how many pixels are grey or coloured, and a hash of all of them. */
const readImage = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('#img');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let grey = 0, colour = 0, skipped = 0, h = 2166136261;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      h = Math.imul(h ^ r, 16777619);
      h = Math.imul(h ^ g, 16777619);
      h = Math.imul(h ^ b, 16777619);
      // Not image data: the no-data colour (#12161c) and the box background (#050604).
      if ((r === 0x12 && g === 0x16 && b === 0x1c) || (r === 5 && g === 6 && b === 4)) skipped++;
      else if (r === g && g === b) grey++;
      else colour++;
    }
    return { grey, colour, skipped, hash: (h >>> 0).toString(16) };
  });

/** Wait until the image has stopped changing (stacking runs in a worker), then read it. */
async function settled(page) {
  let last = await readImage(page);
  let same = 0;
  for (let i = 0; i < 40 && same < 3; i++) {
    await page.waitForTimeout(150);
    const now = await readImage(page);
    same = now.hash === last.hash ? same + 1 : 0;
    last = now;
  }
  return last;
}

/** What the viewer says it is showing. */
const readState = (page) =>
  page.evaluate(() => {
    const s = window.__skydive;
    const pic = s.getPicture();
    const st = s.store.state;
    const legend = document.querySelector('#fc-legend');
    const note = document.querySelector('#wave-note');
    return {
      fc: st.fc, mode: st.mode, frame: st.frame, wl: [...st.wl],
      url: location.search,
      pressed: document.querySelector('#fc-toggle').getAttribute('aria-pressed'),
      legendShown: !legend.hidden && legend.getBoundingClientRect().height > 0,
      legendKeys: [...legend.querySelectorAll('.fc-key')].map((e) => e.textContent.trim()),
      note: note.hidden ? '' : note.textContent,
      sub: document.querySelector('#frame-sub').textContent,
      invertOff: document.querySelector('#invert').disabled,
      pic: pic && {
        kind: pic.kind, diverging: pic.diverging, n: pic.n, title: pic.title, pixels: pic.nPx * pic.nPx,
        rgb: pic.rgb ? { images: pic.rgb.data.length, sizes: pic.rgb.data.map((d) => d.length), n: [...pic.rgb.n], lo: [...pic.rgb.lo], hi: [...pic.rgb.hi], bands: pic.rgb.bands.map((b) => [...b]) } : null,
      },
    };
  });

const thirds = ([a, b]) => {
  const w = (b - a) / 3;
  return [[a + 2 * w, b], [a + w, a + 2 * w], [a, a + w]]; // red, green, blue
};
const near = (x, y) => Math.abs(x - y) < 1e-6;
const sameBands = (got, want) => !!got && got.length === 3 && got.every((b, c) => near(b[0], want[c][0]) && near(b[1], want[c][1]));
/** The legend lists blue, green, red, each with its range to two decimals. */
const legendFor = (wl) => {
  const b = thirds(wl);
  return [2, 1, 0].map((c) => `${['Red', 'Green', 'Blue'][c]} ${b[c][0].toFixed(2)}–${b[c][1].toFixed(2)} µm`);
};
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const hasFc = (search) => new URLSearchParams(search).get('fc') === '1';
/** Problems with a colour picture's numbers, or '' when they add up. */
function colourFaults(pic) {
  if (!pic?.rgb) return 'no colour picture';
  const { rgb } = pic;
  const faults = [];
  if (rgb.images !== 3 || rgb.sizes.some((n) => n !== pic.pixels)) faults.push(`images ${rgb.sizes.join('/')} for ${pic.pixels} pixels`);
  const sum = rgb.n.reduce((a, b) => a + b, 0);
  if (sum !== pic.n) faults.push(`exposures per colour ${rgb.n.join('+')} = ${sum}, picture has ${pic.n}`);
  rgb.n.forEach((n, c) => {
    if (n > 0 && !(Number.isFinite(rgb.lo[c]) && Number.isFinite(rgb.hi[c]))) faults.push(`limits of colour ${c} are ${rgb.lo[c]}..${rgb.hi[c]}`);
  });
  return faults.join('; ');
}

async function open(ctx, field, extra = '') {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
  });
  await page.goto(`${BASE}/?ra=${field[1]}&dec=${field[2]}&fov=6.5${extra}`);
  await page.waitForFunction(() => window.__skydive?.store.session.status === 'ok', null, { timeout: 60000 });
  await page.waitForFunction(() => !!window.__skydive.getPicture(), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  return { page, errors };
}

/** Click something and time, inside the page, how long until a colour picture (a colour stack with `sum`) is on screen. −1 after 20 s. */
const timeClick = (page, selector, sum) =>
  page.evaluate(
    ([sel, wantSum]) =>
      new Promise((resolve) => {
        const t0 = performance.now();
        document.querySelector(sel).click();
        const tick = () => {
          const s = window.__skydive;
          const pic = s.getPicture();
          if (pic?.rgb && (!wantSum || (s.store.state.mode === 'sum' && /stack of/.test(pic.title)))) resolve(performance.now() - t0);
          else if (performance.now() - t0 > 20000) resolve(-1);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    [selector, sum],
  );

const browser = await chromium.launch();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- desktop, WISE 0855−0714
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await group('desktop checks on WISE 0855-0714', async () => {
  const { page, errors } = await open(desktop, WISE0855);
  const firstFrame = (await readState(page)).frame;

  // 1
  const grey0 = await settled(page);
  let s = await readState(page);
  check('1 off by default: grey picture, chip not pressed, no fc in the address',
    !s.fc && !!s.pic && !s.pic.rgb && grey0.colour === 0 && grey0.grey > 0 && s.pressed === 'false' && !hasFc(s.url) && !s.legendShown,
    `${grey0.grey} grey / ${grey0.colour} coloured pixels, aria-pressed=${s.pressed}, url ${s.url}`);

  // 2
  await page.click('#fc-toggle');
  let on = await colourOn(page);
  const urlOn = await until(page, () => new URLSearchParams(location.search).get('fc') === '1', null, 3000);
  const col = await settled(page);
  s = await readState(page);
  check('2 chip click: colour picture of three images, coloured pixels on the canvas',
    on && s.pic?.rgb?.images === 3 && col.colour > 0, `${col.colour} coloured / ${col.grey} grey pixels`);
  check('2 chip click: chip pressed, legend lists the three ranges',
    s.pressed === 'true' && s.legendShown && sameList(s.legendKeys, legendFor(WL_ALL)), `legend "${s.legendKeys.join(' | ')}"`);
  check('2 chip click: address gains fc=1, frame title says false colour, Invert disabled',
    urlOn && /false colour/i.test(s.sub) && s.invertOff, `url ${s.url}, sub "${s.sub}", invert disabled=${s.invertOff}`);

  // 3 and 9 (Blink)
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('c');
  let off = await colourOff(page);
  const urlOff = await until(page, () => !new URLSearchParams(location.search).has('fc'), null, 3000);
  const grey1 = await settled(page);
  s = await readState(page);
  const keyOff = off && !s.fc && s.pressed === 'false' && urlOff && !s.legendShown && !s.invertOff;
  await page.keyboard.press('c');
  on = await colourOn(page);
  s = await readState(page);
  check('3 key C turns it off and on again', keyOff && on && s.fc && s.pressed === 'true', `off ok=${keyOff}, on again=${on && s.fc}`);
  check('9 off again gives exactly the grey image from before (Blink)', grey1.hash === grey0.hash && grey1.colour === 0, `hash ${grey0.hash} then ${grey1.hash}`);

  // 7
  await page.click('#preset-diff');
  const div = await until(page, () => window.__skydive.getPicture()?.diverging === true);
  const diffImg = await settled(page);
  s = await readState(page);
  check('7 Latest − first: diverging grey picture, not colour, with a note',
    div && s.fc && !s.pic.rgb && diffImg.colour === 0 && diffImg.grey > 0 && /false colour does not apply/i.test(s.note),
    `diverging=${s.pic?.diverging}, ${diffImg.colour} coloured pixels, note "${s.note}"`);
  await page.click('#preset-blink');
  on = await colourOn(page);
  s = await readState(page);
  check('7 back to Blink restores colour', on && s.mode === 'blink' && !/false colour does not apply/i.test(s.note), `mode ${s.mode}`);

  // 8
  const wiseId = await page.evaluate(() => window.__skydive.store.session.frames.find((f) => f.kind === 'wise' || /^w\d/.test(f.id))?.id ?? null);
  if (!wiseId) check('8 a WISE frame stays grey while false colour is on', false, 'this field has no WISE frame');
  else {
    await page.evaluate((id) => window.__skydive.store.set({ mode: 'blink', frame: id }), wiseId);
    const isWise = await until(page, () => window.__skydive.getPicture()?.kind === 'wise');
    const wiseImg = await settled(page);
    s = await readState(page);
    check('8 a WISE frame stays grey while false colour is on',
      isWise && s.fc && !s.pic.rgb && wiseImg.colour === 0 && wiseImg.grey > 0 && !/false colour/i.test(s.sub),
      `frame ${wiseId}, ${wiseImg.colour} coloured / ${wiseImg.grey} grey pixels`);
    await page.evaluate((id) => window.__skydive.store.set({ mode: 'blink', frame: id }), firstFrame);
    await colourOn(page);
  }

  // 5
  await page.click('#preset-stack');
  const stacked = await stackOn(page);
  await settled(page);
  s = await readState(page);
  check('5 Stack all, whole range: the colours are thirds of 0.70–5.05 µm, red the longest',
    stacked && sameBands(s.pic?.rgb?.bands, thirds(WL_ALL)) && s.pic.rgb.bands[0][0] > s.pic.rgb.bands[2][1],
    `red ${s.pic?.rgb?.bands[0].map((x) => x.toFixed(2)).join('–')}, exposures ${s.pic?.rgb?.n.join('/')}`);
  const sci = await page.evaluate(() => {
    const sd = window.__skydive;
    const pic = sd.getPicture();
    const z = sd.getZoom();
    const c = document.querySelector('#img');
    const size = c.width;
    const n = pic.nPx;
    const d = c.getContext('2d').getImageData(0, 0, size, size).data;
    // A SPHEREx picture fills the box at zoom 1 (see pictureRect in paint.ts).
    const x0 = size * (0.5 - z.cx * z.z), y0 = size * (0.5 - z.cy * z.z), w = size * z.z;
    const at = (x, y) => {
      const i = 4 * (Math.floor(y0 + ((y + 0.5) * w) / n) * size + Math.floor(x0 + ((x + 0.5) * w) / n));
      return [d[i], d[i + 1], d[i + 2]];
    };
    const m = Math.floor(n / 2);
    let centre = null;
    for (let y = m - 1; y <= m + 1; y++)
      for (let x = m - 1; x <= m + 1; x++) {
        const p = at(x, y);
        if (!centre || p[0] - Math.max(p[1], p[2]) > centre[0] - Math.max(centre[1], centre[2])) centre = p;
      }
    // The brightest star: the brightest pixel of the grey stack, away from the edges and the centre.
    let best = -Infinity, bx = -1, by = -1;
    for (let y = 2; y < n - 2; y++)
      for (let x = 2; x < n - 2; x++) {
        const v = pic.data[y * n + x];
        if (v === v && v > best && (Math.abs(x - m) > 3 || Math.abs(y - m) > 3)) (best = v), (bx = x), (by = y);
      }
    return { centre, star: at(bx, by), starAt: [bx, by], n, zoom: z.z };
  });
  const red = ([r, g, b]) => r > 1.4 * g && r > 1.4 * b;
  check('5 the brown dwarf at the centre is clearly red', red(sci.centre) && sci.centre[0] > 80, `centre rgb(${sci.centre.join(',')})`);
  check('5 the brightest star is not red', !red(sci.star) && Math.max(...sci.star) > 80, `rgb(${sci.star.join(',')}) at pixel ${sci.starAt.join(',')}`);
  if (SHOTS) {
    await page.screenshot({ path: join(SHOTS, 'wise0855_stack_fc_desktop.png') });
    await page.locator('#image-box').screenshot({ path: join(SHOTS, 'wise0855_stack_fc_desktop_image.png') });
  }

  // 9 (Stack)
  await page.click('#fc-toggle');
  await colourOff(page);
  const stackGrey0 = await settled(page);
  await page.click('#fc-toggle');
  await colourOn(page);
  await settled(page);
  await page.click('#fc-toggle');
  await colourOff(page);
  const stackGrey1 = await settled(page);
  check('9 off again gives exactly the grey image from before (Stack all)',
    stackGrey1.hash === stackGrey0.hash && stackGrey1.colour === 0 && stackGrey0.grey > 0, `hash ${stackGrey0.hash} then ${stackGrey1.hash}`);
  await page.click('#fc-toggle');
  await colourOn(page);

  // 6
  await page.click('#det-chips .chip[data-det="6"]');
  const want = thirds(D6);
  const narrowed = await until(page, (w) => {
    const b = window.__skydive.getPicture()?.rgb?.bands;
    return !!b && b.every((x, c) => Math.abs(x[0] - w[c][0]) < 1e-6 && Math.abs(x[1] - w[c][1]) < 1e-6);
  }, want);
  s = await readState(page);
  check('6 detector D6: the colours become thirds of 4.41–5.05 µm and the legend follows',
    narrowed && near(s.wl[0], D6[0]) && near(s.wl[1], D6[1]) && sameList(s.legendKeys, legendFor(D6)) && !colourFaults(s.pic),
    `range ${s.wl.join('–')}, legend "${s.legendKeys.join(' | ')}", exposures ${s.pic?.rgb?.n.join('/')}`);

  check('desktop run on WISE 0855-0714: no page or console errors', errors.length === 0, errors.slice(0, 3).join(' ; '));
  await page.close();
});

// ---------------------------------------------------------------- 4: links
await group('4 deep links', async () => {
  let { page, errors } = await open(desktop, WISE0855, '&fc=1');
  let on = await colourOn(page);
  let img = await settled(page);
  let s = await readState(page);
  check('4 a link with fc=1 opens in false colour',
    on && s.fc && s.pressed === 'true' && s.legendShown && img.colour > 0 && hasFc(s.url) && errors.length === 0,
    `mode ${s.mode}, ${img.colour} coloured pixels, url ${s.url}${errors.length ? `, ${errors[0]}` : ''}`);
  await page.close();

  ({ page, errors } = await open(desktop, WISE0855, '&fc=1&mode=sum&g=A:0.1.2&show=A'));
  on = await stackOn(page);
  img = await settled(page);
  s = await readState(page);
  check('4 a link with fc=1 and a stack of three visits opens as a colour stack',
    on && s.fc && s.mode === 'sum' && img.colour > 0 && !colourFaults(s.pic) && hasFc(s.url) && errors.length === 0,
    `"${s.pic?.title}", exposures ${s.pic?.rgb?.n.join('/')} of ${s.pic?.n}, url ${s.url}${errors.length ? `, ${errors[0]}` : ''}`);
  await page.close();
});

// ---------------------------------------------------------------- 10 and 12: every prepared field
for (const field of FIELDS) {
  await group(`10 ${field[0]}`, async () => {
    const { page, errors } = await open(desktop, field);
    const exposures = await page.evaluate(() => window.__skydive.store.session.exposures?.length ?? null);
    const blinkMs = await timeClick(page, '#fc-toggle', false);
    await settled(page);
    const blink = await readState(page);
    const stackMs = await timeClick(page, '#preset-stack', true);
    const img = await settled(page);
    const stack = await readState(page);
    const faults = [colourFaults(blink.pic) && `Blink: ${colourFaults(blink.pic)}`, colourFaults(stack.pic) && `Stack all: ${colourFaults(stack.pic)}`, ...errors].filter(Boolean);
    check(`10 ${field[0]}: false colour in Blink and Stack all, numbers add up, no errors`,
      blinkMs >= 0 && stackMs >= 0 && img.colour > 0 && faults.length === 0,
      faults.length ? faults.slice(0, 3).join(' ; ') : `Blink ${blink.pic.rgb.n.join('/')} of ${blink.pic.n}, Stack all ${stack.pic.rgb.n.join('/')} of ${stack.pic.n}, colour after ${blinkMs.toFixed(0)} ms / ${stackMs.toFixed(0)} ms`);
    if (field[0] === 'R Draconis')
      check(`12 R Draconis: colour on screen within ${SLOW_MS / 1000} s of the click`,
        blinkMs >= 0 && blinkMs <= SLOW_MS && stackMs >= 0 && stackMs <= SLOW_MS,
        `${blinkMs.toFixed(0)} ms in Blink, then ${stackMs.toFixed(0)} ms for Stack all${exposures ? `, ${exposures} exposures` : ''}`);
    await page.close();
  });
}
await desktop.close();

// ---------------------------------------------------------------- 11: phone
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
await group('11 phone', async () => {
  const { page, errors } = await open(phone, WISE0855);
  const chip = page.locator('#fc-toggle');
  await chip.scrollIntoViewIfNeeded();
  const box = await chip.boundingBox();
  const visible = (await chip.isVisible()) && !!box && box.x >= 0 && box.x + box.width <= 390 && box.width > 0 && box.height > 0;
  await chip.tap({ timeout: 5000 });
  const on = await colourOn(page);
  const img = await settled(page);
  const s = await readState(page);
  check('11 phone: the False colour chip is visible, and a tap turns colour on',
    visible && on && s.fc && s.pressed === 'true' && img.colour > 0, box ? `chip ${box.width.toFixed(0)}×${box.height.toFixed(0)} px at x=${box.x.toFixed(0)}` : 'chip has no box');
  const layout = await page.evaluate(() => {
    const row = document.querySelector('#fc-toggle').closest('.wave-row');
    const rects = [...row.querySelectorAll('.chip')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
    const legend = document.querySelector('#fc-legend').getBoundingClientRect();
    return {
      page: document.documentElement.scrollWidth, inner: window.innerWidth,
      legendRight: legend.right, legendShown: legend.height > 0,
      chips: rects.length,
      clipped: rects.filter((r) => r.left < -0.5 || r.right > window.innerWidth + 0.5).length,
      lines: new Set(rects.map((r) => Math.round(r.top))).size,
      rowOverflow: row.scrollWidth - row.clientWidth,
    };
  });
  check('11 phone: the legend does not make the page scroll sideways',
    layout.legendShown && layout.page <= layout.inner && layout.legendRight <= layout.inner + 0.5,
    `page ${layout.page} px wide in a ${layout.inner} px window, legend ends at ${layout.legendRight.toFixed(0)} px`);
  check('11 phone: the chip row wraps instead of clipping',
    layout.clipped === 0 && layout.lines > 1 && layout.rowOverflow <= 1,
    `${layout.chips} chips on ${layout.lines} lines, ${layout.clipped} outside the window, row overflow ${layout.rowOverflow} px`);
  await chip.tap({ timeout: 5000 });
  const off = await colourOff(page);
  await chip.tap({ timeout: 5000 });
  const again = await colourOn(page);
  check('11 phone: tapping again turns it off and on', off && again);
  if (SHOTS) {
    await page.locator('#preset-stack').tap({ timeout: 5000 });
    await stackOn(page);
    await settled(page);
    await page.screenshot({ path: join(SHOTS, 'wise0855_stack_fc_phone.png') });
    await page.screenshot({ path: join(SHOTS, 'wise0855_stack_fc_phone_full.png'), fullPage: true });
  }
  check('11 phone: no page or console errors', errors.length === 0, errors.slice(0, 3).join(' ; '));
  await page.close();
});
await phone.close();
await browser.close();

console.log(failed ? `\n${failed} check${failed === 1 ? '' : 's'} failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
