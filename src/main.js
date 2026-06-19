import "./style.css";
import { Viewport } from "./viewport.js";
import { Paper } from "./paper.js";
import { loadPdf } from "./pdf.js";
import { DrawController } from "./draw.js";

const GAP = 64; // world px between papers in a grid

const canvasEl = document.getElementById("canvas");
const worldEl = document.getElementById("world");
const fileInput = document.getElementById("file-input");
const emptyState = document.getElementById("empty-state");
const zoomReadout = document.getElementById("zoom-readout");
const progressEl = document.getElementById("progress");
const progressLabel = document.getElementById("progress-label");
const progressCount = document.getElementById("progress-count");
const progressFill = document.getElementById("progress-fill");
const selectBox = document.getElementById("select-box");
const selectionBar = document.getElementById("selection-bar");
const selCount = document.getElementById("sel-count");
const groupBtn = selectionBar.querySelector('[data-act="group"]');
const ungroupBtn = selectionBar.querySelector('[data-act="ungroup"]');
const hideBtn = selectionBar.querySelector('[data-act="hide"]');

const viewport = new Viewport(canvasEl, worldEl);
const draw = new DrawController({ canvas: canvasEl, world: worldEl, viewport });

// ---- opening progress bar ----
function showProgress(label, count, frac) {
  progressLabel.textContent = label;
  progressCount.textContent = count;
  progressFill.style.width = `${Math.round(frac * 100)}%`;
  progressEl.classList.remove("hidden");
}
function hideProgress() {
  progressEl.classList.add("hidden");
}
// Yield to the browser so the bar actually paints between heavy renders.
const paintTick = () => new Promise((r) => requestAnimationFrame(() => r()));

