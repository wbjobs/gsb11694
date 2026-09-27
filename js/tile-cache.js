/* LRU 瓦片缓存：按字节预算控制内存，支持受保护集合（当前可见瓦片不淘汰） */
'use strict';

class TileCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.map = new Map(); // key -> {bitmap, bytes}，插入序即 LRU 序
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) { this.misses++; return null; }
    this.hits++;
    this.map.delete(key);
    this.map.set(key, e); // 移到最新
    return e.bitmap;
  }

  has(key) { return this.map.has(key); }

  set(key, bitmap, bytes, protect) {
    const old = this.map.get(key);
    if (old) { this.bytes -= old.bytes; old.bitmap.close(); this.map.delete(key); }
    this.map.set(key, { bitmap, bytes });
    this.bytes += bytes;
    this.evict(protect);
  }

  /* 从 LRU 端淘汰，跳过 protect 集合中的 key */
  evict(protect) {
    if (this.bytes <= this.maxBytes) return;
    for (const [key, e] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      if (protect && protect.has(key)) continue;
      this.map.delete(key);
      this.bytes -= e.bytes;
      e.bitmap.close();
    }
  }

  setBudget(maxBytes, protect) {
    this.maxBytes = maxBytes;
    this.evict(protect);
  }

  clear() {
    for (const e of this.map.values()) e.bitmap.close();
    this.map.clear();
    this.bytes = 0;
  }
}
