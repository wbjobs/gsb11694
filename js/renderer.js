/*
 * renderer.js — Canvas 多分辨率瓦片渲染器。
 * - 按缩放级别自动选择金字塔层（带迟滞，防抖）
 * - 指数平滑缩放/平移，消除抖动
 * - 瓦片异步加载（LRU 缓存 + IndexedDB），未就绪时回退到更粗层
 * - 瓦片边界像素级对齐（两边取整法，无缝无重叠）
 * - 支持单分辨率降级模式
 */
(function (root) {
  'use strict';

  const LEVEL_HYSTERESIS = 0.6;   // 层切换迟滞（log2 单位）
  const SMOOTH_SPEED = 12;        // 视图平滑速度（1/秒）

  class PyramidRenderer {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cache = opts.cache;                 // TileCache
      this.getTileRecord = opts.getTileRecord; // async (key) => {width,height,data}
      this.onFrame = opts.onFrame || function () {};

      this.meta = null;          // {width,height,levels,tileSize}
      this.view = { scale: 1, tx: 0, ty: 0 };       // 当前视图（css px）
      this.target = { scale: 1, tx: 0, ty: 0 };     // 目标视图
      this.level = 0;
      this.showGrid = false;
      this.laplacianView = false;
      this.singleRes = false;    // 降级：只用最粗层
      this.singleBitmap = null;  // 极端降级：整图单 bitmap
      this.pending = new Map();  // key -> Promise（防重复加载）
      this.dpr = 1;
      this._lastTime = 0;
      this._running = false;
      this._needsRender = true;
      this.frameMs = 0;
    }

    setPyramid(meta) {
      this.meta = meta;
      this.level = meta.levels - 1;
      this.fitView();
      this.requestRender();
    }

    setSingleBitmap(bitmap) {
      this.singleBitmap = bitmap;
      this.meta = { width: bitmap.width, height: bitmap.height, levels: 1, tileSize: bitmap.width };
      this.level = 0;
      this.fitView();
      this.requestRender();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      this.dpr = dpr;
      this.requestRender();
    }

    fitView() {
      if (!this.meta) return;
      const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
      const scale = Math.min(w / this.meta.width, h / this.meta.height) * 0.95;
      this.view.scale = this.target.scale = scale;
      this.view.tx = this.target.tx = (w - this.meta.width * scale) / 2;
      this.view.ty = this.target.ty = (h - this.meta.height * scale) / 2;
      this.level = this.pickLevel(scale);
    }

    /** 以 (cx,cy) 为锚点缩放 factor 倍（目标视图，动画平滑逼近） */
    zoomAt(cx, cy, factor) {
      const t = this.target;
      const newScale = Math.min(64, Math.max(1 / (1 << (this.meta ? this.meta.levels : 1)), t.scale * factor));
      const k = newScale / t.scale;
      t.tx = cx - (cx - t.tx) * k;
      t.ty = cy - (cy - t.ty) * k;
      t.scale = newScale;
      this.requestRender();
    }

    setScale(cx, cy, scale) {
      this.zoomAt(cx, cy, scale / this.target.scale);
    }

    pan(dx, dy) {
      this.target.tx += dx;
      this.target.ty += dy;
      this.requestRender();
    }

    /** 层选择：理想层 = -log2(scale)，带迟滞避免边界抖动 */
    pickLevel(scale) {
      if (!this.meta) return 0;
      const maxLevel = this.meta.levels - 1;
      const ideal = Math.max(0, Math.min(maxLevel, -Math.log2(scale)));
      let level = this.level;
      if (ideal > level + LEVEL_HYSTERESIS) level = Math.min(maxLevel, Math.ceil(ideal));
      else if (ideal < level - LEVEL_HYSTERESIS) level = Math.max(0, Math.floor(ideal));
      return level;
    }

    requestRender() {
      this._needsRender = true;
      if (!this._running) {
        this._running = true;
        this._lastTime = performance.now();
        requestAnimationFrame((t) => this._tick(t));
      }
    }

    _tick(now) {
      const dt = Math.min(0.1, (now - this._lastTime) / 1000);
      this._lastTime = now;
      // 指数平滑逼近目标视图
      const k = 1 - Math.exp(-SMOOTH_SPEED * dt);
      const v = this.view, t = this.target;
      let moving = false;
      for (const key of ['scale', 'tx', 'ty']) {
        const diff = t[key] - v[key];
        if (Math.abs(diff) > (key === 'scale' ? 1e-6 : 0.01)) {
          v[key] += diff * k;
          moving = true;
        } else {
          v[key] = t[key];
        }
      }
      const t0 = performance.now();
      this._render();
      this.frameMs = performance.now() - t0;
      this.onFrame(this);
      if (moving || this._needsRender) {
        this._needsRender = false;
        requestAnimationFrame((t2) => this._tick(t2));
      } else {
        this._running = false;
      }
    }

    _tileKey(prefix, level, tx, ty) { return prefix + ':' + level + ':' + tx + ':' + ty; }

    _loadTile(prefix, level, tx, ty) {
      const key = this._tileKey(prefix, level, tx, ty);
      if (this.cache.has(key) || this.pending.has(key)) return;
      const p = this.getTileRecord(key).then((rec) => {
        this.pending.delete(key);
        if (!rec) return;
        const imageData = new ImageData(new Uint8ClampedArray(rec.data), rec.width, rec.height);
        return createImageBitmap(imageData).then((bitmap) => {
          this.cache.put(key, bitmap, rec.width * rec.height * 4);
          this.requestRender();
        });
      }).catch(() => { this.pending.delete(key); });
      this.pending.set(key, p);
    }

    _render() {
      const ctx = this.ctx;
      const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#111418';
      ctx.fillRect(0, 0, cw, ch);
      if (!this.meta) return;

      if (this.singleBitmap) { this._renderSingleBitmap(ctx); return; }

      performance.mark('render-start');
      const level = this.singleRes ? this.meta.levels - 1 : this.pickLevel(this.view.scale);
      this.level = level;
      const levelScale = Math.pow(2, level);      // level-0 px / level px
      const tileSize = this.meta.tileSize;
      const levelW = Math.ceil(this.meta.width / levelScale);
      const levelH = Math.ceil(this.meta.height / levelScale);
      const cols = Math.ceil(levelW / tileSize);
      const rows = Math.ceil(levelH / tileSize);
      const prefix = this.laplacianView ? 'l' : 'g';
      const isLapLast = this.laplacianView && level === this.meta.levels - 1;
      const usePrefix = isLapLast ? 'g' : prefix; // 最粗层无拉普拉斯，回退高斯

      // 可见区域（level 像素坐标）
      const v = this.view;
      const imgL = Math.max(0, -v.tx / v.scale / levelScale);
      const imgT = Math.max(0, -v.ty / v.scale / levelScale);
      const imgR = Math.min(levelW, (cw - v.tx) / v.scale / levelScale);
      const imgB = Math.min(levelH, (ch - v.ty) / v.scale / levelScale);
      const tx0 = Math.max(0, Math.floor(imgL / tileSize));
      const ty0 = Math.max(0, Math.floor(imgT / tileSize));
      const tx1 = Math.min(cols - 1, Math.floor((imgR - 1e-9) / tileSize));
      const ty1 = Math.min(rows - 1, Math.floor((imgB - 1e-9) / tileSize));

      const pxPerLevelPx = levelScale * v.scale;  // css px / level px
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const key = this._tileKey(usePrefix, level, tx, ty);
          let bitmap = this.cache.get(key);
          let srcRect = null;
          if (!bitmap) {
            this._loadTile(usePrefix, level, tx, ty);
            srcRect = this._fallbackTile(tx, ty, level);
            bitmap = srcRect ? srcRect.bitmap : null;
          }
          // 瓦片目标矩形：两边取整法 → 相邻瓦片共享整数边界，无缝无重叠
          const tileW = Math.min(tileSize, levelW - tx * tileSize);
          const tileH = Math.min(tileSize, levelH - ty * tileSize);
          const dx0 = Math.round(v.tx + tx * tileSize * pxPerLevelPx);
          const dy0 = Math.round(v.ty + ty * tileSize * pxPerLevelPx);
          const dx1 = Math.round(v.tx + (tx * tileSize + tileW) * pxPerLevelPx);
          const dy1 = Math.round(v.ty + (ty * tileSize + tileH) * pxPerLevelPx);
          if (bitmap) {
            if (srcRect) {
              ctx.drawImage(bitmap, srcRect.sx, srcRect.sy, srcRect.sw, srcRect.sh,
                dx0, dy0, Math.max(1, dx1 - dx0), Math.max(1, dy1 - dy0));
            } else {
              ctx.drawImage(bitmap, dx0, dy0, Math.max(1, dx1 - dx0), Math.max(1, dy1 - dy0));
            }
          } else {
            ctx.fillStyle = '#1d232b';
            ctx.fillRect(dx0, dy0, Math.max(1, dx1 - dx0), Math.max(1, dy1 - dy0));
          }
          if (this.showGrid) {
            ctx.strokeStyle = 'rgba(0,255,170,0.8)';
            ctx.lineWidth = 1;
            ctx.strokeRect(dx0 + 0.5, dy0 + 0.5, Math.max(1, dx1 - dx0) - 1, Math.max(1, dy1 - dy0) - 1);
            ctx.fillStyle = 'rgba(0,255,170,0.9)';
            ctx.font = '11px monospace';
            ctx.fillText(level + ':' + tx + ',' + ty, dx0 + 4, dy0 + 14);
          }
        }
      }
      performance.mark('render-end');
      performance.measure('render-frame', 'render-start', 'render-end');
    }

    /**
     * 瓦片未就绪时，用更粗层缓存瓦片的对应子区域临时顶替（避免闪烁）。
     * 返回 {bitmap, sx, sy, sw, sh}：粗层瓦片内的源矩形。
     */
    _fallbackTile(tx, ty, level) {
      const ts = this.meta.tileSize;
      for (let l = level + 1; l < this.meta.levels; l++) {
        const shift = l - level;
        const ptx = tx >> shift, pty = ty >> shift;
        const bitmap = this.cache.get(this._tileKey('g', l, ptx, pty));
        if (!bitmap) continue;
        // 细层瓦片区域换算到粗层像素坐标
        const fx0 = (tx * ts) >> shift, fy0 = (ty * ts) >> shift;
        const fx1 = ((tx + 1) * ts) >> shift, fy1 = ((ty + 1) * ts) >> shift;
        return {
          bitmap,
          sx: fx0 - ptx * ts, sy: fy0 - pty * ts,
          sw: Math.max(1, fx1 - fx0), sh: Math.max(1, fy1 - fy0),
        };
      }
      return null;
    }

    _renderSingleBitmap(ctx) {
      const v = this.view;
      const w = this.meta.width * v.scale, h = this.meta.height * v.scale;
      ctx.drawImage(this.singleBitmap, v.tx, v.ty, w, h);
    }
  }

  root.PyramidRenderer = PyramidRenderer;
})(typeof self !== 'undefined' ? self : globalThis);
