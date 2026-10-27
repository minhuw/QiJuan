import { describe, expect, it } from 'vitest';
import { pdfWorkerUrl } from './worker';

describe('pdf worker', () => {
  it('points at the same origin as the app', () => {
    const url = pdfWorkerUrl();
    expect(url.startsWith('/')).toBe(true);
    expect(url.includes('://')).toBe(false);
    expect(url.endsWith('/pdfjs/pdf.worker.min.mjs')).toBe(true);
    expect(url).not.toMatch(/cdn|unpkg|jsdelivr|mozilla\\.github/);
  });
});
