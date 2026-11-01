import { DEFAULT_ICE, DEFAULT_TRACKERS, newSecret, share, validTracker } from '../share/p2p.js';
import { RECEIVER_URL } from './config.js';

const EXPIRES_MS = 10 * 60 * 1000;

function validReceiver(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname));
  } catch {
    return false;
  }
}

async function settings() {
  const stored = await chrome.storage.local.get(['receiverUrl', 'trackers', 'iceServers']);
  const receiverUrl = stored.receiverUrl || RECEIVER_URL;
  const trackers = Array.isArray(stored.trackers) ? stored.trackers.filter(validTracker) : DEFAULT_TRACKERS;
  const iceServers = Array.isArray(stored.iceServers) ? stored.iceServers : DEFAULT_ICE;
  return { receiverUrl: validReceiver(receiverUrl) ? receiverUrl : '', trackers, iceServers };
}

export async function setupShare(shot) {
  const config = await settings();
  const button = document.querySelector('.share');
  if (!config.receiverUrl) return;
  button.hidden = false;

  const sheet = document.querySelector('.sheet');
  const linkField = sheet.querySelector('.link');
  const copyLink = sheet.querySelector('.copy-link');
  const status = sheet.querySelector('.share-status');
  const statusText = status.querySelector('.text');
  const timer = status.querySelector('.timer');
  const request = sheet.querySelector('.request');
  const code = sheet.querySelector('.code');
  const bar = sheet.querySelector('.bar.sending');
  const fill = bar.querySelector('.fill');
  const sent = sheet.querySelector('.sent');
  const stopButton = sheet.querySelector('.stop');

  let session = null;
  let countdown = null;
  let pending = null;
  // Bumped whenever the dialog ends a share, so a share still starting when
  // that happens stops itself instead of running behind a closed dialog.
  let attempt = 0;
  let starting = false;

  const setStatus = (text, { live = false, error = false } = {}) => {
    statusText.textContent = text;
    status.classList.toggle('live', live);
    status.classList.toggle('error', error);
  };

  function end(note) {
    attempt++;
    clearInterval(countdown);
    timer.textContent = '';
    session?.stop();
    session = null;
    pending = null;
    request.hidden = true;
    if (note) setStatus(note);
  }

  function onState(s) {
    if (s.state === 'waiting') {
      request.hidden = true;
      bar.hidden = true;
      setStatus(s.note || 'Waiting for someone to open the link', { live: true });
    } else if (s.state === 'request') {
      pending = s;
      code.textContent = s.code;
      request.hidden = false;
      setStatus('Someone opened the link', { live: true });
      sheet.querySelector('.send').focus();
    } else if (s.state === 'declined') {
      request.hidden = true;
      setStatus('Declined. Waiting for someone else to open the link', { live: true });
    } else if (s.state === 'sending') {
      request.hidden = true;
      bar.hidden = false;
      fill.style.transform = `scaleX(${s.value})`;
      setStatus(`Sending ${Math.round(s.value * 100)}%`, { live: true });
    } else if (s.state === 'failed') {
      end();
      bar.hidden = true;
      linkField.value = '';
      linkField.placeholder = 'Link used';
      copyLink.disabled = true;
      stopButton.textContent = 'Done';
      stopButton.classList.add('finish');
      setStatus(s.note, { error: true });
    } else if (s.state === 'sent') {
      clearInterval(countdown);
      timer.textContent = '';
      bar.hidden = true;
      sent.hidden = false;
      status.hidden = true;
      linkField.value = '';
      linkField.placeholder = 'Link used';
      copyLink.disabled = true;
      stopButton.textContent = 'Done';
      stopButton.classList.add('finish');
      session = null;
    }
  }

  async function start() {
    const secret = newSecret();
    // The secret goes only in the fragment, which never reaches a server.
    linkField.value = `${config.receiverUrl}#${secret}`;
    copyLink.disabled = false;
    sent.hidden = true;
    status.hidden = false;
    stopButton.textContent = 'Stop sharing';
    stopButton.classList.remove('finish');
    setStatus('Connecting…', { live: true });
    const mine = ++attempt;
    starting = true;
    let started;
    try {
      started = await share({ blob: shot.blob, secret, trackers: config.trackers, iceServers: config.iceServers, onState: (s) => mine === attempt && onState(s) });
    } catch (e) {
      console.error(e);
      if (mine === attempt) setStatus(`Sharing could not start: ${e.message}`, { error: true });
      return;
    } finally {
      starting = false;
    }
    if (mine !== attempt) {
      started.stop();
      // Reopened while this one was starting: that click found it busy.
      if (sheet.open && !session) start();
      return;
    }
    session = started;
    const until = Date.now() + EXPIRES_MS;
    const tick = () => {
      const left = Math.max(0, until - Date.now());
      timer.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
      if (!left && session) end('The link expired.');
    };
    tick();
    countdown = setInterval(tick, 1000);
  }

  button.addEventListener('click', () => {
    sheet.showModal();
    if (!session && !starting) start();
  });

  copyLink.addEventListener('click', async () => {
    const label = copyLink.querySelector('span');
    try {
      await navigator.clipboard.writeText(linkField.value);
      label.textContent = 'Copied';
    } catch {
      linkField.select();
      label.textContent = 'Press ⌘C';
    }
    setTimeout(() => { label.textContent = 'Copy link'; }, 1500);
  });

  sheet.querySelector('.send').addEventListener('click', () => pending?.approve());
  sheet.querySelector('.decline').addEventListener('click', () => pending?.decline());

  const close = () => {
    end();
    sheet.close();
  };
  stopButton.addEventListener('click', close);
  sheet.querySelector('.close').addEventListener('click', close);
  // Esc closes the dialog natively; sharing stops with it.
  sheet.addEventListener('close', () => end());
  // Leaving the page ends the share; the recipient sees the link as closed.
  addEventListener('pagehide', () => end());
}
