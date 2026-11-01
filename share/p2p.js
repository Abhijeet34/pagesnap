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
// fingerprints and a nonce from each side, the recipient's committed to before
// it sees the sender's, so someone else holding the link who sits between them
// cannot steer the two codes to match. The sender sends nothing until they
// approve the recipient. The link is the credential: anyone holding it can
// also pose as the sender, which the recipient catches only by checking the
// code with the sender.

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
// A peer that has not opened a channel by now never will.
const CONNECT_MS = 20_000;
// Live connections the sender keeps at once; offers past this wait for a slot.
const MAX_PEERS = 8;
const RECONNECT_MS = [3000, 10_000, 30_000];
// A recipient that has not revealed its nonce by now is stalling the queue.
const REVEAL_MS = 15_000;
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

// `context` is authenticated but not encrypted: it binds a sealed message to
// where it may be used, so a relay cannot move it somewhere else.
async function seal(key, bytes, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, bytes));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return out;
}

async function open(key, bytes, context) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(context) }, key, bytes.subarray(12)));
}

// An offer and its answer are each bound to the offer's id and direction.
const sealSdp = async (key, sdp, context) => toBase64Url(await seal(key, enc.encode(sdp), context));
async function openSdp(key, text, context) {
  const sdp = new TextDecoder().decode(await open(key, fromBase64Url(String(text)), context));
  fingerprint(sdp);
  return sdp;
}

// Exactly one fingerprint, or a second one could show the code a certificate
// the browser does not actually check.
function fingerprint(sdp) {
  const prints = [...sdp.matchAll(/^a=fingerprint:\S+ (\S+)/gm)];
  if (prints.length !== 1) throw new Error('Unexpected fingerprints');
  return prints[0][1];
}

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const NONCE = 16;

// Both sides hash the same two DTLS fingerprints and the same two nonces, so
// they see the same code only if no one sits between them.
async function codeFor(pc, recipientNonce, senderNonce) {
  const pair = [fingerprint(pc.localDescription.sdp), fingerprint(pc.remoteDescription.sdp)].sort().join('|');
  const hash = await sha256(enc.encode(`${pair}|${toBase64Url(recipientNonce)}|${toBase64Url(senderNonce)}`));
  return String(((hash[0] << 16) | (hash[1] << 8) | hash[2]) % 10000).padStart(4, '0');
}

const nonceFrom = (text) => {
  const bytes = fromBase64Url(String(text));
  if (bytes.length !== NONCE) throw new Error('Bad nonce');
  return bytes;
};

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
    const valid = urls.filter(validTracker);
    if (!valid.length) throw new Error('No usable tracker is configured.');
    for (const url of valid) this.connect(url, onMessage, 0);
  }

  connect(url, onMessage, drops) {
    const ws = new WebSocket(url);
    ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg?.info_hash === this.room && msg.peer_id !== this.peerId) onMessage(msg);
    };
    ws.onopen = () => {
      drops = 0;
      this.pending?.forEach((m) => ws.send(JSON.stringify(m)));
    };
    // Reconnects while the share is live, waiting longer after each failure.
    ws.onclose = () => {
      this.sockets = this.sockets.filter((s) => s !== ws);
      if (this.closed) return;
      const delay = RECONNECT_MS[Math.min(drops, RECONNECT_MS.length - 1)];
      setTimeout(() => !this.closed && this.connect(url, onMessage, drops + 1), delay);
    };
    this.sockets.push(ws);
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

// Resolves on close too, or a recipient leaving mid-send would hang it.
async function drain(channel) {
  if (channel.bufferedAmount < CHUNK * 8) return;
  await new Promise((r) => {
    const done = () => {
      channel.removeEventListener('close', done);
      r();
    };
    channel.bufferedAmountLowThreshold = CHUNK * 2;
    channel.onbufferedamountlow = done;
    channel.addEventListener('close', done);
  });
}

function parse(data) {
  if (typeof data !== 'string') return null;
  try { return JSON.parse(data); } catch { return null; }
}

