// A single PDF "paper" on the table: a movable, rotatable sheet that renders
// one page of a PDF and re-renders at higher resolution as you zoom in.

import { renderCache } from "./rendercache.js";

const MAX_RENDER = 5; // cap bitmap pixels-per-CSS-px so canvases stay sane
const MIN_RENDER = 0.06; // floor so far-zoomed-out thumbnails still have a bitmap
const BASE_LEVEL = 0.0625; // smallest resolution level (1/16); levels double from here
const DPR = window.devicePixelRatio || 1;

let _paperUid = 0; // fallback cache id when a sheet has no sourceId

// Hard limits on the backing <canvas> bitmap. Large-format PDFs (e.g. A1/A0
// engineering drawings) would otherwise demand 100MP+ canvases that GPU-backed
// browsers refuse to allocate, causing renders to fail or come back blank. We
// keep both the per-side dimension and the total area well within what every
// desktop browser handles reliably.
const MAX_CANVAS_DIM = 8192;
const MAX_CANVAS_AREA = 24e6; // ~24 megapixels

export class Paper {
  /**
   * @param {import("pdfjs-dist").PDFDocumentProxy} doc
   * @param {string} name
   * @param {object} ctx  { world, viewport, app }
   */
  constructor(doc, name, { world, viewport, app, page = 1, singlePage = false, sourceId = null }) {
    this.doc = doc;
    this.name = name;
    this.world = world;
    this.viewport = viewport;
    this.app = app;
    this.sourceId = sourceId; // which embedded PDF source this sheet renders

    // Track how many papers share this doc so we only free it on the last close.
    doc.__refs = (doc.__refs || 0) + 1;

    this.numPages = doc.numPages;
    this.singlePage = singlePage; // locked to one page (an "exploded" sheet)
    this.pageNum = Math.max(1, Math.min(this.numPages, page));
    this.x = 0;
    this.y = 0;
    this.rotation = 0;
    this.baseW = 0;
    this.baseH = 0;
    this.group = null; // Group this sheet belongs to, or null
    this.rendered = false; // whether the canvas currently holds a bitmap
    this._displayedLevel = 0; // resolution level currently shown
    this._cacheId = sourceId || `paper${++_paperUid}`; // cache key namespace
    this._renderTask = null;
    this._page = null;

    this._build();
  }

  // ---------- DOM ----------
  _build() {
    const el = document.createElement("div");
    el.className = "paper";
    el.innerHTML = `
      <canvas></canvas>
      <div class="hl-layer"></div>
      <div class="loading">Rendering…</div>
      <div class="paper-bar">
        <span class="label"></span>
        <button data-act="prev" title="Previous page">‹</button>
        <span class="pages"></span>
        <button data-act="next" title="Next page">›</button>
        <button data-act="explode" title="Explode into one sheet per page">⧉</button>
        <button data-act="unrotate" title="Reset rotation">⊙</button>
        <button data-act="close" title="Close">✕</button>
      </div>
      <div class="rotate-handle" title="Drag to rotate (hold Shift to snap)">↻</div>
    `;
    this.el = el;
    this.canvas = el.querySelector("canvas");
    this.hlLayer = el.querySelector(".hl-layer");
    this.loadingEl = el.querySelector(".loading");
    this.barEl = el.querySelector(".paper-bar");
    this.labelEl = el.querySelector(".label");
    this.pagesEl = el.querySelector(".pages");
    this.handleEl = el.querySelector(".rotate-handle");

    this.labelEl.textContent = this.name;
    this._updatePageLabel();

    el.querySelector('[data-act="prev"]').addEventListener("click", (e) => {
      e.stopPropagation();
      this.gotoPage(this.pageNum - 1);
    });
    el.querySelector('[data-act="next"]').addEventListener("click", (e) => {
      e.stopPropagation();
      this.gotoPage(this.pageNum + 1);
    });
    el.querySelector('[data-act="explode"]').addEventListener("click", (e) => {
      e.stopPropagation();
      this.app.explodePaper(this);
    });
    el.querySelector('[data-act="unrotate"]').addEventListener("click", (e) => {
      e.stopPropagation();
      this.rotation = 0;
      this._applyTransform();
    });
    el.querySelector('[data-act="close"]').addEventListener("click", (e) => {
      e.stopPropagation();
      this.app.removePaper(this);
    });

    this._initDrag();
    this._initRotate();

    this.world.appendChild(el);
  }

  _updatePageLabel() {
    // An exploded sheet is pinned to one page; otherwise show nav for multi-page.
    if (this.singlePage) {
      this.labelEl.textContent = `${this.name} · p${this.pageNum}`;
    }
    this.pagesEl.textContent = `${this.pageNum} / ${this.numPages}`;
    const hideNav = this.singlePage || this.numPages <= 1;
    this.el.querySelector('[data-act="prev"]').style.display = hideNav ? "none" : "";
    this.el.querySelector('[data-act="next"]').style.display = hideNav ? "none" : "";
    this.pagesEl.style.display = hideNav ? "none" : "";
    // Explode only makes sense for an intact multi-page document.
    this.el.querySelector('[data-act="explode"]').style.display =
      this.singlePage || this.numPages <= 1 ? "none" : "";
  }

