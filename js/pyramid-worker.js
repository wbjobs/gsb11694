/*
 * pyramid-worker.js — 在 Worker 中构建高斯/拉普拉斯金字塔。
 * 每层切瓦片后流式写入 IndexedDB，随即释放，峰值内存 ~2 层 + 1 个条带。
 * 消息协议：
 *   <- {type:'generate', size}
 *   <- {type:'build', width, height, buffer, tileSize, minDim}
 *   <- {type:'clear'}
 *   -> {type:'generated'|'progress'|'level'|'done'|'error'|'cleared', ...}
 */
importScripts('pyramid-core.js', 'idb.js');

'use strict';

const BAND_ROWS = 256; // 上采样条带高度，控制峰值内存

// ---------- 合成测试图 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateTestImage(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  const rand = mulberry32(11694);
  // 背景渐变
  for (let y = 0; y < size; y++) {
    const fy = y / size;
    for (let x = 0; x < size; x++) {
      const fx = x / size;
      const i = (y * size + x) * 4;
      data[i] = 30 + 120 * fx;
      data[i + 1] = 40 + 100 * fy;
      data[i + 2] = 90 + 80 * (1 - fx) * fy;
      data[i + 3] = 255;
    }
  }
  // 随机圆盘
  const circles = [];
  for (let c = 0; c < 200; c++) {
    circles.push({
      cx: rand() * size, cy: rand() * size,
      r: 20 + rand() * size * 0.08,
      cr: (rand() * 255) | 0, cg: (rand() * 255) | 0, cb: (rand() * 255) | 0,
    });
  }
  for (const c of circles) {
    const x0 = Math.max(0, c.cx - c.r) | 0, x1 = Math.min(size - 1, c.cx + c.r) | 0;
    const y0 = Math.max(0, c.cy - c.r) | 0, y1 = Math.min(size - 1, c.cy + c.r) | 0;
    const r2 = c.r * c.r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - c.cx, dy = y - c.cy;
        if (dx * dx + dy * dy > r2) continue;
        const i = (y * size + x) * 4;
        const alpha = 0.55;
        data[i] = data[i] * (1 - alpha) + c.cr * alpha;
        data[i + 1] = data[i + 1] * (1 - alpha) + c.cg * alpha;
        data[i + 2] = data[i + 2] * (1 - alpha) + c.cb * alpha;
      }
    }
  }
  // 网格线（每 size/64 一条）
  const step = Math.max(8, size >> 6);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x % step === 0 || y % step === 0) {
        const i = (y * size + x) * 4;
        data[i] = 240; data[i + 1] = 240; data[i + 2] = 240;
      }
    }
  }
  // 左上角高频棋盘区（检验高分辨率细节与降采样抗锯齿）
  const cbSize = Math.min(size >> 3, 1024);
  for (let y = 0; y < cbSize; y++) {
    for (let x = 0; x < cbSize; x++) {
      const v = ((x >> 2) + (y >> 2)) % 2 === 0 ? 255 : 0;
      const i = (y * size + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = 255 - v;
    }
  }
  return data;
}

// ---------- 金字塔构建 ----------
async function buildPyramid(width, height, buffer, tileSize, minDim) {
  const t0 = performance.now();
  await IDBStore.clearAll();
  const levels = PyramidCore.computeLevelCount(width, height, minDim);
  const levelStats = [];
  let gauss = new Uint8ClampedArray(buffer);
  let w = width, h = height;

  for (let level = 0; level < levels; level++) {
    const lt0 = performance.now();
    const curW = w, curH = h;
    // 1) 高斯层瓦片 → IDB
    const tiles = PyramidCore.splitTiles(gauss, w, h, tileSize);
    let bytes = 0;
    const rows = tiles.map((t) => {
      bytes += t.data.byteLength;
      return {
        key: 'g:' + level + ':' + t.x / tileSize + ':' + t.y / tileSize,
        level, tx: t.x / tileSize, ty: t.y / tileSize,
        width: t.width, height: t.height, data: t.data,
      };
    });
    await IDBStore.putTiles(rows);

    // 2) 下一层高斯 + 本层拉普拉斯（分条带，控制内存）
    let maxReconErr = 0;
    if (level < levels - 1) {
      const next = PyramidCore.gaussianDownsample(gauss, w, h);
      const lapVis = new Uint8ClampedArray(w * h * 4); // 拉普拉斯可视化 (+128 偏移)
      for (let y0 = 0; y0 < h; y0 += BAND_ROWS) {
        const y1 = Math.min(h, y0 + BAND_ROWS);
        const up = PyramidCore.gaussianUpsampleBand(next.data, next.width, next.height, w, y0, y1);
        const bandLen = (y1 - y0) * w * 4;
        const gBand = gauss.subarray(y0 * w * 4, y0 * w * 4 + bandLen);
        const lap = PyramidCore.laplacianLevel(gBand, up);
        const recon = PyramidCore.reconstructLevel(lap, up);
        for (let i = 0; i < bandLen; i++) {
          const err = Math.abs(recon[i] - gBand[i]);
          if (err > maxReconErr) maxReconErr = err;
          lapVis[y0 * w * 4 + i] = lap[i] + 128;
        }
      }
      const lapTiles = PyramidCore.splitTiles(lapVis, w, h, tileSize);
      const lapRows = lapTiles.map((t) => ({
        key: 'l:' + level + ':' + t.x / tileSize + ':' + t.y / tileSize,
        level, tx: t.x / tileSize, ty: t.y / tileSize,
        width: t.width, height: t.height, data: t.data,
      }));
      await IDBStore.putTiles(lapRows);
      gauss = next.data;
      w = next.width; h = next.height;
    }

    const dt = performance.now() - lt0;
    levelStats.push({
      level, width: curW, height: curH,
      buildMs: Math.round(dt * 100) / 100,
      tiles: rows.length, bytes,
      maxReconErr,
    });
    postMessage({
      type: 'level', level, levels,
      width: curW, height: curH,
      buildMs: levelStats[level].buildMs,
      tiles: rows.length, bytes, maxReconErr,
    });
  }

  const meta = {
    width, height, levels, tileSize, minDim,
    totalBuildMs: Math.round((performance.now() - t0) * 100) / 100,
    levelStats,
    createdAt: Date.now(),
  };
  await IDBStore.putMeta('pyramid', meta);
  postMessage({ type: 'done', meta });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'generate') {
      const t0 = performance.now();
      const data = generateTestImage(msg.size);
      postMessage({
        type: 'generated', width: msg.size, height: msg.size,
        genMs: Math.round((performance.now() - t0) * 100) / 100,
        buffer: data.buffer,
      }, [data.buffer]);
    } else if (msg.type === 'build') {
      await buildPyramid(msg.width, msg.height, msg.buffer, msg.tileSize, msg.minDim);
    } else if (msg.type === 'clear') {
      await IDBStore.clearAll();
      postMessage({ type: 'cleared' });
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
