/*
 * idb.js — IndexedDB Promise 封装（tiles / meta 两个 store）。
 * 同时兼容 window 与 Web Worker（importScripts）。
 */
(function (root) {
  'use strict';
  const DB_NAME = 'image-pyramid-db';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tiles')) {
          db.createObjectStore('tiles', { keyPath: 'key' }); // key: "g:level:tx:ty" / "l:level:tx:ty"
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out._result !== undefined ? out._result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const IDBStore = {
    async putTiles(tiles) {
      const db = await openDB();
      return tx(db, 'tiles', 'readwrite', (s) => {
        for (const tile of tiles) s.put(tile);
      });
    },
    async getTile(key) {
      const db = await openDB();
      return reqToPromise(db.transaction('tiles', 'readonly').objectStore('tiles').get(key));
    },
    async putMeta(id, value) {
      const db = await openDB();
      return tx(db, 'meta', 'readwrite', (s) => { s.put({ id, value }); });
    },
    async getMeta(id) {
      const db = await openDB();
      const row = await reqToPromise(db.transaction('meta', 'readonly').objectStore('meta').get(id));
      return row ? row.value : undefined;
    },
    async clearAll() {
      const db = await openDB();
      await tx(db, 'tiles', 'readwrite', (s) => { s.clear(); });
      await tx(db, 'meta', 'readwrite', (s) => { s.clear(); });
    },
    async tileCount() {
      const db = await openDB();
      return reqToPromise(db.transaction('tiles', 'readonly').objectStore('tiles').count());
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = IDBStore;
  else root.IDBStore = IDBStore;
})(typeof self !== 'undefined' ? self : globalThis);
