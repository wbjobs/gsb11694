/*
 * main.js — 应用主控：UI 绑定、Worker 调度、交互、降级策略。
 */
(function () {
  'use strict';

  const TILE_SIZE = 256;
  const MIN_DIM = 256;
  const DEFAULT_CACHE_MB = 256;

  const $ = (id) => document.getElementById(id);
  const canvas = $('view');
  const metrics = new Metrics();
  const cache = new TileCache(DEFAULT_CACHE_MB * 1024 * 1024);

  const renderer = new PyramidRenderer(canvas, {
    cache,
    getTileRecord: (key) => IDBStore.getTile(key),
    onFrame: () => { metrics.markFrame(); scheduleStats(); },
  });

  let worker = null;
  let fallbackBitmapPromise = null; // 降级用低分辨率 bitmap（构建前先准备好）
  let building = false;
  let statsQueued = false;
  let buildMark = 'build-start';    // 上一层构建结束标记，用于逐层 measure

  // ---------- Worker ----------
  function getWorker() {
    if (!worker) {
      worker = new Worker('js/pyramid-worker.js');
      worker.onmessage = onWorkerMessage;
      worker.onerror = (err) => {
        setStatus('Worker 错误：' + err.message + '，已降级到单分辨率模式');
        degradeToSingleRes();
      };
    }
    return worker;
  }

  function onWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === 'generated') {
      // 先把降级用的低分辨率 bitmap 准备好，再把 buffer 转移给 Worker（避免主线程持有大图）
      fallbackBitmapPromise = makeFallbackBitmap(msg.buffer, msg.width, msg.height);
      setStatus('测试图已生成（' + msg.width + 'x' + msg.height + '，耗时 ' + msg.genMs + ' ms），正在构建金字塔…');
      getWorker().postMessage({
        type: 'build', width: msg.width, height: msg.height,
        buffer: msg.buffer, tileSize: TILE_SIZE, minDim: MIN_DIM,
      }, [msg.buffer]);
    } else if (msg.type === 'level') {
      const markName = 'build-level-end-' + msg.level;
      performance.mark(markName);
      performance.measure('build-level-' + msg.level, buildMark, markName);
      buildMark = markName;
      appendLevelRow(msg);
      setStatus('构建金字塔：第 ' + (msg.level + 1) + '/' + msg.levels + ' 层（' + msg.buildMs + ' ms，' + msg.tiles + ' 瓦片）');
      updateProgress((msg.level + 1) / msg.levels);
    } else if (msg.type === 'done') {
      building = false;
      performance.measure('build-total', 'build-start');
      updateProgress(1);
      renderer.setPyramid(msg.meta);
      setStatus('金字塔构建完成：' + msg.meta.levels + ' 层，总耗时 ' + msg.meta.totalBuildMs + ' ms');
      refreshMetaPanel(msg.meta);
      scheduleStats();
    } else if (msg.type === 'error') {
      building = false;
      setStatus('构建失败：' + msg.message + '，已降级到单分辨率模式');
      degradeToSingleRes();
    } else if (msg.type === 'cleared') {
      setStatus('已清除 IndexedDB 缓存');
    }
  }

  /** 由 RGBA buffer 生成 <=2048 的低分辨率 bitmap，供极端降级使用 */
  function makeFallbackBitmap(buffer, width, height) {
    const maxDim = 2048;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const tmp = document.createElement('canvas');
    tmp.width = width; tmp.height = height;
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
    const small = document.createElement('canvas');
    small.width = w; small.height = h;
    small.getContext('2d').drawImage(tmp, 0, 0, w, h);
    return createImageBitmap(small);
  }

  // ---------- 降级：单分辨率 ----------
  async function degradeToSingleRes() {
    renderer.singleRes = true;
    $('singleRes').checked = true;
    if (fallbackBitmapPromise) {
      try {
        const bitmap = await fallbackBitmapPromise;
        renderer.setSingleBitmap(bitmap);
        setStatus('单分辨率模式：整图 ' + bitmap.width + 'x' + bitmap.height + ' 单 bitmap 渲染');
        return;
      } catch (e) { /* 继续走瓦片最粗层 */ }
    }
    if (renderer.meta) {
      renderer.requestRender();
    }
  }

  // ---------- UI ----------
  function setStatus(text) { $('status').textContent = text; }
  function updateProgress(ratio) {
    $('progress').style.width = Math.round(ratio * 100) + '%';
  }

  function scheduleStats() {
    if (statsQueued) return;
    statsQueued = true;
    setTimeout(() => {
      statsQueued = false;
      const s = cache.stats();
      $('stat-fps').textContent = metrics.fps().toFixed(0);
      $('stat-frame').textContent = renderer.frameMs.toFixed(2) + ' ms';
      $('stat-level').textContent = renderer.singleRes ? '单分辨率' : String(renderer.level);
      $('stat-scale').textContent = renderer.view.scale.toFixed(4) + 'x';
      $('stat-cache').textContent = s.tiles + ' 块 / ' + formatBytes(s.bytes) + ' / 预算 ' + formatBytes(s.budget);
      $('stat-hit').textContent = s.hits + ' / ' + s.misses + ' / 逐出 ' + s.evictions;
      $('stat-heap').textContent = metrics.supported.memory ? formatBytes(metrics.heapBytes()) : 'N/A（非 Chrome）';
      $('stat-longtask').textContent = String(metrics.longtasks.length);
    }, 100);
  }

  function formatBytes(bytes) {
    if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
    if (bytes >= 1 << 10) return (bytes / (1 << 10)).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  function appendLevelRow(msg) {
    const tbody = $('level-table').querySelector('tbody');
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + msg.level + '</td><td>' + msg.width + 'x' + msg.height + '</td><td>' +
      msg.buildMs + '</td><td>' + msg.tiles + '</td><td>' + formatBytes(msg.bytes) + '</td><td>' + msg.maxReconErr + '</td>';
    tbody.appendChild(tr);
  }

  function refreshMetaPanel(meta) {
    const rows = meta.levelStats.map((s) => {
      const w = s.width || Math.ceil(meta.width / Math.pow(2, s.level));
      const h = s.height || Math.ceil(meta.height / Math.pow(2, s.level));
      return '<tr><td>' + s.level + '</td><td>' + w + 'x' + h + '</td><td>' + s.buildMs +
        '</td><td>' + s.tiles + '</td><td>' + formatBytes(s.bytes) + '</td><td>' + s.maxReconErr + '</td></tr>';
    }).join('');
    $('level-table').querySelector('tbody').innerHTML = rows;
  }

  // ---------- 事件 ----------
  $('generate').addEventListener('click', () => {
    if (building) return;
    building = true;
    performance.mark('build-start');
    buildMark = 'build-start';
    cache.clear();
    renderer.meta = null;
    renderer.singleBitmap = null;
    renderer.singleRes = false;
    fallbackBitmapPromise = null;
    $('singleRes').checked = false;
    $('level-table').querySelector('tbody').innerHTML = '';
    const size = parseInt($('img-size').value, 10);
    setStatus('正在生成 ' + size + 'x' + size + ' 测试图…');
    updateProgress(0);
    getWorker().postMessage({ type: 'generate', size });
  });

  $('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file || building) return;
    createImageBitmap(file).then((bitmap) => {
      const c = document.createElement('canvas');
      c.width = bitmap.width; c.height = bitmap.height;
      const cx = c.getContext('2d');
      cx.drawImage(bitmap, 0, 0);
      const imageData = cx.getImageData(0, 0, bitmap.width, bitmap.height);
      building = true;
      performance.mark('build-start');
      buildMark = 'build-start';
      cache.clear();
      // 降级 bitmap 直接从已解码的 bitmap 缩放生成
      const maxDim = 2048;
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(bitmap.width * scale));
      small.height = Math.max(1, Math.round(bitmap.height * scale));
      small.getContext('2d').drawImage(bitmap, 0, 0, small.width, small.height);
      fallbackBitmapPromise = createImageBitmap(small);
      setStatus('已加载 ' + file.name + '（' + bitmap.width + 'x' + bitmap.height + '），正在构建金字塔…');
      getWorker().postMessage({
        type: 'build', width: bitmap.width, height: bitmap.height,
        buffer: imageData.data.buffer, tileSize: TILE_SIZE, minDim: MIN_DIM,
      }, [imageData.data.buffer]);
    });
  });

  $('clear-db').addEventListener('click', () => {
    cache.clear();
    getWorker().postMessage({ type: 'clear' });
  });

  $('fit').addEventListener('click', () => { renderer.fitView(); syncZoomSlider(); });

  $('show-grid').addEventListener('change', (e) => {
    renderer.showGrid = e.target.checked;
    renderer.requestRender();
  });

  $('laplacian').addEventListener('change', (e) => {
    renderer.laplacianView = e.target.checked;
    renderer.requestRender();
  });

  $('singleRes').addEventListener('change', (e) => {
    renderer.singleRes = e.target.checked;
    renderer.singleBitmap = null;
    renderer.requestRender();
    setStatus(e.target.checked ? '单分辨率模式：仅使用最粗层瓦片渲染' : '多分辨率模式');
  });

  $('cache-budget').addEventListener('input', (e) => {
    const mb = parseInt(e.target.value, 10);
    $('cache-budget-label').textContent = mb + ' MB';
    cache.setBudget(mb * 1024 * 1024);
    scheduleStats();
  });

  $('zoom-slider').addEventListener('input', (e) => {
    const log = parseFloat(e.target.value);
    const scale = Math.pow(2, log);
    renderer.setScale(canvas.clientWidth / 2, canvas.clientHeight / 2, scale);
  });

  $('benchmark').addEventListener('click', async () => {
    if (!renderer.meta || renderer.singleBitmap) return;
    setStatus('正在运行分层渲染基准…');
    const results = await metrics.benchmarkLevels(renderer, 30);
    $('bench-table').querySelector('tbody').innerHTML = results.map((r) =>
      '<tr><td>' + r.level + '</td><td>' + r.avgMs + '</td><td>' + r.maxMs +
      '</td><td>' + formatBytes(r.cacheBytes) + '</td><td>' +
      (r.heapBytes ? formatBytes(r.heapBytes) : 'N/A') + '</td></tr>').join('');
    setStatus('基准完成：对比各层渲染帧耗时与内存占用');
  });

  // 滚轮缩放（以光标为锚点）
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    syncZoomSlider();
  }, { passive: false });

  // 拖拽平移
  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    renderer.pan(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });

  // 双击复位
  canvas.addEventListener('dblclick', () => { renderer.fitView(); syncZoomSlider(); });

  function syncZoomSlider() {
    $('zoom-slider').value = Math.log2(renderer.target.scale).toFixed(3);
  }

  window.addEventListener('resize', () => renderer.resize());
  renderer.resize();

  // 启动时尝试恢复上次构建的金字塔
  IDBStore.getMeta('pyramid').then((meta) => {
    if (meta) {
      renderer.setPyramid(meta);
      refreshMetaPanel(meta);
      setStatus('已从 IndexedDB 恢复金字塔：' + meta.width + 'x' + meta.height + '，' + meta.levels + ' 层');
    } else {
      setStatus('点击「生成测试图」或选择本地图片开始');
    }
  });
})();
