// Shots travel from the service worker to the viewer through IndexedDB because
// a full-page PNG easily exceeds chrome.storage.session's 10 MB quota.
const DB = 'pagesnap';
const STORE = 'shots';
const KEEP_MS = 24 * 60 * 60 * 1000;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
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
  });
}

export async function putShot(blob, meta) {
  const db = await open();
  const id = crypto.randomUUID();
  const cutoff = Date.now() - KEEP_MS;
  await tx(db, 'readwrite', (store) => {
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (cursor.value.created < cutoff) cursor.delete();
      cursor.continue();
    };
    return store.put({ blob, ...meta, created: Date.now() }, id);
  });
  db.close();
  return id;
}

export async function getShot(id) {
  const db = await open();
  const shot = await tx(db, 'readonly', (store) => store.get(id));
  db.close();
  return shot;
}
