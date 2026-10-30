import ePub from 'epubjs';
import { createPageScroll } from '../page-scroll';
import { isSavedEpubLocator, locatorFromRelocation } from './cfi';
import { onReaderKey, type ReaderKeyEvent } from './keys';
import { isArchivedStylesheet, isFontOrImage, isRemoteUrl, neutralizeRemoteAssets, rewriteArchivedText, substituteFor } from './remote';
import { fontStack, mountRendition, renditionOptionsFor, themeCss, type ReaderFlow } from './settings';
import type { BookFacts, EpubSession, OpenEpubOptions, SearchHit, TocItem, Typography } from './types';

interface LooseArchive {
  createUrl: (url: string, options?: unknown) => Promise<unknown>;
  request: (url: string, type?: string) => Promise<unknown>;
  getText?: (url: string, encoding?: string) => unknown;
  __qijuanGuarded?: boolean;
}

interface LooseSection {
  load: (request: unknown) => Promise<unknown>;
  search?: (query: string) => Array<{ cfi?: string; excerpt?: string }>;
  find?: (query: string) => Array<{ cfi?: string; excerpt?: string }>;
}

interface LooseContents {
  document?: Document;
  window?: Window;
}

interface LooseRendition {
  settings?: { allowScriptedContent?: boolean };
  themes: {
    registerCss: (name: string, css: string) => void;
    select: (name: string) => void;
    font: (family: string) => void;
    fontSize: (size: string) => void;
    override: (name: string, value: string) => void;
  };
  annotations: {
    highlight: (cfi: string, data: object, cb: undefined, className: string, styles: object) => void;
    underline: (cfi: string, data: object, cb: undefined, className: string, styles: object) => void;
    remove: (cfi: string, type: string) => void;
  };
  hooks: {
    content: { register: (fn: (contents: LooseContents) => void) => void };
    unloaded: { register: (fn: (view: { document?: Document; contents?: LooseContents }) => void) => void };
  };
  display: (target?: string) => Promise<unknown>;
  next: () => Promise<unknown>;
  prev: () => Promise<unknown>;
  resize: (width: number, height: number, cfi?: string) => void;
  direction: (dir: string) => void;
  on: (event: string, listener: (...args: never[]) => void) => void;
  destroy: () => void;
}

interface LooseBook {
  open: (data: ArrayBuffer) => Promise<unknown>;
  unarchive: (data: ArrayBuffer, encoding?: string) => Promise<unknown>;
  archive?: LooseArchive;
  spine: {
    hooks: { content: { register: (fn: (doc: Document) => void) => void } };
    spineItems: LooseSection[];
  };
  packaging?: { metadata?: { language?: string; direction?: string } };
  navigation?: { toc?: unknown[] };
  load: (path: string) => Promise<unknown>;
  renderTo: (element: HTMLElement, options: ReturnType<typeof renditionOptionsFor>) => LooseRendition;
  destroy: () => void;
}

const createBook = ePub as unknown as (url?: unknown, options?: Record<string, unknown>) => LooseBook;

const HIGHLIGHT_STYLE = { fill: 'rgba(157, 64, 54, 0.35)' };
const NOTE_STYLE = { stroke: '#3c6d5c', 'stroke-width': '2px' };

function cssText(url: string, body: unknown): unknown {
  if (typeof url !== 'string' || typeof body !== 'string' || !isArchivedStylesheet(url)) return body;
  return rewriteArchivedText(url, body);
}

function guardArchive(archive: LooseArchive | undefined) {
  if (!archive || archive.__qijuanGuarded) return;
  const createUrl = archive.createUrl.bind(archive);
  const request = archive.request.bind(archive);
  const getText = archive.getText?.bind(archive);
  archive.createUrl = (url, options) => {
    if (typeof url === 'string' && isRemoteUrl(url)) return Promise.resolve(substituteFor(url));
    return Promise.resolve(createUrl(url, options)).catch(() => substituteFor(typeof url === 'string' ? url : ''));
  };
  // epub.js builds blob stylesheets from archive.getText, then only rewrites manifest-relative paths.
  // Remote url() and @import inside that CSS never touch the chapter document, so rewrite the text here.
  if (getText) {
    archive.getText = (url, encoding) => {
      const pending = getText(url, encoding);
      if (pending == null || typeof url !== 'string' || !isArchivedStylesheet(url)) return pending;
      return Promise.resolve(pending).then((text) => cssText(url, text));
    };
  }
  archive.request = (url, type) => {
    if (typeof url === 'string' && isRemoteUrl(url) && isFontOrImage(url)) return Promise.resolve(substituteFor(url));
    const pending = request(url, type);
    if (typeof url !== 'string' || !isArchivedStylesheet(url)) return pending;
    return Promise.resolve(pending).then((body) => cssText(url, body));
  };
  archive.__qijuanGuarded = true;
}

