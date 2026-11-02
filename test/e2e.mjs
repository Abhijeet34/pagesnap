// End-to-end test: loads the unpacked extension into a throwaway headless
// Brave/Chrome profile, opens the real popup through Extensions.triggerAction
// (which grants activeTab like a toolbar click), clicks each capture mode and
// checks the pixels of the image the viewer tab shows.
//
//   node test/e2e.mjs [path-to-browser-binary]
//
// Window capture is not covered: it needs the system picker and a human.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';
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
// Snaps back from anything below 1500 px, as scroll-jacking pages do.
PAGES['/stuck'] = `<body style="margin:0">${bands(10, 500)}<script>addEventListener('scroll', () => { if (scrollY > 1500) scrollTo(0, 1500); });</script></body>`;
// Wider than one 16384-pixel render at 2x: the right edge must be real content.
PAGES['/verywide'] = `<body style="margin:0;width:9000px;height:600px;background:${BANDS[0]}"><div style="position:absolute;left:8800px;top:0;width:200px;height:600px;background:#ff00ff"></div></body>`;
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

// A solid-colour PNG, built by hand so the test needs no image library.
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const LAZY = '#00c853';
// Served slowly, as a real network image would be.
const lazyPng = png(400, 300, [0x00, 0xc8, 0x53]);
// Below the fold, so a one-pass render without scrolling sees a blank.
PAGES['/lazy'] = `<body style="margin:0"><div style="height:5000px;background:${BANDS[0]}"></div>
  <img loading="lazy" src="/lazy.png" width="400" height="300" style="display:block">
  <div style="height:1000px;background:${BANDS[1]}"></div></body>`;

const SHARE_DIR = join(EXT, 'share');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/lazy.png') {
    await sleep(300);
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(lazyPng);
  }
  if (pathname.startsWith('/share/')) {
    const file = pathname === '/share/' ? 'index.html' : pathname.slice('/share/'.length);
    if (!/^[\w.-]+$/.test(file)) return res.writeHead(404).end();
    try {
      const body = await readFile(join(SHARE_DIR, file));
      res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
      return res.end(body);
    } catch {
      return res.writeHead(404).end();
    }
  }
  const page = PAGES[pathname];
  res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
  res.end(page || 'not found');
});

