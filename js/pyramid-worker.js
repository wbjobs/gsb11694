/* 金字塔构建 Worker：高斯/拉普拉斯金字塔 + 瓦片切分 + IndexedDB 落盘
 * 全程 TypedArray 计算，主线程零阻塞。 */
'use strict';

importScripts('db.js');

const K = [1, 4, 6, 4, 1]; // 5x5 高斯核（可分离），归一化系数 1/16

/* 高斯降采样：可分离 5x5 核 + 2 倍抽取，边缘钳制 */
function downsample(src, w, h) {
  const w2 = Math.ceil(w / 2), h2 = Math.ceil(h / 2);
  const tmp = new Float32Array(w2 * h * 4);
  const dst = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h; y++) {
    const rowIn = y * w, rowOut = y * w2;
    for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -2; k <= 2; k++) {
        let sx = 2 * x + k;
        if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
        const i = (rowIn + sx) * 4, kv = K[k + 2];
        r += src[i] * kv; g += src[i + 1] * kv; b += src[i + 2] * kv; a += src[i + 3] * kv;
      }
      const o = (rowOut + x) * 4;
      tmp[o] = r * 0.0625; tmp[o + 1] = g * 0.0625; tmp[o + 2] = b * 0.0625; tmp[o + 3] = a * 0.0625;
    }
  }
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -2; k <= 2; k++) {
        let sy = 2 * y + k;
        if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
        const i = (sy * w2 + x) * 4, kv = K[k + 2];
        r += tmp[i] * kv; g += tmp[i + 1] * kv; b += tmp[i + 2] * kv; a += tmp[i + 3] * kv;
      }
      const o = (y * w2 + x) * 4;
      dst[o] = r * 0.0625; dst[o + 1] = g * 0.0625; dst[o + 2] = b * 0.0625; dst[o + 3] = a * 0.0625;
    }
  }
  return { data: dst, w: w2, h: h2 };
}

/* 上采样扩展（Burt-Adelson expand，增益 4），输出尺寸 (tw, th) */
function expand(src, w, h, tw, th) {
  const tmp = new Float32Array(tw * h * 4);
  const dst = new Float32Array(tw * th * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < tw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -2; k <= 2; k++) {
        const t = x - k;
        if (t & 1) continue;
        const sx = t >> 1;
        if (sx < 0 || sx >= w) continue;
        const i = (y * w + sx) * 4, kv = K[k + 2];
        r += src[i] * kv; g += src[i + 1] * kv; b += src[i + 2] * kv; a += src[i + 3] * kv;
      }
      const o = (y * tw + x) * 4;
      tmp[o] = r * 0.125; tmp[o + 1] = g * 0.125; tmp[o + 2] = b * 0.125; tmp[o + 3] = a * 0.125;
    }
  }
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -2; k <= 2; k++) {
        const t = y - k;
        if (t & 1) continue;
        const sy = t >> 1;
        if (sy < 0 || sy >= h) continue;
        const i = (sy * tw + x) * 4, kv = K[k + 2];
        r += tmp[i] * kv; g += tmp[i + 1] * kv; b += tmp[i + 2] * kv; a += tmp[i + 3] * kv;
      }
      const o = (y * tw + x) * 4;
      dst[o] = r * 0.125; dst[o + 1] = g * 0.125; dst[o + 2] = b * 0.125; dst[o + 3] = a * 0.125;
    }
  }
  return dst;
}

/* 把一层图像切成 tileSize 瓦片（边缘瓦片尺寸更小） */
function sliceTiles(prefix, level, data, w, h, ts) {
  const tiles = [];
  const tilesX = Math.ceil(w / ts), tilesY = Math.ceil(h / ts);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tw = Math.min(ts, w - tx * ts), th = Math.min(ts, h - ty * ts);
      const buf = new Uint8ClampedArray(tw * th * 4);
      for (let row = 0; row < th; row++) {
        const s = ((ty * ts + row) * w + tx * ts) * 4;
        buf.set(data.subarray(s, s + tw * 4), row * tw * 4);
      }
      tiles.push({ key: prefix + ':' + level + ':' + tx + ':' + ty, data: buf, w: tw, h: th });
    }
  }
  return { tiles, tilesX, tilesY };
}

