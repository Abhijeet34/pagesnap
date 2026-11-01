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
// PAGESNAP_DPR=1.5 exercises fractional pixel ratios, where frame seams show up.
const DPR = Number(process.env.PAGESNAP_DPR || 2);
// PAGESNAP_HEADED=1 runs a visible window, which also exercises Window capture:
// the picker is answered by a flag that selects this test's own window by
// title, so nothing else on screen is ever captured.
const HEADED = process.env.PAGESNAP_HEADED === '1';
const WINDOW_TITLE = 'PageSnap window target';
const W = 1000;
const H = 700;
const BANDS = ['#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#00acc1', '#f4511e', '#6d4c41', '#3949ab', '#c0ca33', '#d81b60', '#00897b', '#5e35b1'];
const HEADER = '#ff0000';

const bands = (n, h) => BANDS.slice(0, n).map((c) => `<div style="height:${h}px;background:${c}"></div>`).join('');
const PAGES = {
  // Document scroll with a fixed header that must appear once, at the top.
  '/long': `<body style="margin:0"><div style="position:fixed;top:0;left:0;right:0;height:60px"><div style="visibility:visible;height:60px;background:${HEADER}"></div></div>${bands(12, 500)}</body>`,
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
PAGES['/wintarget'] = `<title>${WINDOW_TITLE}</title><body style="margin:0;background:#00ff00"></body>`;
// Taller than Chromium's canvas side limit at DPR 2, so the result must be scaled.
PAGES['/tall'] = `<body style="margin:0">${bands(10, 2000)}</body>`;

// Default 8px body margin: the document overflows by 16px, yet the pane is what scrolls.
PAGES['/inner-margin'] = `<body style="height:100vh;overflow:hidden"><div style="height:50px;background:${HEADER}"></div>
  <div id="pane" style="position:absolute;top:50px;bottom:0;left:0;right:0;overflow:auto">${bands(8, 400)}</div></body>`;
// A web component whose fixed header lives in its shadow root.
PAGES['/shadow'] = `<body style="margin:0"><x-app>${bands(8, 500)}</x-app><script>
  customElements.define('x-app', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML =
        '<div style="position:fixed;top:0;left:0;right:0;height:60px;background:${HEADER}"></div><slot></slot>';
    }
  });</script></body>`;
// Wider than the viewport, with a marker column at the left edge.
PAGES['/wide'] = `<body style="margin:0;width:3000px"><div style="position:absolute;left:0;top:0;width:200px;height:3000px;background:#ff00ff"></div>${bands(6, 500)}</body>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.method) this.onEvent?.(msg);
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
  const page = PAGES[new URL(req.url, 'http://x').pathname];
  res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
  res.end(page || 'not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), 'pagesnap-e2e-'));
const browser = spawn(BROWSER, [
  // A visible window is colour-managed to the display's profile; sRGB keeps the
  // exact colour checks meaningful.
  ...(HEADED ? [`--auto-select-desktop-capture-source=${WINDOW_TITLE}`, '--force-color-profile=srgb'] : ['--headless=new']), `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
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
  // The service worker's console goes into failure messages.
  const workerLog = [];
  cdp.onEvent = (msg) => {
    if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'service_worker') {
      cdp.send('Runtime.enable', {}, msg.params.sessionId);
      cdp.send('Runtime.runIfWaitingForDebugger', {}, msg.params.sessionId);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      workerLog.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`.slice(0, 400));
      if (workerLog.length > 20) workerLog.shift();
    }
  };
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'service_worker' }] });
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
  // A trigger sent before the service worker registers opens the popup but
  // grants no activeTab, so wait for the worker first.
  await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos
    .some((t) => t.type === 'service_worker' && t.url.includes(extId)), 'service worker');

  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
  const attach = async (targetId) => (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const evaluate = async (session, expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Reads the toolbar title, where the extension reports errors, from one of
  // its own pages, so it works while the service worker is asleep.
  const extensionError = async () => {
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/viewer.html#none`, background: true });
    try {
      const session = await attach(targetId);
      return await waitFor(() => evaluate(session, 'chrome.action?.getTitle({})').catch(() => null), 'extension page', 5000);
    } finally {
      await cdp.send('Target.closeTarget', { targetId });
    }
  };

  // PAGESNAP_SHOTS=<dir> saves the popup and viewer as PNGs for a visual check.
  const shoot = async (session, name) => {
    if (!process.env.PAGESNAP_SHOTS) return;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
    await writeFile(join(process.env.PAGESNAP_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };

  // Clicking the popup the instant it opens can beat the activeTab grant, which
  // no person can do. The popup can read the active tab's URL only once the
  // grant has landed, so wait for exactly that.
  const granted = (popupSession, path) => waitFor(
    () => evaluate(popupSession, `chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t?.url === ${JSON.stringify(path)})`),
    `activeTab grant on ${path}`, 3000,
  ).catch(async (e) => {
    const seen = await evaluate(popupSession, 'chrome.tabs.query({}).then((ts) => ts.map((t) => [t.id, t.active, t.url ?? "-"]))');
    throw new Error(`${e.message}; popup sees ${JSON.stringify(seen)}`);
  });

  // Every tab gets a unique URL, so the tab to trigger is never confused with
  // an earlier tab of the same page.
  let opened = 0;
  const unique = (path) => `${origin}${path}?tab=${++opened}`;
  // Opens a page in a new tab, opens the real popup on it, and waits for the
  // activeTab grant to land.
  async function openPopup(path, setup) {
    const url = unique(path);
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const page = await attach(targetId);
    await evaluate(page, 'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))');
    if (setup) await setup(page);
    const tab = await waitFor(async () => (await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] }))
      .targetInfos.find((t) => t.url === url), `tab ${url}`);
    const seen = new Set((await targets()).map((t) => t.targetId));
    // Headless Brave now and then opens the popup without granting activeTab
    // to the tab; a person re-clicking the toolbar button is the same remedy.
    for (let attempt = 1; ; attempt++) {
      const before = new Set((await targets()).map((t) => t.targetId));
      await cdp.send('Extensions.triggerAction', { id: extId, targetId: tab.targetId });
      const popup = await waitFor(async () => (await targets()).find((t) => !before.has(t.targetId) && t.url.endsWith('/src/popup.html')), 'popup');
      const popupSession = await attach(popup.targetId);
      // Module scripts attach their listeners after the buttons exist; wait
      // for the load to finish so the click is not lost.
      await waitFor(() => evaluate(popupSession, 'document.readyState === "complete"'), 'popup ready');
      try {
        await granted(popupSession, url);
        for (const id of before) seen.add(id);
        seen.add(popup.targetId);
        return { targetId, page, popupSession, seen };
      } catch (e) {
        if (attempt === 3) throw e;
        await cdp.send('Target.closeTarget', { targetId: popup.targetId });
      }
    }
  }

  // Clicks a mode in the real popup and returns the session of the viewer tab it opens.
  async function capture(path, mode, beforeViewer, setup) {
    const { page, popupSession, seen } = await openPopup(path, setup);
    await shoot(popupSession, `popup-${mode}`);
    await evaluate(popupSession, `document.querySelector('[data-mode="${mode}"]').click()`);
    if (beforeViewer) await beforeViewer(page);
    const viewer = await waitFor(async () => (await targets()).find((t) => !seen.has(t.targetId) && t.url.includes('/src/viewer.html#')), 'viewer')
      .catch(async (e) => {
        const popupState = await evaluate(popupSession, 'document.querySelector(".status").textContent + " | disabled=" + document.querySelector("button").disabled').catch((err) => `popup gone (${err.message.slice(0, 40)})`);
        throw new Error(`${e.message}; badge: ${await extensionError()}; popup: ${popupState}; worker log:\n  ${workerLog.join('\n  ')}`);
      });
    const viewerSession = await attach(viewer.targetId);
    await waitFor(() => evaluate(viewerSession, 'document.querySelector("main img")?.complete && document.querySelector("main img").naturalWidth > 0'), 'image');
    await shoot(viewerSession, `viewer-${mode}`);
    const state = await evaluate(page, `({ y: scrollY, pane: document.getElementById('pane')?.scrollTop ?? 0 })`);
    return { viewer: viewerSession, page: { ...state, session: page } };
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

  // Counts pixels down one column that are not one of the expected colours:
  // a seam between frames shows up as a transparent or stale row.
  const strays = (session, x, palette) => evaluate(session, `(async () => {
    const img = document.querySelector('main img');
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(${x}, 0, 1, img.naturalHeight).data;
    const ok = new Set(${JSON.stringify(palette)});
    const bad = [];
    for (let i = 0; i < data.length; i += 4) {
      const hex = '#' + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      if (data[i + 3] !== 255 || !ok.has(hex)) bad.push(\`y=\${i / 4} \${hex}/\${data[i + 3]}\`);
    }
    return bad;
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
    const bad = await strays(viewer, 20, [HEADER, ...BANDS]);
    check(`${mode}: no seams between frames`, bad.length === 0, `${bad.length} stray px ${bad.slice(0, 6).join(', ')}`);
  }

  // Full page from a scrolled position still starts at the top of the document.
  {
    const { viewer, page } = await capture('/long', 'full', null, (p) => waitFor(() => evaluate(p, 'scrollTo(0, 2000), scrollY === 2000'), 'setup scroll'));
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
    const natural = 20000 * DPR;
    check(`${mode} tall: fits the canvas limit`, natural <= 32767 ? h === natural : h <= 32767 && h > 32000, `${w}x${h}`);
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

  // Inner pane found even when the document overflows by its body margin.
  for (const mode of ['full', 'scroll']) {
    const { viewer } = await capture('/inner-margin', mode);
    const [w, h] = await sample(viewer, []);
    check(`${mode} inner pane with body margin: pane content`, h === 3200 * DPR, `${w}x${h}`);
  }

  // Fixed header inside a shadow root appears once.
  {
    const { viewer } = await capture('/shadow', 'scroll');
    const [w, h, colors] = await sample(viewer, [[20, 30 * DPR], ...[1, 2, 3, 4, 5, 6, 7].map((i) => [20, (i * 500 + 30) * DPR])]);
    check('shadow DOM: header at the top', colors[0] === HEADER, colors[0]);
    check('shadow DOM: header not repeated', colors.slice(1).every((c) => c !== HEADER), colors.slice(1).join(' '));
  }

  // Horizontal scroll position does not shift the capture.
  {
    // A tab that has only just loaded can drop a scroll, so retry until it holds.
    const { viewer, page } = await capture('/wide', 'scroll', null, (p) => waitFor(() => evaluate(p, 'scrollTo(500, 0), scrollX === 500'), 'setup scroll'));
    const [w, h, colors] = await sample(viewer, [[20, 100 * DPR], [20, 2500 * DPR]]);
    check('wide: starts at the left edge', colors.every((c) => c === '#ff00ff'), colors.join(' '));
    const x = await evaluate(page.session, 'scrollX');
    check('wide: horizontal position restored', x === 500, `scrollX=${x}`);
  }

  // Switching tabs mid-capture fails cleanly instead of stitching another tab
  // into the image, and leaves the page as it was.
  {
    const { targetId, page, popupSession, seen } = await openPopup('/tall');
    await evaluate(popupSession, `document.querySelector('[data-mode="scroll"]').click()`);
    await sleep(1500);
    const other = await cdp.send('Target.createTarget', { url: origin + '/wide' });
    const error = await waitFor(async () => {
      const title = await extensionError();
      return title !== 'PageSnap' && title;
    }, 'capture error', 20_000).catch(() => 'no error reported');
    const viewer = (await targets()).find((t) => !seen.has(t.targetId) && t.url.includes('/src/viewer.html#') && !t.url.endsWith('#none'));
    check('tab switch: capture aborted with an error', !viewer && /switched|hidden/i.test(error), error);
    await cdp.send('Target.activateTarget', { targetId });
    await sleep(500);
    const left = await evaluate(page, `({ marks: document.querySelectorAll('[data-pagesnap-hide],[data-pagesnap-unstick]').length, y: scrollY })`);
    check('tab switch: page restored', left.marks === 0 && left.y === 0, JSON.stringify(left));
    await cdp.send('Target.closeTarget', { targetId: other.targetId });
  }

  // Window capture, headed only: picks this test's window through the flag.
  if (HEADED) {
    const { popupSession, seen } = await openPopup('/wintarget');
    await evaluate(popupSession, `document.querySelector('[data-mode="window"]').click()`);
    const viewer = await waitFor(async () => (await targets()).find((t) => !seen.has(t.targetId) && t.url.includes('/src/viewer.html#') && !t.url.endsWith('#none')), 'window viewer')
      .catch(async (e) => {
        const picker = (await targets()).find((t) => t.url.endsWith('/src/window.html'));
        const status = picker ? await evaluate(await attach(picker.targetId), 'document.querySelector("[role=status]").textContent') : 'picker closed';
        throw new Error(`${e.message}; picker: ${status}`);
      });
    const session = await attach(viewer.targetId);
    await waitFor(() => evaluate(session, 'document.querySelector("main img")?.complete && document.querySelector("main img").naturalWidth > 0'), 'window image');
    const [w, h] = await sample(session, []);
    const [, , colors] = await sample(session, [[Math.round(w / 2), Math.round(h / 2)]]);
    // Window capture travels as a video frame, whose colour conversion is off
    // by a unit or so; every other mode is compared exactly.
    const near = (hex, want) => [1, 3, 5].every((i) => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16)) <= 4);
    check('window: captured the target window', w > 200 && h > 200 && near(colors[0], '#00ff00'), `${w}x${h} centre ${colors[0]}`);
    const pickerLeft = (await targets()).some((t) => t.url.endsWith('/src/window.html'));
    check('window: picker window closed', !pickerLeft);
  }

  // Visible area.
  {
    let viewport;
    const { viewer } = await capture('/long', 'visible', async (page) => {
      viewport = await evaluate(page, '[innerWidth, innerHeight]');
    });
    const [w, h, colors] = await sample(viewer, [[20, 30 * DPR], [20, 300 * DPR]]);
    check('visible: viewport size', Math.abs(w - viewport[0] * DPR) <= 1 && Math.abs(h - viewport[1] * DPR) <= 1, `${w}x${h}`);
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
    const [w, h, colors] = await sample(viewer, [[10, 10], [100 * DPR, 75 * DPR], [195 * DPR, 145 * DPR]]);
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
