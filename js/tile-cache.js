/*
 * tile-cache.js — LRU 瓦片缓存，带字节预算的内存控制。
 * 缓存 ImageBitmap；超预算时按最久未使用逐出并 close() 释放显存。
 */
(function (root) {
  'use strict';

  class TileCache {
    constructor(budgetBytes) {
      this.budget = budgetBytes;           // 内存预算（字节）
      this.map = new Map();                // key -> {bitmap, bytes, lastUsed}
      this.bytes = 0;
      this.hits = 0;
      this.misses = 0;
      this.evictions = 0;
      this._tick = 0;
    }

    setBudget(budgetBytes) {
      this.budget = budgetBytes;
      this._evictIfNeeded();
    }

    get(key) {
      const entry = this.map.get(key);
      if (!entry) { this.misses++; return null; }
      entry.lastUsed = ++this._tick;
      this.hits++;
      return entry.bitmap;
    }

    has(key) { return this.map.has(key); }

    put(key, bitmap, bytes) {
      const old = this.map.get(key);
      if (old) { this.bytes -= old.bytes; old.bitmap.close(); }
      this.map.set(key, { bitmap, bytes, lastUsed: ++this._tick });
      this.bytes += bytes;
      this._evictIfNeeded();
    }

    _evictIfNeeded() {
      if (this.bytes <= this.budget) return;
      // 按 lastUsed 升序逐出，直到回到预算内
      const entries = [...this.map.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [key, entry] of entries) {
        if (this.bytes <= this.budget) break;
        entry.bitmap.close();
        this.bytes -= entry.bytes;
        this.map.delete(key);
        this.evictions++;
      }
    }

    clear() {
      for (const entry of this.map.values()) entry.bitmap.close();
      this.map.clear();
      this.bytes = 0;
    }

    stats() {
      return {
        tiles: this.map.size,
        bytes: this.bytes,
        budget: this.budget,
        hits: this.hits,
        misses: this.misses,
        evictions: this.evictions,
      };
    }
  }

  root.TileCache = TileCache;
})(typeof self !== 'undefined' ? self : globalThis);
