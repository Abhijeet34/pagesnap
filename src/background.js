import { putShot } from './store.js';

// captureVisibleTab is limited to 2 calls per second per extension.
const CAPTURE_GAP_MS = 550;
// Chromium refuses canvases past 32767 px on a side or 268M px in area.
const MAX_SIDE = 32767;
const MAX_AREA = 16384 * 16384;
const MAX_FRAMES = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'capture') {
    run(msg.mode, msg.tabId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: fail(e) }));
    return true;
  }
  if (msg.type === 'area-selected' && sender.tab) {
    captureArea(sender.tab, msg.rect, msg.viewportWidth).catch(fail);
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
  if (mode === 'visible') return captureVisible(tab);
  if (mode === 'full') return captureFull(tab);
  if (mode === 'scroll') return captureScroll(tab);
  if (mode === 'area') {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/area.js'] });
    return;
  }
  throw new Error(`Unknown capture mode: ${mode}`);
}

async function grab(windowId) {
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  return createImageBitmap(await (await fetch(url)).blob());
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
  const bitmap = await grab(tab.windowId);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  await save(tab, 'visible', await encode(canvas), bitmap.width, bitmap.height);
}

async function captureArea(tab, rect, viewportWidth) {
  const bitmap = await grab(tab.windowId);
  const ratio = bitmap.width / viewportWidth;
  const sx = Math.round(rect.x * ratio);
  const sy = Math.round(rect.y * ratio);
  const w = Math.min(Math.round(rect.w * ratio), bitmap.width - sx);
  const h = Math.min(Math.round(rect.h * ratio), bitmap.height - sy);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
  await save(tab, 'area', await encode(canvas), w, h);
}

// Full page renders the whole document in one pass through the DevTools
// protocol, the same path as DevTools' "Capture full size screenshot". If
// another debugger holds the tab, scroll-and-stitch still gets the page.
async function captureFull(tab) {
  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    if (/already attached|another debugger/i.test(e.message)) return captureScroll(tab);
    throw e;
  }
  try {
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const css = metrics.cssContentSize;
    const ratio = metrics.contentSize.width / css.width;
    const width = Math.ceil(css.width);
    const height = Math.ceil(css.height);
    const scale = fit(width * ratio, height * ratio);
    const { data } = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    });
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    await save(tab, 'full', blob, bitmap.width, bitmap.height);
  } finally {
    await chrome.debugger.detach(target).catch(() => {}); // best effort: the tab may have closed
  }
}

async function inPage(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result.result;
}

async function captureScroll(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page.js'] });
  const info = await inPage(tab.id, () => globalThis.__pagesnap.prepare());
  const frames = [];
  try {
    let y = 0;
    let lastShot = 0;
    while (frames.length < MAX_FRAMES) {
      const pos = await inPage(tab.id, (to) => globalThis.__pagesnap.scrollTo(to), [y]);
      if (frames.length && pos.top <= frames.at(-1).top) break;
      await sleep(Math.max(0, lastShot + CAPTURE_GAP_MS - Date.now()));
      lastShot = Date.now();
      frames.push({ top: pos.top, region: pos.region, bitmap: await grab(tab.windowId) });
      if (pos.top + info.clientHeight >= pos.scrollHeight - 1) break;
      y = pos.top + pos.region.h;
    }
  } finally {
    await inPage(tab.id, () => globalThis.__pagesnap.restore()).catch(() => {}); // best effort: the tab may have navigated
  }
  if (!frames.length) throw new Error('Nothing was captured.');

  const ratio = frames[0].bitmap.width / info.viewportWidth;
  const last = frames.at(-1);
  const fullW = info.region.w * ratio;
  const fullH = (last.top + last.region.h) * ratio;
  const scale = fit(fullW, fullH);
  const canvas = new OffscreenCanvas(Math.round(fullW * scale), Math.round(fullH * scale));
  const ctx = canvas.getContext('2d');
  for (const { top, region, bitmap } of frames) {
    ctx.drawImage(
      bitmap,
      Math.round(region.x * ratio), Math.round(region.y * ratio), Math.round(region.w * ratio), Math.round(region.h * ratio),
      0, Math.round(top * ratio * scale), Math.round(region.w * ratio * scale), Math.round(region.h * ratio * scale),
    );
    bitmap.close();
  }
  await save(tab, 'scroll', await encode(canvas), canvas.width, canvas.height);
}
