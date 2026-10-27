export interface PdfTextRun {
  str: string;
  x: number;
  y: number;
}

export interface PdfSearchHit {
  page: number;
  x: number;
  y: number;
  excerpt: string;
}

export function runsFromTextItems(items: readonly object[]): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  for (const item of items) {
    if (!('str' in item) || typeof item.str !== 'string') continue;
    const transform = 'transform' in item && Array.isArray(item.transform) ? item.transform : [];
    const x = typeof transform[4] === 'number' && Number.isFinite(transform[4]) ? transform[4] : 0;
    const y = typeof transform[5] === 'number' && Number.isFinite(transform[5]) ? transform[5] : 0;
    runs.push({ str: item.str, x, y });
  }
  return runs;
}

/** True when the text layer has something other than whitespace. */
export function hasSearchableText(runs: PdfTextRun[]): boolean {
  return runs.some((run) => run.str.trim().length > 0);
}

/** Search the text layer only. An empty layer yields no hits. */
export function searchRuns(pages: Array<{ page: number; runs: PdfTextRun[] }>, query: string, limit = 40): PdfSearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle || limit < 1) return [];
  const hits: PdfSearchHit[] = [];
  for (const page of pages) {
    let combined = '';
    const spans: Array<{ start: number; run: PdfTextRun }> = [];
    for (const run of page.runs) {
      spans.push({ start: combined.length, run });
      combined += run.str;
    }
    const haystack = combined.toLocaleLowerCase();
    let from = 0;
    while (from < haystack.length && hits.length < limit) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      let span = spans[0];
      for (const candidate of spans) {
        if (candidate.start <= at) span = candidate;
        else break;
      }
      const excerpt = combined
        .slice(Math.max(0, at - 24), Math.min(combined.length, at + needle.length + 24))
        .replace(/\s+/g, ' ')
        .trim();
      hits.push({
        page: page.page,
        x: span?.run.x ?? 0,
        y: span?.run.y ?? 0,
        excerpt,
      });
      from = at + Math.max(needle.length, 1);
    }
  }
  return hits;
}
