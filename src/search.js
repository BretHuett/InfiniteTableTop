// Text search across the open papers.
//
// For each paper's current page we extract words with bounding boxes:
//   • PDF.js text layer when the page has real text (fast, exact), else
//   • OCR via Tesseract.js for scanned / image-only pages.
// Boxes are stored in the paper's local CSS coordinates (0..baseW, 0..baseH),
// so highlights can be drawn as children of the paper element and track its
// position, rotation and zoom for free.

import { pdfjsLib } from "./pdf.js";

const MIN_TEXTLAYER_CHARS = 16; // below this we treat the page as scanned → OCR
const OCR_TARGET_DPI = 200; // resolution to rasterize at for OCR (small text needs this)
const OCR_MAX_PX = 26e6; // cap the OCR bitmap area (big drawings render lower)
const OCR_MIN_CONFIDENCE = 30; // drop very low-confidence noise words

let _ocrWorker = null;
async function getOcrWorker(onStatus) {
  if (_ocrWorker) return _ocrWorker;
  // Lazy-load Tesseract only when a scanned page actually needs OCR.
  const { createWorker } = await import("tesseract.js");
  _ocrWorker = await createWorker("eng", undefined, {
    logger: (m) => {
      if (onStatus && m.status === "recognizing text") {
        onStatus(`${Math.round(m.progress * 100)}%`);
      }
    },
  });
  return _ocrWorker;
}

function wordsFromTextLayer(page) {
  const vp = page.getViewport({ scale: 1 });
  return page.getTextContent().then((tc) => {
    const words = [];
    for (const item of tc.items) {
      const str = (item.str || "").trim();
      if (!str) continue;
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      const h = Math.hypot(tx[2], tx[3]) || item.height || 10;
      const w = item.width || str.length * h * 0.5;
      words.push({ text: str, l: tx[4], t: tx[5] - h, w, h });
    }
    return words;
  });
}

