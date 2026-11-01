// Peer-to-peer screenshot sharing, used by the extension (sender) and by the
// receiver page. Nothing is stored anywhere: the image streams from the
// sender's open tab straight to the recipient over WebRTC.
//
// The link carries a 128-bit secret in its #fragment, which browsers never
// send to a server. Everything is derived from it with HKDF:
// - the room id announced to public WebTorrent trackers, which only relay
//   connection setup between the two browsers;
// - a key that encrypts that setup (SDP), so a tracker can neither read nor
//   alter it, and so cannot put itself between the peers;
// - a key that encrypts the image itself, on top of WebRTC's own DTLS.
// Both sides show a 4-digit code computed from the connection's DTLS
// fingerprints; the sender sends nothing until they approve the recipient.

export const DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
];
export const DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
export const SECRET_LENGTH = 22; // 16 bytes in base64url
export const MAX_BYTES = 256 * 1024 * 1024;

const CHUNK = 64 * 1024;
const ICE_WAIT_MS = 4000;
const ANNOUNCE_MS = 20_000;
const enc = new TextEncoder();

export function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Not base64url');
  const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function newSecret() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export function isSecret(text) {
  return typeof text === 'string' && text.length === SECRET_LENGTH && /^[A-Za-z0-9_-]+$/.test(text);
}

// Trackers speak in 20-character binary strings.
const binary = (bytes) => String.fromCharCode(...bytes);
const randomId = () => binary(crypto.getRandomValues(new Uint8Array(20)));

async function derive(secret) {
  const base = await crypto.subtle.importKey('raw', fromBase64Url(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('pagesnap/v1'), info: enc.encode(info) });
  const aes = (info) => crypto.subtle.deriveKey(params(info), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return {
    room: binary(new Uint8Array(await crypto.subtle.deriveBits(params('room'), base, 160))),
    signal: await aes('signal'),
    data: await aes('data'),
  };
}

async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return out;
}

async function open(key, bytes) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
}

const sealSdp = async (key, sdp) => toBase64Url(await seal(key, enc.encode(sdp)));
const openSdp = async (key, text) => new TextDecoder().decode(await open(key, fromBase64Url(text)));

// Both sides hash the same two DTLS fingerprints, so they see the same code
// only if no one sits between them.
async function codeFor(pc) {
  const print = (sdp) => sdp.match(/^a=fingerprint:\S+ (\S+)/m)?.[1] ?? '';
  const pair = [print(pc.localDescription.sdp), print(pc.remoteDescription.sdp)].sort().join('|');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(pair)));
  return String(((hash[0] << 16) | (hash[1] << 8) | hash[2]) % 10000).padStart(4, '0');
}

// Waits for ICE gathering so one encrypted message carries every candidate.
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, ICE_WAIT_MS);
  });
}

// Allows ws:// only for a tracker on this machine (tests, self-hosting).
export function validTracker(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'wss:' || (u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

// One room on several trackers; messages are deduplicated by the caller.
class Signal {
  constructor(urls, room, onMessage) {
    this.room = room;
    this.peerId = randomId();
    this.sockets = [];
    this.closed = false;
    for (const url of urls.filter(validTracker)) this.connect(url, onMessage);
  }

  connect(url, onMessage) {
    const ws = new WebSocket(url);
    ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg?.info_hash === this.room && msg.peer_id !== this.peerId) onMessage(msg);
    };
    ws.onopen = () => this.pending?.forEach((m) => ws.send(JSON.stringify(m)));
    // One reconnect attempt per drop while the share is live.
    ws.onclose = () => { if (!this.closed) setTimeout(() => !this.closed && this.connect(url, onMessage), 3000); };
    this.sockets = this.sockets.filter((s) => s.url !== url).concat(ws);
  }

  send(msg) {
    const full = { action: 'announce', info_hash: this.room, peer_id: this.peerId, uploaded: 0, downloaded: 0, ...msg };
    // Remembered so sockets that open later announce too.
    if (!msg.answer) this.pending = [full];
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(full));
  }

  close() {
    this.closed = true;
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'announce', info_hash: this.room, peer_id: this.peerId, event: 'stopped', uploaded: 0, downloaded: 0, left: 0, numwant: 0 }));
      ws.close();
    }
  }
}

