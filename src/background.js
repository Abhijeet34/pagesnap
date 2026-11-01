import { armArea, putShot, takeArea } from './store.js';

// captureVisibleTab is limited to 2 calls per second per extension.
const CAPTURE_GAP_MS = 550;
// Chromium refuses canvases past 32767 px on a side or 268M px in area.
const MAX_SIDE = 32767;
const MAX_AREA = 16384 * 16384;
// Page.captureScreenshot repeats content past this many output pixels on
// either side, so larger full-page shots are taken in tiles.
const MAX_TILE = 16384;
const MAX_FRAMES = 200;
// Bounds on the lazy-load pass before a full-page render.
const WARM_STEPS = 60;
const WARM_SETTLE_MS = 3000;
const MODES = ['visible', 'full', 'scroll', 'area', 'window'];
const EXTENSION_ORIGIN = chrome.runtime.getURL('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Two captures on one tab would scroll it against each other.
const busy = new Set();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  // Capture requests come only from the extension's own popup; a content
  // script, which shares a process with the web page, cannot start one.
  if (msg?.type === 'capture' && !sender.tab && sender.url?.startsWith(EXTENSION_ORIGIN)) {
    run(msg.mode, msg.tabId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: fail(e) }));
    return true;
  }
  if (msg?.type === 'area-selected' && sender.tab && sender.frameId === 0) {
    captureArea(sender.tab, msg.rect, msg.viewportWidth).catch(fail);
    // Answer so the sender's promise settles instead of rejecting on a closed port.
    sendResponse({});
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  run(command, tab?.id).catch(fail);
});

// The popup is usually closed by the time a capture fails, so the error also
// goes on the toolbar badge where the user can still see it.
function fail(e) {
  const message = e?.message || String(e);
  console.error('PageSnap:', e);
  chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setTitle({ title: `PageSnap: ${message}` });
  return message;
}

function clearError() {
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: 'PageSnap' });
}

