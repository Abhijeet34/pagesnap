import { putShot } from './store.js';

// captureVisibleTab is limited to 2 calls per second per extension.
const CAPTURE_GAP_MS = 550;
// Chromium refuses canvases past 32767 px on a side or 268M px in area.
const MAX_SIDE = 32767;
const MAX_AREA = 16384 * 16384;
// Page.captureScreenshot repeats content past this many output pixels, so
// taller full-page shots are taken in tiles.
const MAX_TILE = 16384;
const MAX_FRAMES = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Two captures on one tab would scroll it against each other.
const busy = new Set();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'capture') {
    run(msg.mode, msg.tabId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: fail(e) }));
    return true;
  }
  if (msg.type === 'area-selected' && sender.tab) {
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
  clearError();
  if (mode === 'window') {
    await chrome.windows.create({ url: 'src/window.html', type: 'popup', width: 440, height: 300 });
    return;
  }
  const tab = await chrome.tabs.get(tabId);
  if (mode === 'area') {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/area.js'] });
    return;
  }
  const capture = { visible: captureVisible, full: captureFull, scroll: captureScroll }[mode];
  if (!capture) throw new Error(`Unknown capture mode: ${mode}`);
  if (busy.has(tab.id)) throw new Error('A capture is already running on this tab.');
  busy.add(tab.id);
  try {
    await capture(tab);
  } finally {
    busy.delete(tab.id);
  }
}

async function grabBlob(windowId) {
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  return (await fetch(url)).blob();
}

async function grab(windowId) {
  return createImageBitmap(await grabBlob(windowId));
}

// Reads the size from the PNG header instead of decoding the whole image.
async function pngSize(blob) {
  const view = new DataView(await blob.slice(16, 24).arrayBuffer());
  return [view.getUint32(0), view.getUint32(4)];
}

async function save(tab, mode, blob, width, height) {
  const id = await putShot(blob, { mode, width, height, title: tab.title || '', url: tab.url || '' });
  await chrome.tabs.create({ url: `src/viewer.html#${id}`, index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId });
}

function fit(width, height) {
  return Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
}

async function encode(canvas) {
  return canvas.convertToBlob({ type: 'image/png' });
}

async function captureVisible(tab) {
  const blob = await grabBlob(tab.windowId);
  await save(tab, 'visible', blob, ...(await pngSize(blob)));
}

async function captureArea(tab, rect, viewportWidth) {
  clearError();
  const bitmap = await grab(tab.windowId);
  const ratio = bitmap.width / viewportWidth;
  const sx = Math.round(rect.x * ratio);
  const sy = Math.round(rect.y * ratio);
  const w = Math.min(Math.round(rect.w * ratio), bitmap.width - sx);
  const h = Math.min(Math.round(rect.h * ratio), bitmap.height - sy);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
  bitmap.close();
  await save(tab, 'area', await encode(canvas), w, h);
}

// Full page renders the whole document through the DevTools protocol, the
// same path as DevTools' "Capture full size screenshot". It falls back to
// scroll-and-stitch when another debugger holds the tab, and when the
// document itself does not scroll (app layouts with an inner scroll pane).
async function captureFull(tab) {
  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    if (/already attached|another debugger/i.test(e.message)) return captureScroll(tab);
    throw e;
  }
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  let start;
  let shot;
  try {
    // Fixed headers render where the viewport is, so the shot is taken from
    // the top and the user's position is put back afterwards.
    start = await evaluate(`(async () => {
      const at = [scrollX, scrollY];
      scrollTo({ left: 0, top: 0, behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { at, dpr: devicePixelRatio };
    })()`);
    shot = await renderFull(send, start.dpr);
  } finally {
    if (start) await evaluate(`scrollTo({ left: ${start.at[0]}, top: ${start.at[1]}, behavior: 'instant' })`).catch(() => {}); // best effort: the tab may have navigated
    await chrome.debugger.detach(target).catch(() => {}); // best effort: the tab may have closed
  }
  if (!shot) return captureScroll(tab);
  await save(tab, 'full', shot.blob, shot.width, shot.height);
}

