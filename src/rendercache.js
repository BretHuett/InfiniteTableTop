// LRU cache of rendered page bitmaps, keyed by "<source>|<page>|<level>".
//
// Zooming snaps to discrete resolution levels (see Paper._levelFor); the bitmap
// for a level is rendered once and reused, so panning/zooming back to a level
// you've already seen is instant instead of re-rendering. A memory budget caps
// total cached pixels and evicts the least-recently-used entries, so the cache
// can't reintroduce the out-of-memory (black canvas) problem.

const GB = 1024 * 1024 * 1024;
const BUDGET = (() => {
  const mem = navigator.deviceMemory || 4; // GB, browser-capped at 8
  return Math.min(Math.max(mem * 0.05, 0.18), 0.45) * GB; // ~180–460 MB
})();

class RenderCache {
  constructor(budget) {
    this.map = new Map(); // key -> { bitmap, bytes }  (insertion order = LRU)
    this.bytes = 0;
    this.budget = budget;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    this.map.delete(key);
    this.map.set(key, e); // bump to most-recently-used
    return e.bitmap;
  }

  set(key, bitmap, bytes) {
    const prev = this.map.get(key);
    if (prev) {
      this.bytes -= prev.bytes;
      prev.bitmap.close?.();
      this.map.delete(key);
    }
    this.map.set(key, { bitmap, bytes });
    this.bytes += bytes;
    this._evict();
  }

  _evict() {
    for (const [k, e] of this.map) {
      if (this.bytes <= this.budget) break;
      this.map.delete(k);
      this.bytes -= e.bytes;
      e.bitmap.close?.();
    }
  }

  /** Drop every entry for a given source (called when its last sheet closes). */
  dropPrefix(prefix) {
    for (const [k, e] of [...this.map]) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        this.bytes -= e.bytes;
        e.bitmap.close?.();
      }
    }
  }

  get stats() {
    return {
      entries: this.map.size,
      mb: +(this.bytes / 1048576).toFixed(1),
      budgetMb: Math.round(this.budget / 1048576),
    };
  }
}

export const renderCache = new RenderCache(BUDGET);
