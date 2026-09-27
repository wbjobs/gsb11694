/* 主控：UI 接线、Worker 调度、瓦片供给、基准测试、内存控制与降级 */
'use strict';

const $ = (id) => document.getElementById(id);
const perf = new PerfMonitor();
let db = null;
let worker = null;
let viewer = null;
let meta = null;
let singleCanvas = null; // 单分辨率模式的整图位图来源

/* ---------- 日志 ---------- */
function log(msg, cls) {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(line);
  while (el.children.length > 60) el.lastChild.remove();
}

/* ---------- 金字塔构建 ---------- */
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('js/pyramid-worker.js');
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      if (m.phase === 'generate') setProgress(5, `生成 ${m.size}×${m.size} 测试图…`);
      else if (m.phase === 'gaussian') setProgress(10 + m.level * 10, `L${m.level}: ${m.w}×${m.h}，${m.tiles} 瓦片`);
      else if (m.phase === 'laplacian') setProgress(null, `L${m.level} 拉普拉斯层完成，重建误差 ≤ ${m.reconErr}`);
    } else if (m.type === 'done') {
      onPyramidReady(m.meta);
    } else if (m.type === 'error') {
      log('Worker 构建失败：' + m.message + '，降级到单分辨率模式', 'err');
      setProgress(0, '构建失败');
      fallbackToSingle('worker-error');
    }
  };
  worker.onerror = (e) => {
    log('Worker 异常：' + e.message + '，降级到单分辨率模式', 'err');
    fallbackToSingle('worker-crash');
  };
  return worker;
}

function setProgress(pct, text) {
  if (pct !== null) $('progress').value = pct;
  if (text) $('progressText').textContent = text;
}

async function onPyramidReady(m) {
  meta = m;
  performance.mark('build-end');
  setProgress(100, `完成：${m.levels.length} 层，耗时 ${m.buildMs}ms，最大重建误差 ${m.maxReconErr}`);
  log(`金字塔构建完成：${m.origW}×${m.origH} → ${m.levels.length} 层，${m.buildMs}ms，重建误差 ≤ ${m.maxReconErr}`, 'ok');
  viewer.setMeta(m);
  viewer.setMode('pyramid');
  $('modeSelect').value = 'pyramid';
  updateLevelInfo();
  const est = await navigator.storage?.estimate?.();
  if (est && est.usage) log(`IndexedDB 占用 ≈ ${(est.usage / 1048576).toFixed(1)} MB`);
}

async function startBuild(msg) {
  try {
    if (!db) db = await new PyramidDB().open();
    setProgress(0, '构建中…');
    performance.mark('build-start');
    ensureWorker().postMessage(msg, msg.bitmap ? [msg.bitmap] : (msg.buffer ? [msg.buffer] : []));
  } catch (err) {
    log('IndexedDB 不可用：' + err.message + '，降级到单分辨率模式', 'err');
    fallbackToSingle('idb-unavailable');
  }
}

/* ---------- 瓦片供给（IndexedDB → ImageBitmap） ---------- */
async function tileProvider(mode, level, tx, ty) {
  const rec = await db.getTile(`${mode}:${level}:${tx}:${ty}`);
  if (!rec) return null;
  const img = new ImageData(new Uint8ClampedArray(rec.data), rec.w, rec.h);
  const bitmap = await createImageBitmap(img);
  return { bitmap, w: rec.w, h: rec.h };
}

/* ---------- 单分辨率降级 ---------- */
async function fallbackToSingle(reason) {
  log(`触发降级（${reason}）：切换单分辨率渲染`, 'warn');
  $('modeSelect').value = 'single';
  viewer.setMode('single');
  if (!viewer.singleBitmap && singleCanvas) viewer.setSingleBitmap(singleCanvas);
}

async function loadFile(file) {
  const bmp = await createImageBitmap(file);
  log(`加载图片 ${file.name}：${bmp.width}×${bmp.height}`);
  // 单分辨率模式数据源（整图 canvas）
  singleCanvas = document.createElement('canvas');
  singleCanvas.width = bmp.width; singleCanvas.height = bmp.height;
  singleCanvas.getContext('2d').drawImage(bmp, 0, 0);
  viewer.setSingleBitmap(singleCanvas);
  viewer.meta = { origW: bmp.width, origH: bmp.height, levels: [{ w: bmp.width, h: bmp.height }], tileSize: 256 };
  viewer.fitToView();
  // 直接把 ImageBitmap 转移给 Worker 构建金字塔
  startBuild({ type: 'build', bitmap: bmp, tileSize: 256 });
}

