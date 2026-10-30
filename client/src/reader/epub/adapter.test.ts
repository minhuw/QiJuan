import { describe, expect, it, vi } from 'vitest';
import { createDebouncedSave } from './debounce';
import { isSavedEpubLocator, locatorFromRelocation } from './cfi';
import { neutralizeRemoteAssets, replaceRemoteCssUrls } from './remote';
import { openEpubSession } from './session';
import { CJK_SANS, CJK_SERIF, fontStack, mountRendition, renditionOptionsFor, themeCss } from './settings';
import type { ReaderFlow } from './settings';
import type { Typography } from './types';

const epubHarness = vi.hoisted(() => ({
  create: (..._args: unknown[]): unknown => {
    throw new Error('epub mock was not installed');
  },
}));

vi.mock('epubjs', () => ({
  default: (...args: unknown[]) => epubHarness.create(...args),
}));

const LINKED_STYLESHEET = [
  '@import url("https://cdn.example/extra.css");',
  '@font-face { font-family: "Remote"; src: url("https://cdn.example/font.woff2") format("woff2"), url("fonts/local.woff2"); }',
  '.page { background-image: url("https://cdn.example/paper.png"); }',
  '.quoted { background: url(\'https://cdn.example/photo.jpg\'); }',
  '.bare { background: url(https://cdn.example/scan.webp); }',
  '.protocol { background: url("//cdn.example/bg.gif"); }',
  '.local { background-image: url("../images/paper.png"); }',
].join('\n');

const CHAPTER_MARKUP = '<p>Keep https://cdn.example/leave-me.png in the chapter.</p>';

const TYPE: Typography = {
  font: 'serif',
  fontSize: '112%',
  lineHeight: '1.6',
  margin: '1.5rem',
  theme: 'paper',
};

