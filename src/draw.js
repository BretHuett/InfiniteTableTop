// Freehand drawing layer that lives in world space, so ink sits on top of and
// between the papers and pans/zooms with the table.
//
// Input is captured on the full-screen #canvas (in screen coordinates) and
// converted to world coordinates; strokes are stored as world-space point
// lists and drawn as <path>s in an overflow-visible <svg> inside #world.

const SVG_NS = "http://www.w3.org/2000/svg";

export class DrawController {
  constructor({ canvas, world, viewport }) {
    this.canvas = canvas;
    this.world = world;
    this.viewport = viewport;

    this.mode = "move"; // move | pen | highlighter | eraser
    this.color = "#111827";
    this.width = 4; // baseline thickness in *screen* px at draw time

    this.strokes = [];
    this._cur = null;
    this._erasing = false;

    this._buildLayer();
    this._initEvents();
  }

  _buildLayer() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.id = "draw-layer";
    this.world.appendChild(svg);
    this.svg = svg;
  }

  setMode(mode) {
    this.mode = mode;
  }
  isDrawing() {
    return this.mode !== "move";
  }

  _worldPt(e) {
    return this.viewport.screenToWorld(e.clientX, e.clientY);
  }

  _initEvents() {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // left button only; middle still pans
      if (this.mode === "pen" || this.mode === "highlighter") {
        this._startStroke(e);
      } else if (this.mode === "eraser") {
        this._erasing = true;
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch {}
        this._eraseAt(e);
      }
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (this._cur) this._extendStroke(e);
      else if (this._erasing) this._eraseAt(e);
    });

    const end = (e) => {
      if (this._cur) this._endStroke();
      this._erasing = false;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {}
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
  }

  _startStroke(e) {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {}
    const p = this._worldPt(e);
    const hl = this.mode === "highlighter";
    // World width chosen so the on-screen thickness matches `this.width` at the
    // current zoom; afterwards it scales with the table like real ink.
    const w = (hl ? this.width * 4 : this.width) / this.viewport.scale;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", this.color);
    path.setAttribute("stroke-width", w);
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    if (hl) {
      path.setAttribute("stroke-opacity", "0.35");
      path.style.mixBlendMode = "multiply";
    }
    this.svg.appendChild(path);
    this._cur = { points: [p], el: path, type: this.mode, color: this.color, width: w };
  }

  _extendStroke(e) {
    const p = this._worldPt(e);
    const pts = this._cur.points;
    const last = pts[pts.length - 1];
    const min = 2 / this.viewport.scale; // skip jitter, in world units
    if ((p.x - last.x) ** 2 + (p.y - last.y) ** 2 < min * min) return;
    pts.push(p);
    this._cur.el.setAttribute("d", toPath(pts));
  }

  _endStroke() {
    const pts = this._cur.points;
    if (pts.length === 1) {
      // a tap → leave a dot
      pts.push({ x: pts[0].x + 0.01, y: pts[0].y + 0.01 });
    }
    this._cur.el.setAttribute("d", toPath(pts));
    this.strokes.push(this._cur);
    this._cur = null;
  }

  _eraseAt(e) {
    const p = this._worldPt(e);
    const r = (this.width * 3) / this.viewport.scale; // eraser radius in world
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (hitStroke(s, p, r + s.width / 2)) {
        s.el.remove();
        this.strokes.splice(i, 1);
      }
    }
  }

  undo() {
    const s = this.strokes.pop();
    if (s) s.el.remove();
  }
  clear() {
    for (const s of this.strokes) s.el.remove();
    this.strokes = [];
  }

  // ---- persistence ----
  /** Plain-data snapshot of all strokes (world coordinates). */
  serialize() {
    return this.strokes.map((s) => ({
      type: s.type,
      color: s.color,
      width: s.width,
      points: s.points.map((p) => [+p.x.toFixed(2), +p.y.toFixed(2)]),
    }));
  }

  /** Recreate a stroke from saved data. */
  addStroke({ type, color, width, points }) {
    const pts = points.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
    const hl = type === "highlighter";
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", width);
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    if (hl) {
      path.setAttribute("stroke-opacity", "0.35");
      path.style.mixBlendMode = "multiply";
    }
    path.setAttribute("d", toPath(pts));
    this.svg.appendChild(path);
    this.strokes.push({ points: pts, el: path, type, color, width });
  }

  loadStrokes(list) {
    this.clear();
    for (const s of list) this.addStroke(s);
  }
}

// Build a smooth path (quadratic through midpoints) from world points.
function toPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q ${pts[i].x} ${pts[i].y} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function hitStroke(s, p, thresh) {
  const pts = s.points;
  if (pts.length === 1) return dist2(pts[0], p) <= thresh * thresh;
  for (let i = 0; i < pts.length - 1; i++) {
    if (segDist(p, pts[i], pts[i + 1]) <= thresh) return true;
  }
  return false;
}
function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
function segDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
