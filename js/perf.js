/* 性能监控：PerformanceObserver（longtask / measure）+ JS 堆内存 + FPS */
'use strict';

class PerfMonitor {
  constructor() {
    this.longtasks = 0;
    this.lastLongtask = null;
    this.measures = [];
    this.supported = { longtask: false, memory: !!performance.memory };

    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            this.longtasks++;
            this.lastLongtask = Math.round(e.duration);
          }
        });
        po.observe({ entryTypes: ['longtask'] });
        this.supported.longtask = true;
      } catch (e) { /* 浏览器不支持 longtask */ }

      try {
        const po2 = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            this.measures.push({ name: e.name, duration: Math.round(e.duration * 10) / 10 });
            if (this.measures.length > 50) this.measures.shift();
          }
        });
        po2.observe({ entryTypes: ['measure'] });
      } catch (e) { /* ignore */ }
    }
  }

  heapMB() {
    if (!performance.memory) return null;
    return {
      used: performance.memory.usedJSHeapSize / 1048576,
      total: performance.memory.totalJSHeapSize / 1048576,
      limit: performance.memory.jsHeapSizeLimit / 1048576,
    };
  }

  /* 堆内存超过阈值比例时返回 true（用于自动降级） */
  heapPressure(ratio = 0.85) {
    const h = this.heapMB();
    return h ? h.used / h.limit > ratio : false;
  }
}