const app = {
  papers: [],
  topZ: 1,
  mode: "move",
  selection: new Set(),
  groups: [],
  _gid: 0,
  _colorIdx: 0,
  _groupColors: ["#e23b3b", "#2f7bf6", "#23a559", "#f5a623", "#a855f7", "#ec4899", "#14b8a6"],

  bringToFront(paper) {
    paper.el.style.zIndex = String(++this.topZ);
  },

  // ---------- selection ----------
  isSelected(p) {
    return this.selection.has(p);
  },
  clearSelection() {
    this.selection.clear();
    this.refresh();
  },
  selectOnly(p) {
    this.selection.clear();
    if (p) this.selection.add(p);
    this._normalize();
    this.refresh();
  },
  toggleSelect(p) {
    // Groups select/deselect as a unit.
    const members = p.group ? [...p.group.papers] : [p];
    const turnOn = !this.selection.has(p);
    for (const m of members) {
      if (turnOn) this.selection.add(m);
      else this.selection.delete(m);
    }
    this.refresh();
  },
  addToSelection(papers) {
    for (const p of papers) this.selection.add(p);
    this._normalize();
    this.refresh();
  },
  _normalize() {
    // Selecting any member of a group pulls in the whole group.
    for (const p of [...this.selection]) {
      if (p.group) for (const m of p.group.papers) this.selection.add(m);
    }
  },
  /** Every paper that should move when `paper` is dragged. */
  moveSetFor(paper) {
    const base = this.selection.has(paper) ? [...this.selection] : [paper];
    const set = new Set();
    for (const p of base) {
      set.add(p);
      if (p.group) for (const m of p.group.papers) set.add(m);
    }
    return [...set];
  },
  beginDrag(paper) {
    if (!this.selection.has(paper)) this.selectOnly(paper);
    const ms = this.moveSetFor(paper);
    for (const p of ms) p.el.style.zIndex = String(++this.topZ);
    return ms;
  },

  removePaper(paper) {
    const i = this.papers.indexOf(paper);
    if (i >= 0) this.papers.splice(i, 1);
    this.selection.delete(paper);
    if (paper.group) this._removeFromGroup(paper);
    paper.destroy();
    if (this.papers.length === 0) emptyState.classList.remove("hidden");
    this.refresh();
  },

  deleteSelection() {
    const victims = new Set();
    for (const p of this.selection) {
      victims.add(p);
      if (p.group) for (const m of p.group.papers) victims.add(m);
    }
    for (const p of victims) this.removePaper(p);
  },

  // ---------- groups ----------
  _nextColor() {
    return this._groupColors[this._colorIdx++ % this._groupColors.length];
  },
  group() {
    const papers = [...this.selection];
    if (papers.length < 2) return;
    const old = new Set(papers.map((p) => p.group).filter(Boolean));
    const g = {
      id: ++this._gid,
      papers: new Set(papers),
      hidden: false,
      color: this._nextColor(),
      chip: null,
    };
    for (const p of papers) {
      if (p.group) p.group.papers.delete(p);
      p.group = g;
      p.el.classList.add("grouped");
      p.el.style.setProperty("--group-color", g.color);
    }
    // Tidy up groups the members left behind.
    for (const og of old) {
      if (og.papers.size < 2) this._dissolveGroup(og);
      else this._updateChip(og);
    }
    this.groups.push(g);
    this.refresh();
  },
  ungroupSelection() {
    const gs = new Set();
    for (const p of this.selection) if (p.group) gs.add(p.group);
    for (const g of gs) this._dissolveGroup(g);
    this.refresh();
  },
  hideSelection() {
    const gs = new Set();
    for (const p of this.selection) if (p.group) gs.add(p.group);
    for (const g of gs) this._hideGroup(g);
    this.clearSelection();
  },
  _removeFromGroup(paper) {
    const g = paper.group;
    if (!g) return;
    g.papers.delete(paper);
    paper.group = null;
    paper.el.classList.remove("grouped");
    if (g.papers.size < 2) this._dissolveGroup(g);
    else this._updateChip(g);
  },
  _dissolveGroup(g) {
    for (const m of g.papers) {
      m.group = null;
      m.el.classList.remove("grouped");
      m.el.style.display = "";
    }
    g.papers.clear();
    if (g.chip) {
      g.chip.remove();
      g.chip = null;
    }
    const gi = this.groups.indexOf(g);
    if (gi >= 0) this.groups.splice(gi, 1);
  },
  _hideGroup(g) {
    g.hidden = true;
    for (const m of g.papers) {
      m.el.style.display = "none";
      this.selection.delete(m);
    }
    this._updateChip(g);
  },
  _showGroup(g) {
    g.hidden = false;
    for (const m of g.papers) m.el.style.display = "";
    this._updateChip(g);
  },
  _updateChip(g) {
    if (!g.hidden) {
      if (g.chip) {
        g.chip.remove();
        g.chip = null;
      }
      return;
    }
    const b = unionBounds([...g.papers]);
    if (!g.chip) {
      const chip = document.createElement("div");
      chip.className = "group-chip";
      chip.innerHTML = `<span class="gdot"></span><span class="gname"></span><span class="gshow">show</span>`;
      chip.addEventListener("pointerdown", (e) => e.stopPropagation());
      chip.addEventListener("click", () => {
        this._showGroup(g);
        this.refresh();
      });
      worldEl.appendChild(chip);
      g.chip = chip;
    }
    g.chip.style.setProperty("--group-color", g.color);
    g.chip.querySelector(".gname").textContent = `Group · ${g.papers.size}`;
    g.chip.style.left = `${b.x + b.w / 2}px`;
    g.chip.style.top = `${b.y + b.h / 2}px`;
    g.chip.style.setProperty("--k", 1 / viewport.scale);
  },

  // ---------- ui ----------
  refresh() {
    for (const p of this.papers) p.el.classList.toggle("selected", this.selection.has(p));
    const n = this.selection.size;
    if (n === 0) {
      selectionBar.classList.add("hidden");
      return;
    }
    selectionBar.classList.remove("hidden");
    selCount.textContent = `${n} selected`;
    const sel = [...this.selection];
    const hasGroup = sel.some((p) => p.group);
    const groupsInSel = new Set(sel.map((p) => p.group));
    const oneWholeGroup =
      groupsInSel.size === 1 && sel[0].group && sel[0].group.papers.size === n;
    // No point offering "Group" when the selection is already exactly one group.
    groupBtn.style.display = n >= 2 && !oneWholeGroup ? "" : "none";
    ungroupBtn.style.display = hasGroup ? "" : "none";
    hideBtn.style.display = hasGroup ? "" : "none";
  },

  /** Open a list/array of File objects (PDFs). */
  async openFiles(files) {
    const pdfs = Array.from(files).filter(
      (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)
    );
    if (pdfs.length === 0) return;
    emptyState.classList.add("hidden");

    const total = pdfs.length;
    const batch = [];
    showProgress("Opening files…", `0 / ${total}`, 0);
    await paintTick();

    for (let i = 0; i < pdfs.length; i++) {
      const file = pdfs[i];
      showProgress(`Opening ${file.name}`, `${i + 1} / ${total}`, i / total);
      await paintTick();

      // Loading the document is the real "is this a valid PDF?" gate.
      let doc;
      try {
        doc = await loadPdf(file);
      } catch (err) {
        console.error(`Could not open ${file.name}:`, err);
        alert(`Could not open "${file.name}".\n\n${err?.message || err}`);
        continue;
      }
      // From here the file is valid; a rendering hiccup must not throw it away.
      const paper = new Paper(doc, file.name.replace(/\.pdf$/i, ""), {
        world: worldEl,
        viewport,
        app,
      });
      try {
        await paper.init();
      } catch (err) {
        console.error(`Problem rendering ${file.name}:`, err);
      }
      paper.el.style.zIndex = String(++this.topZ);
      this.papers.push(paper);
      batch.push(paper);
      showProgress(`Opening ${file.name}`, `${i + 1} / ${total}`, (i + 1) / total);
    }

    hideProgress();
    if (batch.length === 0) {
      if (this.papers.length === 0) emptyState.classList.remove("hidden");
      return;
    }

    this._placeBatch(batch);
    batch.forEach((p) => p.updateChrome(viewport.scale));
    this.fitAll();
  },

  /** Lay newly opened papers out in a tidy grid, in a free area. */
  _placeBatch(batch) {
    const others = this.papers.filter((p) => !batch.includes(p));
    let originX, originY;
    if (others.length) {
      const b = unionBounds(others);
      originX = b.x + b.w + GAP; // sit to the right of existing content
      originY = b.y;
    } else {
      const c = viewport.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
      const { w, h } = gridSize(batch);
      originX = c.x - w / 2;
      originY = c.y - h / 2;
    }
    layoutGrid(batch, originX, originY);
  },

  /** Split a multi-page paper into one separate sheet per page. */
  async explodePaper(paper) {
    if (paper.singlePage || paper.numPages <= 1) return;
    const { doc, name, numPages } = paper;
    const originX = paper.x;
    const originY = paper.y;

    const children = [];
    for (let i = 1; i <= numPages; i++) {
      const child = new Paper(doc, name, {
        world: worldEl,
        viewport,
        app,
        page: i,
        singlePage: true,
      });
      await child.init();
      child.el.style.zIndex = String(++this.topZ);
      this.papers.push(child);
      children.push(child);
    }

    // Remove the original sheet (its doc stays alive via refcount for the pages).
    const idx = this.papers.indexOf(paper);
    if (idx >= 0) this.papers.splice(idx, 1);
    this.selection.delete(paper);
    if (paper.group) this._removeFromGroup(paper);
    paper.destroy();

    layoutGrid(children, originX, originY);
    children.forEach((c) => c.updateChrome(viewport.scale));
    this.fitAll();
  },

  /** Re-arrange ALL papers into a neat centred grid. */
  tidy() {
    if (this.papers.length === 0) return;
    const { w, h } = gridSize(this.papers);
    const c = viewport.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    layoutGrid(this.papers, c.x - w / 2, c.y - h / 2);
    this.papers.forEach((p) => (p.rotation = 0));
    this.papers.forEach((p) => p._applyTransform());
    for (const g of this.groups) if (g.hidden) this._updateChip(g);
    this.fitAll();
  },

  fitAll() {
    if (this.papers.length === 0) return;
    viewport.fitBounds(unionBounds(this.papers));
  },
};