// Sender: lives in the extension's viewer tab. onState receives
// { state: 'waiting' | 'request' | 'sending' | 'sent' | 'failed' | 'declined' | 'closed', ... }.
export async function share({ blob, secret, trackers = DEFAULT_TRACKERS, iceServers = DEFAULT_ICE, onState }) {
  if (blob.size + 16 > MAX_BYTES) throw new Error('This image is too large to share.');
  const keys = await derive(secret);
  // Encrypted once; every approved recipient would get the same ciphertext,
  // though the link allows only one.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.data, await blob.arrayBuffer()));
  const seen = new Set();
  const peers = new Set();
  // Recipients asking to be approved, one shown at a time; the rest wait.
  const queue = [];
  let active = null;
  let finished = false;
  // Offers being opened count against MAX_PEERS too, or a burst of replays
  // would all pass the check before any of them is added.
  let opening = 0;

  const drop = (pc) => {
    peers.delete(pc);
    pc.close();
  };

  const signal = new Signal(trackers, keys.room, async (msg) => {
    if (!msg.offer || finished || peers.size + opening >= MAX_PEERS || typeof msg.offer_id !== 'string' || seen.has(msg.offer_id)) return;
    // Marked before the await: each tracker relays the same offer.
    seen.add(msg.offer_id);
    opening++;
    let sdp;
    try {
      sdp = await openSdp(keys.signal, msg.offer.sdp, `offer:${msg.offer_id}`);
    } catch {
      // Not sealed with this link's key for this id: someone else's room or
      // junk, forgotten so it cannot grow this set.
      seen.delete(msg.offer_id);
      return;
    } finally {
      opening--;
    }
    if (finished) return;
    const pc = new RTCPeerConnection({ iceServers });
    peers.add(pc);
    let opened = false;
    pc.ondatachannel = ({ channel }) => {
      opened = true;
      serve(pc, channel);
    };
    setTimeout(() => { if (!opened) drop(pc); }, CONNECT_MS);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      if (finished) return drop(pc);
      signal.send({ to_peer_id: msg.peer_id, offer_id: msg.offer_id, answer: { type: 'answer', sdp: await sealSdp(keys.signal, pc.localDescription.sdp, `answer:${msg.offer_id}`) } });
    } catch {
      drop(pc); // a well-sealed but unusable offer from someone holding the link
    }
  });

  const announce = () => signal.send({ numwant: 0, left: 0, event: 'started', offers: [] });
  announce();
  const timer = setInterval(announce, ANNOUNCE_MS);

  function serve(pc, channel) {
    channel.binaryType = 'arraybuffer';
    const entry = { pc, channel, commit: null, nonce: null };
    channel.onmessage = async ({ data }) => {
      const msg = parse(data);
      if (!msg || finished) return;
      if (msg.t === 'hello' && !entry.commit && typeof msg.commit === 'string') {
        entry.commit = msg.commit;
        queue.push(entry);
        next();
      } else if (msg.t === 'reveal' && entry === active && entry.nonce && !entry.revealed) {
        entry.revealed = true;
        clearTimeout(entry.timer);
        let theirs;
        try {
          theirs = nonceFrom(msg.n);
        } catch {
          return reject(entry);
        }
        if (toBase64Url(await sha256(theirs)) !== entry.commit) return reject(entry);
        entry.code = await codeFor(pc, theirs, entry.nonce);
        if (entry !== active || finished) return;
        onState({ state: 'request', code: entry.code, approve: () => send(entry), decline: () => reject(entry, true) });
      } else if (msg.t === 'done' && entry === active && entry.sending) {
        finished = true;
        onState({ state: 'sent' });
        stop();
      }
    };
    channel.onclose = () => {
      peers.delete(pc);
      clearTimeout(entry.timer);
      if (queue.includes(entry)) queue.splice(queue.indexOf(entry), 1);
      if (entry !== active || finished) return;
      active = null;
      // Once bytes have gone out the link is spent, whatever the recipient
      // says: a close without 'done' may still have received everything.
      if (entry.sending) {
        finished = true;
        stop();
        onState({ state: 'failed', note: 'The transfer stopped part-way, and the link is used up. Share again for a new link.' });
        return;
      }
      onState({ state: 'waiting', note: 'The recipient left before approving.' });
      next();
    };
  }

  // Shows the next waiting recipient: the sender's nonce goes out only now,
  // after that recipient has committed to theirs.
  function next() {
    if (active || finished) return;
    while (queue.length && queue[0].channel.readyState !== 'open') queue.shift();
    active = queue.shift() ?? null;
    if (!active) return;
    const entry = active;
    entry.nonce = crypto.getRandomValues(new Uint8Array(NONCE));
    entry.channel.send(JSON.stringify({ t: 'nonce', n: toBase64Url(entry.nonce) }));
    entry.timer = setTimeout(() => { if (!entry.revealed) reject(entry); }, REVEAL_MS);
  }

  function reject(entry, byUser = false) {
    if (entry.channel.readyState === 'open') entry.channel.send(JSON.stringify({ t: 'declined' }));
    // Closed after a moment so the message above gets out first.
    setTimeout(() => drop(entry.pc), 500);
    if (entry !== active) return;
    active = null;
    if (byUser) onState({ state: 'declined' });
    next();
  }

  async function send(entry) {
    if (entry !== active || entry.sending || finished) return;
    entry.sending = true;
    const { channel } = entry;
    channel.send(JSON.stringify({ t: 'meta', size: payload.length, iv: toBase64Url(iv), type: blob.type || 'image/png' }));
    for (let offset = 0; offset < payload.length; offset += CHUNK) {
      await drain(channel);
      if (channel.readyState !== 'open') return;
      channel.send(payload.subarray(offset, offset + CHUNK));
      onState({ state: 'sending', value: Math.min(1, (offset + CHUNK) / payload.length) });
    }
    channel.send(JSON.stringify({ t: 'end' }));
  }

  function stop() {
    clearInterval(timer);
    signal.close();
    for (const pc of peers) pc.close();
    peers.clear();
    queue.length = 0;
  }

  onState({ state: 'waiting' });
  return { stop: () => { finished = true; stop(); onState({ state: 'closed' }); } };
}

