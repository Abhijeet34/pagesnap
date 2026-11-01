const status = document.querySelector('.status');
const buttons = document.querySelectorAll('button[data-mode]');

for (const button of buttons) {
  button.addEventListener('click', async () => {
    const { mode } = button.dataset;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Area and window need the popup out of the way: one for dragging on the
    // page, the other for the system window picker. The popup injects the
    // overlay itself so it never waits on a sleeping service worker.
    if (mode === 'area') {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/area.js'] });
        window.close();
      } catch (e) {
        status.textContent = `Can't capture this page: ${e.message}`;
        status.classList.add('error');
      }
      return;
    }
    const request = chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab?.id });
    if (mode === 'window') {
      await request;
      window.close();
      return;
    }
    for (const b of buttons) b.disabled = true;
    status.textContent = mode === 'visible' ? 'Capturing…' : 'Capturing the page, this can take a few seconds…';
    const result = await request;
    if (result?.error) {
      status.textContent = result.error;
      status.classList.add('error');
      for (const b of buttons) b.disabled = false;
      return;
    }
    window.close();
  });
}