function sendJson(channel, value) {
  channel.send(JSON.stringify(value));
}

async function drain(channel) {
  if (channel.bufferedAmount < CHUNK * 8) return;
  await new Promise((r) => { channel.bufferedAmountLowThreshold = CHUNK * 2; channel.onbufferedamountlow = r; });
}

// Sender: lives in the extension's viewer tab. onState receives
// { state: 'waiting' | 'request' | 'sending' | 'sent' | 'declined' | 'closed', ... }.
export async function share({ blob, secret, trackers = DEFAULT_TRACKERS, iceServers = DEFAULT_ICE, onState }) {
  const keys = await derive(secret);
  const payload = await seal(keys.data, new Uint8Array(await blob.arrayBuffer()));
  const seen = new Set();
  const peers = new Set();
  let busy = false;
  let finished = false;

  const signal = new Signal(trackers, keys.room, async (msg) => {
    if (!msg.offer || finished || busy || seen.has(msg.offer_id)) return;
    seen.add(msg.offer_id);
    let sdp;
    try {
      sdp = await openSdp(keys.signal, msg.offer.sdp);
    } catch {
      return; // not sealed with this link's key: someone else's room or junk
    }
    const pc = new RTCPeerConnection({ iceServers });
    peers.add(pc);
    pc.ondatachannel = ({ channel }) => serve(pc, channel);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    signal.send({ to_peer_id: msg.peer_id, offer_id: msg.offer_id, answer: { type: 'answer', sdp: await sealSdp(keys.signal, pc.localDescription.sdp) } });
  });

  const announce = () => signal.send({ numwant: 0, left: 0, event: 'started', offers: [] });
  announce();
  const timer = setInterval(announce, ANNOUNCE_MS);

  function serve(pc, channel) {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = async ({ data }) => {
      if (typeof data !== 'string' || finished || busy) return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.t !== 'hello') return;
      busy = true;
      const code = await codeFor(pc);
      onState({
        state: 'request',
        code,
        approve: () => send(pc, channel),
        decline: () => {
          sendJson(channel, { t: 'declined' });
          busy = false;
          setTimeout(() => pc.close(), 500);
          onState({ state: 'declined' });
        },
      });
    };
    channel.onclose = () => {
      peers.delete(pc);
      if (busy && !finished) {
        busy = false;
        onState({ state: 'waiting', note: 'The recipient left before the transfer finished.' });
      }
    };
  }

  async function send(pc, channel) {
    sendJson(channel, { t: 'meta', size: payload.length, type: blob.type || 'image/png' });
    for (let offset = 0; offset < payload.length; offset += CHUNK) {
      if (channel.readyState !== 'open') return;
      await drain(channel);
      channel.send(payload.subarray(offset, offset + CHUNK));
      onState({ state: 'sending', value: Math.min(1, (offset + CHUNK) / payload.length) });
    }
    sendJson(channel, { t: 'end' });
    channel.onmessage = ({ data }) => {
      if (typeof data === 'string' && data.includes('"done"')) {
        finished = true;
        onState({ state: 'sent' });
        stop();
      }
    };
  }

  function stop() {
    clearInterval(timer);
    signal.close();
    for (const pc of peers) pc.close();
    peers.clear();
  }

  onState({ state: 'waiting' });
  return { stop: () => { finished = true; stop(); onState({ state: 'closed' }); } };
}