// Receiver: runs on the receiver page. onState receives
// { state: 'connecting' | 'connected' | 'approval' | 'receiving' | 'received' | 'declined' | 'unreachable', ... }.
export async function receive({ secret, trackers = DEFAULT_TRACKERS, iceServers = DEFAULT_ICE, onState, timeoutMs = 60_000 }) {
  const keys = await derive(secret);
  let pc;
  let opened = false;
  let done = false;
  const offers = new Map();

  const signal = new Signal(trackers, keys.room, async (msg) => {
    const entry = offers.get(msg.offer_id);
    if (!msg.answer || pc || !entry) return;
    try {
      const sdp = await openSdp(keys.signal, msg.answer.sdp, `answer:${msg.offer_id}`);
      if (pc) return;
      await entry.setRemoteDescription({ type: 'answer', sdp });
    } catch {
      return; // junk, or not the answer to this offer: keep waiting
    }
    if (pc) return;
    pc = entry;
    for (const [id, other] of offers) if (other !== pc) { other.close(); offers.delete(id); }
    // A direct connection can still fail, between two strict NATs say; there is
    // no relay to fall back on, so say so rather than wait forever.
    setTimeout(() => { if (!opened) finish(UNREACHABLE); }, CONNECT_MS);
  });

  async function offer() {
    const peer = new RTCPeerConnection({ iceServers });
    const channel = peer.createDataChannel('pagesnap', { ordered: true });
    channel.binaryType = 'arraybuffer';
    // Committed to before the sender's nonce is known.
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
    channel.onopen = async () => {
      opened = true;
      onState({ state: 'connected' });
      channel.send(JSON.stringify({ t: 'hello', commit: toBase64Url(await sha256(nonce)) }));
    };
    peer.onconnectionstatechange = () => {
      if (peer === pc && peer.connectionState === 'failed') finish(UNREACHABLE);
    };
    channel.onmessage = handle(peer, channel, nonce);
    channel.onclose = () => { if (peer === pc && !done) finish('The connection closed before the image arrived.'); };
    await peer.setLocalDescription(await peer.createOffer());
    await gathered(peer);
    if (pc || done) return peer.close();
    const id = randomId();
    offers.set(id, peer);
    signal.send({ numwant: 1, left: 1, event: 'started', offers: [{ offer_id: id, offer: { type: 'offer', sdp: await sealSdp(keys.signal, peer.localDescription.sdp, `offer:${id}`) } }] });
  }

  function handle(peer, channel, nonce) {
    let meta = null;
    let buffer = null;
    let received = 0;
    let code = null;
    let nonced = false;
    return async ({ data }) => {
      if (typeof data !== 'string') {
        if (!buffer) return;
        if (received + data.byteLength > buffer.length) return finish('The sender sent more than it announced.');
        buffer.set(new Uint8Array(data), received);
        received += data.byteLength;
        onState({ state: 'receiving', value: received / buffer.length });
        return;
      }
      const msg = parse(data);
      if (!msg) return;
      if (msg.t === 'nonce' && !nonced) {
        nonced = true;
        let theirs;
        try {
          theirs = nonceFrom(msg.n);
        } catch {
          return finish('The sender’s side sent something unexpected.');
        }
        code = await codeFor(peer, nonce, theirs);
        channel.send(JSON.stringify({ t: 'reveal', n: toBase64Url(nonce) }));
        onState({ state: 'approval', code });
      } else if (msg.t === 'declined') {
        done = true;
        onState({ state: 'declined' });
        finish();
      } else if (msg.t === 'meta' && code && !meta) {
        let iv;
        try {
          iv = fromBase64Url(String(msg.iv));
        } catch {
          iv = null;
        }
        if (!(Number.isSafeInteger(msg.size) && msg.size > 16 && msg.size <= MAX_BYTES && iv?.length === 12 && /^image\/(png|jpeg)$/.test(msg.type))) {
          return finish('The sender offered a file this page does not accept.');
        }
        meta = { ...msg, iv };
        buffer = new Uint8Array(msg.size);
        onState({ state: 'receiving', value: 0 });
      } else if (msg.t === 'end' && meta) {
        if (received !== buffer.length) return finish('The image arrived incomplete.');
        let bytes;
        try {
          bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: meta.iv }, keys.data, buffer);
        } catch {
          return finish('The image could not be decrypted with this link.');
        }
        buffer = null;
        done = true;
        channel.send(JSON.stringify({ t: 'done' }));
        onState({ state: 'received', blob: new Blob([bytes], { type: meta.type }), code });
        setTimeout(finish, 1000);
      }
    };
  }

  function finish(error) {
    clearInterval(retry);
    clearTimeout(expiry);
    signal.close();
    for (const peer of offers.values()) peer.close();
    pc?.close();
    if (error && !done) {
      done = true;
      onState({ state: 'unreachable', note: error });
    }
  }

  onState({ state: 'connecting' });
  // A fresh offer every few seconds covers a sender who opens the share a
  // moment after the link was sent, and offers lost on a busy tracker.
  const retry = setInterval(() => { if (!pc) offer().catch(() => {}); }, 5000); // best effort: the next tick tries again
  const expiry = setTimeout(() => {
    if (!pc) finish('No one is sharing on this link. It may have expired, or the sender closed it.');
  }, timeoutMs);
  try {
    await offer();
  } catch (e) {
    done = true;
    finish();
    throw e;
  }
  return { stop: () => { done = true; finish(); } };
}

const UNREACHABLE = 'Couldn’t connect to the sender’s browser directly. Some networks block peer-to-peer connections; try another network.';
