/* 多分辨率瓦片渲染器：
 * - 相机平滑缩放/平移/惯性（指数趋近，消除缩放抖动）
 * - 瓦片目标边对齐到设备像素（两边同时取整，杜绝接缝与缝隙）
 * - 缺失瓦片用更粗层级已缓存瓦片垫底（缩放过程不闪空白）
 * - 单分辨率降级模式（直接缩放整图）用于对比与兜底 */
'use strict';

class Viewer {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getTile = opts.getTile;       // async (mode, level, tx, ty) -> {data,w,h}|null
    this.onStats = opts.onStats || (() => {});
    this.onFallback = opts.onFallback || (() => {});

    this.cache = new TileCache(opts.cacheBytes || 256 * 1024 * 1024);
    this.meta = null;                  // 金字塔元数据
    this.mode = 'pyramid';             // 'pyramid' | 'single'
    this.viewMode = 'g';               // 'g' 高斯 | 'l' 拉普拉斯
    this.singleBitmap = null;          // 单分辨率模式整图
    this.showGrid = false;

    // 相机：当前值 + 目标值（动画趋近）
    this.cam = { x: 0, y: 0, scale: 1 };
    this.tgt = { x: 0, y: 0, scale: 1 };
    this.vel = { x: 0, y: 0 };         // 平移惯性（CSS px/s）
    this.animating = true;
    this.dirty = true;

    // 瓦片加载队列
    this.pending = new Map();          // key -> {mode,l,tx,ty,prio}
    this.inflight = 0;
    this.maxInflight = 6;
    this.visibleKeys = new Set();

    // 统计
    this.stats = { frameMs: 0, fps: 0, tilesDrawn: 0, level: 0, loads: 0 };
    this._frameTimes = [];
    this._lastFrame = 0;

    this._pointers = new Map();
    this._pinchDist = 0;