// A minimal WebTorrent-style tracker (the same announce/offer/answer relay the
// public trackers run), so the share test needs no network. It records every
// relayed message so the test can check nothing readable passed through it.
const relayed = [];
const swarms = new Map();
const tracker = createServer();
tracker.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (obj) => {
    const data = Buffer.from(JSON.stringify(obj));
    const head = data.length < 126 ? Buffer.from([0x81, data.length])
      : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(data.length)); return b; })()]);
    if (!socket.destroyed) socket.write(Buffer.concat([head, data]));
  };
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const op = buffer[0] & 15;
      let len = buffer[1] & 127;
      let at = 2;
      if (len === 126) { len = buffer.readUInt16BE(2); at = 4; } else if (len === 127) { len = Number(buffer.readBigUInt64BE(2)); at = 10; }
      if (buffer.length < at + 4 + len) return;
      const mask = buffer.subarray(at, at + 4);
      const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      buffer = buffer.subarray(at + 4 + len);
      if (op === 8) return socket.end();
      if (op !== 1) continue;
      const msg = JSON.parse(payload.toString());
      relayed.push(msg);
      const swarm = swarms.get(msg.info_hash) ?? new Map();
      swarms.set(msg.info_hash, swarm);
      if (msg.event === 'stopped') { swarm.delete(msg.peer_id); continue; }
      swarm.set(msg.peer_id, send);
      if (msg.answer) {
        swarm.get(msg.to_peer_id)?.({ action: 'announce', info_hash: msg.info_hash, peer_id: msg.peer_id, offer_id: msg.offer_id, answer: msg.answer });
      }
      for (const offer of msg.offers ?? []) {
        for (const [peer, deliver] of swarm) {
          if (peer !== msg.peer_id) deliver({ action: 'announce', info_hash: msg.info_hash, peer_id: msg.peer_id, offer_id: offer.offer_id, offer: offer.offer });
        }
      }
    }
  });
  socket.on('error', () => {}); // a browser closing its tab drops the socket
});
await new Promise((r) => tracker.listen(0, '127.0.0.1', r));
const trackerUrl = `ws://127.0.0.1:${tracker.address().port}`;
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

  // PAGESNAP_SHOTS=<dir> saves the popup and viewer as PNGs for a visual check;
  // PAGESNAP_SCHEME=light|dark shoots them in that colour scheme.
  const shoot = async (session, name) => {
    if (!process.env.PAGESNAP_SHOTS) return;
    const scheme = process.env.PAGESNAP_SCHEME;
    if (scheme) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, session);
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
    // Stitched scrolling has no popup button; it is a shortcut-only mode, and
    // the popup sends the same request its shortcut does.
    await evaluate(popupSession, `(() => {
      const button = document.querySelector('[data-mode="${mode}"]');
      if (button) return button.click();
      chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => chrome.runtime.sendMessage({ type: 'capture', mode: '${mode}', tabId: t.id }));
    })()`);
    // Samples what the popup shows while the capture runs.
    const progress = [];
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        // A closed popup never answers, so each poll gives up after a moment.
        const seenNow = await Promise.race([
          evaluate(popupSession, `(() => { const p = document.querySelector('.progress'); return p && !p.hidden ? p.querySelector('.progress-label').textContent + ' ' + p.querySelector('.progress-value').textContent : null; })()`).catch(() => null),
          sleep(300).then(() => null),
        ]);
        if (seenNow && progress.at(-1) !== seenNow) {
          progress.push(seenNow);
          if (/\d+%/.test(seenNow) && progress.length === 3) await shoot(popupSession, `popup-progress-${mode}`).catch(() => {});
        }
        await sleep(40);
      }
    })();
    if (beforeViewer) await beforeViewer(page);
    const viewer = await waitFor(async () => (await targets()).find((t) => !seen.has(t.targetId) && t.url.includes('/src/viewer.html#')), 'viewer')
      .catch(async (e) => {
        const popupState = await evaluate(popupSession, 'document.querySelector(".status").textContent + " | disabled=" + document.querySelector("button").disabled').catch((err) => `popup gone (${err.message.slice(0, 40)})`);
        throw new Error(`${e.message}; badge: ${await extensionError()}; popup: ${popupState}; worker log:\n  ${workerLog.join('\n  ')}`);
      });
    const viewerSession = await attach(viewer.targetId);
    await waitFor(() => evaluate(viewerSession, 'document.querySelector("main img")?.complete && document.querySelector("main img").naturalWidth > 0'), 'image');
    await shoot(viewerSession, `viewer-${mode}`);
    watching = false;
    await watcher;
    const state = await evaluate(page, `({ y: scrollY, pane: document.getElementById('pane')?.scrollTop ?? 0 })`);
    return { viewer: viewerSession, page: { ...state, session: page }, progress, viewerTarget: viewer.targetId };
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
    // Unscaled, every row is exactly one band colour; a gap between render
    // tiles or stitched frames shows up as a stray row.
    if (natural <= 32767) {
      const bad = await strays(viewer, 5, BANDS.slice(0, 10));
      check(`${mode} tall: no seams`, bad.length === 0, bad.slice(0, 3).join(', ') || 'none');
    }
  }

  // Full page wider than one render: the far right is the page's own content.
  {
    const { viewer } = await capture('/verywide', 'full');
    const [w, h, colors] = await sample(viewer, [[5, 5], [Math.round(8900 * DPR), 5], [Math.round(8900 * DPR), Math.round(590 * DPR)]]);
    check('full very wide: whole width', w === 9000 * DPR, `${w}x${h}`);
    check('full very wide: right edge is real content', colors[1] === '#ff00ff' && colors[2] === '#ff00ff', colors.join(' '));
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
    await evaluate(popupSession, `chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => { chrome.runtime.sendMessage({ type: 'capture', mode: 'scroll', tabId: t.id }); })`);
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

  // Full page loads lazy images before rendering, and the popup shows real
  // progress while it does.
  {
    const { viewer, progress, page } = await capture('/lazy', 'full');
    const lazyState = await evaluate(page.session, '(() => { const i = document.querySelector("img"); return `complete=${i.complete} natural=${i.naturalWidth}`; })()');
    const [w, h, colors] = await sample(viewer, [[200 * DPR, 5150 * DPR], [20, 100 * DPR]]);
    check('lazy: below-the-fold image loaded in the capture', colors[0] === LAZY, `${w}x${h} ${colors[0]} page img ${lazyState}`);
    const percents = progress.map((p) => Number(p.match(/(\d+)%/)?.[1])).filter(Number.isFinite);
    check('progress: popup showed rising percentages', percents.length >= 2 && percents.at(-1) > percents[0], progress.join(' | '));
  }

  // Viewer: 100% is one image pixel per device pixel, Fit never enlarges, and
  // both download formats keep the full resolution.
  {
    const { viewer } = await capture('/long', 'visible');
    const [nw, nh] = await sample(viewer, []);
    // The format menu's two-line items must each get their own room.
    await evaluate(viewer, 'document.querySelector("#formats").showPopover()');
    await shoot(viewer, 'viewer-menu');
    const menu = await evaluate(viewer, `(() => {
      const m = document.querySelector('#formats');
      const [a, b] = [...m.querySelectorAll('button')].map((x) => x.getBoundingClientRect());
      const fits = [...m.querySelectorAll('button')].every((x) => x.scrollHeight <= x.clientHeight);
      return { apart: a.bottom <= b.top, fits, scrolls: m.scrollHeight > m.clientHeight };
    })()`);
    await evaluate(viewer, 'document.querySelector("#formats").hidePopover()');
    check('viewer menu: items neither overlap nor scroll', menu.apart && menu.fits && !menu.scrolls, JSON.stringify(menu));
    const css = (q) => evaluate(viewer, `(() => { const i = document.querySelector('main img'); return ${q}; })()`);
    await evaluate(viewer, 'document.querySelector(".zoom").click()');
    const actual = await css('[i.getBoundingClientRect().width * devicePixelRatio, document.querySelector(".zoom").getAttribute("aria-pressed")]');
    check('viewer 100%: one image pixel per device pixel', Math.abs(actual[0] - nw) <= 1 && actual[1] === 'true', `${actual[0]} device px for ${nw} px`);
    await evaluate(viewer, 'document.querySelector(".zoom").click()');
    // The stage's own box, not clientWidth: at 1.5x it is 1478 device px, or
    // 985.33 css px, which clientWidth rounds to an integer, 985, just below the image
    // that exactly fills it. The stage has no side padding, so its box is
    // the width max-width: 100% resolves against.
    const fit = await css('[i.getBoundingClientRect().width, document.querySelector(".stage").getBoundingClientRect().width]');
    check('viewer Fit: within the window, never enlarged', fit[0] <= fit[1] && fit[0] * DPR <= nw + 1, `${fit[0]} of ${fit[1]} css px`);
    // A full page is as wide as the window it came from; at Fit it must stay
    // pixel for pixel, since even a 3% shrink resamples and blurs the text.
    {
      const { viewer: full } = await capture('/long', 'full');
      const [fw] = await sample(full, []);
      const shown = await evaluate(full, 'document.querySelector("main img").getBoundingClientRect().width * devicePixelRatio');
      check('viewer Fit: a window-wide capture shows pixel for pixel', Math.abs(shown - fw) <= 1, `${shown} device px for ${fw} px`);
    }

    const downloads = await mkdtemp(join(tmpdir(), 'pagesnap-downloads-'));
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    const fileOf = (ext) => waitFor(async () => (await readdir(downloads)).find((f) => f.endsWith(ext)), `${ext} download`);
    await evaluate(viewer, 'document.querySelector(".download").click()');
    const pngFile = await readFile(join(downloads, await fileOf('.png')));
    const pngDims = [pngFile.readUInt32BE(16), pngFile.readUInt32BE(20)];
    check('download PNG: full resolution', pngDims[0] === nw && pngDims[1] === nh, pngDims.join('x'));
    await evaluate(viewer, 'document.querySelector(".more").click(); document.querySelector(\'[data-format="jpeg"]\').click()');
    const jpg = await readFile(join(downloads, await fileOf('.jpg')));
    // Width and height sit in the first SOF marker of a JPEG.
    let jpgDims = null;
    for (let i = 2; i < jpg.length - 9 && !jpgDims;) {
      const marker = jpg[i + 1];
      if (marker >= 0xc0 && marker <= 0xc3) jpgDims = [jpg.readUInt16BE(i + 7), jpg.readUInt16BE(i + 5)];
      i += 2 + jpg.readUInt16BE(i + 2);
    }
    check('download JPG: full resolution', jpgDims?.[0] === nw && jpgDims?.[1] === nh, String(jpgDims));
    await rm(downloads, { recursive: true, force: true });
  }

  // Share: the image goes peer to peer through the local tracker; both sides
  // agree on the code, the bytes arrive intact, nothing readable crosses the
  // tracker, and the key leaves the recipient's address bar.
  {
    const { viewer, viewerTarget } = await capture('/long', 'visible');
    // PAGESNAP_LIVE=1 uses the real public trackers and STUN servers, as
    // shipped links do; otherwise everything stays on this machine.
    // PAGESNAP_PUBLISHED=1 goes further: no overrides at all, so the shipped
    // receiver page, trackers and STUN servers are exactly what is tested.
    const LIVE = process.env.PAGESNAP_LIVE === '1' || process.env.PAGESNAP_PUBLISHED === '1';
    const receiverUrl = LIVE ? `${origin}/share/` : `${origin}/share/?tracker=${encodeURIComponent(trackerUrl)}`;
    if (process.env.PAGESNAP_PUBLISHED !== '1') {
      await evaluate(viewer, `chrome.storage.local.set(${JSON.stringify(LIVE ? { receiverUrl } : { receiverUrl, trackers: [trackerUrl], iceServers: [] })})`);
    }
    await evaluate(viewer, 'location.reload()');
    await sleep(300);
    const sender = await attach(viewerTarget);
    await waitFor(() => evaluate(sender, '!document.querySelector(".share")?.hidden'), 'share button');
    const original = await evaluate(sender, `(async () => {
      const blob = await (await fetch(document.querySelector('main img').src)).blob();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
    })()`);

    const openShare = async () => {
      await evaluate(sender, 'document.querySelector(".share").click()');
      return waitFor(() => evaluate(sender, 'document.querySelector(".sheet .link").value || null'), 'share link');
    };
    const openReceiver = async (link) => {
      const { targetId } = await cdp.send('Target.createTarget', { url: link });
      const session = await attach(targetId);
      await waitFor(() => evaluate(session, 'document.readyState === "complete"'), 'receiver page');
      return session;
    };

    const link = await openShare();
    await sleep(300);
    await shoot(sender, 'share-waiting');
    const fieldKeepsCopy = await evaluate(sender, `(() => {
      const e = new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true });
      document.querySelector('.sheet .link').dispatchEvent(e);
      return !e.defaultPrevented;
    })()`);
    check('share: Cmd+C in the link field copies the link, not the image', fieldKeepsCopy);
    check('share: link carries only a 22-character key in the fragment', /#[A-Za-z0-9_-]{22}$/.test(link), link.replace(/#.*/, '#…'));
    const receiver = await openReceiver(link);
    const cleared = await waitFor(() => evaluate(receiver, 'location.hash === "" && location.href.startsWith("http")'), 'key cleared', 5000).catch(() => false);
    check('share: key removed from the recipient\'s address bar', cleared, await evaluate(receiver, 'location.href.replace(/#.+/, "#…")'));
    const receiverCode = await waitFor(() => evaluate(receiver, 'document.querySelector(".code").textContent || null'), 'receiver code', 20_000);
    const senderCode = await waitFor(() => evaluate(sender, '!document.querySelector(".request").hidden && document.querySelector(".sheet .code").textContent'), 'sender code', 20_000);
    check('share: both sides show the same code', /^\d{4}$/.test(receiverCode) && receiverCode === senderCode, `${senderCode} / ${receiverCode}`);
    await shoot(sender, 'share-request');
    await shoot(receiver, 'receiver-code');
    await evaluate(sender, 'document.querySelector(".sheet .send").click()');
    await waitFor(() => evaluate(receiver, '!document.querySelector(".result").hidden'), 'image received', 20_000);
    // The receiver page's CSP rightly blocks fetch(), so the bytes are checked
    // the way a recipient gets them: through its Download link.
    const inbox = await mkdtemp(join(tmpdir(), 'pagesnap-inbox-'));
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: inbox });
    await evaluate(receiver, 'document.querySelector(".result .download").click()');
    const file = await waitFor(async () => (await readdir(inbox)).find((f) => f.endsWith('.png')), 'received download');
    const received = createHash('sha256').update(await readFile(join(inbox, file))).digest('hex');
    await rm(inbox, { recursive: true, force: true });
    check('share: received bytes identical to the capture', received === original, `${received.slice(0, 12)} / ${original.slice(0, 12)}`);
    await waitFor(() => evaluate(sender, '!document.querySelector(".sent").hidden'), 'sender sees sent');
    await shoot(sender, 'share-sent');
    await shoot(receiver, 'receiver-result');
    check('share: link is one-time', (await evaluate(sender, 'document.querySelector(".sheet .link").value')) === '');
    const plain = relayed.filter((m) => /v=0|a=fingerprint|a=candidate/.test(JSON.stringify(m)));
    if (!LIVE) check('share: tracker never saw a readable connection offer', relayed.some((m) => m.offers?.length) && plain.length === 0, `${relayed.length} messages, ${plain.length} readable`);

    // Decline: a second link, and the recipient is turned away.
    await evaluate(sender, 'document.querySelector(".sheet .stop").click()');
    const secondLink = await openShare();
    const second = await openReceiver(secondLink);
    const firstCode = await waitFor(() => evaluate(sender, '!document.querySelector(".request").hidden && document.querySelector(".sheet .code").textContent'), 'second request', 20_000);
    // A second recipient arriving now must wait its turn, not be dropped.
    const third = await openReceiver(secondLink);
    await waitFor(() => evaluate(third, 'document.querySelector(".status")?.textContent.startsWith("Connected")'), 'third connected', 20_000);
    const secondCode = await evaluate(second, 'document.querySelector(".code").textContent');
    check('share: the request shows the recipient\'s code', firstCode === secondCode, `${firstCode} / ${secondCode}`);
    await evaluate(sender, 'document.querySelector(".sheet .decline").click()');
    const declined = await waitFor(() => evaluate(second, 'document.querySelector("h1").textContent.includes("declined") && document.querySelector("h1").textContent'), 'declined', 10_000);
    check('share: declined recipient receives nothing', declined && (await evaluate(second, 'document.querySelector(".result").hidden')), declined);
    const thirdCode = await waitFor(() => evaluate(third, 'document.querySelector(".code").textContent || null'), 'third code', 20_000);
    const queued = await waitFor(() => evaluate(sender, `!document.querySelector(".request").hidden && document.querySelector(".sheet .code").textContent === ${JSON.stringify(thirdCode)}`), 'queued request', 20_000).catch(() => false);
    check('share: a recipient who arrived meanwhile is shown next', queued, thirdCode);
    await evaluate(sender, 'document.querySelector(".sheet .decline").click()');

    // Keyless arrivals name their real cause rather than one generic error.
    await evaluate(second, 'location.reload()');
    await sleep(300);
    const reloaded = await waitFor(() => evaluate(second, 'document.readyState === "complete" && document.querySelector("h1").textContent'), 'reloaded page');
    check('share: reloading the receiver explains the key is gone', reloaded === 'This page was reloaded', reloaded);
    const bare = await openReceiver(link.replace(/#.*/, ''));
    // The new tab reports complete for its initial blank document, so wait
    // for the receiver's own verdict instead.
    const keyless = await waitFor(() => evaluate(bare, '(h => h && h !== "Receiving a screenshot" && h)(document.querySelector("h1")?.textContent)'), 'keyless page')
      .catch(() => evaluate(bare, 'document.querySelector("h1")?.textContent'));
    check('share: a link without its key says so', keyless === 'This link has no key', keyless);
    await evaluate(sender, 'document.querySelector(".sheet .stop").click()');
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
  {
    const { viewer } = await capture('/long', 'area', drag);
    const [w, h, colors] = await sample(viewer, [[10, 10], [100 * DPR, 75 * DPR], [195 * DPR, 145 * DPR]]);
    check('area: crop size', w === Math.round(200 * DPR) && h === Math.round(150 * DPR), `${w}x${h}`);
    check('area: no overlay tint in the crop', colors.every((c) => c === BANDS[0]), colors.join(' '));
  }

  // A page that deletes the overlay must not lock area capture until reload.
  {
    const overlay = (page) => waitFor(() => evaluate(page, 'document.documentElement.lastElementChild.tagName === "DIV"'), 'area overlay');
    const { viewer } = await capture('/long', 'area', async (page) => {
      await overlay(page);
      await evaluate(page, 'document.documentElement.lastElementChild.remove()');
      const url = await evaluate(page, 'location.href');
      const tab = (await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find((t) => t.url === url);
      const before = new Set((await targets()).map((t) => t.targetId));
      await cdp.send('Extensions.triggerAction', { id: extId, targetId: tab.targetId });
      const popup = await waitFor(async () => (await targets()).find((t) => !before.has(t.targetId) && t.url.endsWith('/src/popup.html')), 'second popup');
      const session = await attach(popup.targetId);
      await waitFor(() => evaluate(session, 'document.readyState === "complete"'), 'second popup ready');
      await evaluate(session, 'document.querySelector("[data-mode=area]").click()');
      await drag(page);
    });
    const [w, h] = await sample(viewer, []);
    check('area: works again after the page removed the overlay', w === Math.round(200 * DPR) && h === Math.round(150 * DPR), `${w}x${h}`);
  }

  // A page that will not scroll further says so instead of looking complete.
  {
    const { viewer } = await capture('/stuck', 'scroll');
    const detail = await evaluate(viewer, 'document.querySelector(".meta p").textContent');
    check('scroll: a stalled page is marked as stopped early', detail.includes('Stopped early'), detail);
  }

  // Every capture above has ended, so none may leave the popup locked.
  {
    const { popupSession } = await openPopup('/long');
    const left = await evaluate(popupSession, 'chrome.storage.session.get().then((all) => Object.keys(all).filter((k) => k.startsWith("progress:")))');
    const disabled = await evaluate(popupSession, 'document.querySelector("button[data-mode]").disabled');
    check('popup: no capture leaves progress behind', left.length === 0 && !disabled, left.join(' ') || 'none');
  }
} catch (e) {
  console.error(e);
  failures++;
} finally {
  // The profile can only be deleted once the browser has let go of it;
  // deleting straight after kill() left a profile behind on every run.
  const exited = browser.exitCode !== null || once(browser, 'exit');
  browser.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL');
  server.close();
  tracker.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch((e) => console.error(`Could not delete the test profile ${profile}: ${e.message}`));
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
