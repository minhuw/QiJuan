import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireUser } from './auth.js';
import type { WebTransport } from './metadata/assistant/client.js';
import { imageDimensions, sameSiteFamily } from './metadata/cover-fetch.js';
import { safeGet } from './metadata/safe-fetch.js';

/**
 * The small site icons shown beside external ratings. Nothing is bundled: the server reads each
 * provider's own homepage, follows its `<link rel="icon">` (or `/favicon.ico`), checks the bytes,
 * and keeps the file under `<data>/provider-icons/` for 30 days. A failed lookup is not retried
 * for six hours; the page then shows the provider's name without an icon.
 */

export const ICON_PROVIDERS = ['douban', 'goodreads', 'open_library', 'google_books', 'worldcat'] as const;
export type IconProvider = (typeof ICON_PROVIDERS)[number];

const HOMEPAGES: Record<IconProvider, string> = {
  douban: 'https://book.douban.com/',
  goodreads: 'https://www.goodreads.com/',
  open_library: 'https://openlibrary.org/',
  google_books: 'https://books.google.com/',
  worldcat: 'https://search.worldcat.org/',
};

export const ICON_MAX_BYTES = 256 * 1024;
export const ICON_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const ICON_FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;
/** Shown at 16px; 32px covers a 2× display. */
const ICON_PREFERRED_PX = 32;
const PAGE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8000;
/** WorldCat redirects static files to a `/zh-cn/` path that does not exist when asked in Chinese. */
const ICON_ACCEPT_LANGUAGE = 'en';
/** At most this many declared icons are tried before `/favicon.ico`. */
const ICON_ATTEMPTS = 3;

export type IconMediaType = 'image/png' | 'image/x-icon' | 'image/webp' | 'image/jpeg';

const EXTENSIONS: Record<IconMediaType, string> = {
  'image/png': 'png',
  'image/x-icon': 'ico',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};

export interface IconCandidate {
  url: string;
  rel: 'icon' | 'apple-touch-icon';
  /** The largest edge declared in `sizes`, or null when none is given or it is `any`. */
  size: number | null;
}

export interface IconCheck {
  mediaType: IconMediaType;
  width: number;
  height: number;
}

interface IconMeta {
  provider: IconProvider;
  /** When the stored file was fetched. */
  fetchedAt?: number;
  file?: string;
  mediaType?: IconMediaType;
  width?: number;
  height?: number;
  sourceUrl?: string;
  /** When the last lookup failed, and why. */
  failedAt?: number;
  error?: string;
}

export interface StoredIcon {
  bytes: Buffer;
  mediaType: IconMediaType;
}

export type ResolvedIcon = { ok: true; bytes: Buffer; url: string } & IconCheck;
export type IconLookup = ResolvedIcon | { ok: false; error: string };

export function isIconProvider(value: unknown): value is IconProvider {
  return typeof value === 'string' && (ICON_PROVIDERS as readonly string[]).includes(value);
}

// --- page and bytes ---------------------------------------------------------------

/**
 * The icons a page declares, best first for a 16px display: sized icons of at least 32px
 * (smallest first), then unsized ones, then apple-touch-icon, then smaller sized icons
 * (largest first). SVG icons are skipped.
 */
export function extractIconLinks(html: string, pageUrl: string): IconCandidate[] {
  const head = html.slice(0, PAGE_BYTES);
  const base = baseHref(head, pageUrl);
  const found: IconCandidate[] = [];
  const seen = new Set<string>();
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = readAttributes(match[0]);
    const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const rel = rels.includes('apple-touch-icon') || rels.includes('apple-touch-icon-precomposed')
      ? 'apple-touch-icon'
      : rels.includes('icon')
        ? 'icon'
        : null;
    if (!rel || !attrs.href) continue;
    if (rels.includes('mask-icon')) continue;
    const type = (attrs.type ?? '').toLowerCase();
    if (type.includes('svg')) continue;
    let url: URL;
    try {
      url = new URL(attrs.href.trim(), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (/\.svgz?$/i.test(url.pathname)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    found.push({ url: url.href, rel, size: largestSize(attrs.sizes) });
  }
  return found.sort((a, b) => rank(a) - rank(b));
}

function rank(candidate: IconCandidate): number {
  const { size, rel } = candidate;
  if (size !== null && size >= ICON_PREFERRED_PX) return size;
  if (rel === 'icon' && size === null) return 10_000;
  if (rel === 'apple-touch-icon') return 20_000 + (size ?? 180);
  return 30_000 + (ICON_PREFERRED_PX - (size ?? 0));
}

function largestSize(sizes: string | undefined): number | null {
  if (!sizes) return null;
  let best: number | null = null;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (match) best = Math.max(best ?? 0, Number(match[1]), Number(match[2]));
  }
  return best;
}

function baseHref(html: string, pageUrl: string): string {
  const tag = /<base\b[^>]*>/i.exec(html);
  const href = tag ? readAttributes(tag[0]).href : undefined;
  if (!href) return pageUrl;
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return pageUrl;
  }
}

function readAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = match[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/');
}

/** Accepts PNG, ICO, WebP, and JPEG by magic bytes, up to 256 KiB, with a readable pixel size. */
export function verifyIconBytes(bytes: Buffer, contentType: string | null = null): IconCheck | { error: string } {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('text/') || type.includes('html') || type.includes('json')) return { error: `served as ${type}` };
  if (bytes.length === 0) return { error: 'empty' };
  if (bytes.length > ICON_MAX_BYTES) return { error: 'too_large' };
  if (isIco(bytes)) {
    const size = icoSize(bytes);
    return size ? { mediaType: 'image/x-icon', ...size } : { error: 'unreadable_dimensions' };
  }
  const info = imageDimensions(bytes);
  if (!info) return { error: 'unsupported_type' };
  return { mediaType: info.mediaType, width: info.width, height: info.height };
}

function isIco(bytes: Buffer): boolean {
  return bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1 && bytes.readUInt16LE(4) > 0;
}

/** The largest image in an ICO directory; a 0 byte means 256. */
function icoSize(bytes: Buffer): { width: number; height: number } | null {
  const count = bytes.readUInt16LE(4);
  if (bytes.length < 6 + count * 16) return null;
  let best: { width: number; height: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = bytes[entry] || 256;
    const height = bytes[entry + 1] || 256;
    if (!best || width > best.width) best = { width, height };
  }
  return best;
}

/**
 * Resolves a provider's icon from its homepage, then `/favicon.ico` at the page's origin. Every
 * request goes through `safeGet`; an icon on the same site family gets the homepage as Referer
 * (Douban's image hosts refuse requests without one).
 */