    this._bindEvents();
    this._resize();
    requestAnimationFrame((t) => this._loop(t));
  }

  /* ---------- 对外接口 ---------- */

  setMeta(meta, fitView = true) {
    this.meta = meta;
    if (fitView && meta) this.fitToView();
    this.dirty = true;
  }

  setMode(mode) { this.mode = mode; this.dirty = true; }
  setViewMode(vm) { this.viewMode = vm; this.dirty = true; }
  setSingleBitmap(bmp) { this.singleBitmap = bmp; this.dirty = true; }
  setShowGrid(v) { this.showGrid = v; this.dirty = true; }
  setCacheBudget(bytes) { this.cache.setBudget(bytes, this.visibleKeys); }

  fitToView() {
    const m = this.meta;
    if (!m) return;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const s = Math.min(cw / m.origW, ch / m.origH) * 0.95;
    this.tgt.scale = this.cam.scale = s;
    this.tgt.x = this.cam.x = m.origW / 2;
    this.tgt.y = this.cam.y = m.origH / 2;
    this.dirty = true;
  }

  pickLevel() {
    const m = this.meta;
    const ideal = -Math.log2(this.cam.scale);
    return Math.max(0, Math.min(m.levels.length - 1, Math.round(ideal)));
  }

  /* 等待当前视野所需瓦片全部就绪（基准测试用） */
  waitIdle() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.pending.size === 0 && this.inflight === 0) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  /* ---------- 事件 ---------- */

  _bindEvents() {
    const c = this.canvas;
    new ResizeObserver(() => this._resize()).observe(c);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      this._zoomAt(mx, my, this.tgt.scale * factor);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        this._pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      this.vel.x = this.vel.y = 0;
    });

    c.addEventListener('pointermove', (e) => {
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (this._pointers.size === 1) {
        // 平移：当前值与目标值同步移动，1:1 跟手
        this.cam.x -= dx / this.cam.scale; this.tgt.x -= dx / this.tgt.scale;
        this.cam.y -= dy / this.cam.scale; this.tgt.y -= dy / this.tgt.scale;
        this.vel.x = dx * 60; this.vel.y = dy * 60; // 估算惯性速度
        this.dirty = true;
      } else if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const rect = c.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - rect.left, my = (a.y + b.y) / 2 - rect.top;
        if (this._pinchDist > 0) this._zoomAt(mx, my, this.tgt.scale * (d / this._pinchDist));
        this._pinchDist = d;
      }
    });

    const up = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinchDist = 0;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);

    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      this._zoomAt(e.clientX - rect.left, e.clientY - rect.top, this.tgt.scale * 2);
    });
  }

  _zoomAt(mx, my, newScale) {
    const m = this.meta;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const minS = m ? Math.min(cw / m.origW, ch / m.origH) * 0.2 : 0.001;
    newScale = Math.max(minS, Math.min(64, newScale));
    // 锚点：光标下的图像坐标在缩放前后保持不动
    const ix = this.tgt.x + (mx - cw / 2) / this.tgt.scale;
    const iy = this.tgt.y + (my - ch / 2) / this.tgt.scale;
    this.tgt.scale = newScale;
    this.tgt.x = ix - (mx - cw / 2) / newScale;
    this.tgt.y = iy - (my - ch / 2) / newScale;
    this.animating = true;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.dpr = dpr;
    this.dirty = true;
  }

  /* ---------- 主循环 ---------- */

  _loop(t) {
    requestAnimationFrame((tt) => this._loop(tt));
    const dt = this._lastFrame ? Math.min(0.1, (t - this._lastFrame) / 1000) : 0.016;
    this._lastFrame = t;

    // 惯性
    const vMag = Math.hypot(this.vel.x, this.vel.y);
    if (vMag > 1 && this._pointers.size === 0) {
      this.tgt.x -= (this.vel.x * dt) / this.tgt.scale;
      this.tgt.y -= (this.vel.y * dt) / this.tgt.scale;
      const decay = Math.exp(-dt * 4);
      this.vel.x *= decay; this.vel.y *= decay;
      this.animating = true;
    }

    // 指数趋近目标相机（时间常数 ~90ms，平滑无抖动）
    const k = 1 - Math.exp(-dt / 0.09);
    const dx = this.tgt.x - this.cam.x, dy = this.tgt.y - this.cam.y;
    const ds = this.tgt.scale - this.cam.scale;
    if (Math.abs(ds) > 1e-6 || Math.abs(dx * this.cam.scale) > 0.05 || Math.abs(dy * this.cam.scale) > 0.05) {
      this.cam.x += dx * k; this.cam.y += dy * k; this.cam.scale += ds * k;
      this.animating = true; this.dirty = true;
    } else if (this.animating) {
      this.cam.x = this.tgt.x; this.cam.y = this.tgt.y; this.cam.scale = this.tgt.scale;
      this.animating = false; this.dirty = true;
    }

    if (!this.dirty) return;
    const t0 = performance.now();
    this._render();
    const ms = performance.now() - t0;
    this._frameTimes.push(ms);
    if (this._frameTimes.length > 60) this._frameTimes.shift();
    this.stats.frameMs = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
    this.stats.fps = 1000 / Math.max(0.01, (t - (this._prevT || t - 16)));
    this._prevT = t;
    this.dirty = this.pending.size > 0 || this.inflight > 0; // 有加载任务时继续刷新
    this.onStats(this.stats);
  }

  /* ---------- 渲染 ---------- */

  _render() {
    const ctx = this.ctx, dpr = this.dpr;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#111418';
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.animating ? 'low' : 'high';

    this.visibleKeys.clear();
    this.stats.tilesDrawn = 0;

    if (this.mode === 'single') { this._renderSingle(cw, ch); return; }
    if (!this.meta) return;

    const level = this.pickLevel();
    this.stats.level = level;
    // 从最粗层到目标层依次绘制：粗层垫底，细层覆盖
    for (let l = this.meta.levels.length - 1; l >= level; l--) {
      this._drawLevel(l, l === level, cw, ch);
    }
    this._pumpQueue();
  }

  _renderSingle(cw, ch) {
    const bmp = this.singleBitmap;
    if (!bmp) return;
    const s = this.cam.scale, dpr = this.dpr;
    const dx = (0 - this.cam.x) * s + cw / 2;
    const dy = (0 - this.cam.y) * s + ch / 2;
    const r = (v) => Math.round(v * dpr) / dpr;
    const x0 = r(dx), y0 = r(dy);
    this.ctx.drawImage(bmp, x0, y0, r(dx + bmp.width * s) - x0, r(dy + bmp.height * s) - y0);
    this.stats.tilesDrawn = 1;
    this.stats.level = -1;
  }

  _drawLevel(l, isTarget, cw, ch) {
    const m = this.meta, lm = m.levels[l], ts = m.tileSize;
    const scale2 = Math.pow(2, l);
    const ls = this.cam.scale * scale2;      // CSS px / 层像素
    const s = this.cam.scale;
    // 视野对应的层像素范围
    const imgX0 = this.cam.x - cw / 2 / s, imgY0 = this.cam.y - ch / 2 / s;
    const imgX1 = this.cam.x + cw / 2 / s, imgY1 = this.cam.y + ch / 2 / s;
    const tx0 = Math.max(0, Math.floor(imgX0 / scale2 / ts));
    const ty0 = Math.max(0, Math.floor(imgY0 / scale2 / ts));
    const tx1 = Math.min(lm.tilesX - 1, Math.floor(imgX1 / scale2 / ts));
    const ty1 = Math.min(lm.tilesY - 1, Math.floor(imgY1 / scale2 / ts));
    if (tx1 < tx0 || ty1 < ty0) return;

    const dpr = this.dpr;
    const r = (v) => Math.round(v * dpr) / dpr; // 对齐设备像素
    const ox = -this.cam.x * s + cw / 2, oy = -this.cam.y * s + ch / 2;
    const ctx = this.ctx;

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = this.viewMode + ':' + l + ':' + tx + ':' + ty;
        // 目标瓦片边界：两边独立取整，相邻瓦片共享取整后的边 → 无缝无重叠
        const gx0 = tx * ts, gy0 = ty * ts;
        const gx1 = Math.min(gx0 + ts, lm.w), gy1 = Math.min(gy0 + ts, lm.h);
        const dx0 = r(gx0 * ls + ox), dy0 = r(gy0 * ls + oy);
        const dx1 = r(gx1 * ls + ox), dy1 = r(gy1 * ls + oy);

        const bmp = this.cache.get(key);
        if (bmp) {
          ctx.drawImage(bmp, dx0, dy0, dx1 - dx0, dy1 - dy0);
          if (isTarget) { this.stats.tilesDrawn++; this.visibleKeys.add(key); }
        } else if (isTarget) {
          this.visibleKeys.add(key);
          this._enqueue(key, this.viewMode, l, tx, ty, tx, ty, tx0, ty0, tx1, ty1);
          // 占位底色，避免闪烁
          ctx.fillStyle = '#1c2128';
          ctx.fillRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
        }
        if (this.showGrid && isTarget) {
          ctx.strokeStyle = 'rgba(0,255,180,0.5)';
          ctx.lineWidth = 1;
          ctx.strokeRect(dx0 + 0.5, dy0 + 0.5, dx1 - dx0 - 1, dy1 - dy0 - 1);
        }
      }
    }
  }

  /* ---------- 瓦片调度 ---------- */

  _enqueue(key, mode, l, tx, ty, cx, cy, tx0, ty0, tx1, ty1) {
    if (this.pending.has(key) || this.cache.has(key)) return;
    // 优先级：离视野中心越近越先加载
    const prio = Math.hypot(tx - (tx0 + tx1) / 2, ty - (ty0 + ty1) / 2);
    this.pending.set(key, { key, mode, l, tx, ty, prio });
  }

  _pumpQueue() {
    // 清理已不可见的请求，按优先级排序
    for (const key of this.pending.keys()) {
      if (!this.visibleKeys.has(key)) this.pending.delete(key);
    }
    const sorted = [...this.pending.values()].sort((a, b) => a.prio - b.prio);
    while (this.inflight < this.maxInflight && sorted.length) {
      const job = sorted.shift();
      if (!this.pending.has(job.key)) continue;
      this.pending.delete(job.key);
      this.inflight++;
      this.stats.loads++;
      this.getTile(job.mode, job.l, job.tx, job.ty).then((tile) => {
        this.inflight--;
        if (tile) {
          const bmp = tile.bitmap;
          this.cache.set(job.key, bmp, tile.w * tile.h * 4, this.visibleKeys);
        }
        this.dirty = true;
      }).catch(() => { this.inflight--; this.dirty = true; });
    }
  }
}
