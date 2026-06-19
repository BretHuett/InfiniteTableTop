import "./style.css";
import { Viewport } from "./viewport.js";
import { Paper } from "./paper.js";
import { loadPdf } from "./pdf.js";

const GAP = 64; // world px between papers in a grid

const canvasEl = document.getElementById("canvas");
const worldEl = document.getElementById("world");
const fileInput = document.getElementById("file-input");
const emptyState = document.getElementById("empty-state");
const zoomReadout = document.getElementById("zoom-readout");

const viewport = new Viewport(canvasEl, worldEl);

const app = {
  papers: [],
  topZ: 1,
  active: null,

  bringToFront(paper) {
    paper.el.style.zIndex = String(++this.topZ);
  },

  setActive(paper) {
    if (this.active && this.active !== paper) this.active.el.classList.remove("active");
    this.active = paper;
    if (paper) paper.el.classList.add("active");
  },

  removePaper(paper) {
    const i = this.papers.indexOf(paper);
    if (i >= 0) this.papers.splice(i, 1);
    if (this.active === paper) this.active = null;
    paper.destroy();
    if (this.papers.length === 0) emptyState.classList.remove("hidden");
  },

  /** Open a list/array of File objects (PDFs). */
  async openFiles(files) {
    const pdfs = Array.from(files).filter(
      (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)
    );
    if (pdfs.length === 0) return;
    emptyState.classList.add("hidden");

    const batch = [];
    for (const file of pdfs) {
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
    }
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
    if (this.active === paper) this.active = null;
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

// deselect when clicking empty canvas
canvasEl.addEventListener("pointerdown", (e) => {
  if (e.target === canvasEl || e.target === worldEl) app.setActive(null);
});

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
  switch (e.key) {
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
      app.setActive(null);
      break;
    case "Delete":
    case "Backspace":
      if (app.active) app.removePaper(app.active);
      break;
  }
});

// expose for debugging
window.__tabletop = app;
