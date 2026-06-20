import "./style.css";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { Viewport } from "./viewport.js";
import { Paper } from "./paper.js";
import { loadPdf } from "./pdf.js";
import { DrawController } from "./draw.js";

const WORKSPACE_VERSION = 1;

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
  sources: new Map(), // id -> { id, name, bytes, doc } — kept so workspaces can be saved
  _sid: 0,
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

  /** Register PDF bytes as a reusable source and load its pdf.js document. */
  async _addSource(name, bytes, id = null) {
    const sid = id || `doc${this._sid++}`;
    const doc = await loadPdf(bytes.slice()); // give pdf.js its own copy; keep ours
    const src = { id: sid, name, bytes, doc };
    this.sources.set(sid, src);
    return src;
  },

  removePaper(paper) {
    const i = this.papers.indexOf(paper);
    if (i >= 0) this.papers.splice(i, 1);
    this.selection.delete(paper);
    if (paper.group) this._removeFromGroup(paper);
    paper.destroy();
    // Drop the source once no sheet uses it anymore.
    if (paper.sourceId && !this.papers.some((p) => p.sourceId === paper.sourceId)) {
      this.sources.delete(paper.sourceId);
    }
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
      let source;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        source = await this._addSource(file.name, bytes);
      } catch (err) {
        console.error(`Could not open ${file.name}:`, err);
        alert(`Could not open "${file.name}".\n\n${err?.message || err}`);
        continue;
      }
      // From here the file is valid; a rendering hiccup must not throw it away.
      const paper = new Paper(source.doc, file.name.replace(/\.pdf$/i, ""), {
        world: worldEl,
        viewport,
        app,
        sourceId: source.id,
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
    const { doc, name, numPages, sourceId } = paper;
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
        sourceId,
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

  // ---------- workspace save / load ----------
  /** Bundle the PDFs + layout + drawings into a .ittt (zip) file and download it. */
  saveWorkspace() {
    if (this.papers.length === 0) {
      alert("Nothing to save yet — open some PDFs first.");
      return;
    }
    // Stable per-paper ids so groups can reference members.
    const ids = new Map();
    this.papers.forEach((p, i) => ids.set(p, i));

    const usedSources = new Set(this.papers.map((p) => p.sourceId).filter(Boolean));
    const manifest = {
      version: WORKSPACE_VERSION,
      savedAt: new Date().toISOString(),
      viewport: { scale: viewport.scale, panX: viewport.panX, panY: viewport.panY },
      sources: [...usedSources].map((sid) => ({
        id: sid,
        name: this.sources.get(sid)?.name || `${sid}.pdf`,
        file: `pdfs/${sid}.pdf`,
      })),
      papers: this.papers.map((p) => ({
        id: ids.get(p),
        sourceId: p.sourceId,
        name: p.name,
        page: p.pageNum,
        singlePage: p.singlePage,
        x: p.x,
        y: p.y,
        rotation: p.rotation,
        z: parseInt(p.el.style.zIndex, 10) || 1,
      })),
      groups: this.groups.map((g) => ({
        members: [...g.papers].map((p) => ids.get(p)),
        color: g.color,
        hidden: g.hidden,
      })),
      strokes: draw.serialize(),
    };

    const files = { "manifest.json": strToU8(JSON.stringify(manifest)) };
    for (const sid of usedSources) {
      const src = this.sources.get(sid);
      if (src) files[`pdfs/${sid}.pdf`] = src.bytes;
    }
    // level 0: PDFs are already compressed, so just store (fast, no bloat).
    const zipped = zipSync(files, { level: 0 });
    const blob = new Blob([zipped], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tabletop-${stamp()}.ittt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },

  async loadWorkspace(file) {
    let manifest, entries;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      entries = unzipSync(bytes);
      manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    } catch (err) {
      console.error("Could not read workspace:", err);
      alert(`Could not open this workspace file.\n\n${err?.message || err}`);
      return;
    }
    if (this.papers.length && !confirm("Replace the current table with this workspace?")) {
      return;
    }

    // Clear everything currently on the table.
    [...this.papers].forEach((p) => this.removePaper(p));
    draw.clear();
    this.sources.clear();

    const total = manifest.papers.length;
    showProgress("Opening workspace…", `0 / ${total}`, 0);
    await paintTick();

    // Recreate sources (one pdf.js doc per embedded PDF).
    const srcById = new Map();
    for (const s of manifest.sources || []) {
      const bytes = entries[s.file];
      if (!bytes) continue;
      try {
        const src = await this._addSource(s.name, bytes, s.id);
        srcById.set(s.id, src);
      } catch (err) {
        console.error(`Workspace source ${s.id} failed to load:`, err);
      }
    }

    // Recreate papers in saved order; remember by saved id for grouping.
    const byId = new Map();
    let maxZ = 1;
    for (let i = 0; i < manifest.papers.length; i++) {
      const d = manifest.papers[i];
      const src = srcById.get(d.sourceId);
      if (!src) continue;
      showProgress(`Restoring ${d.name}`, `${i + 1} / ${total}`, i / total);
      await paintTick();
      const paper = new Paper(src.doc, d.name, {
        world: worldEl,
        viewport,
        app,
        page: d.page,
        singlePage: d.singlePage,
        sourceId: d.sourceId,
      });
      try {
        await paper.init();
      } catch (err) {
        console.error(`Problem rendering ${d.name}:`, err);
      }
      paper.x = d.x;
      paper.y = d.y;
      paper.rotation = d.rotation;
      paper._applyTransform();
      paper.el.style.zIndex = String(d.z);
      maxZ = Math.max(maxZ, d.z);
      this.papers.push(paper);
      byId.set(d.id, paper);
      showProgress(`Restoring ${d.name}`, `${i + 1} / ${total}`, (i + 1) / total);
    }
    this.topZ = maxZ;

    // Recreate groups.
    for (const g of manifest.groups || []) {
      const members = g.members.map((id) => byId.get(id)).filter(Boolean);
      if (members.length < 2) continue;
      this._rebuildGroup(members, g.color, g.hidden);
    }

    // Recreate drawings.
    if (manifest.strokes) draw.loadStrokes(manifest.strokes);

    hideProgress();
    if (this.papers.length === 0) {
      emptyState.classList.remove("hidden");
      return;
    }
    emptyState.classList.add("hidden");
    this.papers.forEach((p) => p.updateChrome(viewport.scale));
    if (manifest.viewport) {
      viewport.setTransform(manifest.viewport.scale, manifest.viewport.panX, manifest.viewport.panY);
    } else {
      this.fitAll();
    }
  },

  _rebuildGroup(members, color, hidden) {
    const g = { id: ++this._gid, papers: new Set(members), hidden: false, color, chip: null };
    for (const p of members) {
      p.group = g;
      p.el.classList.add("grouped");
      p.el.style.setProperty("--group-color", color);
    }
    this.groups.push(g);
    if (hidden) this._hideGroup(g);
    // keep colour cycling roughly in step so new groups don't immediately clash
    this._colorIdx++;
  },
};

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

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

// ---- workspace save / open ----
const workspaceInput = document.getElementById("workspace-input");
document.getElementById("save-ws-btn").addEventListener("click", () => app.saveWorkspace());
document.getElementById("open-ws-btn").addEventListener("click", () => {
  workspaceInput.value = "";
  workspaceInput.click();
});
workspaceInput.addEventListener("change", (e) => {
  if (e.target.files?.[0]) app.loadWorkspace(e.target.files[0]);
});

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
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  const ws = [...files].find((f) => /\.(ittt|zip)$/i.test(f.name));
  if (ws) app.loadWorkspace(ws);
  else app.openFiles(files);
});

// ---- keyboard shortcuts ----
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    app.saveWorkspace();
    e.preventDefault();
    return;
  }
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