// ---- grid helpers ----
function gridDims(n) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}
function cellSize(list) {
  let w = 0;
  let h = 0;
  for (const p of list) {
    w = Math.max(w, p.baseW);
    h = Math.max(h, p.baseH);
  }
  return { cw: w + GAP, ch: h + GAP };
}
function gridSize(list) {
  const { cols, rows } = gridDims(list.length);
  const { cw, ch } = cellSize(list);
  return { w: cols * cw - GAP, h: rows * ch - GAP };
}
function layoutGrid(list, originX, originY) {
  const { cols } = gridDims(list.length);
  const { cw, ch } = cellSize(list);
  list.forEach((p, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // centre each sheet within its (uniform) cell
    const x = originX + col * cw + (cw - GAP - p.baseW) / 2;
    const y = originY + row * ch + (ch - GAP - p.baseH) / 2;
    p.rotation = 0;
    p.setPosition(x, y);
  });
}
function unionBounds(list) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of list) {
    const b = p.bounds();
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---- viewport reactions: zoom readout, chrome scaling, adaptive detail ----
let improveTimer = null;
viewport.onChange((vp) => {
  zoomReadout.textContent = `${Math.round(vp.scale * 100)}%`;
  for (const p of app.papers) p.updateChrome(vp.scale);
  for (const g of app.groups) if (g.chip) g.chip.style.setProperty("--k", 1 / vp.scale);
  clearTimeout(improveTimer);
  improveTimer = setTimeout(() => {
    for (const p of app.papers) p.maybeImprove(vp.scale);
  }, 160);
});

// ---- toolbar / file wiring ----
function pick() {
  fileInput.value = "";
  fileInput.click();
}
document.getElementById("open-btn").addEventListener("click", pick);
document.getElementById("empty-open-btn").addEventListener("click", pick);
document.getElementById("tidy-btn").addEventListener("click", () => app.tidy());
document.getElementById("fit-btn").addEventListener("click", () => app.fitAll());
document.getElementById("reset-btn").addEventListener("click", () => viewport.reset());
fileInput.addEventListener("change", (e) => app.openFiles(e.target.files));

// ---- empty-canvas clicks: deselect, or Shift+drag a rubber-band box ----
let box = null; // { sx, sy } screen-space start, while dragging a selection box
canvasEl.addEventListener("pointerdown", (e) => {
  if (app.mode !== "move" || e.button !== 0) return;
  if (e.target !== canvasEl && e.target !== worldEl) return;
  if (e.shiftKey) {
    box = { sx: e.clientX, sy: e.clientY };
    drawSelectBox(e.clientX, e.clientY);
    selectBox.style.display = "block";
    try {
      canvasEl.setPointerCapture(e.pointerId);
    } catch {}
    e.stopPropagation();
  } else {
    app.clearSelection();
  }
});
canvasEl.addEventListener("pointermove", (e) => {
  if (box) drawSelectBox(e.clientX, e.clientY);
});
canvasEl.addEventListener("pointerup", (e) => {
  if (!box) return;
  const r = boxRect(box.sx, box.sy, e.clientX, e.clientY);
  selectBox.style.display = "none";
  const hits = app.papers.filter(
    (p) => p.el.style.display !== "none" && rectsOverlap(p.el.getBoundingClientRect(), r)
  );
  app.addToSelection(hits);
  box = null;
  try {
    canvasEl.releasePointerCapture(e.pointerId);
  } catch {}
});
function boxRect(x0, y0, x1, y1) {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
}
function drawSelectBox(x, y) {
  const r = boxRect(box.sx, box.sy, x, y);
  selectBox.style.left = `${r.left}px`;
  selectBox.style.top = `${r.top}px`;
  selectBox.style.width = `${r.right - r.left}px`;
  selectBox.style.height = `${r.bottom - r.top}px`;
}
function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// ---- selection action bar ----
groupBtn.addEventListener("click", () => app.group());
ungroupBtn.addEventListener("click", () => app.ungroupSelection());
hideBtn.addEventListener("click", () => app.hideSelection());
selectionBar
  .querySelector('[data-act="delete"]')
  .addEventListener("click", () => app.deleteSelection());

// ---- drawing tools ----
const toolBtns = document.querySelectorAll("#draw-tools .tool[data-tool]");
const swatchBtns = document.querySelectorAll("#draw-tools .swatch");
const widthBtns = document.querySelectorAll("#draw-tools .wbtn");

function setMode(mode) {
  app.mode = mode;
  draw.setMode(mode);
  viewport.allowLeftPan = mode === "move"; // middle-drag always pans
  document.body.classList.toggle("draw-mode", mode !== "move");
  toolBtns.forEach((b) => b.classList.toggle("active", b.dataset.tool === mode));
  if (mode !== "move") app.clearSelection();
}

toolBtns.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.tool)));
swatchBtns.forEach((btn) =>
  btn.addEventListener("click", () => {
    draw.color = btn.dataset.color;
    swatchBtns.forEach((s) => s.classList.toggle("active", s === btn));
    if (draw.mode !== "pen" && draw.mode !== "highlighter") setMode("pen");
  })
);
widthBtns.forEach((btn) =>
  btn.addEventListener("click", () => {
    draw.width = Number(btn.dataset.width);
    widthBtns.forEach((s) => s.classList.toggle("active", s === btn));
  })
);
document.querySelector('#draw-tools [data-act="undo"]').addEventListener("click", () => draw.undo());
document.querySelector('#draw-tools [data-act="clear"]').addEventListener("click", () => draw.clear());

// ---- drag & drop ----
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("drag-over");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) document.body.classList.remove("drag-over");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("drag-over");
  if (e.dataTransfer?.files?.length) app.openFiles(e.dataTransfer.files);
});

// ---- keyboard shortcuts ----
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    draw.undo();
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
    if (e.shiftKey) app.ungroupSelection();
    else app.group();
    e.preventDefault();
    return;
  }
  switch (e.key) {
    case "v":
    case "V":
      setMode("move");
      break;
    case "p":
    case "P":
      setMode("pen");
      break;
    case "h":
    case "H":
      setMode("highlighter");
      break;
    case "e":
    case "E":
      setMode("eraser");
      break;
    case "f":
    case "F":
      app.fitAll();
      break;
    case "0":
      viewport.reset();
      break;
    case "=":
    case "+":
      viewport.zoomBy(1.2);
      break;
    case "-":
    case "_":
      viewport.zoomBy(1 / 1.2);
      break;
    case "Escape":
      setMode("move");
      app.clearSelection();
      break;
    case "Delete":
    case "Backspace":
      if (app.selection.size) app.deleteSelection();
      break;
  }
});

// expose for debugging
window.__tabletop = app;
window.__draw = draw;
window.__setMode = setMode;
