import { putShot } from './store.js';

// Runs in its own small popup window so that picking the browser window shows
// the page the user was on, not this extension page.
const status = document.querySelector('[role=status]');

function choose() {
  return new Promise((resolve) => chrome.desktopCapture.chooseDesktopMedia(['window', 'screen'], resolve));
}

async function frameOf(stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  // The first decoded frame of a fresh capture is often blank.
  await new Promise((r) => video.requestVideoFrameCallback(() => video.requestVideoFrameCallback(r)));
  const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas;
}

try {
  const streamId = await choose();
  if (!streamId) {
    window.close();
  } else {
    status.textContent = 'Capturing…';
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
}
