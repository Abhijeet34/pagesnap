import { armArea } from './store.js';

const status = document.querySelector('.status');
const buttons = document.querySelectorAll('button[data-mode]');

function showError(message) {
  status.textContent = message;
  status.classList.add('error');
  for (const b of buttons) b.disabled = false;
}

for (const button of buttons) {
  button.addEventListener('click', async () => {
    const { mode } = button.dataset;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Area and window need the popup out of the way: one for dragging on the
    // page, the other for the system window picker. The popup injects the
    // overlay itself so it never waits on a sleeping service worker.
    if (mode === 'area') {
      try {
        await armArea(tab.id);
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/area.js'] });
        window.close();
      } catch (e) {
        showError(`Can't capture this page: ${e.message}`);
      }
      return;
    }
    for (const b of buttons) b.disabled = true;
    if (mode !== 'window') {
      status.textContent = mode === 'visible' ? 'Capturing…' : 'Capturing the page, this can take a few seconds…';
    }
    try {
      const result = await chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab?.id });
      if (result?.error) return showError(result.error);
      window.close();
    } catch (e) {
      showError(`Capture failed: ${e.message}`);
    }
  });
}
