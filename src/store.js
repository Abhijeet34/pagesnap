// Shots travel from the service worker to the viewer through IndexedDB because
// a full-page PNG easily exceeds chrome.storage.session's 10 MB quota.
const DB = 'pagesnap';
const STORE = 'shots';
const KEEP_MS = 24 * 60 * 60 * 1000;
const KEEP_COUNT = 20;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE) ? req.transaction.objectStore(STORE) : db.createObjectStore(STORE);
      // Lets pruning find old shots by key without loading their images.
      if (!store.indexNames.contains('created')) store.createIndex('created', 'created');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const request = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(request.result);
    t.onerror = () => reject(t.error);
    // A quota failure aborts the commit without an error event.
    t.onabort = () => reject(t.error || new Error('Could not store the screenshot (storage full?).'));
  });
}

export async function putShot(blob, meta) {
  const db = await open();
  const id = crypto.randomUUID();
  try {
    await tx(db, 'readwrite', (store) => store.put({ blob, ...meta, created: Date.now() }, id));
    await prune(db);
  } finally {
    db.close();
  }
  return id;
}

// Screenshots can hold sensitive pages, so old ones go: anything past a day,
// and anything beyond the newest few.
async function prune(db) {
  const cutoff = Date.now() - KEEP_MS;
  const oldestFirst = await tx(db, 'readonly', (store) => store.index('created').getAllKeys());
  const excess = Math.max(0, oldestFirst.length - KEEP_COUNT);
  const expired = await tx(db, 'readonly', (store) => store.index('created').getAllKeys(IDBKeyRange.upperBound(cutoff, true)));
  const stale = new Set([...oldestFirst.slice(0, excess), ...expired]);
  if (stale.size) await tx(db, 'readwrite', (store) => { for (const key of stale) store.delete(key); return store.count(); });
}

export async function getShot(id) {
  const db = await open();
  try {
    const shot = await tx(db, 'readonly', (store) => store.get(id));
    await prune(db);
    return shot && shot.created >= Date.now() - KEEP_MS ? shot : undefined;
  } finally {
    db.close();
  }
}

// Area selection is armed by the popup or a shortcut and consumed by the one
// selection that follows. chrome.storage.session is out of reach of content
// scripts by default, so a page cannot arm a capture of itself.
const AREA_TTL_MS = 5 * 60 * 1000;

export function armArea(tabId) {
  return chrome.storage.session.set({ [`area:${tabId}`]: Date.now() });
}

export async function takeArea(tabId) {
  const key = `area:${tabId}`;
  const { [key]: armed } = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  return typeof armed === 'number' && Date.now() - armed < AREA_TTL_MS;
}
