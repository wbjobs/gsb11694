/*
 * 构建流程集成测试（Node）：模拟 pyramid-worker 的完整构建管线。
 * 验证：瓦片切分→重组无损；分条带拉普拉斯 → 全金字塔重建误差有界。
 * 运行：node test/build-pipeline.test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PC = require('../js/pyramid-core.js');

let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const W = 777, H = 555, TILE = 256, BAND = 128;

// 带渐变+高频细节的合成图（比纯随机更接近真实图像频谱）
function synthImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 255 / w) | 0;
      data[i + 1] = (y * 255 / h) | 0;
      data[i + 2] = ((x >> 2) + (y >> 2)) % 2 === 0 ? 255 : 0; // 高频棋盘
      data[i + 3] = 255;
    }
  }
  return data;
}

function reassemble(tiles, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (const t of tiles) {
    for (let row = 0; row < t.height; row++) {
      out.set(t.data.subarray(row * t.width * 4, (row + 1) * t.width * 4),
        ((t.y + row) * w + t.x) * 4);
    }
  }
  return out;
}

console.log('build-pipeline integration tests');

const g0 = synthImage(W, H);
const levels = PC.computeLevelCount(W, H, 256);
assert(levels === 3, 'level count for 777x555 (555>256, 278>256, 139<=256)', String(levels));

// 模拟 worker：逐层降采样 + 分条带拉普拉斯
const gaussLevels = [{ data: g0, width: W, height: H }];
const lapLevels = [];
let cur = g0, cw = W, ch = H;
for (let level = 0; level < levels - 1; level++) {
  const next = PC.gaussianDownsample(cur, cw, ch);
  // 分条带计算拉普拉斯（与 worker 相同路径）
  const lap = new Int16Array(cw * ch * 4);
  for (let y0 = 0; y0 < ch; y0 += BAND) {
    const y1 = Math.min(ch, y0 + BAND);
    const up = PC.gaussianUpsampleBand(next.data, next.width, next.height, cw, y0, y1);
    const gBand = cur.subarray(y0 * cw * 4, y1 * cw * 4);
    const lBand = PC.laplacianLevel(gBand, up);
    lap.set(lBand, y0 * cw * 4);
  }
  lapLevels.push(lap);
  gaussLevels.push(next);
  cur = next.data; cw = next.width; ch = next.height;
}

// 1. 每层瓦片切分 → 重组 == 原层（瓦片边界正确性）
{
  let ok = true;
  for (const g of gaussLevels) {
    const tiles = PC.splitTiles(g.data, g.width, g.height, TILE);
    const back = reassemble(tiles, g.width, g.height);
    for (let i = 0; i < back.length; i++) if (back[i] !== g.data[i]) { ok = false; break; }
  }
  assert(ok, 'tile split/reassemble is lossless at every level');
}

// 2. 全金字塔重建：从最粗层高斯 + 各层拉普拉斯重建原图
{
  const top = gaussLevels[gaussLevels.length - 1];
  let recon = top.data, rw = top.width, rh = top.height;
  for (let level = gaussLevels.length - 2; level >= 0; level--) {
    const g = gaussLevels[level];
    const up = PC.gaussianUpsample(recon, rw, rh, g.width, g.height);
    recon = PC.reconstructLevel(lapLevels[level], up);
    rw = g.width; rh = g.height;
  }
  let maxErr = 0, sumErr = 0;
  for (let i = 0; i < g0.length; i++) {
    const e = Math.abs(recon[i] - g0[i]);
    if (e > maxErr) maxErr = e;
    sumErr += e;
  }
  const meanErr = sumErr / g0.length;
  assert(maxErr <= 2, 'full pyramid reconstruction max error <= 2', 'maxErr=' + maxErr);
  assert(meanErr < 0.5, 'full pyramid reconstruction mean error < 0.5', 'meanErr=' + meanErr.toFixed(4));
}

// 3. 分条带拉普拉斯 == 整体拉普拉斯
{
  const d1 = PC.gaussianDownsample(g0, W, H);
  const upFull = PC.gaussianUpsample(d1.data, d1.width, d1.height, W, H);
  const lapFull = PC.laplacianLevel(g0, upFull);
  let maxDiff = 0;
  for (let i = 0; i < lapFull.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(lapFull[i] - lapLevels[0][i]));
  }
  assert(maxDiff === 0, 'banded laplacian identical to full laplacian', 'maxDiff=' + maxDiff);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
