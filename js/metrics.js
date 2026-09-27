/*
 * metrics.js — 性能与内存监控。
 * - PerformanceObserver 收集 measure / longtask
 * - FPS 与帧耗时统计
 * - JS 堆内存采样（performance.memory，Chrome）+ 瓦片缓存字节数
 * - 分层渲染基准：逐层渲染 N 帧，输出帧耗时对比
 */
(function (root) {
  'use strict';

  class Metrics {
    constructor() {
      this.measures = [];        // 最近 200 条 measure
      this.longtasks = [];
      this.frameTimes = [];      // 最近 120 帧间隔
      this._lastFrame = 0;
      this.supported = { memory: !!(performance && performance.memory) };
      if (typeof PerformanceObserver !== 'undefined') {
        try {
          const obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.entryType === 'measure') {
                this.measures.push({ name: entry.name, duration: entry.duration, start: entry.startTime });
                if (this.measures.length > 200) this.measures.shift();
              } else if (entry.entryType === 'longtask') {
                this.longtasks.push({ duration: entry.duration, start: entry.startTime });
                if (this.longtasks.length > 50) this.longtasks.shift();
              }
            }
            // 按名清理高频打点，避免 performance 条目无限累积
            performance.clearMarks('render-start');
            performance.clearMarks('render-end');
            performance.clearMeasures('render-frame');
          });
          obs.observe({ entryTypes: ['measure', 'longtask'] });
        } catch (e) { /* longtask 不支持时忽略 */ }
      }
    }

    markFrame() {
      const now = performance.now();
      if (this._lastFrame) {
        this.frameTimes.push(now - this._lastFrame);
        if (this.frameTimes.length > 120) this.frameTimes.shift();
      }
      this._lastFrame = now;
    }

    fps() {
      if (this.frameTimes.length < 2) return 0;
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      return avg > 0 ? 1000 / avg : 0;
    }

    heapBytes() {
      return this.supported.memory ? performance.memory.usedJSHeapSize : 0;
    }

    /** 汇总某前缀的 measure 统计 */
    summarize(prefix) {
      const rows = this.measures.filter((m) => m.name.indexOf(prefix) === 0);
      if (!rows.length) return null;
      const durations = rows.map((r) => r.duration);
      return {
        count: rows.length,
        total: durations.reduce((a, b) => a + b, 0),
        avg: durations.reduce((a, b) => a + b, 0) / rows.length,
        max: Math.max.apply(null, durations),
      };
    }

    /**
     * 分层渲染基准：对每一层，把视图缩放到该层 1:1 比例渲染 frames 帧，
     * 返回 [{level, avgMs, maxMs, cacheBytes}]。
     */
    async benchmarkLevels(renderer, frames) {
      frames = frames || 30;
      const results = [];
      const meta = renderer.meta;
      if (!meta) return results;
      const savedView = Object.assign({}, renderer.target);
      const cw = renderer.canvas.clientWidth, ch = renderer.canvas.clientHeight;
      for (let level = 0; level < meta.levels; level++) {
        const scale = 1 / Math.pow(2, level);
        renderer.target.scale = renderer.view.scale = scale;
        renderer.target.tx = renderer.view.tx = (cw - meta.width * scale) / 2;
        renderer.target.ty = renderer.view.ty = (ch - meta.height * scale) / 2;
        renderer.level = level;
        // 等待该层可见瓦片加载完
        await waitForTiles(renderer);
        const times = [];
        for (let f = 0; f < frames; f++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const t0 = performance.now();
          renderer._render();
          times.push(performance.now() - t0);
        }
        results.push({
          level,
          avgMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length * 100) / 100,
          maxMs: Math.round(Math.max.apply(null, times) * 100) / 100,
          cacheBytes: renderer.cache.bytes,
          heapBytes: this.heapBytes(),
        });
      }
      Object.assign(renderer.target, savedView);
      Object.assign(renderer.view, savedView);
      renderer.requestRender();
      return results;
    }
  }

  function waitForTiles(renderer) {
    return new Promise((resolve) => {
      const check = () => {
        if (renderer.pending.size === 0) resolve();
        else setTimeout(check, 30);
      };
      renderer.requestRender();
      check();
    });
  }

  root.Metrics = Metrics;
})(typeof self !== 'undefined' ? self : globalThis);