export async function resolveProviderIcon(provider: IconProvider, transport: WebTransport): Promise<IconLookup> {
  const homepage = HOMEPAGES[provider];
  const page = await safeGet(homepage, {
    transport,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    maxBytes: PAGE_BYTES,
    overflow: 'truncate',
    acceptLanguage: ICON_ACCEPT_LANGUAGE,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  const pageUrl = page.ok ? page.url.href : homepage;
  const candidates = page.ok ? extractIconLinks(page.bytes.toString('utf8'), pageUrl).slice(0, ICON_ATTEMPTS) : [];
  const fallback = new URL('/favicon.ico', pageUrl).href;
  const urls = [...candidates.map((candidate) => candidate.url)];
  if (!urls.includes(fallback)) urls.push(fallback);

  const referer = (url: URL) => (sameSiteFamily(new URL(pageUrl).hostname, url.hostname) ? `${new URL(pageUrl).origin}/` : null);
  let error = page.ok ? 'no_icon' : `page_${page.code}`;
  for (const url of urls) {
    const reply = await safeGet(url, {
      transport,
      accept: 'image/png,image/x-icon,image/webp,image/jpeg,image/*;q=0.8,*/*;q=0.5',
      maxBytes: ICON_MAX_BYTES,
      overflow: 'reject',
      referer,
      acceptLanguage: ICON_ACCEPT_LANGUAGE,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!reply.ok) {
      error = reply.code;
      continue;
    }
    const check = verifyIconBytes(reply.bytes, reply.contentType);
    if ('error' in check) {
      error = check.error;
      continue;
    }
    return { ok: true, bytes: reply.bytes, url: reply.url.href, ...check };
  }
  return { ok: false, error };
}

// --- cache ------------------------------------------------------------------------

export interface ProviderIconsOptions {
  dataDir: string;
  /** Tests pass a stub `fetch` and `lookup`. Without a stub, Vitest never reaches the network. */
  transport?: WebTransport;
  now?: () => number;
}

export class ProviderIcons {
  private readonly dir: string;
  private readonly transport: WebTransport;
  private readonly now: () => number;
  private readonly inFlight = new Map<IconProvider, Promise<StoredIcon | null>>();

  constructor(options: ProviderIconsOptions) {
    this.dir = path.join(options.dataDir, 'provider-icons');
    this.transport = options.transport ?? {};
    this.now = options.now ?? Date.now;
  }

  /** The stored icon, fetched first when missing or older than 30 days. Null when there is none. */
  async get(provider: IconProvider): Promise<StoredIcon | null> {
    const meta = this.readMeta(provider);
    const stored = meta ? this.readStored(meta) : null;
    const now = this.now();
    if (stored && meta?.fetchedAt !== undefined && now - meta.fetchedAt < ICON_MAX_AGE_MS) return stored;
    if (meta?.failedAt !== undefined && now - meta.failedAt < ICON_FAILURE_RETRY_MS) return stored;
    const running = this.inFlight.get(provider);
    if (running) return running;
    const task = this.refresh(provider, meta, stored).finally(() => this.inFlight.delete(provider));
    this.inFlight.set(provider, task);
    return task;
  }

  private async refresh(provider: IconProvider, meta: IconMeta | null, stored: StoredIcon | null): Promise<StoredIcon | null> {
    const result = await resolveProviderIcon(provider, this.transport);
    mkdirSync(this.dir, { recursive: true });
    if (!result.ok) {
      // The last good icon stays in use; only the retry is put off.
      this.writeMeta({ ...(meta ?? { provider }), provider, failedAt: this.now(), error: result.error });
      return stored;
    }
    const file = `${provider}.${EXTENSIONS[result.mediaType]}`;
    writeAtomic(path.join(this.dir, file), result.bytes);
    if (meta?.file && meta.file !== file) rmSync(path.join(this.dir, meta.file), { force: true });
    this.writeMeta({
      provider,
      fetchedAt: this.now(),
      file,
      mediaType: result.mediaType,
      width: result.width,
      height: result.height,
      sourceUrl: result.url,
    });
    return { bytes: result.bytes, mediaType: result.mediaType };
  }

  private readMeta(provider: IconProvider): IconMeta | null {
    try {
      const parsed = JSON.parse(readFileSync(path.join(this.dir, `${provider}.json`), 'utf8')) as IconMeta;
      return parsed && parsed.provider === provider ? parsed : null;
    } catch {
      return null;
    }
  }

  private readStored(meta: IconMeta): StoredIcon | null {
    if (!meta.file || !meta.mediaType || !(meta.mediaType in EXTENSIONS) || meta.file !== path.basename(meta.file)) return null;
    const absolute = path.join(this.dir, meta.file);
    if (!existsSync(absolute)) return null;
    try {
      return { bytes: readFileSync(absolute), mediaType: meta.mediaType };
    } catch {
      return null;
    }
  }

  private writeMeta(meta: IconMeta): void {
    writeAtomic(path.join(this.dir, `${meta.provider}.json`), Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
  }
}

function writeAtomic(target: string, bytes: Buffer): void {
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, target);
}

// --- route ------------------------------------------------------------------------

export function registerProviderIconRoutes(app: FastifyInstance, icons: ProviderIcons): void {
  app.get('/api/providers/:provider/icon', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const provider = (request.params as { provider?: string }).provider;
    if (!isIconProvider(provider)) return reply.code(404).send({ error: 'not_found' });
    const icon = await icons.get(provider);
    if (!icon) {
      reply.header('cache-control', 'no-store');
      return reply.code(404).send({ error: 'not_found' });
    }
    reply.header('content-type', icon.mediaType);
    reply.header('cache-control', 'private, max-age=86400');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'");
    return reply.send(icon.bytes);
  });
}
