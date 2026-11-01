import { putShot } from './store.js';

// Runs in its own small popup window so that picking the browser window shows
// the page the user was on, not this extension page.
const status = document.querySelector('[role=status]');

function choose() {
  return new Promise((resolve) => chrome.desktopCapture.chooseDesktopMedia(['window', 'screen'], resolve));
}

async function frameOf(stream) {
  const capture = new ImageCapture(stream.getVideoTracks()[0]);
  // The first frame of a fresh capture is often blank.
  (await capture.grabFrame()).close();
  const bitmap = await capture.grabFrame();
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
    const self = await chrome.windows.getCurrent();
    await chrome.windows.update(self.id, { state: 'minimized' });
    await new Promise((r) => setTimeout(r, 400));
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
    const target = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    await chrome.tabs.create({ url: `src/viewer.html#${id}`, windowId: target.id });
    window.close();
  }
} catch (e) {
  console.error(e);
  status.textContent = `Capture failed: ${e.message}. On macOS, allow the browser under System Settings > Privacy & Security > Screen Recording.`;
  const self = await chrome.windows.getCurrent();
  await chrome.windows.update(self.id, { state: 'normal', focused: true });
}
