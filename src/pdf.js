// Central PDF.js setup. Keeps the worker wiring in one place.
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Load a PDF from a File / Blob into a pdf.js document.
 * @param {File|Blob} file
 * @returns {Promise<import("pdfjs-dist").PDFDocumentProxy>}
 */
export async function loadPdf(file) {
  const buffer = await file.arrayBuffer();
  const task = pdfjsLib.getDocument({ data: buffer });
  return task.promise;
}

export { pdfjsLib };
