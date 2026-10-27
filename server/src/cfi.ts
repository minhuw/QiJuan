const CFI_MIN = 'epubcfi()'.length + 1;
const CFI_MAX = 4000;

/** A bare progress fraction or percent, which must not be stored as a place. */
export function isBarePercentage(value: string): boolean {
  const trimmed = value.trim();
  if (/^\d{1,3}(?:\.\d+)?%$/.test(trimmed)) return true;
  if (/^(?:0|1)(?:\.0+)?$/.test(trimmed)) return true;
  if (/^0?\.\d+$/.test(trimmed)) return true;
  return false;
}

/**
 * EPUB CFI only. Values such as `0.42` or `42%` are refused.
 * The string must begin with `epubcfi(`.
 */
export function parseEpubCfi(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const locator = value.trim();
  if (locator.length < CFI_MIN || locator.length > CFI_MAX) return null;
  if (!locator.startsWith('epubcfi(') || !locator.endsWith(')')) return null;
  if (isBarePercentage(locator)) return null;
  if (/[\u0000-\u001f\u007f]/.test(locator)) return null;
  return locator;
}
