// End-to-end test: loads the unpacked extension into a throwaway headless
// Brave/Chrome profile, opens the real popup through Extensions.triggerAction
// (which grants activeTab like a toolbar click), clicks each capture mode and
// checks the pixels of the image the viewer tab shows.
//
//   node test/e2e.mjs [path-to-browser-binary]
//
// Window capture is not covered: it needs the system picker and a human.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BROWSER = process.argv[2] || process.env.BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const EXT = resolve(import.meta.dirname, '..');
const DPR = 2;
const W = 1000;
const H = 700;
const BANDS = ['#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#00acc1', '#f4511e', '#6d4c41', '#3949ab', '#c0ca33', '#d81b60', '#00897b', '#5e35b1'];
const HEADER = '#ff0000';

const bands = (n, h) => BANDS.slice(0, n).map((c) => `<div style="height:${h}px;background:${c}"></div>`).join('');
const PAGES = {
  // Document scroll with a fixed header that must appear once, at the top.
  '/long': `<body style="margin:0"><div style="position:fixed;top:0;left:0;right:0;height:60px;background:${HEADER}"></div>${bands(12, 500)}</body>`,
  // App-style layout: the body never scrolls, an inner pane does.
  '/inner': `<body style="margin:0;height:100vh;overflow:hidden"><div style="height:50px;background:${HEADER}"></div>
    <div id="pane" style="position:absolute;top:50px;bottom:0;left:0;right:0;overflow:auto">${bands(8, 400)}</div></body>`,
};

PAGES['/sticky'] = `<body style="margin:0">
  <div id="nav" style="height:40px;background:#ff00ff"></div>
  <div style="height:1000px;background:${BANDS[0]}"></div>
  <div style="position:sticky;top:0;height:80px;background:#00ff00"></div>
  ${bands(6, 500)}
  <script>
    // A header that a scroll handler pins, as many sites do.
    addEventListener('scroll', () => {
      const pin = scrollY > 100;
      nav.style.cssText = 'height:40px;background:#ff00ff;' + (pin ? 'position:fixed;top:0;left:0;right:0' : '');
      document.body.style.paddingTop = pin ? '40px' : '';
    });
  </script></body>`;
