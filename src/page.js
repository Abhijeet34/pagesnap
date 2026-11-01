// Injected into the isolated world before a scrolling or full-page capture.
// State lives on globalThis so later executeScript calls in the same world can
// reach it. Page script cannot see or override anything defined here.
globalThis.__pagesnap?.restore();
globalThis.__pagesnap = (() => {
  // Overrides go through attributes and stylesheets rather than inline styles,
  // because scroll handlers often rewrite an element's style attribute
  // mid-capture and would wipe an inline override.
  const HIDE = 'data-pagesnap-hide';
  const UNSTICK = 'data-pagesnap-unstick';
  const CSS = `[${HIDE}] { visibility: hidden !important; opacity: 0 !important; }
    [${UNSTICK}] { position: relative !important; inset: auto !important; }`;
  // If the service worker dies mid-capture, nobody calls restore(); the page
  // puts itself back once calls stop arriving.
  const WATCHDOG_MS = 10_000;
  // A tiled full-page render of a very long page can take a while.
  const FULL_WATCHDOG_MS = 60_000;
  let scroller;
  let isDocument;
  let saved;
  let watchdog;
  const sheets = new Map();

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // rAF stops in hidden tabs; the timeout keeps a capture from stalling there.
  const nextFrame = () => Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    wait(500),
  ]);
  const rootScroller = () => document.scrollingElement || document.documentElement;

  let watchdogMs = WATCHDOG_MS;
  function arm() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => restore(), watchdogMs);
  }

  // Every element, including those inside open shadow roots.
  function* elements(root = document) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* elements(el.shadowRoot);
    }
  }

  function containsComposed(el, node) {
    for (let n = node; n; n = n.parentNode || n.host) if (n === el) return true;
    return false;
  }

  function scrollsY(el) {
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    const { overflowY } = getComputedStyle(el);
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  }

  // Apps that pin the body to 100vh scroll an inner element instead. Whichever
  // of the document and the largest visible inner scroller has more to scroll
  // wins, so a body margin overflowing by a few pixels does not hide the pane.
  function findScroller() {
    const root = rootScroller();
    let best = root;
    let bestDistance = root.scrollHeight - root.clientHeight;
    let bestArea = 0;
    const minArea = innerWidth * innerHeight * 0.25;
    for (const el of elements()) {
      if (!scrollsY(el)) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
        Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const distance = el.scrollHeight - el.clientHeight;
      if (area >= minArea && area > bestArea && distance > bestDistance) {
        best = el;
        bestArea = area;
        bestDistance = distance;
      }
    }
    return best;
  }

  function region() {
    if (isDocument) {
      const de = document.documentElement;
      return { x: 0, y: 0, w: de.clientWidth || innerWidth, h: Math.min(de.clientHeight || innerHeight, innerHeight) };
    }
    const r = scroller.getBoundingClientRect();
    const x = Math.max(0, r.left + scroller.clientLeft);
    const y = Math.max(0, r.top + scroller.clientTop);
    return { x, y, w: Math.min(scroller.clientWidth, innerWidth - x), h: Math.min(scroller.clientHeight, innerHeight - y) };
  }

  function addSheet(root) {
    if (sheets.has(root)) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    (root === document ? document.documentElement : root).append(style);
    sheets.set(root, style);
  }

  // After the first frame, fixed elements would repeat in every frame, so they
  // are hidden; sticky ones are returned to the flow so they still appear once,
  // where they belong. Re-run after every scroll because sites pin headers from
  // scroll handlers. Anything containing the scroller (a fixed modal, say)
  // stays, or the content itself would vanish.
  function neutralizeFloating() {
    for (const el of elements()) {
      if (el.hasAttribute(HIDE) || el.hasAttribute(UNSTICK)) continue;
      const { position } = getComputedStyle(el);
      if (position !== 'fixed' && position !== 'sticky') continue;
      if (containsComposed(el, scroller)) continue;
      addSheet(el.getRootNode());
      el.setAttribute(position === 'fixed' ? HIDE : UNSTICK, '');
    }
  }

  function restore() {
    clearTimeout(watchdog);
    for (const root of [document, ...sheets.keys()]) {
      for (const el of root.querySelectorAll(`[${HIDE}], [${UNSTICK}]`)) {
        el.removeAttribute(HIDE);
        el.removeAttribute(UNSTICK);
      }
    }
    for (const style of sheets.values()) style.remove();
    sheets.clear();
    if (!saved) return;
    // Position first, then behaviour, so a smooth-scrolling page jumps back
    // instead of animating.
    saved.el.scrollTop = saved.top;
    saved.el.scrollLeft = saved.left;
    if (saved.behavior) saved.el.style.setProperty('scroll-behavior', saved.behavior);
    else saved.el.style.removeProperty('scroll-behavior');
    saved = null;
  }

  function hold(el) {
    saved = {
      el,
      top: el.scrollTop,
      left: el.scrollLeft,
      behavior: el.style.getPropertyValue('scroll-behavior'),
    };
    el.style.setProperty('scroll-behavior', 'auto', 'important');
    arm();
  }

  return {
    // Full page: says whether an inner pane is the real scroller, otherwise
    // scrolls the document to the top so fixed headers render there.
    async probe() {
      if (findScroller() !== rootScroller()) return { inner: true };
      watchdogMs = FULL_WATCHDOG_MS;
      hold(rootScroller());
      scrollTo(0, 0);
      await nextFrame();
      return { inner: false, dpr: devicePixelRatio };
    },

    // Full page renders the document in one pass, which skips images that load
    // only when scrolled into view; a quick pass down the page loads them.
    async peek(y) {
      arm();
      const root = rootScroller();
      root.scrollTop = y;
      await nextFrame();
      await wait(80);
      return { top: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
    },

    // Waits, at most `ms`, for images that started loading during the pass.
    async settle(ms) {
      arm();
      const pending = [...document.images].filter((img) => !img.complete);
      await Promise.race([
        Promise.all(pending.map((img) => new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); }))),
        wait(ms),
      ]);
      rootScroller().scrollTop = 0;
      await nextFrame();
    },

    prepare() {
      scroller = findScroller();
      isDocument = scroller === rootScroller();
      hold(scroller);
      // Frames are stitched from the left edge, so a horizontal offset would
      // shift every one of them.
      scroller.scrollLeft = 0;
      addSheet(document);
      return { region: region(), viewportWidth: innerWidth, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight };
    },

    async scrollTo(y) {
      arm();
      scroller.scrollTop = y;
      await nextFrame();
      // Gives lazy images and scroll-triggered layout a moment to settle.
      await wait(150);
      if (y > 0) {
        neutralizeFloating();
        await nextFrame();
      }
      return {
        top: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        region: region(),
        visible: document.visibilityState === 'visible',
      };
    },

    restore,
  };
})();
