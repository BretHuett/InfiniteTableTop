// A single PDF "paper" on the table: a movable, rotatable sheet that renders
// one page of a PDF and re-renders at higher resolution as you zoom in.

const MAX_RENDER = 5; // cap bitmap pixels-per-CSS-px so canvases stay sane
const DPR = window.devicePixelRatio || 1;

export class Paper {
  /**
   * @param {import("pdfjs-dist").PDFDocumentProxy} doc
   * @param {string} name
   * @param {object} ctx  { world, viewport, app }
   */
  constructor(doc, name, { world, viewport, app, page = 1, singlePage = false }) {
    this.doc = doc;
    this.name = name;
    this.world = world;
    this.viewport = viewport;
    this.app = app;

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
    this.renderScale = Math.min(1.5 * DPR, MAX_RENDER);
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

  // ---------- rendering ----------
  async init() {
    const page = await this.doc.getPage(this.pageNum);
    this._page = page;
    const vp1 = page.getViewport({ scale: 1 });
    this.baseW = Math.round(vp1.width);
    this.baseH = Math.round(vp1.height);
    this.el.style.width = `${this.baseW}px`;
    this.el.style.height = `${this.baseH}px`;
    this.canvas.style.width = `${this.baseW}px`;
    this.canvas.style.height = `${this.baseH}px`;
    await this._render();
  }

  async gotoPage(n) {
    const next = Math.max(1, Math.min(this.numPages, n));
    if (next === this.pageNum) return;
    this.pageNum = next;
    this._page = await this.doc.getPage(next);
    this._updatePageLabel();
    // Different pages can be different sizes (e.g. landscape inserts).
    const vp1 = this._page.getViewport({ scale: 1 });
    this.baseW = Math.round(vp1.width);
    this.baseH = Math.round(vp1.height);
    this.el.style.width = `${this.baseW}px`;
    this.el.style.height = `${this.baseH}px`;
    this.canvas.style.width = `${this.baseW}px`;
    this.canvas.style.height = `${this.baseH}px`;
    await this._render();
  }

  async _render() {
    if (!this._page) return;
    if (this._renderTask) {
      try {
        this._renderTask.cancel();
      } catch {}
      this._renderTask = null;
    }
    const scale = this.renderScale;
    const vp = this._page.getViewport({ scale });
    const ctx = this.canvas.getContext("2d", { alpha: false });
    this.canvas.width = Math.round(vp.width);
    this.canvas.height = Math.round(vp.height);

    try {
      this._renderTask = this._page.render({ canvasContext: ctx, viewport: vp });
      await this._renderTask.promise;
      this._renderTask = null;
      this.loadingEl.style.display = "none";
    } catch (err) {
      if (err && err.name === "RenderingCancelledException") return; // superseded
      console.error("Render failed", err);
      this.loadingEl.textContent = "Failed to render";
    }
  }

  /** Bump resolution when the user has zoomed in past the current bitmap. */
  maybeImprove(worldScale) {
    if (!this._page || !this._isVisible()) return;
    const desired = Math.min(MAX_RENDER, Math.round(worldScale * DPR * 1.1 * 10) / 10);
    if (desired > this.renderScale + 0.15) {
      this.renderScale = desired;
      this._render();
    }
  }

  _isVisible() {
    const r = this.el.getBoundingClientRect();
    const m = 200;
    return (
      r.right > -m &&
      r.bottom > -m &&
      r.left < window.innerWidth + m &&
      r.top < window.innerHeight + m
    );
  }

  // ---------- dragging to move ----------
  _initDrag() {
    let lastX = 0;
    let lastY = 0;
    let active = false;

    this.el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".paper-bar") || e.target.closest(".rotate-handle")) return;
      if (e.button !== 0) return;
      this.app.bringToFront(this);
      this.app.setActive(this);
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
      this.x += (e.clientX - lastX) / s;
      this.y += (e.clientY - lastY) / s;
      lastX = e.clientX;
      lastY = e.clientY;
      this._applyTransform();
    });

    const end = (e) => {
      if (!active) return;
      active = false;
      this.el.classList.remove("dragging");
      try {
        this.el.releasePointerCapture(e.pointerId);
      } catch {}
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
      this.app.setActive(this);
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