function readToc(items: unknown): TocItem[] {
  if (!Array.isArray(items)) return [];
  const result: TocItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { label?: unknown; href?: unknown; subitems?: unknown; children?: unknown };
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const href = typeof record.href === 'string' ? record.href : '';
    if (!label || !href) continue;
    result.push({ label, href, children: readToc(record.subitems ?? record.children) });
  }
  return result;
}

function quoteFrom(contents: unknown): string {
  if (!contents || typeof contents !== 'object') return '';
  const selection = (contents as LooseContents).window?.getSelection?.();
  return (selection?.toString() ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function paintTypography(rendition: LooseRendition, typography: Typography) {
  rendition.themes.registerCss('paper', themeCss('paper'));
  rendition.themes.registerCss('ink', themeCss('ink'));
  rendition.themes.select(typography.theme);
  rendition.themes.font(fontStack(typography.font));
  rendition.themes.fontSize(typography.fontSize);
  rendition.themes.override('line-height', typography.lineHeight);
  rendition.themes.override('padding', typography.margin);
}

function readFacts(book: LooseBook): BookFacts {
  const language = book.packaging?.metadata?.language?.trim() || null;
  const direction = book.packaging?.metadata?.direction === 'rtl' ? 'rtl' : 'ltr';
  return { language, direction };
}

/**
 * Opens EPUB bytes with epub.js. Callers outside `client/src/reader/epub` use this
 * session instead of epub.js itself.
 */
export async function openEpubSession(
  data: ArrayBuffer,
  element: HTMLElement,
  options: OpenEpubOptions,
): Promise<EpubSession> {
  const book = createBook(undefined, { replacements: 'blobUrl' });
  const originalUnarchive = book.unarchive.bind(book);
  book.unarchive = (input, encoding) =>
    Promise.resolve(originalUnarchive(input, encoding)).then((result) => {
      guardArchive(book.archive);
      return result;
    });
  book.spine.hooks.content.register((doc) => {
    try {
      neutralizeRemoteAssets(doc);
    } catch {
      // A chapter that cannot be rewritten still opens.
    }
  });
  await book.open(data);

  const facts = readFacts(book);
  if (facts.language) element.lang = facts.language;
  element.dir = facts.direction;

  let mode: ReaderFlow = options.flow;
  let typography = options.typography;
  let currentCfi = options.initialCfi && isSavedEpubLocator(options.initialCfi) ? options.initialCfi : null;
  let rendition: LooseRendition;
  let destroyed = false;
  let changingFlow = false;
  let stopPageScroll = () => {};
  const relocated = new Set<(cfi: string) => void>();
  const selected = new Set<(cfi: string, quote: string) => void>();
  const marks = new Map<string, 'highlight' | 'underline'>();

  function paintMarks(target: LooseRendition) {
    for (const [cfi, kind] of marks) draw(target, cfi, kind);
  }

  function draw(target: LooseRendition, cfi: string, kind: 'highlight' | 'underline') {
    try {
      if (kind === 'highlight') {
        target.annotations.highlight(cfi, {}, undefined, 'qijuan-highlight', HIGHLIGHT_STYLE);
      } else {
        target.annotations.underline(cfi, {}, undefined, 'qijuan-note', NOTE_STYLE);
      }
    } catch {
      // The range cannot be drawn in this chapter.
    }
  }

  function wire(target: LooseRendition) {
    const pageScroll = createPageScroll({
      horizontal: true,
      direction: facts.direction,
      enabled: () => !destroyed && !changingFlow && mode === 'paginated',
      canTurn: () => true,
      turn: (turn) => turn === 'next' ? target.next() : target.prev(),
    });
    stopPageScroll = pageScroll.destroy;
    const chapters = new WeakMap<Document, () => void>();
    pageScroll.attach(element);
    target.hooks.unloaded.register((view) => {
      const document = view.document ?? view.contents?.document;
      if (!document) return;
      chapters.get(document)?.();
      chapters.delete(document);
    });
    target.hooks.content.register((contents) => {
      if (!contents.document) return;
      if (mode === 'paginated') chapters.set(contents.document, pageScroll.attach(contents.document));
      try {
        neutralizeRemoteAssets(contents.document);
      } catch {
        // Ignore a document that is already gone.
      }
    });
    target.direction(facts.direction);
    paintTypography(target, typography);
    paintMarks(target);
    target.on('relocated', ((location: unknown) => {
      const cfi = locatorFromRelocation(location);
      if (!cfi) return;
      currentCfi = cfi;
      for (const listener of relocated) listener(cfi);
    }) as (...args: never[]) => void);
    target.on('selected', ((cfiRange: unknown, contents: unknown) => {
      if (!isSavedEpubLocator(cfiRange)) return;
      const quote = quoteFrom(contents);
      for (const listener of selected) listener(cfiRange, quote);
    }) as (...args: never[]) => void);
    // epub.js listens for keydown inside the chapter iframe and re-emits it here.
    // Those events never reach window, which is where chrome focus is handled.
    target.on('keydown', ((event: unknown) => {
      if (!event || typeof event !== 'object' || typeof (event as ReaderKeyEvent).key !== 'string') return;
      if (typeof (event as ReaderKeyEvent).preventDefault !== 'function') return;
      onReaderKey(event as ReaderKeyEvent, {
        enabled: !destroyed && mode === 'paginated',
        direction: facts.direction,
        next: () => {
          void target.next();
        },
        prev: () => {
          void target.prev();
        },
      });
    }) as (...args: never[]) => void);
  }

  function mount(flow: ReaderFlow): LooseRendition {
    const width = element.clientWidth || 320;
    const height = element.clientHeight || 480;
    const next = mountRendition(book, element, renditionOptionsFor(flow, { width, height }));
    wire(next);
    return next;
  }

  async function show(target: string | null) {
    if (destroyed) return;
    if (target && isSavedEpubLocator(target)) {
      currentCfi = target;
      await rendition.display(target);
      return;
    }
    if (target) await rendition.display(target);
    else await rendition.display();
  }

  rendition = mount(mode);
  await show(currentCfi);

  return {
    facts,
    toc: readToc(book.navigation?.toc),
    async display(target: string) {
      await show(target);
    },
    async next() {
      if (!destroyed) await rendition.next();
    },
    async prev() {
      if (!destroyed) await rendition.prev();
    },
    async setFlow(next: ReaderFlow) {
      if (destroyed || next === mode) return;
      mode = next;
      changingFlow = true;
      const cfi = currentCfi;
      stopPageScroll();
      try {
        rendition.destroy();
      } catch {
        // The previous view is already gone.
      }
      try {
        rendition = mount(next);
        await show(cfi);
        if (!destroyed) {
          // epub.js can clear its views on resize before its first location report.
          // Display again so a mode change that alters the toolbar height keeps the page visible.
          rendition.resize(element.clientWidth || 320, element.clientHeight || 480, currentCfi ?? undefined);
          await show(currentCfi);
        }
      } finally {
        changingFlow = false;
      }
    },
    async applyTypography(next: Typography, cfi: string | null) {
      typography = next;
      element.style.fontFamily = fontStack(next.font);
      if (destroyed) return;
      paintTypography(rendition, next);
      const target = cfi && isSavedEpubLocator(cfi) ? cfi : currentCfi;
      if (target) await rendition.display(target);
    },
    resize(width: number, height: number, cfi: string | null) {
      if (destroyed || changingFlow || width < 1 || height < 1) return;
      const target = cfi && isSavedEpubLocator(cfi) ? cfi : undefined;
      rendition.resize(width, height, target);
    },
    highlight(cfi: string) {
      if (!isSavedEpubLocator(cfi)) return;
      marks.set(cfi, 'highlight');
      draw(rendition, cfi, 'highlight');
    },
    underline(cfi: string) {
      if (!isSavedEpubLocator(cfi)) return;
      marks.set(cfi, 'underline');
      draw(rendition, cfi, 'underline');
    },
    removeMark(cfi: string, kind: 'highlight' | 'underline') {
      if (marks.get(cfi) === kind) marks.delete(cfi);
      try {
        rendition.annotations.remove(cfi, kind);
      } catch {
        // Already detached.
      }
    },
    onRelocated(listener) {
      relocated.add(listener);
      return () => relocated.delete(listener);
    },
    onSelected(listener) {
      selected.add(listener);
      return () => selected.delete(listener);
    },
    async search(query: string) {
      const needle = query.trim();
      if (!needle || destroyed) return [];
      const hits: SearchHit[] = [];
      for (const section of book.spine.spineItems) {
        try {
          await section.load(book.load.bind(book));
          const found = section.search?.(needle) ?? section.find?.(needle) ?? [];
          for (const match of found) {
            if (!isSavedEpubLocator(match?.cfi)) continue;
            hits.push({ cfi: match.cfi, excerpt: typeof match.excerpt === 'string' ? match.excerpt : '' });
            if (hits.length >= 40) return hits;
          }
        } catch {
          // Skip a section that cannot be searched.
        }
      }
      return hits;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopPageScroll();
      relocated.clear();
      selected.clear();
      try {
        rendition.destroy();
      } catch {
        // Already destroyed.
      }
      try {
        book.destroy();
      } catch {
        // Already destroyed.
      }
    },
  };
}
