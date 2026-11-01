// Injected into the isolated world before a scrolling capture. State lives on
// globalThis so later executeScript calls in the same world can reach it.
globalThis.__pagesnap = (() => {
  // Overrides go through attributes and one stylesheet rather than inline
  // styles, because scroll handlers often rewrite an element's style attribute
  // mid-capture and would wipe an inline override.
  const HIDE = 'data-pagesnap-hide';
  const UNSTICK = 'data-pagesnap-unstick';
  let scroller;
  let isDocument;
  let saved;
  let sheet;

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rootScroller = () => document.scrollingElement || document.documentElement;

  function scrollsY(el) {
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    const { overflowY } = getComputedStyle(el);
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  }

  // Apps that pin the body to 100vh scroll an inner element instead; pick the
  // largest visible one so the stitch follows what the user actually scrolls.
  function findScroller() {
    const root = rootScroller();
    if (root.scrollHeight > root.clientHeight + 1) return root;
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (!scrollsY(el)) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
        Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best || root;
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

  // After the first frame, fixed elements would repeat in every frame, so they
  // are hidden; sticky ones are returned to the flow so they still appear once,
  // where they belong. Re-run after every scroll because sites pin headers from
  // scroll handlers. Anything containing the scroller (a fixed modal, say)
  // stays, or the content itself would vanish.
  function neutralizeFloating() {
    for (const el of document.querySelectorAll('body *')) {
      if (el.hasAttribute(HIDE) || el.hasAttribute(UNSTICK)) continue;
      const { position } = getComputedStyle(el);
      if (position !== 'fixed' && position !== 'sticky') continue;
      if (el.contains(scroller)) continue;
      el.setAttribute(position === 'fixed' ? HIDE : UNSTICK, '');
    }
  }

  return {
    prepare() {
      scroller = findScroller();
      isDocument = scroller === rootScroller();
      saved = {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
        behavior: scroller.style.getPropertyValue('scroll-behavior'),
      };
      scroller.style.setProperty('scroll-behavior', 'auto', 'important');
      sheet = document.createElement('style');
      sheet.textContent = `[${HIDE}] { visibility: hidden !important; }
        [${UNSTICK}] { position: relative !important; inset: auto !important; }`;
      document.documentElement.append(sheet);
      return { region: region(), viewportWidth: innerWidth, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight };
    },

    async scrollTo(y) {
      scroller.scrollTop = y;
      await nextFrame();
      // Gives lazy images and scroll-triggered layout a moment to settle.
      await wait(150);
      if (y > 0) {
        neutralizeFloating();
        await nextFrame();
      }
      return { top: scroller.scrollTop, scrollHeight: scroller.scrollHeight, region: region() };
    },

    restore() {
      for (const el of document.querySelectorAll(`[${HIDE}], [${UNSTICK}]`)) {
        el.removeAttribute(HIDE);
        el.removeAttribute(UNSTICK);
      }
      sheet?.remove();
      // Position first, then behaviour, so a smooth-scrolling page jumps back
      // instead of animating.
      scroller.scrollTop = saved.top;
      scroller.scrollLeft = saved.left;
      if (saved.behavior) scroller.style.setProperty('scroll-behavior', saved.behavior);
      else scroller.style.removeProperty('scroll-behavior');
    },
  };
})();
