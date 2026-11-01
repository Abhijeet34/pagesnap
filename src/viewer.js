import { setupShare } from './share-ui.js';
import { getShot } from './store.js';

const MODES = { full: 'Full page', scroll: 'Full page', visible: 'Visible area', area: 'Area', window: 'Window' };

const heading = document.querySelector('.meta h1');
const detail = document.querySelector('.meta p');
const stage = document.querySelector('.stage');
const img = stage.querySelector('img');
const actions = document.querySelector('.actions');

const shot = await getShot(location.hash.slice(1));

if (!shot) {
  actions.hidden = true;
  heading.textContent = 'Screenshot not found';
  img.replaceWith(Object.assign(document.createElement('p'), {
    className: 'empty',
    textContent: 'Screenshots are kept for 24 hours. Take a new one from the toolbar.',
  }));
} else {
  const d = new Date(shot.created);
  const pad = (n) => String(n).padStart(2, '0');
  // Local time, as the user reads the clock; ':' is not allowed in filenames.
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  // Sliced by code point so an emoji in the title is never split in half.
  const title = [...(shot.title || 'Screenshot').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').trim()].slice(0, 80).join('').replace(/[. ]+$/, '');
  const name = `${title || 'Screenshot'} ${stamp}`;
  document.title = shot.title || MODES[shot.mode];
  heading.textContent = shot.title || MODES[shot.mode];
  detail.textContent = [
    MODES[shot.mode],
    `${shot.width} × ${shot.height}`,
    shot.blob.size < 1048576 ? `${Math.max(1, Math.round(shot.blob.size / 1024))} KB` : `${(shot.blob.size / 1048576).toFixed(1)} MB`,
    shot.note,
  ].filter(Boolean).join(' · ');
  img.src = URL.createObjectURL(shot.blob);
  img.alt = `${MODES[shot.mode]} screenshot of ${shot.title || shot.url || 'the page'}`;

  // One image pixel per device pixel at 100%: the CSS width is the pixel
  // width divided by the display's ratio, which also keeps Fit from ever
  // enlarging a small capture past its real size.
  const zoom = document.querySelector('.zoom');
  const size = () => { img.style.width = `${shot.width / devicePixelRatio}px`; };
  const watchRatio = () => {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { size(); watchRatio(); }, { once: true });
  };
  size();
  watchRatio();
  const setActual = (on) => {
    stage.classList.toggle('actual', on);
    zoom.setAttribute('aria-pressed', String(on));
    zoom.querySelector('span').textContent = on ? '100%' : 'Fit';
    zoom.title = on ? 'Fit to window' : 'Show at actual size';
  };
  zoom.addEventListener('click', () => setActual(!stage.classList.contains('actual')));
  img.addEventListener('click', () => setActual(!stage.classList.contains('actual')));

  const flash = (button, text) => {
    const span = button.querySelector('span');
    const original = span.textContent;
    span.textContent = text;
    setTimeout(() => { span.textContent = original; }, 1500);
  };

  const save = (blob, ext) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  // Both formats keep every pixel of the capture; JPG only trades exactness
  // of colour for a smaller file.
  const toJpeg = async () => {
    const bitmap = await createImageBitmap(shot.blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha; transparent pixels would otherwise turn black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  };

  const download = document.querySelector('.download');
  const menu = document.querySelector('#formats');
  const savePng = () => save(shot.blob, 'png');
  download.addEventListener('click', savePng);
  menu.addEventListener('click', async (e) => {
    const format = e.target.closest('button')?.dataset.format;
    if (!format) return;
    menu.hidePopover();
    if (format === 'png') return savePng();
    try {
      save(await toJpeg(), 'jpg');
    } catch (err) {
      console.error(err);
      flash(download, 'Failed');
    }
  });

  const copy = document.querySelector('.copy');
  const copyImage = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': shot.blob })]);
      flash(copy, 'Copied');
    } catch (e) {
      console.error(e);
      flash(copy, 'Copy failed');
    }
  };
  copy.addEventListener('click', copyImage);

  addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    // Inside the share dialog the keys keep their usual meaning, so the link
    // field copies its text.
    if (e.target.closest?.('dialog, input')) return;
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      savePng();
    } else if (key === 'c' && !getSelection()?.toString()) {
      e.preventDefault();
      copyImage();
    }
  });
  await setupShare(shot);
}