// Pull word boxes (in canvas px) out of a Tesseract result and scale them into
// paper-local CSS px via `factor` (= baseW / canvasWidth).
function wordsFromOcr(result, factor) {
  const data = result.data || result;
  const out = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const ln of p.lines || []) {
        for (const w of ln.words || []) {
          const text = (w.text || "").trim();
          if (!text || !w.bbox) continue;
          if ((w.confidence ?? 100) < OCR_MIN_CONFIDENCE) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          out.push({
            text,
            l: x0 * factor,
            t: y0 * factor,
            w: (x1 - x0) * factor,
            h: (y1 - y0) * factor,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Render a fresh, high-resolution bitmap of the page and OCR it. Decoupled from
 * the display canvas so OCR always gets a clean, well-sized image. May throw if
 * the OCR worker can't be loaded.
 */
async function ocrPage(paper, onStatus) {
  const page = paper._page;
  if (!page) return [];
  const v1 = page.getViewport({ scale: 1 });
  // Aim for ~200 DPI (cap at 4× so small pages don't go absurd), but back off
  // to keep the bitmap within OCR_MAX_PX — a big A1/A0 drawing renders lower.
  let scale = Math.min(OCR_TARGET_DPI / 72, 4);
  if (v1.width * scale * (v1.height * scale) > OCR_MAX_PX) {
    scale = Math.sqrt(OCR_MAX_PX / (v1.width * v1.height));
  }
  scale = Math.max(scale, 1);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff"; // flatten transparency to white for cleaner OCR
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  const worker = await getOcrWorker(onStatus);
  const result = await worker.recognize(canvas, {}, { blocks: true });
  return wordsFromOcr(result, paper.baseW / canvas.width);
}

export class SearchController {
  constructor(app) {
    this.app = app;
    this.query = "";
    this.matches = []; // flat list: { paper, box }
    this.active = -1;
    this.onUpdate = null; // (status) => void
  }

  /** Build/refresh the word index for every paper (text instant, OCR slower). */
  async index(onStatus) {
    this.ocrError = false;
    this.ocrRan = false;
    const needOcr = []; // { paper, textWords }

    // First pass: text layers only (fast). A page only counts as a real text
    // document if its text is dense enough for its size — a 45-char footer on a
    // big scanned drawing must still go through OCR. Otherwise we OCR the page
    // and merge in whatever little text layer it had.
    for (const p of this.app.papers) {
      if (p._searchPage === p.pageNum && p._searchWords) continue;
      let words = [];
      try {
        if (p._page) words = await wordsFromTextLayer(p._page);
      } catch (err) {
        console.error("Text-layer extraction failed:", err);
      }
      const chars = words.reduce((n, w) => n + w.text.length, 0);
      const areaMP = p.baseW && p.baseH ? (p.baseW * p.baseH) / 1e6 : 0.5;
      const threshold = Math.max(MIN_TEXTLAYER_CHARS, 200, areaMP * 60);
      if (chars >= threshold) {
        p._searchWords = words;
        p._searchPage = p.pageNum;
        p._searchSource = "text";
      } else {
        needOcr.push({ paper: p, textWords: words });
      }
    }

    // Second pass: OCR the scanned/sparse pages, reporting progress.
    for (let i = 0; i < needOcr.length; i++) {
      const { paper: p, textWords } = needOcr[i];
      const label = `OCR ${i + 1}/${needOcr.length}`;
      onStatus?.(`${label}…`);
      try {
        const ocr = await ocrPage(p, (s) => onStatus?.(`${label} — reading ${s}`));
        p._searchWords = [...textWords, ...ocr]; // merge embedded text + OCR
        p._searchSource = ocr.length ? "ocr" : textWords.length ? "text" : "none";
        if (ocr.length) this.ocrRan = true;
      } catch (err) {
        console.error(`OCR failed for ${p.name}:`, err);
        this.ocrError = true;
        p._searchWords = textWords;
        p._searchSource = textWords.length ? "text" : "none";
      }
      p._searchPage = p.pageNum;
      this.onUpdate?.(); // surface results as each page finishes
    }
  }

  /** Run the current query against the index; returns per-paper results. */
  run(query) {
    this.query = query;
    const q = query.trim().toLowerCase();
    this.matches = [];
    const results = [];
    if (!q) {
      for (const p of this.app.papers) p.clearHighlights?.();
      this.active = -1;
      return results;
    }
    const tokens = q.split(/\s+/).filter((t) => t.length > 1);
    for (const p of this.app.papers) {
      const words = p._searchWords || [];
      const boxes = [];
      for (const w of words) {
        const t = w.text.toLowerCase();
        if (t.includes(q) || (tokens.length > 1 && tokens.some((tok) => t.includes(tok)))) {
          boxes.push(w);
        }
      }
      if (boxes.length) {
        const startIndex = this.matches.length;
        for (const b of boxes) this.matches.push({ paper: p, box: b });
        results.push({ paper: p, count: boxes.length, startIndex });
        p.setHighlights?.(boxes);
      } else {
        p.clearHighlights?.();
      }
    }
    this.active = this.matches.length ? 0 : -1;
    this._markActive();
    return results;
  }

  clear() {
    this.query = "";
    this.matches = [];
    this.active = -1;
    for (const p of this.app.papers) p.clearHighlights?.();
  }

  _markActive() {
    const m = this.matches[this.active];
    for (const p of this.app.papers) {
      if (p.setActiveHighlight) p.setActiveHighlight(m && m.paper === p ? m.box : null);
    }
  }

  /** Focus a match: frame its paper and emphasise the box. */
  focus(index, viewport) {
    if (!this.matches.length) return null;
    this.active = ((index % this.matches.length) + this.matches.length) % this.matches.length;
    const m = this.matches[this.active];
    this._markActive();
    viewport.fitBounds(m.paper.bounds(), 140);
    return m;
  }
  next(viewport) {
    return this.focus(this.active + 1, viewport);
  }
  prev(viewport) {
    return this.focus(this.active - 1, viewport);
  }
}
