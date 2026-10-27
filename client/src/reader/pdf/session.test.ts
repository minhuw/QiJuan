// @vitest-environment node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { imageOnlyPdf, outlineTextPdf, plainTextPdf } from './fixtures';
import { mapOutline } from './outline';
import { hasSearchableText, runsFromTextItems, searchRuns } from './search';
import { nearbyPages } from './thumbs';

beforeAll(() => {
  const require = createRequire(import.meta.url);
  GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')).href;
});

async function openPdf(data: Uint8Array) {
  const task = getDocument({
    data,
    verbosity: 0,
    useWasm: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  return {
    doc,
    async close() {
      await task.destroy();
    },
  };
}

async function pageRuns(doc: PDFDocumentProxy) {
  const pages = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const pdfPage = await doc.getPage(page);
    const text = await pdfPage.getTextContent();
    pages.push({ page, runs: runsFromTextItems(text.items) });
  }
  return pages;
}

describe('pdf text layer', () => {
  it('states that the image-only fixture has no searchable text', async () => {
    const opened = await openPdf(imageOnlyPdf());
    const outline = await mapOutline(await opened.doc.getOutline(), opened.doc);
    const pages = await pageRuns(opened.doc);
    expect(outline).toEqual([]);
    expect(pages.some((page) => hasSearchableText(page.runs))).toBe(false);
    expect(searchRuns(pages, 'Hello')).toEqual([]);
    expect(searchRuns(pages, 'scan')).toEqual([]);
    await opened.close();
  });

  it('searches a text layer and keeps an outline when the file has one', async () => {
    const opened = await openPdf(outlineTextPdf());
    const outline = await mapOutline(await opened.doc.getOutline(), opened.doc);
    const pages = await pageRuns(opened.doc);
    expect(outline).toEqual([
      expect.objectContaining({ title: 'Chapter One', page: 1, x: 10, y: 350, children: [] }),
    ]);
    expect(pages.some((page) => hasSearchableText(page.runs))).toBe(true);
    const hits = searchRuns(pages, 'QiJuan');
    expect(hits).toEqual([expect.objectContaining({ page: 1, excerpt: expect.stringContaining('QiJuan') })]);
    expect(String(hits[0]?.x).endsWith('%')).toBe(false);
    expect(searchRuns(pages, 'missing-word')).toEqual([]);
    await opened.close();
  });

  it('omits a missing outline without throwing', async () => {
    const opened = await openPdf(plainTextPdf());
    expect(await opened.doc.getOutline()).toBeNull();
    expect(await mapOutline(await opened.doc.getOutline(), opened.doc)).toEqual([]);
    const pages = await pageRuns(opened.doc);
    expect(hasSearchableText(pages[0]?.runs ?? [])).toBe(true);
    await opened.close();
  });

  it('keeps thumbnail draws to pages near the current one', () => {
    const pages = Array.from({ length: 40 }, (_, index) => index + 1);
    expect(nearbyPages(pages, 20, 2)).toEqual([18, 19, 20, 21, 22]);
    expect(nearbyPages([], 1, 2)).toEqual([]);
  });
});