function keyEvent(key: string, target: EventTarget | null = null) {
  return {
    key,
    target,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function installBook(direction: 'ltr' | 'rtl') {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const contentHooks: Array<(contents: { document: Document }) => void> = [];
  const unloadHooks: Array<(view: { document: Document }) => void> = [];
  const next = vi.fn(async () => {});
  const prev = vi.fn(async () => {});
  const display = vi.fn(async () => {});
  const resize = vi.fn();
  const rendition = {
    settings: { allowScriptedContent: false },
    themes: {
      registerCss: () => {},
      select: () => {},
      font: () => {},
      fontSize: () => {},
      override: () => {},
    },
    annotations: { highlight: () => {}, underline: () => {}, remove: () => {} },
    hooks: {
      content: { register: (hook: (contents: { document: Document }) => void) => { contentHooks.push(hook); } },
      unloaded: { register: (hook: (view: { document: Document }) => void) => { unloadHooks.push(hook); } },
    },
    display,
    next,
    prev,
    resize,
    direction: () => {},
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    destroy() {
      listeners.clear();
      contentHooks.length = 0;
      unloadHooks.length = 0;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
  };
  const archive = {
    createUrl(url: string) {
      return Promise.resolve(url);
    },
    getText(url: string) {
      return Promise.resolve(/\.css(?:$|[?#])/i.test(url) ? LINKED_STYLESHEET : CHAPTER_MARKUP);
    },
    request(this: { getText: (url: string) => Promise<string> }, url: string) {
      return this.getText(url);
    },
  };
  const book = {
    archive: undefined as typeof archive | undefined,
    spine: { hooks: { content: { register: () => {} } }, spineItems: [] as [] },
    packaging: { metadata: { language: 'zh-Hans', direction } },
    navigation: { toc: [] as [] },
    load: async () => '',
    renderTo: () => rendition,
    destroy: () => {},
    unarchive: async () => {
      book.archive = archive;
    },
    open: async () => {
      await book.unarchive();
    },
  };
  epubHarness.create = () => book;
  return {
    archive, rendition, next, prev, display, resize,
    loadChapter(document: Document) {
      for (const hook of contentHooks) hook({ document });
    },
    unloadChapter(document: Document) {
      for (const hook of unloadHooks) hook({ document });
    },
  };
}

async function openFake(direction: 'ltr' | 'rtl', flow: ReaderFlow = 'paginated') {
  const installed = installBook(direction);
  const session = await openEpubSession(new ArrayBuffer(8), document.createElement('div'), {
    initialCfi: null,
    flow,
    typography: TYPE,
  });
  return { session, ...installed };
}

describe('epub adapter', () => {
  it('keeps scripted content off and saves an epub cfi rather than a percentage', () => {
    for (const mode of ['paginated', 'continuous'] as const) {
      const options = renditionOptionsFor(mode, { width: 640, height: 800 });
      expect(options.allowScriptedContent).toBe(false);
      expect(options.allowPopups).toBe(false);
    }
    expect(renditionOptionsFor('paginated', { width: '100%', height: '100%' }).flow).toBe('paginated');
    expect(renditionOptionsFor('paginated', { width: 1, height: 1 }).manager).toBe('default');
    expect(renditionOptionsFor('continuous', { width: 1, height: 1 })).toMatchObject({
      flow: 'scrolled',
      manager: 'continuous',
      allowScriptedContent: false,
    });

    const renderTo = vi.fn((_element: HTMLElement, options: { allowScriptedContent?: boolean }) => ({
      settings: { allowScriptedContent: options.allowScriptedContent !== false },
    }));
    const element = document.createElement('div');
    const rendition = mountRendition({ renderTo }, element, renditionOptionsFor('paginated', { width: 10, height: 12 }));
    expect(renderTo).toHaveBeenCalledWith(element, expect.objectContaining({ allowScriptedContent: false }));
    expect(rendition.settings?.allowScriptedContent).toBe(false);

    expect(isSavedEpubLocator('epubcfi(/6/4!/4/2:10)')).toBe(true);
    expect(isSavedEpubLocator('epubcfi(/6/4!/4,/2:1,/2:20)')).toBe(true);
    expect(isSavedEpubLocator('epubcfi(/6/4!/4/2:10)').valueOf() && 'epubcfi(/6/4!/4/2:10)'.startsWith('epubcfi(')).toBe(
      true,
    );
    expect(isSavedEpubLocator('0.42')).toBe(false);
    expect(isSavedEpubLocator('42%')).toBe(false);
    expect(isSavedEpubLocator('1')).toBe(false);
    expect(isSavedEpubLocator('0')).toBe(false);
    expect(isSavedEpubLocator('0.0')).toBe(false);
    expect(isSavedEpubLocator('')).toBe(false);
    expect(locatorFromRelocation({ start: { cfi: 'epubcfi(/6/2)', percentage: 0.25 } })).toBe('epubcfi(/6/2)');
    expect(locatorFromRelocation({ start: { cfi: '0.42', percentage: 0.42 } })).toBeNull();
    expect(locatorFromRelocation({ start: { cfi: '42%', percentage: 0.42 } })).toBeNull();
    expect(locatorFromRelocation({ start: { percentage: 0.5 } })).toBeNull();
  });

  it('uses a CJK font stack and the paper and ink colors', () => {
    expect(CJK_SERIF).toContain('Source Han Serif SC');
    expect(CJK_SERIF).toContain('Noto Serif CJK SC');
    expect(CJK_SANS).toContain('Noto Sans SC');
    expect(CJK_SANS).toContain('PingFang SC');
    expect(fontStack('serif')).toBe(CJK_SERIF);
    expect(fontStack('sans')).toBe(CJK_SANS);
    expect(themeCss('paper')).toContain('#f4efe4');
    expect(themeCss('paper')).toContain('#231f1b');
    expect(themeCss('ink')).toContain('#1b1815');
    expect(themeCss('ink')).toContain('#f4eee4');
  });

  it('substitutes remote fonts and images and leaves a chapter image alone', () => {
    const doc = document.implementation.createHTMLDocument('chapter');
    const local = doc.createElement('img');
    local.setAttribute('src', 'images/cover.png');
    const remote = doc.createElement('img');
    remote.setAttribute('src', 'https://cdn.example/cover.png');
    const sheet = doc.createElement('style');
    sheet.textContent = "@font-face { src: url('https://cdn.example/font.woff2'); }";
    doc.body.append(local, remote);
    doc.head.append(sheet);
    neutralizeRemoteAssets(doc);
    expect(local.getAttribute('src')).toBe('images/cover.png');
    expect(remote.getAttribute('src')?.startsWith('data:')).toBe(true);
    expect(sheet.textContent).not.toContain('https://');
    expect(sheet.textContent).toContain('data:');
  });

  it('writes the last cfi once after a burst of page turns', () => {
    vi.useFakeTimers();
    const saved: string[] = [];
    const saver = createDebouncedSave(200, (locator) => {
      saved.push(locator);
    });
    saver.push('epubcfi(/6/2)');
    saver.push('epubcfi(/6/4)');
    saver.push('epubcfi(/6/6)');
    expect(saved).toEqual([]);
    vi.advanceTimersByTime(199);
    expect(saved).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(saved).toEqual(['epubcfi(/6/6)']);
    saver.push('epubcfi(/6/8)');
    saver.flush();
    expect(saved).toEqual(['epubcfi(/6/6)', 'epubcfi(/6/8)']);
    vi.useRealTimers();
  });

  it('rewrites remote fonts and images inside a linked stylesheet and leaves local urls', async () => {
    const { archive, session } = await openFake('ltr');
    expect(session.facts.language).toBe('zh-Hans');
    const rewritten = replaceRemoteCssUrls(LINKED_STYLESHEET);
    expect(rewritten).not.toContain('cdn.example');
    expect(rewritten).not.toContain('@import');
    expect(rewritten).toContain('data:font/woff2');
    expect(rewritten).toContain('data:image/gif');
    expect(rewritten).toContain('fonts/local.woff2');
    expect(rewritten).toContain('../images/paper.png');

    expect(await archive.getText('/OEBPS/styles/styles.css')).toBe(rewritten);
    expect(await archive.request('/OEBPS/styles/styles.CSS')).toBe(rewritten);
    expect(await archive.getText('/OEBPS/chapter.xhtml')).toBe(CHAPTER_MARKUP);
    expect(await archive.getText('/OEBPS/styles/styles.css?raw=1')).toBe(rewritten);
    session.destroy();
  });

  it('turns pages from rendition keydown when the chapter iframe has focus', async () => {
    const { rendition, next, prev, session } = await openFake('ltr');
    const right = keyEvent('ArrowRight');
    rendition.emit('keydown', right);
    expect(next).toHaveBeenCalledTimes(1);
    expect(prev).not.toHaveBeenCalled();
    expect(right.defaultPrevented).toBe(true);

    rendition.emit('keydown', keyEvent('ArrowLeft'));
    expect(prev).toHaveBeenCalledTimes(1);

    rendition.emit('keydown', keyEvent('ArrowDown'));
    expect(next).toHaveBeenCalledTimes(2);
    rendition.emit('keydown', keyEvent('ArrowUp'));
    expect(prev).toHaveBeenCalledTimes(2);

    for (const tag of ['input', 'textarea', 'select']) {
      rendition.emit('keydown', keyEvent('ArrowRight', document.createElement(tag)));
    }
    // Iframe nodes are not the parent window's HTMLElement, so the guard reads the tag and contenteditable flag.
    const editable = { tagName: 'div', isContentEditable: true } as unknown as EventTarget;
    rendition.emit('keydown', keyEvent('ArrowRight', editable));
    expect(next).toHaveBeenCalledTimes(2);

    const blocked = keyEvent('ArrowRight');
    blocked.cancelable = false;
    rendition.emit('keydown', blocked);
    expect(blocked.defaultPrevented).toBe(false);
    expect(next).toHaveBeenCalledTimes(3);

    const passive = keyEvent('ArrowRight');
    passive.preventDefault = () => {
      throw new Error('passive');
    };
    rendition.emit('keydown', passive);
    expect(next).toHaveBeenCalledTimes(4);

    await session.setFlow('continuous');
    rendition.emit('keydown', keyEvent('ArrowRight'));
    expect(next).toHaveBeenCalledTimes(4);
    session.destroy();
  });

  it('turns pages from wheel gestures inside chapter frames and leaves continuous mode native', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { session, loadChapter, next, prev } = await openFake('ltr');
    const frame = document.body.appendChild(document.createElement('iframe'));
    const chapter = frame.contentDocument!;
    loadChapter(chapter);
    const scroll = (deltaY: number) => {
      const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
      chapter.body.dispatchEvent(event);
      return event;
    };
    try {
      expect(scroll(100).defaultPrevented).toBe(true);
      await Promise.resolve();
      for (let i = 0; i < 8; i++) scroll(80);
      expect(next).toHaveBeenCalledTimes(1);
      now += 200;
      scroll(-100);
      expect(prev).toHaveBeenCalledTimes(1);
      await Promise.resolve();

      await session.setFlow('continuous');
      loadChapter(chapter);
      now += 200;
      expect(scroll(100).defaultPrevented).toBe(false);
      expect(next).toHaveBeenCalledTimes(1);
      await session.setFlow('paginated');
      loadChapter(chapter);
      now += 200;
      expect(scroll(100).defaultPrevented).toBe(true);
      expect(next).toHaveBeenCalledTimes(2);
      session.destroy();
      expect(scroll(100).defaultPrevented).toBe(false);
    } finally {
      session.destroy();
      frame.remove();
      clock.mockRestore();
    }
  });

  it.each(['ltr', 'rtl'] as const)('handles horizontal chapter wheels in %s reading order', async (direction) => {
    const { session, loadChapter, next, prev } = await openFake(direction);
    const frame = document.body.appendChild(document.createElement('iframe'));
    loadChapter(frame.contentDocument!);
    frame.contentDocument!.body.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, bubbles: true, cancelable: true }));
    expect(direction === 'ltr' ? next : prev).toHaveBeenCalledTimes(1);
    session.destroy();
    frame.remove();
  });

  it('defers resize until a changed flow has finished mounting', async () => {
    const { session, display, resize } = await openFake('ltr');
    let finish!: () => void;
    display.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const changing = session.setFlow('continuous');
    session.resize(900, 600, null);
    expect(resize).not.toHaveBeenCalled();
    finish();
    await changing;
    expect(resize).toHaveBeenLastCalledWith(320, 480, undefined);
    session.resize(900, 600, null);
    expect(resize).toHaveBeenLastCalledWith(900, 600, undefined);
    session.destroy();
  });

  it('detaches an unloaded chapter without disabling the active reader', async () => {
    const { session, loadChapter, unloadChapter, next } = await openFake('ltr');
    const frame = document.body.appendChild(document.createElement('iframe'));
    const chapter = frame.contentDocument!;
    loadChapter(chapter);
    unloadChapter(chapter);
    const oldWheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    chapter.body.dispatchEvent(oldWheel);
    expect(oldWheel.defaultPrevented).toBe(false);
    expect(next).not.toHaveBeenCalled();
    loadChapter(chapter);
    chapter.body.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    expect(next).toHaveBeenCalledTimes(1);
    session.destroy();
    frame.remove();
  });

  it('swaps horizontal arrows for an rtl book on the rendition keydown path', async () => {
    const { rendition, next, prev, session } = await openFake('rtl');
    expect(session.facts.direction).toBe('rtl');
    rendition.emit('keydown', keyEvent('ArrowLeft'));
    rendition.emit('keydown', keyEvent('ArrowRight'));
    expect(next).toHaveBeenCalledTimes(1);
    expect(prev).toHaveBeenCalledTimes(1);
    session.destroy();
  });
});
