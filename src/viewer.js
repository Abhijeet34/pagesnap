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
  const d = new Date(shot.created);
  const pad = (n) => String(n).padStart(2, '0');
  // Local time, as the user reads the clock; ':' is not allowed in filenames.
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  // Sliced by code point so an emoji in the title is never split in half.
  const title = [...(shot.title || 'Screenshot').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').trim()].slice(0, 80).join('').replace(/[. ]+$/, '');
  const name = `${title || 'Screenshot'} ${stamp}`;
  document.title = `Screenshot: ${shot.title || MODES[shot.mode]}`;
  heading.textContent = shot.title || MODES[shot.mode];
  detail.textContent = [
    MODES[shot.mode],
    `${shot.width} × ${shot.height} px`,
    `${(shot.blob.size / 1048576).toFixed(1)} MB`,
    shot.note,
  ].filter(Boolean).join(' · ');
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

  const jpeg = document.querySelector('.jpeg');
  jpeg.addEventListener('click', async () => {
    jpeg.disabled = true;
    try {
      const bitmap = await createImageBitmap(shot.blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      // JPEG has no alpha; transparent pixels would otherwise turn black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      download(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 }), 'jpg');
    } catch (e) {
      console.error(e);
      flash(jpeg, 'JPEG failed');
    } finally {
      jpeg.disabled = false;
    }
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