async function run(mode, tabId) {
  if (!MODES.includes(mode)) throw new Error(`Unknown capture mode: ${mode}`);
  clearError();
  if (mode === 'window') {
    await chrome.windows.create({ url: 'src/window.html', type: 'popup', width: 440, height: 300 });
    return;
  }
  const tab = await chrome.tabs.get(tabId);
  if (mode === 'area') {
    await armArea(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/area.js'] });
    return;
  }
  if (busy.has(tab.id)) throw new Error('A capture is already running on this tab.');
  busy.add(tab.id);
  try {
    await { visible: captureVisible, full: captureFull, scroll: captureScroll }[mode](tab);
  } finally {
    busy.delete(tab.id);
    await endProgress(tab);
  }
}

// Progress lives in session storage, so a popup opened mid-capture picks it
// up, and on the tab's badge, which shows it when no popup is open. `value`
// is 0..1, or null while the length of a step is unknown.
const PROGRESS_STEP_MS = 150;
const lastProgress = new Map();

async function progress(tab, label, value = null) {
  const now = Date.now();
  // Badge and storage writes are cheap but not free; a few per second is plenty.
  if (value !== null && value < 1 && now - (lastProgress.get(tab.id) ?? 0) < PROGRESS_STEP_MS) return;
  lastProgress.set(tab.id, now);
  await chrome.storage.session.set({ [`progress:${tab.id}`]: { label, value, at: now } });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#1c1c1e' });
  await chrome.action.setBadgeText({ tabId: tab.id, text: value === null ? '…' : `${Math.round(value * 100)}%` });
}

async function endProgress(tab) {
  lastProgress.delete(tab.id);
  await chrome.storage.session.remove(`progress:${tab.id}`);
  // null hands the badge back to the global one, which carries any error.
  await chrome.action.setBadgeText({ tabId: tab.id, text: null }).catch(() => {}); // best effort: the tab may have closed
}

// captureVisibleTab grabs whatever tab is showing in the window, so every grab
// is bracketed by a check that it is still the tab being captured.
async function ensureShowing(tab) {
  const now = await chrome.tabs.get(tab.id).catch(() => null);
  if (!now || !now.active || now.windowId !== tab.windowId) {
    throw new Error('Capture stopped: the tab was switched or closed.');
  }
}

// The quota is per extension, not per capture, so every grab shares one clock.
let lastGrab = 0;

async function grabBlob(tab) {
  for (let attempt = 1; ; attempt++) {
    await sleep(Math.max(0, lastGrab + CAPTURE_GAP_MS - Date.now()));
    await ensureShowing(tab);
    lastGrab = Date.now();
    try {
      const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      await ensureShowing(tab);
      return (await fetch(url)).blob();
    } catch (e) {
      // A restarted worker has lost the clock above; one wait covers that.
      if (attempt > 1 || !/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(e.message)) throw e;
      await sleep(1000);
    }
  }
}

async function grab(tab) {
  return createImageBitmap(await grabBlob(tab));
}

// Reads the size from the PNG header instead of decoding the whole image.
async function pngSize(blob) {
  const view = new DataView(await blob.slice(16, 24).arrayBuffer());
  return [view.getUint32(0), view.getUint32(4)];
}

async function save(tab, mode, blob, width, height, note = '') {
  await progress(tab, 'Saving');
  const id = await putShot(blob, { mode, width, height, note, title: tab.title || '', url: tab.url || '' });
  await chrome.tabs.create({ url: `src/viewer.html#${id}`, index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId });
}

function fit(width, height) {
  return Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
}

async function encode(canvas) {
  return canvas.convertToBlob({ type: 'image/png' });
}

async function captureVisible(tab) {
  const blob = await grabBlob(tab);
  await save(tab, 'visible', blob, ...(await pngSize(blob)));
}

async function captureArea(tab, rect, viewportWidth) {
  // Only a selection the user armed from the popup or a shortcut counts.
  if (!(await takeArea(tab.id))) return;
  const numbers = [rect?.x, rect?.y, rect?.w, rect?.h, viewportWidth];
  if (!numbers.every(Number.isFinite) || viewportWidth <= 0 || rect.w < 1 || rect.h < 1) return;
  clearError();
  const bitmap = await grab(tab);
  try {
    const ratio = bitmap.width / viewportWidth;
    const sx = Math.min(Math.max(0, Math.round(rect.x * ratio)), bitmap.width - 1);
    const sy = Math.min(Math.max(0, Math.round(rect.y * ratio)), bitmap.height - 1);
    const w = Math.max(1, Math.min(Math.round(rect.w * ratio), bitmap.width - sx));
    const h = Math.max(1, Math.min(Math.round(rect.h * ratio), bitmap.height - sy));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
    await save(tab, 'area', await encode(canvas), w, h);
  } finally {
    bitmap.close();
    await endProgress(tab);
  }
}

async function inPage(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result.result;
}

// Full page renders the whole document through the DevTools protocol, the
// same path as DevTools' "Capture full size screenshot". Page measurements
// come from the extension's isolated world, never from page script. It falls
// back to scroll-and-stitch when the real scroller is an inner pane, when
// another debugger holds the tab, or when the render fails.
async function captureFull(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page.js'] });
  const probe = await inPage(tab.id, () => globalThis.__pagesnap.probe());
  if (probe.inner) return captureScroll(tab);
  let shot = null;
  try {
    await warm(tab);
    const target = { tabId: tab.id };
    let attached = false;
    try {
      await chrome.debugger.attach(target, '1.3');
      attached = true;
      await progress(tab, 'Capturing', 0.5);
      shot = await renderFull(
        (method, params) => chrome.debugger.sendCommand(target, method, params),
        probe.dpr,
        (done) => progress(tab, 'Capturing', 0.5 + done * 0.45),
      );
    } catch (e) {
      // The scroll capture below still gets the page.
      console.warn('PageSnap: full-page render failed, falling back to scrolling capture', e);
    } finally {
      if (attached) await chrome.debugger.detach(target).catch(() => {}); // best effort: the tab may have closed
    }
  } finally {
    await inPage(tab.id, () => globalThis.__pagesnap.restore()).catch(() => {}); // best effort: page.js restores itself on a timer too
  }
  if (!shot) return captureScroll(tab);
  // The debugger renders whatever the tab shows now; a page that navigated
  // elsewhere mid-capture is not the one the user chose.
  const origin = (url) => { try { return new URL(url).origin; } catch { return null; } };
  if (origin((await chrome.tabs.get(tab.id)).url) !== origin(tab.url)) throw new Error('Capture stopped: the page navigated away.');
  await save(tab, 'full', shot.blob, shot.width, shot.height);
}

// Scrolls down the page once so lazy images load, then back to the top.
// Counts as the first half of the progress bar.
async function warm(tab) {
  let y = 0;
  for (let step = 0; step < WARM_STEPS; step++) {
    const pos = await inPage(tab.id, (to) => globalThis.__pagesnap.peek(to), [y]);
    const end = pos.top + pos.clientHeight >= pos.scrollHeight - 1;
    await progress(tab, 'Loading the whole page', Math.min(1, (pos.top + pos.clientHeight) / pos.scrollHeight) * 0.5);
    // Offsets snap to device pixels, so at fractional ratios the page lands a
    // fraction short of the requested position; only a real stall ends it.
    if (end || pos.top < y - 1) break;
    y = pos.top + pos.clientHeight;
  }
  await inPage(tab.id, (ms) => globalThis.__pagesnap.settle(ms), [WARM_SETTLE_MS]);
}

async function renderFull(send, dpr, onProgress) {
  if (!(dpr > 0 && dpr <= 16)) throw new Error(`Unexpected device pixel ratio ${dpr}`);
  const { cssContentSize: css } = await send('Page.getLayoutMetrics');
  const width = Math.max(1, Math.ceil(css.width));
  const height = Math.max(1, Math.ceil(css.height));
  const scale = fit(width * dpr, height * dpr);
  const ratio = dpr * scale;
  const tile = Math.max(1, Math.floor(MAX_TILE / ratio));
  const shoot = async (x, y, w, h) => {
    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x, y, width: w, height: h, scale },
    });
    return (await fetch(`data:image/png;base64,${data}`)).blob();
  };

  if (width <= tile && height <= tile) {
    const blob = await shoot(0, 0, width, height);
    const [w, h] = await pngSize(blob);
    return { blob, width: w, height: h };
  }
  const canvas = new OffscreenCanvas(Math.round(width * ratio), Math.round(height * ratio));
  const ctx = canvas.getContext('2d');
  const total = Math.ceil(width / tile) * Math.ceil(height / tile);
  let done = 0;
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) {
      await onProgress(done++ / total);
      const bitmap = await createImageBitmap(await shoot(x, y, Math.min(tile, width - x), Math.min(tile, height - y)));
      try {
        ctx.drawImage(bitmap, Math.round(x * ratio), Math.round(y * ratio));
      } finally {
        bitmap.close();
      }
    }
  }
  return { blob: await encode(canvas), width: canvas.width, height: canvas.height };
}

