// Central PDF.js setup. Keeps the worker wiring in one place.
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Load a PDF into a pdf.js document.
 * Accepts a File/Blob, an ArrayBuffer, or a Uint8Array of the PDF bytes.
 * Note: pdf.js may transfer the buffer to its worker, so pass a copy if you
 * need to keep the original bytes (see the workspace save path).
 * @param {File|Blob|ArrayBuffer|Uint8Array} src
 * @returns {Promise<import("pdfjs-dist").PDFDocumentProxy>}
 */
export async function loadPdf(src) {
  let data;
  if (src instanceof Uint8Array) data = src;
  else if (src instanceof ArrayBuffer) data = new Uint8Array(src);
  else data = new Uint8Array(await src.arrayBuffer()); // File / Blob
  const task = pdfjsLib.getDocument({ data });
  return task.promise;
}

export { pdfjsLib };
