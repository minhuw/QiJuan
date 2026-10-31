import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { WebTransport } from './assistant/client.js';

/**
 * Direct GETs of public web pages and images for the metadata agent (page_images and cover
 * downloads). Every URL, including each redirect hop, must pass `validateFetchUrl`.
 */

/** The documented URL limit for DeepSeek Fetch, also used for direct fetches. */
export const FETCH_URL_MAX = 8192;
/** One direct fetch, redirects included, must finish within this time. */
export const SAFE_FETCH_TIMEOUT_MS = 30_000;
export const SAFE_FETCH_MAX_REDIRECTS = 3;

/** Some sites serve a stripped page, or nothing, to clients that do not look like a browser. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const BROWSER_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

export type FetchUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Accepts only public http(s) URLs without credentials. IP literals, localhost, and single-label
 * or local-only names are refused, and the host must resolve only to public addresses.
 */
export async function validateFetchUrl(
  value: unknown,
  lookup: WebTransport['lookup'] = defaultLookup,
): Promise<FetchUrlCheck> {
  if (typeof value !== 'string') return { ok: false, reason: 'url must be a string' };
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > FETCH_URL_MAX) {
    return { ok: false, reason: `url must be 1 to ${FETCH_URL_MAX} characters` };
  }
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return { ok: false, reason: 'url must not contain whitespace' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'url is not valid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'only http and https urls' };
  if (url.username || url.password) return { ok: false, reason: 'url must not contain credentials' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'url must have a host' };
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return { ok: false, reason: 'ip address urls are not allowed' };
  if (isLocalName(host)) return { ok: false, reason: 'local host names are not allowed' };
  if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, reason: 'only default ports' };

  let addresses: string[];
  try {
    addresses = await (lookup ?? defaultLookup)(host);
  } catch {
    return { ok: false, reason: 'host does not resolve' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'host does not resolve' };
  if (addresses.some(isPrivateAddress)) return { ok: false, reason: 'host resolves to a private address' };
  return { ok: true, url };
}

function isLocalName(host: string): boolean {
  if (!host.includes('.')) return true;
  return ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'localdomain'].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

const PRIVATE_RANGES = (() => {
  const list = new BlockList();
  const v4: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [network, prefix] of v4) list.addSubnet(network, prefix, 'ipv4');
  const v6: Array<[string, number]> = [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ];
  for (const [network, prefix] of v6) list.addSubnet(network, prefix, 'ipv6');
  return list;
})();

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_RANGES.check(address, 'ipv4');
  if (family === 6) {
    // IPv4-mapped addresses (::ffff:a.b.c.d or ::ffff:xxxx:xxxx) are refused outright. They are not
    // in the BlockList because Node matches plain IPv4 addresses against that IPv6 range too.
    if (/^(0{0,4}:){0,5}:?ffff:/i.test(address) && !/^ffff:/i.test(address)) return true;
    return PRIVATE_RANGES.check(address, 'ipv6');
  }
  return true;
}

async function defaultLookup(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export type SafeFetchErrorCode =
  | 'url_rejected'
  | 'redirect_rejected'
  | 'too_many_redirects'
  | 'http_error'
  | 'too_large'
  | 'timeout'
  | 'network';

export type SafeFetchResult =
  | {
      ok: true;
      /** The final URL, after redirects. */
      url: URL;
      status: number;
      contentType: string | null;
      bytes: Buffer;
      /** The body was longer than `maxBytes` and only its start was kept (`truncate` mode). */
      truncated: boolean;
    }
  | { ok: false; code: SafeFetchErrorCode; detail: string; status?: number };

export interface SafeGetOptions {
  transport: WebTransport;
  accept: string;
  maxBytes: number;
  /** `reject` refuses a longer body; `truncate` keeps its first `maxBytes`. */
  overflow: 'reject' | 'truncate';
  /** The Referer for one hop, or null to send none. */
  referer?: (url: URL) => string | null;
  /** Defaults to `BROWSER_ACCEPT_LANGUAGE`. */
  acceptLanguage?: string;
  timeoutMs?: number;
}

/**
 * A GET that re-validates every redirect hop (`redirect: 'manual'`, at most three), shares one
 * timeout across hops, and never buffers more than `maxBytes`. It never throws.
 */
export async function safeGet(value: string, options: SafeGetOptions): Promise<SafeFetchResult> {
  if (!options.transport.fetch && process.env.VITEST) {
    return { ok: false, code: 'network', detail: 'network disabled in tests' };
  }
  const fetchImpl = options.transport.fetch ?? globalThis.fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS);
  let target: string = value;
  for (let hop = 0; ; hop += 1) {
    const checked = await validateFetchUrl(target, options.transport.lookup);
    if (!checked.ok) {
      return { ok: false, code: hop === 0 ? 'url_rejected' : 'redirect_rejected', detail: checked.reason };
    }
    const url = checked.url;
    const headers: Record<string, string> = {
      'user-agent': BROWSER_USER_AGENT,
      accept: options.accept,
      'accept-language': options.acceptLanguage ?? BROWSER_ACCEPT_LANGUAGE,
    };
    const referer = options.referer?.(url) ?? null;
    if (referer) headers.referer = referer;
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal });
    } catch (error) {
      return failure(error);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      await discard(response);
      const location = response.headers.get('location');
      if (!location) return { ok: false, code: 'http_error', status: response.status, detail: 'redirect without a location' };
      if (hop >= SAFE_FETCH_MAX_REDIRECTS) {
        return { ok: false, code: 'too_many_redirects', detail: `more than ${SAFE_FETCH_MAX_REDIRECTS} redirects` };
      }
      try {
        target = new URL(location, url).href;
      } catch {
        return { ok: false, code: 'redirect_rejected', detail: 'redirect location is not a valid url' };
      }
      continue;
    }
    if (!response.ok) {
      await discard(response);
      return { ok: false, code: 'http_error', status: response.status, detail: `HTTP ${response.status}` };
    }
    const advertised = Number(response.headers.get('content-length'));
    if (options.overflow === 'reject' && Number.isFinite(advertised) && advertised > options.maxBytes) {
      await discard(response);
      return { ok: false, code: 'too_large', detail: `larger than ${options.maxBytes} bytes` };
    }
    try {
      const body = await readCapped(response, options.maxBytes);
      if (body.overflow && options.overflow === 'reject') {
        return { ok: false, code: 'too_large', detail: `larger than ${options.maxBytes} bytes` };
      }
      return {
        ok: true,
        url,
        status: response.status,
        contentType: response.headers.get('content-type'),
        bytes: body.bytes,
        truncated: body.overflow,
      };
    } catch (error) {
      return failure(error);
    }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Buffer; overflow: boolean }> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > maxBytes ? { bytes: bytes.subarray(0, maxBytes), overflow: true } : { bytes, overflow: false };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    if (total + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - total));
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks), overflow: true };
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return { bytes: Buffer.concat(chunks), overflow: false };
}

function failure(error: unknown): SafeFetchResult {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, code: 'timeout', detail: 'request timed out' };
  return { ok: false, code: 'network', detail: 'request failed' };
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status already decided the outcome.
  }
}
