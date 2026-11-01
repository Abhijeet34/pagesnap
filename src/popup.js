import { armArea } from './store.js';

const status = document.querySelector('.status');
const buttons = document.querySelectorAll('button[data-mode]');
const panel = document.querySelector('.progress');
const label = panel.querySelector('.progress-label');
const value = panel.querySelector('.progress-value');
const bar = panel.querySelector('.bar');
const fill = panel.querySelector('.fill');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const key = `progress:${tab?.id}`;

function busy(on) {
  for (const b of buttons) b.disabled = on;
}

function showError(message) {
  panel.hidden = true;
  status.textContent = message;
  status.classList.add('error');
  busy(false);
}

// A worker that died mid-capture never clears its entry; updates arrive
// several times a second, so one this old is left over, not live.
const STALE_MS = 60_000;

function render(state) {
  if (!state || !(Date.now() - state.at < STALE_MS)) return;
  busy(true);
  status.textContent = '';
  status.classList.remove('error');
  panel.hidden = false;
  label.textContent = state.label;
  const known = typeof state.value === 'number';
  panel.classList.toggle('indeterminate', !known);
  value.textContent = known ? `${Math.round(state.value * 100)}%` : '';
  fill.style.transform = known ? `scaleX(${state.value})` : '';
  if (known) bar.setAttribute('aria-valuenow', String(Math.round(state.value * 100)));
  else bar.removeAttribute('aria-valuenow');
}

// A capture started earlier (or by a shortcut) shows its progress here too.
render((await chrome.storage.session.get(key))[key]);
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'session' || !changes[key]) return;
  if (changes[key].newValue) return render(changes[key].newValue);
  // The capture ended. A failure leaves its message on the toolbar title.
  const title = await chrome.action.getTitle({});
  if (title.startsWith('PageSnap: ')) showError(title.slice('PageSnap: '.length));
  else {
    panel.hidden = true;
    busy(false);
  }
});

for (const button of buttons) {
  button.addEventListener('click', async () => {
    const { mode } = button.dataset;
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
    busy(true);
    if (mode !== 'window') render({ label: 'Starting', value: null });
    try {
      const result = await chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab?.id });
      if (result?.error) return showError(result.error);
      window.close();
    } catch (e) {
      showError(`Capture failed: ${e.message}`);
    }
  });
}