// Receiver: runs on the receiver page. onState receives
// { state: 'connecting' | 'approval' | 'receiving' | 'received' | 'declined' | 'unreachable', ... }.
export async function receive({ secret, trackers = DEFAULT_TRACKERS, iceServers = DEFAULT_ICE, onState, timeoutMs = 60_000 }) {
  const keys = await derive(secret);
  let pc;
  let connected = false;
  let done = false;
  const offers = new Map();

  const signal = new Signal(trackers, keys.room, async (msg) => {
    const entry = offers.get(msg.offer_id);
    if (!msg.answer || connected || !entry) return;
    let sdp;
    try {
      sdp = await openSdp(keys.signal, msg.answer.sdp);
    } catch {
      return;
    }
    connected = true;
    pc = entry;
    for (const [id, other] of offers) if (other !== pc) { other.close(); offers.delete(id); }
    await pc.setRemoteDescription({ type: 'answer', sdp });
  });

  async function offer() {
    const peer = new RTCPeerConnection({ iceServers });
    const channel = peer.createDataChannel('pagesnap', { ordered: true });
    channel.binaryType = 'arraybuffer';
    channel.onopen = async () => {
      onState({ state: 'approval', code: await codeFor(peer) });
      sendJson(channel, { t: 'hello' });
    };
    channel.onmessage = handle(channel);
    channel.onclose = () => { if (!done) onState({ state: 'unreachable', note: 'The connection closed before the image arrived.' }); };
    await peer.setLocalDescription(await peer.createOffer());
    await gathered(peer);
    const id = randomId();
    offers.set(id, peer);
    signal.send({ numwant: 1, left: 1, event: 'started', offers: [{ offer_id: id, offer: { type: 'offer', sdp: await sealSdp(keys.signal, peer.localDescription.sdp) } }] });
  }

  function handle(channel) {
    let meta = null;
    let received = 0;
    let parts = [];
    return async ({ data }) => {
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.t === 'declined') {
          done = true;
          onState({ state: 'declined' });
          finish();
        } else if (msg.t === 'meta') {
          if (!(Number.isSafeInteger(msg.size) && msg.size > 28 && msg.size <= MAX_BYTES)) return finish('The sender offered a file this page does not accept.');
          if (!/^image\/(png|jpeg)$/.test(msg.type)) return finish('The sender offered a file this page does not accept.');
          meta = msg;
          onState({ state: 'receiving', value: 0 });
        } else if (msg.t === 'end' && meta) {
          if (received !== meta.size) return finish('The image arrived incomplete.');
          const sealed = new Uint8Array(received);
          let at = 0;
          for (const p of parts) { sealed.set(p, at); at += p.length; }
          parts = [];
          let bytes;
          try {
            bytes = await open(keys.data, sealed);
          } catch {
            return finish('The image could not be decrypted with this link.');
          }
          done = true;
          sendJson(channel, { t: 'done' });
          onState({ state: 'received', blob: new Blob([bytes], { type: meta.type }) });
          setTimeout(finish, 1000);
        }
        return;
      }
      if (!meta) return;
      received += data.byteLength;
      if (received > meta.size) return finish('The sender sent more than it announced.');
      parts.push(new Uint8Array(data));
      onState({ state: 'receiving', value: received / meta.size });
    };
  }

  function finish(error) {
    clearInterval(retry);
    clearTimeout(expiry);
    signal.close();
    for (const peer of offers.values()) if (peer !== pc) peer.close();
    pc?.close();
    if (error) {
      done = true;
      onState({ state: 'unreachable', note: error });
    }
  }

  onState({ state: 'connecting' });
  await offer();
  // A fresh offer every few seconds covers a sender who opens the share a
  // moment after the link was sent, and offers lost on a busy tracker.
  const retry = setInterval(() => { if (!connected) offer(); }, 5000);
  const expiry = setTimeout(() => {
    if (!connected) finish('No one is sharing on this link. It may have expired, or the sender closed it.');
  }, timeoutMs);
  return { stop: () => { done = true; finish(); } };
}
