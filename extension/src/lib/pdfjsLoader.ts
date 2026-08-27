import type { PdfjsLike } from '@mapply/core/pdfText';

/**
 * Loads pdf.js for the side panel, pointing it at the worker Vite emits.
 *
 * The `?url` suffix is a Vite idiom and only compiles inside this package, which
 * is why the loader lives here rather than in core. Imported on demand because
 * pdf.js is far bigger than the rest of the side panel.
 */
export async function loadPdfjs(): Promise<PdfjsLike> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs as unknown as PdfjsLike;
}
