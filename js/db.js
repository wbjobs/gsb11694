/* IndexedDB 封装：瓦片持久化存储（主线程与 Worker 共用） */
'use strict';

class PyramidDB {
  constructor(name = 'img-pyramid-db') {
    this.name = name;
    this.db = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => { this.db = req.result; resolve(this); };
      req.onerror = () => reject(req.error);
    });
  }

  _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const os = tx.objectStore(store);
      const out = fn(os);
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  putMeta(meta) { return this._tx('meta', 'readwrite', os => os.put(meta, 'pyramid')); }

  getMeta() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('pyramid');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /* 单事务批量写入一层瓦片，entries: [{key, data, w, h}] */
  putTiles(entries) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('tiles', 'readwrite');
      const os = tx.objectStore('tiles');
      for (const e of entries) os.put({ data: e.data, w: e.w, h: e.h }, e.key);
      tx.oncomplete = () => resolve(entries.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  getTile(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('tiles', 'readonly');
      const req = tx.objectStore('tiles').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  clear() {
    return Promise.all([
      this._tx('tiles', 'readwrite', os => os.clear()),
      this._tx('meta', 'readwrite', os => os.clear()),
    ]);
  }

  count() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('tiles', 'readonly');
      const req = tx.objectStore('tiles').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

if (typeof module !== 'undefined') module.exports = PyramidDB;