// Taller than Chromium's canvas side limit at DPR 2, so the result must be scaled.
PAGES['/tall'] = `<body style="margin:0">${bands(10, 2000)}</body>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    };
    this.ready = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
}

async function waitFor(fn, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const server = createServer((req, res) => {
  res.writeHead(PAGES[req.url] ? 200 : 404, { 'content-type': 'text/html' });
  res.end(PAGES[req.url] || 'not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), 'pagesnap-e2e-'));
const browser = spawn(BROWSER, [
  '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
  '--no-first-run', `--window-size=${W},${H}`, `--force-device-scale-factor=${DPR}`, 'about:blank',
], { stdio: 'ignore' });

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

try {
  const port = await waitFor(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return null; }
  }, 'browser start');
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = new CDP(webSocketDebuggerUrl);
  await cdp.ready;
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });

  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
  const attach = async (targetId) => (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const evaluate = async (session, expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const extensionError = async () => {
    const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(extId));
    return sw ? evaluate(await attach(sw.targetId), 'chrome.action.getTitle({})') : 'no service worker';
  };

  // PAGESNAP_SHOTS=<dir> saves the popup and viewer as PNGs for a visual check.
  const shoot = async (session, name) => {
    if (!process.env.PAGESNAP_SHOTS) return;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
    await writeFile(join(process.env.PAGESNAP_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };

  const tabsUsed = new Set();
  // Clicks a mode in the real popup and returns the session of the viewer tab it opens.
  async function capture(path, mode, beforeViewer, setup) {
    const { targetId } = await cdp.send('Target.createTarget', { url: origin + path });
    const page = await attach(targetId);
    await evaluate(page, 'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))');
    if (setup) await setup(page);
    const seen = new Set((await targets()).map((t) => t.targetId));
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tab = targetInfos.find((t) => t.url === origin + path && !tabsUsed.has(t.targetId));
    tabsUsed.add(tab.targetId);
    await cdp.send('Extensions.triggerAction', { id: extId, targetId: tab.targetId });
    const popup = await waitFor(async () => (await targets()).find((t) => !seen.has(t.targetId) && t.url.endsWith('/src/popup.html')), 'popup');
    const popupSession = await attach(popup.targetId);
    await waitFor(() => evaluate(popupSession, '!!document.querySelector("button[data-mode]")'), 'popup ready');
    await shoot(popupSession, `popup-${mode}`);
    await evaluate(popupSession, `document.querySelector('[data-mode="${mode}"]').click()`);
    if (beforeViewer) await beforeViewer(page);
    const viewer = await waitFor(async () => (await targets()).find((t) => !seen.has(t.targetId) && t.url.includes('/src/viewer.html#')), 'viewer')
      .catch(async (e) => { throw new Error(`${e.message}; badge: ${await extensionError()}`); });
    const viewerSession = await attach(viewer.targetId);
    await waitFor(() => evaluate(viewerSession, 'document.querySelector("main img")?.complete && document.querySelector("main img").naturalWidth > 0'), 'image');
    await shoot(viewerSession, `viewer-${mode}`);
    const state = await evaluate(page, `({ y: scrollY, pane: document.getElementById('pane')?.scrollTop ?? 0 })`);
    return { viewer: viewerSession, page: state };
  }

  // Returns [width, height, hex at each [x, y] in image pixels].
  const sample = (session, points) => evaluate(session, `(async () => {
    const img = document.querySelector('main img');
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const hex = ([x, y]) => '#' + [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('');
    return [img.naturalWidth, img.naturalHeight, ${JSON.stringify(points)}.map(hex)];
  })()`);

  // Full page and scrolling capture of the document-scroll page.
  for (const mode of ['full', 'scroll']) {
    const { viewer, page } = await capture('/long', mode);
    const points = [[20, 30 * DPR], ...BANDS.map((_, i) => [20, (i * 500 + 250) * DPR]), [20, 1030 * DPR], [20, 5530 * DPR]];
    const [w, h, colors] = await sample(viewer, points);
    check(`${mode}: height covers the whole page`, h === 6000 * DPR, `${w}x${h}`);
    check(`${mode}: fixed header at the top`, colors[0] === HEADER, colors[0]);
    check(`${mode}: every band at its offset`, BANDS.every((c, i) => colors[i + 1] === c), colors.slice(1, 13).join(' '));
    check(`${mode}: fixed header not repeated`, colors[13] !== HEADER && colors[14] !== HEADER, `${colors[13]} ${colors[14]}`);
    check(`${mode}: page scroll restored`, page.y === 0, `scrollY=${page.y}`);
  }

  // Full page from a scrolled position still starts at the top of the document.
  {
    const { viewer, page } = await capture('/long', 'full', null, (p) => evaluate(p, 'scrollTo(0, 2000)'));
    const [w, h, colors] = await sample(viewer, [[20, 30 * DPR], ...BANDS.map((_, i) => [20, (i * 500 + 250) * DPR])]);
    check('full from scrolled page: whole page', h === 6000 * DPR && colors[0] === HEADER && BANDS.every((c, i) => colors[i + 1] === c), `${w}x${h} ${colors.join(' ')}`);
    check('full from scrolled page: scroll position kept', page.y === 2000, `scrollY=${page.y}`);
  }

  // Full page on an app-style page falls back to the inner pane.
  {
    const { viewer } = await capture('/inner', 'full');
    const [w, h, colors] = await sample(viewer, BANDS.slice(0, 8).map((_, i) => [20, (i * 400 + 200) * DPR]));
    check('full inner pane: falls back to the pane content', h === 3200 * DPR && BANDS.slice(0, 8).every((c, i) => colors[i] === c), `${w}x${h}`);
  }

  // Sticky bars stay in place, and a header pinned on scroll appears once.
  {
    const { viewer } = await capture('/sticky', 'scroll');
    const stickyAt = 1040;
    const [w, h, colors] = await sample(viewer, [[20, 20 * DPR], [20, (stickyAt + 40) * DPR], ...[1, 2, 3, 4].map((k) => [20, (stickyAt + 80 + k * 600 + 20) * DPR])]);
    check('sticky: page height', h === (40 + 1000 + 80 + 3000) * DPR, `${w}x${h}`);
    check('sticky: pinned header at the top', colors[0] === '#ff00ff', colors[0]);
    check('sticky: sticky bar at its place', colors[1] === '#00ff00', colors[1]);
    check('sticky: neither repeats further down', colors.slice(2).every((c) => c !== '#ff00ff' && c !== '#00ff00'), colors.slice(2).join(' '));
  }

  // Pages past the canvas limit come out scaled to fit, not cut off or failed.
  for (const mode of ['full', 'scroll']) {
    const { viewer } = await capture('/tall', mode);
    const [w, h, colors] = await sample(viewer, [[5, 5], [5, 0]]);
    const scale = h / (20000 * DPR);
    const bandColors = await sample(viewer, BANDS.slice(0, 10).map((_, i) => [5, Math.round((i * 2000 + 1000) * DPR * scale)]));
    check(`${mode} tall: scaled to the canvas limit`, h <= 32767 && h > 32000, `${w}x${h}`);
    check(`${mode} tall: every band at its scaled offset`, BANDS.slice(0, 10).every((c, i) => bandColors[2][i] === c), bandColors[2].join(' '));
  }

  // Scrolling capture follows an inner scroll pane.
  {
    const { viewer, page } = await capture('/inner', 'scroll');
    const points = BANDS.slice(0, 8).map((_, i) => [20, (i * 400 + 200) * DPR]);
    const [w, h, colors] = await sample(viewer, points);
    check('scroll inner pane: height is the pane content', h === 3200 * DPR, `${w}x${h}`);
    check('scroll inner pane: every band at its offset', BANDS.slice(0, 8).every((c, i) => colors[i] === c), colors.join(' '));
    check('scroll inner pane: pane scroll restored', page.pane === 0, `scrollTop=${page.pane}`);
  }

  // Visible area.
  {
    let viewport;
    const { viewer } = await capture('/long', 'visible', async (page) => {
      viewport = await evaluate(page, '[innerWidth, innerHeight]');
    });
    const [w, h, colors] = await sample(viewer, [[20, 30 * DPR], [20, 300 * DPR]]);
    check('visible: viewport size', w === viewport[0] * DPR && h === viewport[1] * DPR, `${w}x${h}`);
    check('visible: content', colors[0] === HEADER && colors[1] === BANDS[0], colors.join(' '));
  }

  // Area: drag a rectangle; the overlay must be gone from the crop.
  {
    const drag = async (page) => {
      // The overlay's shadow root is closed, so its arrival shows as a new last child of <html>.
      await waitFor(() => evaluate(page, 'document.documentElement.lastElementChild.tagName === "DIV"'), 'area overlay').catch(async (e) => {
        console.error('page children:', await evaluate(page, '[...document.documentElement.children].map((e) => e.tagName)'), 'badge:', await extensionError());
        throw e;
      });
      const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 }, page);
      await mouse('mousePressed', 100, 100, 1);
      await mouse('mouseMoved', 200, 180, 1);
      await mouse('mouseMoved', 300, 250, 1);
      await mouse('mouseReleased', 300, 250, 0);
    };
    const { viewer } = await capture('/long', 'area', drag);
    const [w, h, colors] = await sample(viewer, [[10, 10], [200, 150], [390, 290]]);
    check('area: crop size', w === 200 * DPR && h === 150 * DPR, `${w}x${h}`);
    check('area: no overlay tint in the crop', colors.every((c) => c === BANDS[0]), colors.join(' '));
  }
} catch (e) {
  console.error(e);
  failures++;
} finally {
  browser.kill();
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {}); // best effort: the browser may still hold files
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
