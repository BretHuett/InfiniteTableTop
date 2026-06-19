// The infinite canvas: pan + zoom that map screen space <-> world space.
//
// #world is a single transformed layer (translate + scale). Papers live inside
// it positioned in world coordinates, so panning/zooming the layer moves them
// all together. The dotted background grid is offset in JS so it appears glued
// to the world.

const MIN_SCALE = 0.04;
const MAX_SCALE = 8;
const GRID = 48; // world px between grid dots at scale 1

export class Viewport {
  constructor(canvasEl, worldEl) {
    this.canvas = canvasEl;
    this.world = worldEl;
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this._listeners = new Set();

    this._initPan();
    this._initZoom();
    this.apply();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _emit() {
    for (const fn of this._listeners) fn(this);
  }

  // ---- coordinate conversion ----
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.panX) / this.scale,
      y: (sy - this.panY) / this.scale,
    };
  }

  apply() {
    this.world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
    // Keep the background grid aligned with the world.
    const g = GRID * this.scale;
    this.canvas.style.backgroundSize = `${g}px ${g}px, ${g * 4}px ${g * 4}px`;
    this.canvas.style.backgroundPosition = `${this.panX}px ${this.panY}px, ${this.panX}px ${this.panY}px`;
    this._emit();
  }

  setScale(newScale, centerX, centerY) {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    // Keep the world point under (centerX, centerY) fixed on screen.
    const wx = (centerX - this.panX) / this.scale;
    const wy = (centerY - this.panY) / this.scale;
    this.scale = clamped;
    this.panX = centerX - wx * this.scale;
    this.panY = centerY - wy * this.scale;
    this.apply();
  }

  zoomBy(factor, centerX, centerY) {
    const cx = centerX ?? window.innerWidth / 2;
    const cy = centerY ?? window.innerHeight / 2;
    this.setScale(this.scale * factor, cx, cy);
  }

  reset() {
    // 100% centred-ish on whatever the user is looking at.
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    this.setScale(1, cx, cy);
  }

  /** Fit the given world-space bounding box into the viewport with padding. */
  fitBounds(bounds, padding = 90) {
    if (!bounds) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = Math.max(bounds.w, 1);
    const bh = Math.max(bounds.h, 1);
    const scale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, Math.min((vw - padding * 2) / bw, (vh - padding * 2) / bh))
    );
    this.scale = scale;
    this.panX = vw / 2 - (bounds.x + bw / 2) * scale;
    this.panY = vh / 2 - (bounds.y + bh / 2) * scale;
    this.apply();
  }

  // ---- panning the camera ----
  //  • Middle mouse button  -> pan from anywhere, even over a paper.
  //  • Left mouse button     -> pan only from empty canvas (papers handle their
  //                             own left-drag to move themselves).
  _initPan() {
    let active = false;
    let startX = 0;
    let startY = 0;
    let startPanX = 0;
    let startPanY = 0;

    // Stop the browser's middle-click autoscroll from kicking in.
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    this.canvas.addEventListener("auxclick", (e) => {
      if (e.button === 1) e.preventDefault();
    });

    this.canvas.addEventListener("pointerdown", (e) => {
      const middle = e.button === 1;
      const leftOnEmpty =
        e.button === 0 && (e.target === this.canvas || e.target === this.world);
      if (!middle && !leftOnEmpty) return;
      if (middle) e.preventDefault();

      active = true;
      startX = e.clientX;
      startY = e.clientY;
      startPanX = this.panX;
      startPanY = this.panY;
      this.canvas.classList.add("panning");
      document.body.classList.add("cam-panning");
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {}
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (!active) return;
      this.panX = startPanX + (e.clientX - startX);
      this.panY = startPanY + (e.clientY - startY);
      this.apply();
    });

    const end = (e) => {
      if (!active) return;
      active = false;
      this.canvas.classList.remove("panning");
      document.body.classList.remove("cam-panning");
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {}
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
  }

  // ---- zooming with the wheel / trackpad ----
  _initZoom() {
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey) {
          // Pinch-zoom on trackpads arrives as ctrl+wheel.
          const factor = Math.exp(-e.deltaY * 0.01);
          this.setScale(this.scale * factor, e.clientX, e.clientY);
        } else {
          const factor = Math.exp(-e.deltaY * 0.0015);
          this.setScale(this.scale * factor, e.clientX, e.clientY);
        }
      },
      { passive: false }
    );
  }
}