/* ---------- 基准测试：逐层测量渲染耗时与内存 ---------- */
async function runBenchmark() {
  if (!meta) { log('请先构建金字塔', 'warn'); return; }
  const btn = $('benchBtn');
  btn.disabled = true;
  const rows = [];
  const cw = viewer.canvas.clientWidth, ch = viewer.canvas.clientHeight;

  for (let l = 0; l < meta.levels.length; l++) {
    // 固定视野：以 2^-l 缩放看整图中心区域
    const scale = Math.pow(2, -l) * Math.min(cw / meta.origW, ch / meta.origH) * meta.levels.length;
    viewer.tgt.scale = viewer.cam.scale = Math.min(8, scale);
    viewer.tgt.x = viewer.cam.x = meta.origW / 2;
    viewer.tgt.y = viewer.cam.y = meta.origH / 2;
    viewer.dirty = true;
    await viewer.waitIdle();
    await new Promise(r => setTimeout(r, 100));

    const heapBefore = perf.heapMB();
    const times = [];
    for (let i = 0; i < 30; i++) {
      viewer.dirty = true;
      await new Promise(r => requestAnimationFrame(r));
      times.push(viewer.stats.frameMs);
    }
    const heapAfter = perf.heapMB();
    rows.push({
      level: l,
      res: `${meta.levels[l].w}×${meta.levels[l].h}`,
      frameMs: (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
      tiles: viewer.stats.tilesDrawn,
      cacheMB: (viewer.cache.bytes / 1048576).toFixed(1),
      heapMB: heapAfter ? heapAfter.used.toFixed(0) : 'N/A',
    });
    log(`L${l} 基准：${rows[rows.length - 1].frameMs}ms/帧，${rows[rows.length - 1].tiles} 瓦片，缓存 ${rows[rows.length - 1].cacheMB}MB`);
  }

  // 单分辨率对比
  if (viewer.singleBitmap) {
    viewer.setMode('single');
    const times = [];
    for (let i = 0; i < 30; i++) {
      viewer.dirty = true;
      await new Promise(r => requestAnimationFrame(r));
      times.push(viewer.stats.frameMs);
    }
    const ms = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2);
    rows.push({ level: '单分辨率', res: `${meta.origW}×${meta.origH}`, frameMs: ms, tiles: 1, cacheMB: '-', heapMB: perf.heapMB()?.used.toFixed(0) || 'N/A' });
    log(`单分辨率基准：${ms}ms/帧`, 'warn');
    viewer.setMode('pyramid');
  }

  renderBenchTable(rows);
  viewer.fitToView();
  btn.disabled = false;
}

function renderBenchTable(rows) {
  const t = $('benchTable');
  t.innerHTML = '<tr><th>层级</th><th>分辨率</th><th>帧耗时(ms)</th><th>瓦片数</th><th>缓存(MB)</th><th>堆内存(MB)</th></tr>' +
    rows.map(r => `<tr><td>${r.level}</td><td>${r.res}</td><td>${r.frameMs}</td><td>${r.tiles}</td><td>${r.cacheMB}</td><td>${r.heapMB}</td></tr>`).join('');
}

/* ---------- 统计面板 ---------- */
function updateStats(s) {
  $('statFps').textContent = s.fps.toFixed(0);
  $('statFrame').textContent = s.frameMs.toFixed(2);
  $('statLevel').textContent = s.level >= 0 ? `L${s.level}` : '单分辨率';
  $('statTiles').textContent = s.tilesDrawn;
  $('statCache').textContent = (viewer.cache.bytes / 1048576).toFixed(1);
  $('statHit').textContent = viewer.cache.hits + viewer.cache.misses
    ? Math.round(100 * viewer.cache.hits / (viewer.cache.hits + viewer.cache.misses)) + '%' : '-';
}

function updateLevelInfo() {
  if (!meta) return;
  $('levelInfo').textContent = meta.levels.map((l, i) => `L${i}: ${l.w}×${l.h}`).join('  |  ');
}

/* ---------- 启动 ---------- */
window.addEventListener('DOMContentLoaded', async () => {
  viewer = new Viewer($('view'), {
    getTile: (m, l, x, y) => tileProvider(m, l, x, y),
    onStats: updateStats,
    cacheBytes: 256 * 1024 * 1024,
  });

  // 定时刷新内存与长任务统计 + 堆压力自动降级
  setInterval(() => {
    const h = perf.heapMB();
    $('statHeap').textContent = h ? `${h.used.toFixed(0)} / ${h.limit.toFixed(0)}` : 'N/A';
    $('statLongtask').textContent = perf.longtasks + (perf.lastLongtask ? ` (最近 ${perf.lastLongtask}ms)` : '');
    if (h && perf.heapPressure(0.9) && viewer.mode === 'pyramid') {
      viewer.setCacheBudget(Math.max(32, viewer.cache.maxBytes / 1048576 / 2) * 1048576);
      log('堆内存压力过高，瓦片缓存预算减半', 'warn');
    }
  }, 500);

  // 尝试恢复上次构建的金字塔
  try {
    db = await new PyramidDB().open();
    const m = await db.getMeta();
    if (m) { meta = m; viewer.setMeta(m); updateLevelInfo(); log(`恢复已缓存金字塔：${m.origW}×${m.origH}，${m.levels.length} 层（上次构建 ${m.buildMs}ms）`, 'ok'); }
  } catch (err) {
    log('IndexedDB 打开失败：' + err.message, 'err');
  }

  // --- UI 事件 ---
  document.querySelectorAll('[data-gen]').forEach(btn => {
    btn.addEventListener('click', () => startBuild({ type: 'generate', size: +btn.dataset.gen, tileSize: 256 }));
  });
  $('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  $('clearBtn').addEventListener('click', async () => {
    if (db) await db.clear();
    viewer.cache.clear(); meta = null; viewer.setMeta(null);
    log('已清空 IndexedDB 与内存缓存');
  });
  $('fitBtn').addEventListener('click', () => viewer.fitToView());
  $('benchBtn').addEventListener('click', runBenchmark);
  $('modeSelect').addEventListener('change', (e) => {
    viewer.setMode(e.target.value);
    if (e.target.value === 'single' && !viewer.singleBitmap) {
      log('单分辨率模式需要先加载图片文件（生成图仅存在于金字塔中）', 'warn');
    }
  });
  $('viewModeSelect').addEventListener('change', (e) => viewer.setViewMode(e.target.value));
  $('gridCheck').addEventListener('change', (e) => viewer.setShowGrid(e.target.checked));
  $('budgetRange').addEventListener('input', (e) => {
    const mb = +e.target.value;
    $('budgetLabel').textContent = mb + ' MB';
    viewer.setCacheBudget(mb * 1048576);
  });

  log('就绪。点击「生成测试图」或加载本地图片开始。');
});
