/**
 * Same-origin worker for the pinned pdfjs-dist build.
 * Vite copies `pdf.worker.min.mjs` into `dist/pdfjs/` and the dev server
 * exposes that path, so the browser never loads the worker from a CDN.
 */
export function pdfWorkerUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}pdfjs/pdf.worker.min.mjs`;
}
