// Injected into the isolated world before a scrolling capture. State lives on
// globalThis so later executeScript calls in the same world can reach it.
globalThis.__pagesnap = (() => {
  let scroller;
  let isDocument;
  let saved;
  const hidden = [];

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function scrollsY(el) {
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    const { overflowY } = getComputedStyle(el);
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  }

  // Apps that pin the body to 100vh scroll an inner element instead; pick the
  // largest visible one so the stitch follows what the user actually scrolls.
  function findScroller() {
    const root = document.scrollingElement || document.documentElement;
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

  // Fixed headers and sticky bars would repeat in every frame, so they are
  // hidden once the first frame has them. Anything containing the scroller
  // (a fixed modal, say) stays, or the content itself would vanish.
  function hideFloating() {
    for (const el of document.querySelectorAll('body *')) {
      const { position } = getComputedStyle(el);
      if (position !== 'fixed' && position !== 'sticky') continue;
      if (el.contains(scroller)) continue;
      hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
      el.style.setProperty('visibility', 'hidden', 'important');
    }
  }

  return {
    prepare() {
      scroller = findScroller();
      isDocument = scroller === (document.scrollingElement || document.documentElement);
      saved = {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
        behavior: scroller.style.getPropertyValue('scroll-behavior'),
      };
      scroller.style.setProperty('scroll-behavior', 'auto', 'important');
      return { region: region(), viewportWidth: innerWidth, clientHeight: scroller.clientHeight };
    },

    async scrollTo(y) {
      if (y > 0 && hidden.length === 0) hideFloating();
      scroller.scrollTop = y;
      await nextFrame();
      // Gives lazy images and scroll-triggered layout a moment to settle.
      await wait(150);
      return { top: scroller.scrollTop, scrollHeight: scroller.scrollHeight, region: region() };
    },

    restore() {
      for (const [el, value, priority] of hidden) {
        if (value) el.style.setProperty('visibility', value, priority);
        else el.style.removeProperty('visibility');
      }
      hidden.length = 0;
      if (saved.behavior) scroller.style.setProperty('scroll-behavior', saved.behavior);
      else scroller.style.removeProperty('scroll-behavior');
      scroller.scrollTop = saved.top;
      scroller.scrollLeft = saved.left;
    },
  };
})();
