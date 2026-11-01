import { isSecret, receive } from './p2p.js';

const title = document.querySelector('h1');
const status = document.querySelector('.status');
const codeBlock = document.querySelector('.code-block');
const code = document.querySelector('.code');
const bar = document.querySelector('.bar');
const fill = bar.querySelector('.fill');
const result = document.querySelector('.result');

const secret = location.hash.slice(1);
// The key leaves the address bar and this history entry before anything else
// runs, so it is not left behind in the browser.
history.replaceState(null, '', location.pathname + location.search);

// Tests point the page at a local tracker; real links never carry this.
const params = new URLSearchParams(location.search);
const local = params.get('tracker');
const options = local && /^ws:\/\/(127\.0\.0\.1|localhost):\d+$/.test(local) ? { trackers: [local], iceServers: [] } : {};

function fail(heading, text) {
  title.textContent = heading;
  status.textContent = text;
  codeBlock.hidden = true;
  bar.hidden = true;
}

if (!isSecret(secret)) {
  fail('This link is incomplete', 'Ask the sender to copy the whole link again.');
} else {
  receive({
    secret,
    ...options,
    onState(s) {
      if (s.state === 'connecting') {
        status.textContent = 'Connecting to the sender…';
      } else if (s.state === 'approval') {
        code.textContent = s.code;
        codeBlock.hidden = false;
        status.textContent = 'Connected. Waiting for the sender to approve.';
      } else if (s.state === 'receiving') {
        codeBlock.hidden = true;
        bar.hidden = false;
        fill.style.transform = `scaleX(${s.value})`;
        status.textContent = `Receiving ${Math.round(s.value * 100)}%`;
      } else if (s.state === 'received') {
        const url = URL.createObjectURL(s.blob);
        bar.hidden = true;
        title.textContent = 'Screenshot received';
        status.textContent = 'It lives only in this tab. Download it to keep it.';
        result.querySelector('img').src = url;
        const link = result.querySelector('.download');
        link.href = url;
        link.download = `Screenshot.${s.blob.type === 'image/jpeg' ? 'jpg' : 'png'}`;
        result.hidden = false;
      } else if (s.state === 'declined') {
        fail('The sender declined', 'Nothing was sent. Ask them for a new link if this was a mistake.');
      } else if (s.state === 'unreachable') {
        fail('Couldn’t receive the screenshot', s.note);
      }
    },
  }).catch((e) => fail('Couldn’t receive the screenshot', e.message));
}
