const CFI_MIN = 'epubcfi()'.length + 1;
const CFI_MAX = 4000;

/** A bare progress fraction or percent. Never a saved EPUB place. */
export function isBarePercentage(value: string): boolean {
  const trimmed = value.trim();
  if (/^\d{1,3}(?:\.\d+)?%$/.test(trimmed)) return true;
  if (/^(?:0|1)(?:\.0+)?$/.test(trimmed)) return true;
  if (/^0?\.\d+$/.test(trimmed)) return true;
  return false;
}

/** True when the value is an EPUB CFI, not a percentage. */
export function isSavedEpubLocator(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const locator = value.trim();
  if (locator.length < CFI_MIN || locator.length > CFI_MAX) return false;
  if (!locator.startsWith('epubcfi(') || !locator.endsWith(')')) return false;
  if (isBarePercentage(locator)) return false;
  if (/[\u0000-\u001f\u007f]/.test(locator)) return false;
  return true;
}

function cfiText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && 'toString' in value) {
    const text = String(value).trim();
    return text.startsWith('epubcfi(') ? text : null;
  }
  return null;
}

/**
 * The locator to persist from an epub.js relocation.
 * `start.percentage` is ignored. A bare percentage is never returned.
 */
export function locatorFromRelocation(location: unknown): string | null {
  if (!location || typeof location !== 'object') return null;
  const start = (location as { start?: { cfi?: unknown } }).start;
  if (!start) return null;
  const raw = cfiText(start.cfi);
  if (!raw || !isSavedEpubLocator(raw)) return null;
  return raw.trim();
}
