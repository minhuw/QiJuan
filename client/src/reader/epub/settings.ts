export const CJK_SERIF = '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Palatino, serif';
export const CJK_SANS = '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Segoe UI", sans-serif';

export type ReaderFlow = 'paginated' | 'continuous';
export type ReaderFont = 'serif' | 'sans';
export type ReaderTheme = 'paper' | 'ink';

export interface RenditionOptions {
  width: number | string;
  height: number | string;
  flow: 'paginated' | 'scrolled';
  manager: 'default' | 'continuous';
  spread: 'none';
  allowScriptedContent: false;
  allowPopups: false;
}

export interface MountedRendition {
  settings?: { allowScriptedContent?: boolean };
}

/** Options passed to epub.js. Scripted content stays off no matter the flow. */
export function renditionOptionsFor(
  mode: ReaderFlow,
  size: { width: number | string; height: number | string },
): RenditionOptions {
  return {
    width: size.width,
    height: size.height,
    flow: mode === 'continuous' ? 'scrolled' : 'paginated',
    manager: mode === 'continuous' ? 'continuous' : 'default',
    spread: 'none',
    allowScriptedContent: false,
    allowPopups: false,
  };
}

export function mountRendition<T extends MountedRendition>(
  book: { renderTo: (element: HTMLElement, options: RenditionOptions) => T },
  element: HTMLElement,
  options: RenditionOptions,
): T {
  const safe: RenditionOptions = { ...options, allowScriptedContent: false, allowPopups: false };
  const rendition = book.renderTo(element, safe);
  if (rendition.settings) rendition.settings.allowScriptedContent = false;
  return rendition;
}

export function fontStack(font: ReaderFont): string {
  return font === 'sans' ? CJK_SANS : CJK_SERIF;
}

export function themeCss(theme: ReaderTheme): string {
  if (theme === 'ink') {
    return 'html, body { background: #1b1815 !important; color: #f4eee4 !important; }';
  }
  return 'html, body { background: #f4efe4 !important; color: #231f1b !important; }';
}
