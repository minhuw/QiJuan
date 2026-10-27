const TRANSPARENT_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const EMPTY_FONT = 'data:font/woff2;base64,';

const FONT_OR_IMAGE = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|bmp|avif|ico)(?:$|[?#])/i;

/** A URL the book asks the browser or epub.js to fetch from another origin. */
export function isRemoteUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return false;
  if (trimmed.startsWith('//')) return true;
  if (/^mailto:/i.test(trimmed)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

export function isFontOrImage(value: string): boolean {
  return FONT_OR_IMAGE.test(value.trim());
}

/** Quiet stand-in so a failed or remote font/image is not requested. */
export function substituteFor(url: string): string {
  if (isFontOrImage(url) && /\.(?:woff2?|ttf|otf|eot)(?:$|[?#])/i.test(url)) return EMPTY_FONT;
  return TRANSPARENT_GIF;
}

/** True for a linked stylesheet path. Query strings and fragments are ignored. */
export function isArchivedStylesheet(url: string): boolean {
  const path = url.trim().split(/[?#]/, 1)[0] ?? '';
  return /\.css$/i.test(path);
}

/**
 * Drops remote @import rules and replaces remote url() values.
 * Relative in-archive fonts and images are left untouched.
 */
export function replaceRemoteCssUrls(css: string): string {
  const withoutImport = css.replace(/@import\s+(?:url\()?\s*['"]?(?:https?:)?\/\/[^'")\s;]+['"]?\s*\)?\s*;?/gi, '');
  return withoutImport.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, _quote, raw: string) => {
    const target = raw.trim();
    if (!isRemoteUrl(target)) return full;
    return `url("${substituteFor(target)}")`;
  });
}

/** Rewrites a stylesheet body. Any other archived file is returned unchanged. */
export function rewriteArchivedText(url: string, text: string): string {
  if (!isArchivedStylesheet(url)) return text;
  try {
    return replaceRemoteCssUrls(text);
  } catch {
    return text;
  }
}

/**
 * Rewrites remote fonts and images in a parsed chapter so the iframe does not request them.
 * Failures are ignored by the caller. Local chapter files are left alone.
 */
export function neutralizeRemoteAssets(doc: Document): void {
  if (!doc || typeof doc.querySelectorAll !== 'function') return;
  const styled = doc.querySelectorAll('style');
  styled.forEach((node) => {
    node.textContent = replaceRemoteCssUrls(node.textContent ?? '');
  });
  const nodes = doc.querySelectorAll('[src], [href], [srcset], [style]');
  nodes.forEach((node) => {
    const tag = node.tagName.toLowerCase();
    const style = node.getAttribute('style');
    if (style && /url\(/i.test(style)) node.setAttribute('style', replaceRemoteCssUrls(style));
    if (tag === 'a') return;
    const href = node.getAttribute('href');
    const src = node.getAttribute('src');
    if (tag === 'link' && href && isRemoteUrl(href)) {
      node.parentNode?.removeChild(node);
      return;
    }
    if (src && isRemoteUrl(src) && (tag === 'img' || tag === 'image' || tag === 'source' || isFontOrImage(src))) {
      node.setAttribute('src', substituteFor(src));
    }
    if (href && isRemoteUrl(href) && (tag === 'image' || isFontOrImage(href))) {
      node.setAttribute('href', substituteFor(href));
    }
    const srcset = node.getAttribute('srcset');
    if (srcset) {
      const kept = srcset
        .split(',')
        .map((part) => part.trim())
        .filter((part) => {
          const url = part.split(/\s+/)[0] ?? '';
          return url && !isRemoteUrl(url);
        });
      if (kept.length === 0) node.removeAttribute('srcset');
      else node.setAttribute('srcset', kept.join(', '));
    }
  });
}
