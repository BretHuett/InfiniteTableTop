# InfiniteTableTop

An infinite canvas for your PDFs. Open as many as you like and spread them across
an endless table — drag, rotate, overlap and zoom into them exactly like sheets of
paper in front of you.

![InfiniteTableTop](https://img.shields.io/badge/PDF-infinite%20canvas-4c8dff)

## Features

- **Infinite canvas** — pan by dragging empty space, zoom with the scroll wheel
  (or pinch on a trackpad). Zoom way out to see dozens of documents at once, or way
  in to read the fine print.
- **Open many PDFs at once** — pick multiple files or drag & drop them anywhere.
  New documents arrive arranged in a tidy grid.
- **Papers, not windows** — every PDF is a free sheet you can drag around, **rotate**
  (grab the ↻ handle below it), and **overlap** with others. Click a sheet to bring
  it to the front.
- **Adaptive detail** — pages re-render at higher resolution as you zoom in, so you
  get crisp text instead of a blurry blow-up.
- **Multi-page support** — flip through a document's pages right on its sheet, or
  **explode** a document into one separate, movable sheet per page (⧉ button).
- **Drawing tools** — a pen, highlighter and eraser (left palette) let you annotate
  on top of and *between* the documents. Ink lives on the table, so it pans, zooms
  and stays put with everything else. Pick a colour and thickness, undo, or clear.
- **Loading progress** — opening a batch of files shows a progress bar with the
  current filename and count, so large drawings don't feel like a hang.
- **Tidy & Fit** — one click to re-grid everything, another to frame the whole table.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed URL (usually <http://localhost:5173>) in your browser and click
**＋ Open PDFs**.

To build a static production bundle:

```bash
npm run build      # output in dist/
npm run preview    # serve the built bundle locally
```

## Controls

| Action | How |
| --- | --- |
| Pan | Drag empty space, or **middle-mouse drag** anywhere (even over a paper) |
| Zoom | Scroll wheel / trackpad pinch, or `+` / `-` |
| Move a paper | Drag it |
| Rotate a paper | Drag the ↻ handle (hold **Shift** to snap to 15°) |
| Bring to front | Click the paper |
| Flip pages | `‹` / `›` on the paper's toolbar |
| Explode into one sheet per page | ⧉ on the paper's toolbar |
| Reset a paper's rotation | ⊙ on the paper's toolbar |
| Close a paper | ✕ on the paper's toolbar, or select it and press **Delete** |
| Fit everything on screen | **Fit all** button, or `F` |
| Re-arrange into a grid | **Tidy** button |
| Reset zoom to 100% | **100%** button, or `0` |
| Move / select tool | left palette, or `V` |
| Pen / Highlighter / Eraser | left palette, or `P` / `H` / `E` |
| Undo last stroke | `Ctrl`/`Cmd` + `Z`, or the ↶ button |
| Clear all drawings | 🗑 button on the palette |

## How it works

Built with [Vite](https://vitejs.dev/) and [PDF.js](https://mozilla.github.io/pdf.js/).
A single transformed `#world` layer provides the pan/zoom; each PDF is rendered to its
own `<canvas>` positioned in world coordinates. Everything runs locally in your
browser — your PDFs are never uploaded anywhere.
