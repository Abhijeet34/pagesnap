import { putShot } from './store.js';

// Runs in its own small popup window so that picking the browser window shows
// the page the user was on, not this extension page.
const status = document.querySelector('[role=status]');

function choose() {
  return new Promise((resolve) => chrome.desktopCapture.chooseDesktopMedia(['window', 'screen'], resolve));
}

// How long to wait for the screen to stop moving, such as this window's own
// minimize animation, before taking whatever is showing.
const STILL_WITHIN_MS = 2000;
const STILL_GAP_MS = 100;

// A tiny greyscale copy is enough to tell whether the picture moved.
function thumbnail(bitmap) {
  const canvas = new OffscreenCanvas(48, 27);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return Uint8Array.from({ length: data.length / 4 }, (_, i) => (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
}

// A clock or a blinking cursor still counts as still; an animation does not.
const still = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length < 1;

async function frameOf(stream) {
  const capture = new ImageCapture(stream.getVideoTracks()[0]);
  // The first frame of a fresh capture is often blank.
  (await capture.grabFrame()).close();
  let bitmap = await capture.grabFrame();
  let previous = thumbnail(bitmap);
  for (const until = Date.now() + STILL_WITHIN_MS; Date.now() < until;) {
    await new Promise((r) => setTimeout(r, STILL_GAP_MS));
    const next = await capture.grabFrame();
    const current = thumbnail(next);
    bitmap.close();
    bitmap = next;
    if (still(previous, current)) break;
    previous = current;
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

try {
  const streamId = await choose();
  if (!streamId) {
    window.close();
  } else {
    status.textContent = 'Capturing…';
    // Out of the way so a whole-screen capture does not include this window.
    // The minimize animation outlasts this call; frameOf waits for it to end.
    const self = await chrome.windows.getCurrent();
    await chrome.windows.update(self.id, { state: 'minimized' });
    // Before that, the picture could hold still with this window on it.
    if (document.visibilityState !== 'hidden') {
      await Promise.race([
        new Promise((r) => document.addEventListener('visibilitychange', r, { once: true })),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId, maxWidth: 16384, maxHeight: 16384 } },
    });
    let canvas;
    try {
      canvas = await frameOf(stream);
    } finally {
      for (const track of stream.getTracks()) track.stop();
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const id = await putShot(blob, { mode: 'window', width: canvas.width, height: canvas.height, title: '', url: '' });
    const target = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    // With no normal window left, a new one holds the viewer.
    if (target) await chrome.tabs.create({ url: `src/viewer.html#${id}`, windowId: target.id });
    else await chrome.windows.create({ url: `src/viewer.html#${id}` });
    window.close();
  }
} catch (e) {
  console.error(e);
  // Permission errors from getUserMedia are the Screen Recording case.
  const permission = e?.name === 'NotAllowedError' || e?.name === 'NotReadableError';
  status.textContent = permission
    ? 'Capture failed: on macOS, allow the browser under System Settings > Privacy & Security > Screen Recording, then try again.'
    : `Capture failed: ${e.message}`;
  const self = await chrome.windows.getCurrent();
  await chrome.windows.update(self.id, { state: 'normal', focused: true });
}