// Returns null when the document does not scroll.
async function renderFull(send, dpr) {
  const { cssContentSize: css, cssLayoutViewport: viewport } = await send('Page.getLayoutMetrics');
  if (css.height <= viewport.clientHeight + 1) return null;
  const width = Math.max(1, Math.ceil(css.width));
  const height = Math.ceil(css.height);
  const scale = fit(width * dpr, height * dpr);
  const tileHeight = Math.floor(MAX_TILE / (dpr * scale));
  const shoot = async (y, h) => {
    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y, width, height: h, scale },
    });
    return (await fetch(`data:image/png;base64,${data}`)).blob();
  };

  if (height <= tileHeight) {
    const blob = await shoot(0, height);
    const [w, h] = await pngSize(blob);
    return { blob, width: w, height: h };
  }
  const ratio = dpr * scale;
  const canvas = new OffscreenCanvas(Math.round(width * ratio), Math.round(height * ratio));
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < height; y += tileHeight) {
    const bitmap = await createImageBitmap(await shoot(y, Math.min(tileHeight, height - y)));
    ctx.drawImage(bitmap, 0, Math.round(y * ratio));
    bitmap.close();
  }
  return { blob: await encode(canvas), width: canvas.width, height: canvas.height };
}

async function inPage(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result.result;
}

// Frames are drawn as they arrive so only one full-size bitmap is alive at a
// time; the canvas grows if lazy content makes the page longer.
async function captureScroll(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page.js'] });
  const info = await inPage(tab.id, () => globalThis.__pagesnap.prepare());
  let canvas;
  let ctx;
  let ratio;
  let scale;
  let bottom = 0;
  try {
    let y = 0;
    let lastTop = -1;
    let lastShot = 0;
    for (let frames = 0; frames < MAX_FRAMES; frames++) {
      const pos = await inPage(tab.id, (to) => globalThis.__pagesnap.scrollTo(to), [y]);
      if (pos.top <= lastTop) break;
      lastTop = pos.top;
      await sleep(Math.max(0, lastShot + CAPTURE_GAP_MS - Date.now()));
      lastShot = Date.now();
      const bitmap = await grab(tab.windowId);
      const { region } = pos;
      if (!canvas) {
        ratio = bitmap.width / info.viewportWidth;
        scale = fit(info.region.w * ratio, info.scrollHeight * ratio);
        canvas = new OffscreenCanvas(Math.round(info.region.w * ratio * scale), Math.round(info.scrollHeight * ratio * scale));
        ctx = canvas.getContext('2d');
      }
      const k = ratio * scale;
      const end = Math.min(Math.round((pos.top + region.h) * k), MAX_SIDE);
      if (end > canvas.height) {
        const grown = new OffscreenCanvas(canvas.width, Math.min(MAX_SIDE, Math.max(end, Math.round(pos.scrollHeight * k))));
        grown.getContext('2d').drawImage(canvas, 0, 0);
        canvas = grown;
        ctx = canvas.getContext('2d');
      }
      ctx.drawImage(
        bitmap,
        Math.round(region.x * ratio), Math.round(region.y * ratio), Math.round(region.w * ratio), Math.round(region.h * ratio),
        0, Math.round(pos.top * k), Math.round(region.w * k), Math.round(region.h * k),
      );
      bitmap.close();
      bottom = end;
      if (bottom >= MAX_SIDE || pos.top + info.clientHeight >= pos.scrollHeight - 1) break;
      y = pos.top + region.h;
    }
  } finally {
    await inPage(tab.id, () => globalThis.__pagesnap.restore()).catch(() => {}); // best effort: the tab may have navigated
  }
  if (!canvas) throw new Error('Nothing was captured.');
  if (bottom < canvas.height) {
    // The page got shorter while scrolling; trim the unused space.
    const trimmed = new OffscreenCanvas(canvas.width, bottom);
    trimmed.getContext('2d').drawImage(canvas, 0, 0);
    canvas = trimmed;
  }
  await save(tab, 'scroll', await encode(canvas), canvas.width, canvas.height);
}
