// Lokale Datenbank (IndexedDB). Alle Daten bleiben auf dem Gerät.
const DB_NAME = 'autodarts180';
const DB_VERSION = 1;
const STORES = ['players', 'matches', 'kv', 'samples'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('players')) db.createObjectStore('players', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('matches')) {
        const s = db.createObjectStore('matches', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('samples')) db.createObjectStore('samples', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  put: (store, value) => tx(store, 'readwrite', (s) => s.put(structuredClone(value))),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),

  async getKV(key, fallback = null) {
    const r = await this.get('kv', key);
    return r ? r.value : fallback;
  },
  setKV(key, value) {
    return this.put('kv', { key, value });
  },

  async exportAll({ includeSamples = false } = {}) {
    const out = { app: 'Autodarts180', format: 1, exportedAt: new Date().toISOString() };
    for (const s of STORES) {
      if (s === 'samples' && !includeSamples) continue;
      out[s] = await this.all(s);
    }
    return out;
  },

  async importAll(data, { replace = false } = {}) {
    if (!data || data.app !== 'Autodarts180') throw new Error('Keine gültige Autodarts180-Sicherung');
    for (const s of STORES) {
      if (!Array.isArray(data[s])) continue;
      if (replace) await this.clear(s);
      for (const item of data[s]) await this.put(s, item);
    }
  },

  async wipe() {
    for (const s of STORES) await this.clear(s);
  },
};