/* 程序化生成测试大图：网格 / 色块 / 多频条纹 / 圆环，便于观察多分辨率差异 */
function generateImage(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x / size, v = y / size;
      let r = 40 + 180 * u, g = 40 + 180 * v, b = 200 - 120 * u * v;
      // 细网格（高频细节）
      if (x % 64 === 0 || y % 64 === 0) { r = 255; g = 255; b = 255; }
      if (x % 512 === 0 || y % 512 === 0) { r = 30; g = 30; b = 30; }
      // 多频正弦条纹（检验降采样抗混叠）
      const s1 = Math.sin(x * 0.8) * Math.sin(y * 0.8);
      const s2 = Math.sin(x * 0.08 + y * 0.05);
      r += 30 * s1; g += 25 * s2; b += 30 * s1 * s2;
      // 圆环
      const dx = x - size / 2, dy = y - size / 2;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs((d % 200) - 100) < 3) { r = 255; g = 200; b = 0; }
      // 伪随机噪点块
      const n = ((x * 7349 + y * 15187) ^ (x * y)) & 63;
      if (n < 2) { r = 255 - r; g = 255 - g; b = 255 - b; }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, w: size, h: size };
}

async function build(db, level0, tileSize) {
  const t0 = performance.now();
  await db.clear();

  const levels = [];
  let cur = level0;
  let maxReconErr = 0;

  while (true) {
    const isLast = cur.w <= tileSize && cur.h <= tileSize;
    const g = sliceTiles('g', levels.length, cur.data, cur.w, cur.h, tileSize);
    await db.putTiles(g.tiles);
    postMessage({ type: 'progress', phase: 'gaussian', level: levels.length, w: cur.w, h: cur.h, tiles: g.tiles.length });

    let next = null, lapErr = 0;
    if (!isLast) {
      next = downsample(cur.data, cur.w, cur.h);
      // 拉普拉斯层：L = G - expand(G_next)，Float32 计算，(L+255)/2 量化存储
      const up = expand(next.data, next.w, next.h, cur.w, cur.h);
      // L ∈ [-255,255]，映射 (L+255)/2 → [0,255] 全量程存储，量化步长 2，重建误差 ≤ 1
      const lq = new Uint8ClampedArray(cur.w * cur.h * 4);
      for (let i = 0; i < up.length; i += 4) {
        lq[i] = (cur.data[i] - up[i] + 255) * 0.5;
        lq[i + 1] = (cur.data[i + 1] - up[i + 1] + 255) * 0.5;
        lq[i + 2] = (cur.data[i + 2] - up[i + 2] + 255) * 0.5;
        lq[i + 3] = 255;
        // 重建误差校验：G ≈ (Lq * 2 - 255) + expand(G_next)
        const e0 = Math.abs(cur.data[i] - (lq[i] * 2 - 255 + up[i]));
        const e1 = Math.abs(cur.data[i + 1] - (lq[i + 1] * 2 - 255 + up[i + 1]));
        const e2 = Math.abs(cur.data[i + 2] - (lq[i + 2] * 2 - 255 + up[i + 2]));
        const e = Math.max(e0, e1, e2);
        if (e > lapErr) lapErr = e;
      }
      if (lapErr > maxReconErr) maxReconErr = lapErr;
      const l = sliceTiles('l', levels.length, lq, cur.w, cur.h, tileSize);
      await db.putTiles(l.tiles);
      postMessage({ type: 'progress', phase: 'laplacian', level: levels.length, reconErr: lapErr });
    }

    levels.push({ w: cur.w, h: cur.h, tilesX: g.tilesX, tilesY: g.tilesY });
    if (isLast) break;
    cur = next; // 释放上一层引用，控制 Worker 内存
  }

  const meta = {
    tileSize,
    levels,
    origW: levels[0].w,
    origH: levels[0].h,
    buildMs: Math.round(performance.now() - t0),
    maxReconErr,
    builtAt: Date.now(),
  };
  await db.putMeta(meta);
  return meta;
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'build' || msg.type === 'generate') {
      const db = await new PyramidDB().open();
      let level0;
      if (msg.type === 'generate') {
        postMessage({ type: 'progress', phase: 'generate', size: msg.size });
        level0 = generateImage(msg.size);
      } else if (msg.bitmap) {
        // ImageBitmap 从主线程转移过来，在 Worker 内解码为 TypedArray
        const w = msg.bitmap.width, h = msg.bitmap.height;
        const oc = new OffscreenCanvas(w, h);
        const ctx = oc.getContext('2d');
        ctx.drawImage(msg.bitmap, 0, 0);
        msg.bitmap.close();
        level0 = { data: ctx.getImageData(0, 0, w, h).data, w, h };
      } else {
        level0 = { data: new Uint8ClampedArray(msg.buffer), w: msg.width, h: msg.height };
      }
      const meta = await build(db, level0, msg.tileSize || 256);
      postMessage({ type: 'done', meta });
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
