import { getShot } from './store.js';

const MODES = { full: 'Full page', scroll: 'Scrolling capture', visible: 'Visible area', area: 'Area', window: 'Window' };

const heading = document.querySelector('.meta h1');
const detail = document.querySelector('.meta p');
const img = document.querySelector('main img');
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
  const stamp = new Date(shot.created);
  const name = `${(shot.title || 'Screenshot').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80)} ${stamp.toISOString().slice(0, 19).replace('T', ' ').replaceAll(':', '.')}`;
  document.title = `Screenshot: ${shot.title || MODES[shot.mode]}`;
  heading.textContent = shot.title || MODES[shot.mode];
  detail.textContent = `${MODES[shot.mode]} · ${shot.width} × ${shot.height} px · ${(shot.blob.size / 1048576).toFixed(1)} MB`;
  img.src = URL.createObjectURL(shot.blob);
  img.alt = `${MODES[shot.mode]} screenshot of ${shot.title || shot.url || 'the page'}`;
  img.addEventListener('click', () => img.classList.toggle('actual'));

  const download = (blob, ext) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  const flash = (button, text) => {
    const original = button.textContent;
    button.textContent = text;
    setTimeout(() => { button.textContent = original; }, 1500);
  };

  document.querySelector('.png').addEventListener('click', () => download(shot.blob, 'png'));

  document.querySelector('.jpeg').addEventListener('click', async () => {
    const bitmap = await createImageBitmap(shot.blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha; transparent pixels would otherwise turn black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    download(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 }), 'jpg');
  });

  const copy = document.querySelector('.copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': shot.blob })]);
      flash(copy, 'Copied');
    } catch (e) {
      console.error(e);
      flash(copy, 'Copy failed');
    }
  });
}