  // ---------- placement ----------
  setPosition(x, y) {
    this.x = x;
    this.y = y;
    this._applyTransform();
  }

  _applyTransform() {
    this.el.style.transform = `translate(${this.x}px, ${this.y}px) rotate(${this.rotation}deg)`;
  }

  /** Axis-aligned world bounding box, accounting for rotation. */
  bounds() {
    const r = (this.rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(r));
    const sin = Math.abs(Math.sin(r));
    const w = this.baseW * cos + this.baseH * sin;
    const h = this.baseW * sin + this.baseH * cos;
    const cx = this.x + this.baseW / 2;
    const cy = this.y + this.baseH / 2;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  /** Counter-scale chrome so it stays a constant on-screen size. */
  updateChrome(worldScale) {
    const k = 1 / worldScale;
    this.barEl.style.setProperty("--k", k);
    this.handleEl.style.setProperty("--k", k);
  }

  // ---------- search highlights (boxes in paper-local CSS px) ----------
  setHighlights(boxes) {
    this._hlBoxes = boxes;
    this.hlLayer.innerHTML = "";
    for (const b of boxes) {
      const d = document.createElement("div");
      d.className = "hl";
      d.style.left = `${b.l}px`;
      d.style.top = `${b.t}px`;
      d.style.width = `${b.w}px`;
      d.style.height = `${b.h}px`;
      d._box = b;
      this.hlLayer.appendChild(d);
    }
  }
  setActiveHighlight(box) {
    for (const d of this.hlLayer.children) d.classList.toggle("active", d._box === box);
  }
  clearHighlights() {
    this.hlLayer.innerHTML = "";
    this._hlBoxes = null;
  }

  // ---------- rendering ----------
  /** Largest render scale whose canvas still fits the browser's limits. */
  _maxScale() {
    if (!this.baseW || !this.baseH) return MAX_RENDER;
    return Math.min(
      MAX_RENDER,
      MAX_CANVAS_DIM / this.baseW,
      MAX_CANVAS_DIM / this.baseH,
      Math.sqrt(MAX_CANVAS_AREA / (this.baseW * this.baseH))
    );
  }

  /** Resolution to match the sheet's current on-screen pixel size, clamped. */
  _targetScale() {
    const desired = this.viewport.scale * DPR;
    return Math.max(MIN_RENDER, Math.min(desired, this._maxScale()));
  }

  /** Snap the target to a discrete level (powers of two) so there's a small,
   *  cacheable set of resolutions. Rounds up so the bitmap is never upscaled. */
  _levelFor(target) {
    const max = this._maxScale();
    let l = BASE_LEVEL;
    while (l < target - 1e-6 && l < max) l *= 2;
    return Math.min(l, max);
  }

  _cacheKey(level) {
    return `${this._cacheId}|${this.pageNum}|${level.toFixed(4)}`;
  }

  /** Draw a finished bitmap/canvas into the visible canvas in one paint. */
  _blit(src) {
    if (this.canvas.width !== src.width || this.canvas.height !== src.height) {
      this.canvas.width = src.width;
      this.canvas.height = src.height;
    }
    this.canvas.getContext("2d", { alpha: false }).drawImage(src, 0, 0);
    this.canvas.style.opacity = "1";
    this.loadingEl.style.display = "none";
  }

  _applyPageSize(page) {
    const vp1 = page.getViewport({ scale: 1 });
    this.baseW = Math.round(vp1.width);
    this.baseH = Math.round(vp1.height);
    this.el.style.width = `${this.baseW}px`;
    this.el.style.height = `${this.baseH}px`;
    this.canvas.style.width = `${this.baseW}px`;
    this.canvas.style.height = `${this.baseH}px`;
  }

  /** Prepare size + page, but DON'T render — the app renders on demand once the
   *  sheet is placed and on-screen (so opening 200 PDFs doesn't try to hold 200
   *  full-resolution canvases at once). */
  async init() {
    this._page = await this.doc.getPage(this.pageNum);
    this._applyPageSize(this._page);
  }

  async gotoPage(n) {
    const next = Math.max(1, Math.min(this.numPages, n));
    if (next === this.pageNum) return;
    this.pageNum = next;
    this._page = await this.doc.getPage(next);
    this._searchWords = null; // page changed → re-index on next search
    this.clearHighlights();
    this._updatePageLabel();
    // Different pages can be different sizes (e.g. landscape inserts).
    this._applyPageSize(this._page);
    this.free();
    this.app.scheduleRender?.();
  }

  /** True if the bitmap is missing or no longer at the current zoom's level. */
  needsRender() {
    if (!this._page) return false;
    if (!this.rendered) return true;
    return this._levelFor(this._targetScale()) !== this._displayedLevel;
  }

  /** Show the page at the current level — from cache if we've rendered it
   *  before, otherwise render it (into an offscreen canvas so the visible
   *  sheet keeps its current bitmap until the new one is ready) and cache it. */
  async render() {
    if (!this._page) return;
    const level = this._levelFor(this._targetScale());
    if (this.rendered && level === this._displayedLevel) return;

    // Cache hit: instant, no pdf.js work.
    const cached = renderCache.get(this._cacheKey(level));
    if (cached) {
      this._blit(cached);
      this.rendered = true;
      this._displayedLevel = level;
      return;
    }

    if (this._renderTask) {
      try {
        this._renderTask.cancel();
      } catch {}
      this._renderTask = null;
    }

    // Cache miss: render at `level`, backing off if the canvas can't allocate.
    let scale = level;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const vp = this._page.getViewport({ scale });
        const off = document.createElement("canvas");
        off.width = Math.round(vp.width);
        off.height = Math.round(vp.height);
        const ctx = off.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("Could not allocate canvas context");
        this._renderTask = this._page.render({ canvasContext: ctx, viewport: vp });
        await this._renderTask.promise;
        this._renderTask = null;
        this._blit(off); // swap into the visible canvas in one paint
        this.rendered = true;
        this._displayedLevel = level;
        try {
          const bmp = await createImageBitmap(off);
          renderCache.set(this._cacheKey(level), bmp, off.width * off.height * 4);
        } catch {}
        return;
      } catch (err) {
        this._renderTask = null;
        if (err && err.name === "RenderingCancelledException") return; // superseded
        console.error(`Render failed at scale ${scale.toFixed(2)}`, err);
        scale *= 0.6; // shrink the canvas and try again
      }
    }
    this.loadingEl.textContent = "Couldn't render";
    this.loadingEl.style.display = "grid";
  }

  /** Release the visible bitmap to free memory; cached levels are kept so
   *  returning to this sheet is instant. The white sheet shows underneath. */
  free() {
    if (this._renderTask) {
      try {
        this._renderTask.cancel();
      } catch {}
      this._renderTask = null;
    }
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.style.opacity = "0";
    this.rendered = false;
    this._displayedLevel = 0;
  }

  /** Is the sheet within `margin` px of the viewport? */
  isVisible(margin = 300) {
    const r = this.el.getBoundingClientRect();
    return (
      r.right > -margin &&
      r.bottom > -margin &&
      r.left < window.innerWidth + margin &&
      r.top < window.innerHeight + margin
    );
  }

  // ---------- dragging to move ----------
  _initDrag() {
    let lastX = 0;
    let lastY = 0;
    let active = false;
    let moveSet = null; // every paper that moves with this one (selection ∪ groups)

    this.el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".paper-bar") || e.target.closest(".rotate-handle")) return;
      if (e.button !== 0) return;
      if (this.app.mode !== "move") return; // drawing tools own the pointer

      // Shift toggles selection membership without starting a drag.
      if (e.shiftKey) {
        this.app.toggleSelect(this);
        e.stopPropagation();
        return;
      }

      moveSet = this.app.beginDrag(this);
      active = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.el.classList.add("dragging");
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {}
      e.stopPropagation();
    });

    this.el.addEventListener("pointermove", (e) => {
      if (!active) return;
      const s = this.viewport.scale;
      const dx = (e.clientX - lastX) / s;
      const dy = (e.clientY - lastY) / s;
      lastX = e.clientX;
      lastY = e.clientY;
      for (const p of moveSet) {
        p.x += dx;
        p.y += dy;
        p._applyTransform();
      }
    });

    const end = (e) => {
      if (!active) return;
      active = false;
      moveSet = null;
      this.el.classList.remove("dragging");
      try {
        this.el.releasePointerCapture(e.pointerId);
      } catch {}
      this.app.scheduleRender?.(); // papers moved → refresh which are rendered
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
  }

  // ---------- rotating ----------
  _initRotate() {
    let active = false;

    const center = () => {
      const r = this.el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    };

    this.handleEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      this.app.bringToFront(this);
      if (!this.app.isSelected(this)) this.app.selectOnly(this);
      active = true;
      this.handleEl.setPointerCapture(e.pointerId);
    });

    this.handleEl.addEventListener("pointermove", (e) => {
      if (!active) return;
      const { cx, cy } = center();
      let deg = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      this.rotation = deg;
      this._applyTransform();
    });

    const end = (e) => {
      if (!active) return;
      active = false;
      try {
        this.handleEl.releasePointerCapture(e.pointerId);
      } catch {}
    };
    this.handleEl.addEventListener("pointerup", end);
    this.handleEl.addEventListener("pointercancel", end);
  }

  destroy() {
    if (this._renderTask) {
      try {
        this._renderTask.cancel();
      } catch {}
    }
    this.el.remove();
    // Only tear down the underlying PDF once no sheets reference it anymore
    // (exploded pages share one doc with each other).
    if (--this.doc.__refs <= 0) this.doc.destroy?.();
  }
}
