// Renders icons/*.svg to the PNG sizes the manifest lists, through headless
// Brave/Chrome, so no image tooling is needed.
//   node scripts/icons.mjs [path-to-browser-binary]
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BROWSER = process.argv[2] || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const ROOT = resolve(import.meta.dirname, '..');
// The small drawing is pixel-aligned for 16 px and doubled for 32 px.
const SIZES = [[16, 'icon-small.svg'], [32, 'icon-small.svg'], [48, 'icon.svg'], [128, 'icon.svg']];

const profile = await mkdtemp(join(tmpdir(), 'pagesnap-icons-'));
const browser = spawn(BROWSER, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then((s) => s.split('\n')[0], () => null);
    if (!port) await new Promise((r) => setTimeout(r, 100));
  }
  const [page] = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); pending.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  for (const [size, file] of SIZES) {
    const svg = await readFile(join(ROOT, 'icons', file), 'utf8');
    const html = `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
    await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
    await new Promise((r) => setTimeout(r, 300));
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const { result } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    await writeFile(join(ROOT, 'icons', `${size}.png`), Buffer.from(result.data, 'base64'));
    console.log(`icons/${size}.png`);
  }
  ws.close();
} finally {
  browser.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {}); // best effort: the browser may still hold files
}
