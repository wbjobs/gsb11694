/*
 * pyramid-core.js — 纯算法模块：高斯/拉普拉斯金字塔、瓦片切分。
 * UMD：可被 Web Worker (importScripts)、浏览器 <script>、Node (require) 复用。
 * 全部基于 TypedArray，无 DOM 依赖。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PyramidCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 5x5 高斯核 (1,4,6,4,1)/16，可分离
  const KERNEL = [1, 4, 6, 4, 1];
  const KERNEL_SUM = 16;

  // 镜像反射边界索引
  function reflectIndex(i, n) {
    if (n === 1) return 0;
    let k = i;
    while (k < 0 || k >= n) {
      k = k < 0 ? -k : 2 * (n - 1) - k;
    }
    return k;
  }

  /**
   * 高斯降采样 (REDUCE)：先 5x5 高斯模糊，再隔行隔列取样。
   * 可分离两遍卷积：横向 (W,H)->(ceil(W/2),H)，纵向 ->(ceil(W/2),ceil(H/2))。
   */
  function gaussianDownsample(src, width, height) {
    const outW = Math.ceil(width / 2);
    const outH = Math.ceil(height / 2);
    const tmp = new Float32Array(outW * height * 4);
    for (let y = 0; y < height; y++) {
      const rowBase = y * width * 4;
      const tmpBase = y * outW * 4;
      for (let ox = 0; ox < outW; ox++) {
        const sx = 2 * ox;
        let r = 0, g = 0, b = 0, a = 0;
        for (let m = -2; m <= 2; m++) {
          const w = KERNEL[m + 2];
          const x = reflectIndex(sx + m, width);
          const p = rowBase + x * 4;
          r += w * src[p]; g += w * src[p + 1]; b += w * src[p + 2]; a += w * src[p + 3];
        }
        const q = tmpBase + ox * 4;
        tmp[q] = r / KERNEL_SUM; tmp[q + 1] = g / KERNEL_SUM;
        tmp[q + 2] = b / KERNEL_SUM; tmp[q + 3] = a / KERNEL_SUM;
      }
    }
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let oy = 0; oy < outH; oy++) {
      const sy = 2 * oy;
      const outBase = oy * outW * 4;
      for (let x = 0; x < outW; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let n = -2; n <= 2; n++) {
          const w = KERNEL[n + 2];
          const y = reflectIndex(sy + n, height);
          const p = y * outW * 4 + x * 4;
          r += w * tmp[p]; g += w * tmp[p + 1]; b += w * tmp[p + 2]; a += w * tmp[p + 3];
        }
        const q = outBase + x * 4;
        out[q] = r / KERNEL_SUM; out[q + 1] = g / KERNEL_SUM;
        out[q + 2] = b / KERNEL_SUM; out[q + 3] = a / KERNEL_SUM;
      }
    }
    return { data: out, width: outW, height: outH };
  }

  /**
   * 高斯上采样（分条带版本）：只计算输出行 [y0, y1)，
   * 横向中间缓存也只保留所需源行，峰值内存从 O(W*H) 降到 O(W*band)。
   * 这是大图（如 8192px）构建时不爆内存的关键。
   */
  function gaussianUpsampleBand(src, width, height, targetW, y0, y1) {
    // 输出行 y 依赖源行 (y+n-2)/2, n∈[-2,2] → 源行范围 [(y0-4)/2, (y1+1)/2]
    const lo = Math.max(0, Math.floor((y0 - 4) / 2));
    const hi = Math.min(height - 1, Math.floor((y1 + 1) / 2));
    const tmpRows = hi - lo + 1;
    const tmp = new Float32Array(targetW * tmpRows * 4);
    for (let ry = lo; ry <= hi; ry++) {
      const srcBase = ry * width * 4;
      const tmpBase = (ry - lo) * targetW * 4;
      for (let x = 0; x < targetW; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let m = -2; m <= 2; m++) {
          const t = x + m - 2;
          if (t % 2 !== 0) continue; // 奇数位为零，跳过
          const sx = reflectIndex(t / 2, width);
          const w = KERNEL[m + 2];
          const p = srcBase + sx * 4;
          r += w * src[p]; g += w * src[p + 1]; b += w * src[p + 2]; a += w * src[p + 3];
        }
        const q = tmpBase + x * 4;
        tmp[q] = 2 * r / KERNEL_SUM; tmp[q + 1] = 2 * g / KERNEL_SUM;
        tmp[q + 2] = 2 * b / KERNEL_SUM; tmp[q + 3] = 2 * a / KERNEL_SUM;
      }
    }
    const out = new Float32Array(targetW * (y1 - y0) * 4);
    for (let y = y0; y < y1; y++) {
      const outBase = (y - y0) * targetW * 4;
      for (let x = 0; x < targetW; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let n = -2; n <= 2; n++) {
          const t = y + n - 2;
          if (t % 2 !== 0) continue;
          const sy = reflectIndex(t / 2, height) - lo;
          const w = KERNEL[n + 2];
          const p = (sy * targetW + x) * 4;
          r += w * tmp[p]; g += w * tmp[p + 1]; b += w * tmp[p + 2]; a += w * tmp[p + 3];
        }
        const q = outBase + x * 4;
        out[q] = 2 * r / KERNEL_SUM; out[q + 1] = 2 * g / KERNEL_SUM;
        out[q + 2] = 2 * b / KERNEL_SUM; out[q + 3] = 2 * a / KERNEL_SUM;
      }
    }
    return out;
  }

  /**
   * 高斯上采样 (EXPAND)：放大到 targetW x targetH（支持奇数尺寸父图）。
   * 返回 Float32Array 保留精度供拉普拉斯计算。
   */
  function gaussianUpsample(src, width, height, targetW, targetH) {
    return gaussianUpsampleBand(src, width, height, targetW, 0, targetH);
  }

  /** 拉普拉斯层：L = G - EXPAND(G_next)，Int16 存储残差（含符号）。 */
  function laplacianLevel(gaussData, upFloat) {
    const n = gaussData.length;
    const lap = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      lap[i] = Math.round(gaussData[i] - upFloat[i]);
    }
    return lap;
  }

  /** 由拉普拉斯层 + 上采样结果重建高斯层（验证金字塔正确性）。 */
  function reconstructLevel(lap, upFloat) {
    const n = lap.length;
    const out = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) {
      out[i] = lap[i] + upFloat[i]; // Uint8ClampedArray 自动 clamp+round
    }
    return out;
  }

  /** 金字塔层数：直到最短边 <= minDim */
  function computeLevelCount(width, height, minDim) {
    minDim = minDim || 256;
    let w = width, h = height, levels = 1;
    while (Math.min(w, h) > minDim && levels < 16) {
      w = Math.ceil(w / 2); h = Math.ceil(h / 2); levels++;
    }
    return levels;
  }

  /** 第 level 层的尺寸 */
  function levelSize(width, height, level) {
    let w = width, h = height;
    for (let i = 0; i < level; i++) { w = Math.ceil(w / 2); h = Math.ceil(h / 2); }
    return { width: w, height: h };
  }

  /**
   * 瓦片切分：把一层图像切成 tileSize 对齐的瓦片（边缘瓦片为部分尺寸）。
   * 返回行列主序瓦片数组。
   */
  function splitTiles(data, width, height, tileSize) {
    const tiles = [];
    const cols = Math.ceil(width / tileSize);
    const rows = Math.ceil(height / tileSize);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const x = tx * tileSize, y = ty * tileSize;
        const w = Math.min(tileSize, width - x);
        const h = Math.min(tileSize, height - y);
        const tile = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          const srcStart = ((y + row) * width + x) * 4;
          tile.set(data.subarray(srcStart, srcStart + w * 4), row * w * 4);
        }
        tiles.push({ x, y, width: w, height: h, data: tile });
      }
    }
    return tiles;
  }

  /** 瓦片网格信息（行列数） */
  function tileGrid(width, height, tileSize) {
    return { cols: Math.ceil(width / tileSize), rows: Math.ceil(height / tileSize) };
  }

  return {
    KERNEL,
    reflectIndex,
    gaussianDownsample,
    gaussianUpsampleBand,
    gaussianUpsample,
    laplacianLevel,
    reconstructLevel,
    computeLevelCount,
    levelSize,
    splitTiles,
    tileGrid,
  };
});
