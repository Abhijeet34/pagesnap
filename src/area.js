// Injected for area capture: the user drags a rectangle, the overlay removes
// itself, and the service worker captures the viewport and crops it.
(() => {
  if (globalThis.__pagesnapArea) return;
  globalThis.__pagesnapArea = true;

  const host = document.createElement('div');
  // Has to sit above any page content, so it takes the top of the int32 range.
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .shade { position: fixed; inset: 0; background: rgb(0 0 0 / 0.35); }
      .box { position: fixed; display: none; outline: 1px solid #fff; box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.35); }
      .size { position: fixed; display: none; font: 12px/1 system-ui, sans-serif; color: #fff;
        background: rgb(0 0 0 / 0.75); padding: 4px 6px; border-radius: 4px; pointer-events: none; }
      .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); font: 13px/1.4 system-ui, sans-serif;
        color: #fff; background: rgb(0 0 0 / 0.75); padding: 6px 10px; border-radius: 6px; pointer-events: none; }
    </style>
    <div class="shade"></div><div class="box"></div><div class="size"></div>
    <div class="hint">Drag to select an area. Esc to cancel.</div>`;
  const shade = root.querySelector('.shade');
  const box = root.querySelector('.box');
  const size = root.querySelector('.size');
  const hint = root.querySelector('.hint');
  document.documentElement.append(host);

  let start = null;
  let rect = null;

  function cleanup() {
    host.remove();
    removeEventListener('keydown', onKey, true);
    delete globalThis.__pagesnapArea;
  }

  function onKey(e) {
    if (!e.isTrusted || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
  }

  // Page script can dispatch synthetic pointer events at the overlay; only
  // real input from the user may make a selection.
  host.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.button !== 0) return;
    e.preventDefault();
    host.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    shade.style.display = 'none';
    hint.style.display = 'none';
  });

  host.addEventListener('pointermove', (e) => {
    if (!e.isTrusted || !start) return;
    const x = Math.max(0, Math.min(start.x, e.clientX));
    const y = Math.max(0, Math.min(start.y, e.clientY));
    const w = Math.min(innerWidth, Math.max(start.x, e.clientX)) - x;
    const h = Math.min(innerHeight, Math.max(start.y, e.clientY)) - y;
    rect = { x, y, w, h };
    Object.assign(box.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    Object.assign(size.style, { display: 'block', left: `${x}px`, top: `${Math.max(0, y - 24)}px` });
  });

  host.addEventListener('pointerup', async (e) => {
    if (!e.isTrusted || !start) return;
    start = null;
    cleanup();
    if (!rect || rect.w < 4 || rect.h < 4) return;
    // Two frames so the overlay is gone from the compositor before capture.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    chrome.runtime.sendMessage({ type: 'area-selected', rect, viewportWidth: innerWidth });
  });

  addEventListener('keydown', onKey, true);
})();
