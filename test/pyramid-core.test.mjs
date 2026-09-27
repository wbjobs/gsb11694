/*
 * pyramid-core 单元测试（Node）：验证金字塔构建正确性。
 * 运行：node test/pyramid-core.test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PC = require('../js/pyramid-core.js');

let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function randomImage(w, h, seed) {
  let s = seed >>> 0;
  const rand = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (rand() * 256) | 0;
  return data;
}

console.log('pyramid-core tests');

// 1. 降采样尺寸（含奇数尺寸 ceil 行为）
{
  const img = randomImage(257, 255, 1);
  const d = PC.gaussianDownsample(img, 257, 255);
  assert(d.width === 129 && d.height === 128, 'downsample odd dims', d.width + 'x' + d.height);
  const d2 = PC.gaussianDownsample(d.data, d.width, d.height);
  assert(d2.width === 65 && d2.height === 64, 'downsample twice');
}

// 2. 常数图像降采样/上采样后仍为常数（核归一化正确）
{
  const w = 64, h = 64;
  const img = new Uint8ClampedArray(w * h * 4).fill(200);
  const d = PC.gaussianDownsample(img, w, h);
  let ok = true;
  for (let i = 0; i < d.data.length; i++) if (Math.abs(d.data[i] - 200) > 1) ok = false;
  assert(ok, 'constant image preserved by downsample');
  const up = PC.gaussianUpsample(d.data, d.width, d.height, w, h);
  ok = true;
  for (let i = 0; i < up.length; i++) if (Math.abs(up[i] - 200) > 1.5) ok = false;
  assert(ok, 'constant image preserved by upsample');
}

// 3. 分条带上采样 == 整体上采样（内存优化不改变结果）
{
  const w = 37, h = 29;
  const img = randomImage(w, h, 7);
  const full = PC.gaussianUpsample(img, w, h, 73, 57);
  const banded = new Float32Array(full.length);
  const BAND = 8;
  for (let y0 = 0; y0 < 57; y0 += BAND) {
    const y1 = Math.min(57, y0 + BAND);
    const band = PC.gaussianUpsampleBand(img, w, h, 73, y0, y1);
    banded.set(band, y0 * 73 * 4);
  }
  let maxDiff = 0;
  for (let i = 0; i < full.length; i++) maxDiff = Math.max(maxDiff, Math.abs(full[i] - banded[i]));
  assert(maxDiff < 1e-3, 'banded upsample matches full upsample', 'maxDiff=' + maxDiff);
}

// 4. 拉普拉斯金字塔重建：G_i ≈ EXPAND(G_{i+1}) + L_i
{
  const w = 128, h = 96;
  const g0 = randomImage(w, h, 42);
  const d1 = PC.gaussianDownsample(g0, w, h);
  const d2 = PC.gaussianDownsample(d1.data, d1.width, d1.height);
  // L1 = G1 - expand(G2)
  const up2 = PC.gaussianUpsample(d2.data, d2.width, d2.height, d1.width, d1.height);
  const l1 = PC.laplacianLevel(d1.data, up2);
  const recon1 = PC.reconstructLevel(l1, up2);
  let err1 = 0;
  for (let i = 0; i < recon1.length; i++) err1 = Math.max(err1, Math.abs(recon1[i] - d1.data[i]));
  assert(err1 <= 1, 'level-1 reconstruction error <= 1', 'err=' + err1);
  // L0 = G0 - expand(G1)，用重建的 G1 再重建 G0（误差累积也应很小）
  const up1 = PC.gaussianUpsample(recon1, d1.width, d1.height, w, h);
  const l0 = PC.laplacianLevel(g0, up1);
  const recon0 = PC.reconstructLevel(l0, up1);
  let err0 = 0;
  for (let i = 0; i < recon0.length; i++) err0 = Math.max(err0, Math.abs(recon0[i] - g0[i]));
  assert(err0 <= 2, 'level-0 reconstruction error <= 2', 'err=' + err0);
}

// 5. 瓦片切分：完整覆盖、无重叠、边缘瓦片尺寸正确
{
  const w = 600, h = 300, ts = 256;
  const img = randomImage(w, h, 9);
  const tiles = PC.splitTiles(img, w, h, ts);
  const grid = PC.tileGrid(w, h, ts);
  assert(grid.cols === 3 && grid.rows === 2, 'tile grid dims', grid.cols + 'x' + grid.rows);
  assert(tiles.length === 6, 'tile count');
  const cover = new Uint8Array(w * h);
  let pixelsOk = true;
  for (const t of tiles) {
    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < t.width; x++) {
        const gi = (t.y + y) * w + (t.x + x);
        cover[gi]++;
        for (let c = 0; c < 4; c++) {
          if (t.data[(y * t.width + x) * 4 + c] !== img[gi * 4 + c]) pixelsOk = false;
        }
      }
    }
  }
  let coveredOnce = true;
  for (let i = 0; i < cover.length; i++) if (cover[i] !== 1) coveredOnce = false;
  assert(coveredOnce, 'tiles cover image exactly once (no gaps/overlaps)');
  assert(pixelsOk, 'tile pixels match source');
  const last = tiles[tiles.length - 1];
  assert(last.width === 600 - 512 && last.height === 300 - 256, 'edge tile size', last.width + 'x' + last.height);
}

// 6. 层数计算与边界反射
{
  assert(PC.computeLevelCount(4096, 4096, 256) === 5, 'level count 4096');
  assert(PC.computeLevelCount(300, 200, 256) === 1, 'level count small image');
  assert(PC.reflectIndex(-1, 10) === 1 && PC.reflectIndex(10, 10) === 8, 'reflect index');
  const s = PC.levelSize(4096, 2048, 3);
  assert(s.width === 512 && s.height === 256, 'levelSize');
}

// 7. 值域检查：降采样输出无越界/NaN
{
  const img = randomImage(513, 511, 123);
  const d = PC.gaussianDownsample(img, 513, 511);
  let ok = true;
  for (let i = 0; i < d.data.length; i++) {
    const v = d.data[i];
    if (Number.isNaN(v) || v < 0 || v > 255) { ok = false; break; }
  }
  assert(ok, 'downsample output in [0,255], no NaN');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