// Frames are drawn as they arrive so only one full-size bitmap is alive at a
// time; the canvas grows if lazy content makes the page longer.
async function captureScroll(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page.js'] });
  const info = await inPage(tab.id, () => globalThis.__pagesnap.prepare());
  let canvas;
  let ctx;
  let ratio;
  let k;
  let scale;
  let cap;
  let bottom = 0;
  let cut = false;
  let stalled = false;
  try {
    let y = 0;
    let lastTop = -1;
    for (let frames = 0; ; frames++) {
      if (frames === MAX_FRAMES) {
        cut = true;
        break;
      }
      const pos = await inPage(tab.id, (to) => globalThis.__pagesnap.scrollTo(to), [y]);
      if (!pos.visible) throw new Error('Capture stopped: the tab was hidden.');
      if (pos.top <= lastTop) {
        stalled = true;
        break;
      }
      lastTop = pos.top;
      const bitmap = await grab(tab);
      try {
        const { region } = pos;
        if (!canvas) {
          ratio = bitmap.width / info.viewportWidth;
          scale = fit(info.region.w * ratio, info.scrollHeight * ratio);
          k = ratio * scale;
          const width = Math.max(1, Math.round(info.region.w * k));
          cap = Math.min(MAX_SIDE, Math.floor(MAX_AREA / width));
          canvas = new OffscreenCanvas(width, Math.max(1, Math.min(cap, Math.round(info.scrollHeight * k))));
          ctx = canvas.getContext('2d');
        }
        const atEnd = pos.top + pos.clientHeight >= pos.scrollHeight - 1;
        // Stitching works in device pixels: scroll offsets snap to them, so a
        // frame copies 1:1 into place, with no resampling that would blur the
        // rows where frames meet. Only a page past the canvas limit is scaled.
        const sx = Math.round(region.x * ratio);
        const sy = Math.round(region.y * ratio);
        const sw = Math.round((region.x + region.w) * ratio) - sx;
        const sh = Math.round((region.y + region.h) * ratio) - sy;
        // The last frame is pinned to the true bottom, because the final
        // offset is clamped and snapped rather than where it was asked to be.
        const top = atEnd ? Math.round(pos.scrollHeight * ratio) - sh : Math.round(pos.top * ratio);
        const y0 = Math.round(top * scale);
        const y1 = Math.round((top + sh) * scale);
        if (y1 > cap) cut = true;
        if (y1 > canvas.height) {
          // Pages that keep loading more grow on every frame; growing by half
          // again bounds the number of full-canvas copies.
          const grown = new OffscreenCanvas(canvas.width, Math.min(cap, Math.max(y1, Math.round(pos.scrollHeight * k), Math.round(canvas.height * 1.5))));
          grown.getContext('2d').drawImage(canvas, 0, 0);
          canvas = grown;
          ctx = canvas.getContext('2d');
        }
        ctx.drawImage(bitmap, sx, sy, sw, sh, 0, y0, canvas.width, y1 - y0);
        bottom = Math.min(y1, cap);
        await progress(tab, 'Capturing', Math.min(0.95, (pos.top + region.h) / pos.scrollHeight));
        if (cut || atEnd) break;
        // One CSS pixel of overlap: at fractional ratios the next offset can
        // snap just past this frame's bottom and leave a gap row.
        y = pos.top + region.h - 1;
      } finally {
        bitmap.close();
      }
    }
  } finally {
    await inPage(tab.id, () => globalThis.__pagesnap.restore()).catch(() => {}); // best effort: page.js restores itself on a timer too
  }
  if (!canvas) throw new Error('Nothing was captured.');
  if (bottom < canvas.height) {
    // The page got shorter while scrolling, or the canvas grew ahead of it.
    const trimmed = new OffscreenCanvas(canvas.width, bottom);
    trimmed.getContext('2d').drawImage(canvas, 0, 0);
    canvas = trimmed;
  }
  const note = cut ? 'Cut off: the page is longer than the largest image the browser can make.'
    : stalled ? 'Stopped early: the page would not scroll any further.' : '';
  await save(tab, 'scroll', await encode(canvas), canvas.width, canvas.height, note);
}
